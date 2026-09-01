// Unauthenticated control-plane bypass: the auth hook prefix-matches the RAW url while
// Fastify's router percent-DECODES the path before matching, so one encoded character
// walks between the gate and the route. Fails against current source, passes once
// scratchpad/auth-path-bypass.patch is applied.
//
// Asserts on a SET of encodings, not one literal, so a future variant is caught too.
import Fastify from 'fastify'
import { makeAuthHook, type Auth } from '../server/src/auth.ts'
import { registerFsRoutes } from '../server/src/fs/fsApi.ts'

const auth: Auth = { required: true, token: 'SECRET-TOKEN' }
import { withMarks, failed as bad } from './assert.mjs'
const check = withMarks({ sep: '  — ' })

const app = Fastify()
app.addHook('preHandler', makeAuthHook(auth))
app.get('/api/session/list', async () => ({ sessions: ['REAL DATA'] }))
app.post('/api/session/setSandbox', async (req) => ({ ok: true, got: req.body }))
app.get('/api/health', async () => ({ ok: true }))
app.all('/jupyter/*', async () => ({ jupyter: 'reachable' }))
app.get('/assets/app.js', async () => 'console.log(1)')   // stands in for a static asset
registerFsRoutes(app)                                      // brings its own Sec-Fetch hook
await app.ready()

const hit = (url: string, opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  app.inject({ method: (opts.method ?? 'GET') as 'GET', url, payload: opts.body as object, headers: opts.headers })

// ── the gate must hold across every spelling of "/api/…" the router will accept ────────
// NB the exploitable class is NARROWER than it first looks, and knowing that is what
// stops someone writing a weaker fix: ONLY the `/api/` prefix itself has to be encoded.
// Encode a LATER segment and the raw string still begins with `/api/`, so the old hook
// matched and returned 401 unaided — `/api/%73ession/list` was never a bypass. A fix that
// only sanitised later segments, or that special-cased a couple of literals, would look
// like it worked against a naive test set and leave the actual hole wide open. Hence:
// assert on the SET, and keep both the exploitable and the never-vulnerable spellings in
// it so a regression in either direction shows up.
const ENCODINGS = [
  '/api/session/list',            // baseline — must already be 401
  '/%61pi/session/list',          // 'a'      ← was a bypass
  '/a%70i/session/list',          // 'p'      ← was a bypass
  '/ap%69/session/list',          // 'i'      ← was a bypass
  '/%61%70%69/session/list',      // all three ← was a bypass
  '/api/%73ession/list',          // a LATER segment — already 401 before the fix (see above)
]
console.log('unauthenticated GETs:')
for (const u of ENCODINGS) {
  const r = await hit(u)
  const gated = r.statusCode === 401
  console.log(`   ${String(r.statusCode).padEnd(4)} ${u}`)
  check(`gated: ${u}`, gated, gated ? '401' : `LEAKED ${r.body.slice(0, 40)}`)
}

// The one that actually disables confinement.
const post = await hit('/%61pi/session/setSandbox', {
  method: 'POST', body: { id: 'x', sandbox: { enabled: false, mounts: [] } },
  headers: { 'content-type': 'application/json' },
})
check('gated: encoded POST /api/session/setSandbox', post.statusCode === 401, post.statusCode === 401 ? '401' : `ACCEPTED (${post.statusCode}) — confinement disablable unauthenticated`)

// The Jupyter reverse-proxy grants kernel access, so it is gated by the same rule and
// must survive the same encodings.
for (const u of ['/jupyter/api/kernels', '/%6aupyter/api/kernels', '/j%75pyter/api/kernels']) {
  const r = await hit(u)
  check(`gated: ${u}`, r.statusCode === 401, r.statusCode === 401 ? '401' : `LEAKED (${r.statusCode})`)
}

// ── …while everything deliberately public STAYS public ────────────────────────────────
for (const [u, want] of [['/api/health', 200], ['/assets/app.js', 200]] as const) {
  const r = await hit(u)
  check(`still open: ${u}`, r.statusCode === want, `${r.statusCode}`)
}
const authed = await hit('/%61pi/session/list', { headers: { authorization: 'Bearer SECRET-TOKEN' } })
check('an AUTHENTICATED encoded request still works', authed.statusCode === 200, `${authed.statusCode}`)

// A malformed escape must not throw inside the hook — an uncaught throw in a preHandler
// is a 500 on every request, including static assets.
const malformed = await hit('/%')
check('malformed escape does not 500', malformed.statusCode !== 500, `${malformed.statusCode}`)

// ── (b) fsApi's Sec-Fetch CSRF guard uses the same raw-url prefix ──────────────────────
const csrf = await hit('/%61pi/fs/list?path=/tmp', {
  headers: { 'sec-fetch-site': 'cross-site', authorization: 'Bearer SECRET-TOKEN' },
})
check('(b) fsApi Sec-Fetch guard survives encoding', csrf.statusCode === 403, csrf.statusCode === 403 ? '403' : `cross-site request allowed through (${csrf.statusCode})`)

await app.close()
console.log(`\n${bad === 0 ? 'all checks passed' : `${bad} check(s) failed`}`)
process.exitCode = bad === 0 ? 0 : 2
