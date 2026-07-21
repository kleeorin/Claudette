import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { FastifyInstance } from 'fastify'
import type { UsageResponse, UsageWindow } from '@claudette/shared'

// Plan-quota usage (5-hour "session" + weekly windows). The CLI stream stopped
// carrying a usage fraction (rate_limit_event is just status + reset), so — exactly
// like `claude`'s own `/usage` command — we read the account's OAuth token and query
// the usage endpoint directly. Local single-user tool; the token never leaves here.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'
const CREDS = join(homedir(), '.claude', '.credentials.json')

// Re-read the creds file every call so a token the CLI just refreshed is picked up
// (we do NOT refresh it ourselves — that's the CLI's job). Null ⇒ not logged in via
// OAuth (e.g. an API-key install), so there's simply no quota meter to show.
async function accessToken(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(CREDS, 'utf8')) as { claudeAiOauth?: { accessToken?: unknown } }
    const tok = parsed.claudeAiOauth?.accessToken
    return typeof tok === 'string' && tok ? tok : null
  } catch { return null }
}

interface RawLimit { kind?: string; group?: string; percent?: number; severity?: string; resets_at?: string }

// The upstream endpoint is aggressively rate-limited — a couple of quick hits and it
// starts returning 429. With no caching we'd fetch on EVERY /api/usage request, and
// the client polls each open tab every 60s plus on every tab focus, so 429s are easy
// to trigger — and each one used to blank the meter ("session usage gone"). So: cache
// the last SUCCESSFUL snapshot, serve it without re-fetching while fresh (TTL), and
// serve it STALE on any error so a transient 429 never makes the chip vanish. The
// numbers move slowly (% of a 5h / weekly window), so a short TTL loses nothing.
const CACHE_TTL_MS = 60_000     // serve the cached snapshot without re-fetching
const MIN_REFETCH_MS = 20_000   // even when stale, never hit upstream more often than this
let cache: { value: UsageResponse; at: number } | null = null
let lastAttempt = 0

function labelFor(l: RawLimit): string {
  if (l.group === 'session') return 'Session'
  if (l.group === 'weekly') return 'Weekly'
  return (l.kind ?? 'limit').replace(/_/g, ' ')
}

// Fetch + normalize. Keeps the primary "session" window and the top-level weekly
// ("weekly_all"); skips the model-scoped weekly sub-windows (noise for a single meter).
export async function fetchUsage(): Promise<UsageResponse | null> {
  const now = Date.now()
  // Fresh cache: skip the upstream call entirely.
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value
  // Every failure path below falls back to the last good snapshot (stale-on-error), so
  // a transient 429 / offline blip keeps the meter showing the last known numbers
  // instead of blanking it. Null only until the very first success (or no OAuth token).
  const stale = cache?.value ?? null
  // Throttle upstream calls even when the cache is stale, so many tabs / rapid polls
  // can't gang up and trip the endpoint's rate limit.
  if (now - lastAttempt < MIN_REFETCH_MS) return stale
  lastAttempt = now

  const token = await accessToken()
  if (!token) return stale
  let res: Response
  try {
    res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA } })
  } catch { return stale }   // offline / DNS — keep showing the last snapshot
  if (!res.ok) return stale  // 401 (token expired between CLI refreshes) / 429 / 5xx — same
  const data = await res.json() as { limits?: RawLimit[] }
  const windows: UsageWindow[] = (Array.isArray(data.limits) ? data.limits : [])
    .filter((l) => (l.group === 'session' || l.kind === 'weekly_all') && typeof l.percent === 'number')
    .map((l) => ({
      kind: l.kind ?? 'limit',
      group: l.group ?? 'limit',
      label: labelFor(l),
      percent: Math.round(l.percent as number),
      resetsAt: l.resets_at ? Math.floor(Date.parse(l.resets_at) / 1000) || undefined : undefined,
      severity: l.severity,
    }))
  const value: UsageResponse = { windows, fetchedAt: now }
  cache = { value, at: now }
  return value
}

export function registerUsageRoutes(app: FastifyInstance): void {
  // Empty windows (not an error) when there's no OAuth token or the endpoint is
  // unreachable — the client just shows no quota chip rather than an error state.
  app.get('/api/usage', async (): Promise<UsageResponse> =>
    (await fetchUsage()) ?? { windows: [], fetchedAt: Date.now() })
}
