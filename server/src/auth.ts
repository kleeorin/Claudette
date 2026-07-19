import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { IncomingMessage } from 'http'
import type { FastifyRequest, FastifyReply } from 'fastify'

// Access control for the app server. Two rules keep it safe-by-default:
//
//   • A token is ALWAYS required — even on a loopback bind. "Local-only" is not
//     a boundary here: session sandboxes share the host network (SANDBOX.md
//     "Control-plane escape"), so an in-box process can reach 127.0.0.1:<PORT>.
//     Without CLAUDETTE_TOKEN set, a loopback server loads (or generates) a
//     persistent token from ~/.config/claudette/token — the same file
//     rc_launch.sh uses, deliberately OUTSIDE every sandbox mount. Explicit
//     opt-out for tests/dev: CLAUDETTE_NO_AUTH=1 (honored on loopback only).
//   • Any non-loopback bind      → CLAUDETTE_TOKEN is REQUIRED. `resolveAuth`
//     refuses to start without it, so you can't accidentally expose an
//     unauthenticated server to a LAN / tunnel / Tailnet (and a stale
//     auto-generated file token can't silently guard a public bind).
//
// The token travels as an httpOnly, SameSite=Lax cookie: delivered once via
// `/api/auth?token=…`, then sent automatically on every HTTP request AND the
// same-origin WebSocket upgrade — so the phone/PWA stays authenticated with no
// per-request handling. `Authorization: Bearer <token>` and `?token=` are also
// accepted (for the bootstrap call and programmatic clients).

export const COOKIE = 'claudette_auth'

export interface Auth {
  required: boolean
  token: string | null
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1'
}

// Where the loopback token persists: ~/.config/claudette/token (same file
// rc_launch.sh manages). ~/.config is never bind-mounted into a session sandbox,
// so the box can't just read it. Stable across runs → devices stay logged in.
export function tokenFilePath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config')
  return path.join(base, 'claudette', 'token')
}

// Load the persisted token, or mint + persist a fresh one (0600, dir 0700).
function loadOrCreateToken(): string {
  const file = tokenFilePath()
  try {
    const t = fs.readFileSync(file, 'utf8').trim()
    if (t) return t
  } catch { /* missing/unreadable → create below */ }
  const t = crypto.randomBytes(16).toString('hex')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, t, { mode: 0o600 })
  return t
}

// Decide the auth posture from HOST + CLAUDETTE_TOKEN. Exits the process with a
// clear message if a non-loopback bind is requested without a token — failing
// closed is the whole point.
export function resolveAuth(host: string, envToken: string | undefined): Auth {
  const token = envToken && envToken.trim() ? envToken.trim() : null
  if (isLoopback(host)) {
    if (token) return { required: true, token }
    // Explicit, greppable opt-out (tests / a conscious "this box is airgapped").
    // Loopback only — a non-loopback bind below still fails closed.
    if (process.env.CLAUDETTE_NO_AUTH === '1') return { required: false, token: null }
    // No env token: fall back to the persistent file token (created on first
    // run). Loopback is NOT trusted — sandboxed sessions share this network.
    return { required: true, token: loadOrCreateToken() }
  }
  // Exposed beyond loopback → a token is mandatory.
  if (!token) {
    // eslint-disable-next-line no-console
    console.error(
      `\n✖ Refusing to start: HOST=${host} exposes the server beyond loopback, but no CLAUDETTE_TOKEN is set.\n` +
      `  Set a strong secret and retry, e.g.:\n` +
      `    CLAUDETTE_TOKEN=$(openssl rand -hex 24) HOST=${host} ./launch.sh\n` +
      `  Then open the app once with ?token=<that value> to authenticate this device.\n`,
    )
    process.exit(1)
  }
  return { required: true, token }
}

// Generate a token suggestion (used only to print a hint; not auto-applied).
export function suggestToken(): string {
  return crypto.randomBytes(24).toString('hex')
}

// Parse a Cookie header into a map (no dependency; the WS upgrade path only has
// the raw request).
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

// Constant-time compare so a wrong token can't be timed out character by character.
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

// Pull a presented token from a raw request: cookie, Bearer header, or ?token=.
function presentedToken(req: IncomingMessage): string | null {
  const cookies = parseCookies(req.headers.cookie)
  if (cookies[COOKIE]) return cookies[COOKIE]
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  try {
    const url = new URL(req.url ?? '', 'http://localhost')
    const q = url.searchParams.get('token')
    if (q) return q
  } catch { /* malformed url */ }
  return null
}

// Does a raw request carry a valid token? Used for the WS upgrade check.
export function isAuthed(req: IncomingMessage, auth: Auth): boolean {
  if (!auth.required || !auth.token) return true
  const t = presentedToken(req)
  return t != null && safeEqual(t, auth.token)
}

// Fastify preHandler: gate the sensitive surface — the data/control API. Static
// assets (the SPA bundle, manifest, icons) stay open so the app shell can load
// and render the token-entry screen; they hold no secrets. `/api/health` and the
// `/api/auth` bootstrap are also open. The WebSocket is gated separately at the
// upgrade (see index.ts). Returns 401 for anything unauthenticated.
export function makeAuthHook(auth: Auth) {
  const open = new Set(['/api/health', '/api/auth'])
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!auth.required) return
    const path = req.url.split('?')[0]
    // Gate the data/control API and the Jupyter reverse-proxy (it grants kernel
    // access); everything else (static assets / SPA shell) stays open.
    if (!path.startsWith('/api/') && !path.startsWith('/jupyter/')) return
    if (open.has(path)) return
    if (!isAuthed(req.raw, auth)) {
      await reply.code(401).send({ error: 'unauthorized' })
    }
  }
}

// Build the Set-Cookie value for a validated token.
export function authCookie(token: string): string {
  // 400 days ≈ the max most browsers honor; httpOnly blocks JS/XSS from reading
  // it; Lax lets it ride top-level navigations (the ?token= link) but not
  // cross-site requests. Secure is added by the caller when the origin is https.
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000`
}
