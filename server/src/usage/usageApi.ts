import { readFile } from 'fs/promises'
import { join } from 'path'
import type { FastifyInstance } from 'fastify'
import type { UsageResponse, UsageWindow } from '@claudette/shared'
import { claudeConfigDir } from '../claude/sandbox'

// Plan-quota usage (5-hour "session" + weekly windows). The CLI stream stopped
// carrying a usage fraction (rate_limit_event is just status + reset), so — exactly
// like `claude`'s own `/usage` command — we read the account's OAuth token and query
// the usage endpoint directly. Local single-user tool; the token never leaves here.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'

// WHERE THE OAUTH TOKEN IS READ FROM. Reading the operator's real credentials is the
// FEATURE — it is how the quota meter has any numbers at all — so nothing here is trying to
// stop that. The defect this replaces is narrower: the path was `join(homedir(), '.claude',
// '.credentials.json')`, a constant computed at module load from homedir() alone, which
// ignored every override this codebase offers. A harness that set CLAUDETTE_DATA_DIR to a
// throwaway directory, believing that isolated it, still read the operator's real token —
// and any Chrome harness that renders ChatView polls /api/usage via useUsage(), so a suite
// run could authenticate as the operator against api.anthropic.com.
//
// Resolved per call, not once at module load, so a harness can set the variable after import
// (which is how the scratchpad harnesses are written — see sandbox-defaults-test.mts).
//
// Two layers, in this order:
//  1. CLAUDETTE_DATA_DIR. A harness that sets it gets a directory with no credentials file,
//     so accessToken() returns null, fetchUsage() returns before the fetch, and /api/usage
//     answers `{windows: []}` WITHOUT touching the network. A harness that wants to exercise
//     the parsing can plant its own fake token there instead.
//
//     ★ THIS OVERLOADS THE VARIABLE, AND THE COST IS REAL — stated plainly because an earlier
//     draft of this comment called it "THE test-isolation switch, documented as such", which
//     is stronger than the source. util/dataDir.ts actually says "CLAUDETTE_DATA_DIR still
//     overrides everything (tests use it to isolate)": a general RELOCATION override that
//     mentions tests in passing. So an operator who legitimately relocates Claudette's data —
//     which that wording supports — now also redirects the credential lookup, finds no
//     .credentials.json, and gets a quota meter that silently shows nothing, with no error and
//     no log line to explain it.
//     It is kept because it is the cheapest lever that actually isolates the harnesses we have
//     (they already set this variable and nothing else), and because no launcher sets it in
//     production. A DEDICATED variable — CLAUDETTE_CREDENTIALS_DIR, or an explicit "no
//     credentials" switch — would isolate without coupling credential resolution to data-dir
//     relocation, and is the right fix if that silent-empty-meter case is ever reported.
//     NB this deliberately does NOT call dataDir(). dataDir() also runs the one-time legacy
//     migration, which has nothing to do with reading a token, and ~/.config/claudette is
//     emphatically NOT where credentials live (see that file's header) — so this reads the
//     override directly and treats it as "the sandboxed world this process may look at",
//     rather than pretending the credentials belong to Claudette's own data dir.
//  2. claudeConfigDir() — the real location otherwise, i.e. CLAUDE_CONFIG_DIR or ~/.claude.
//     Unchanged in production: the server process does not set CLAUDE_CONFIG_DIR (it sets it
//     per-launched-child, see sessionManager), so this still resolves to ~/.claude exactly as
//     the old constant did. It also fixes the same class of bug permissions.ts already fixed
//     for the user settings scope, where hardcoding ~/.claude meant the app read a file no
//     session was using.
//
// READ ONLY, always: Claudette never creates or writes this file. Token refresh is the CLI's
// job, and an isolated run finding no file is the correct, quiet outcome — not an error.
function credentialsPath(): string {
  const isolated = process.env.CLAUDETTE_DATA_DIR?.trim()
  if (isolated) return join(isolated, '.credentials.json')
  return join(claudeConfigDir(), '.credentials.json')
}

// Re-read the creds file every call so a token the CLI just refreshed is picked up
// (we do NOT refresh it ourselves — that's the CLI's job). Null ⇒ not logged in via
// OAuth (e.g. an API-key install), so there's simply no quota meter to show.
async function accessToken(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(), 'utf8')) as { claudeAiOauth?: { accessToken?: unknown } }
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

// Test seam, matching resetConnectorCache / resetSandboxDefaultsCache. Without it the
// module-level throttle makes this file untestable in the only way that matters: after a
// single call, MIN_REFETCH_MS makes every later call return the stale value for 20 seconds,
// so a harness cannot check two cases in one process — and "does it reach the network?"
// needs at least two (isolated: no; with a planted token: yes).
export function resetUsageCache(): void {
  cache = null
  lastAttempt = 0
}

export function registerUsageRoutes(app: FastifyInstance): void {
  // Empty windows (not an error) when there's no OAuth token or the endpoint is
  // unreachable — the client just shows no quota chip rather than an error state.
  app.get('/api/usage', async (): Promise<UsageResponse> =>
    (await fetchUsage()) ?? { windows: [], fetchedAt: Date.now() })
}
