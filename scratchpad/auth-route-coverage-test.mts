// scratchpad/auth-route-coverage-test.mts
//
// Every gated route, unauthenticated, must 401 — including under percent-encodings of
// the guard prefix itself.
//
// WHY THIS EXISTS: makeAuthHook decides what to gate by prefix-matching the RAW url
// (auth.ts:144-148) while Fastify's router percent-DECODES before matching. So
// `/%61pi/session/list` did not start with '/api/' as far as the hook could see, was
// waved through unauthenticated, and was then routed to the real handler — and
// `POST /%61pi/session/setSandbox {"enabled":false}` was accepted with its body parsed.
//
// Five design choices worth keeping if this file is ever edited:
//
//  1. It enumerates Fastify's OWN route table (the `onRoute` hook) instead of a
//     hand-written list, so a route added later is covered without anyone remembering
//     to come back here. A hand-written list would have to be maintained by the same
//     person who forgot to gate the route.
//  2. It mirrors index.ts's COMPOSITION ORDER: the auth hook is added BEFORE the routes
//     (index.ts:53 vs :248-254), which is what puts every route inside its scope.
//     REVERSING THIS MAKES THE ENTIRE FILE PASS VACUOUSLY — the hook would not apply to
//     routes already registered, every probe would sail through, and the sweep would
//     report all-clear over a completely ungated server. Do not "tidy" the order.
//  3. Evasions are GENERATED from the guard prefix rather than listed as literals, and
//     include upper-case hex (RFC 3986 allows %2F as well as %2f). Only characters
//     INSIDE the prefix can evade: `/api/%73ession/list` is still gated because the raw
//     string already begins with '/api/'. That case is pinned as a negative control —
//     without it the sweep could "pass" by flagging everything.
//  4. The assertion asymmetry is deliberate. BASELINE (the exact registered url) must be
//     exactly 401 and does NOT accept 404, because a 404 there means the enumeration is
//     wrong rather than the route being safe. EVASIONS accept 401 or 404, since 404
//     means the router never matched anything. Collapsing these two into one rule guts
//     the file.
//  5. It SELF-CHECKS. Generating evasions still would not catch this harness going
//     BLIND — most plausibly because app.inject() normalizes a URL differently from a
//     real socket, in which case the sweep reports all-clear over an open hole. So
//     section 2 rebuilds the known-vulnerable hook and FAILS THE RUN if the sweep
//     detects zero bypasses. This is the "no check may pass for the wrong reason"
//     invariant turned on the test itself, and it generalises past this file: every
//     instance of a check silently passing for the wrong reason found on this project
//     so far was caught by a person noticing, not by the harness. This one is caught
//     mechanically.
//
// Run against an UNPATCHED hook and the sweep really does reach handlers; the stubs
// make that harmless. It builds its own app and never touches a live server.
//
//   npx tsx scratchpad/auth-route-coverage-test.mts
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import { makeAuthHook, isAuthed, type Auth } from '../server/src/auth'
import { registerSessionRoutes } from '../server/src/session/sessionApi'
import { registerNotebookRoutes } from '../server/src/notebook/notebookApi'
import { registerPaneRoutes } from '../server/src/pane/paneApi'
import { registerFsRoutes } from '../server/src/fs/fsApi'
import { registerGitRoutes } from '../server/src/git/gitApi'
import { registerConnectorRoutes } from '../server/src/connectors/connectorApi'
import { registerUsageRoutes } from '../server/src/usage/usageApi'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

// Constructed directly rather than via resolveAuth(), which touches ~/.config and can
// exit the process. The token is never presented, so every probe below is unauthenticated
// unless it explicitly sends the header.
const AUTH: Auth = { required: true, token: 'test-token-not-presented' }

// Registration never INVOKES these — every handler sits behind the gate under test, and
// the one authenticated probe below deliberately uses a dependency-free route. So a bare
// cast is honest here rather than hidden behind a fake object that implies more.
const stub = <T>(): T => ({} as T)

function buildApp(hook: (req: FastifyRequest, reply: FastifyReply) => Promise<void>): {
  app: FastifyInstance
  routes: Array<{ method: string; url: string }>
} {
  const app = Fastify({ logger: false })
  const routes: Array<{ method: string; url: string }> = []
  const seen = new Set<string>()
  app.addHook('onRoute', (r) => {
    for (const m of (Array.isArray(r.method) ? r.method : [r.method])) {
      const k = `${m} ${r.url}`
      if (!seen.has(k)) { seen.add(k); routes.push({ method: String(m), url: r.url }) }
    }
  })
  // MUST come before the routes — see design note 2 in the header.
  app.addHook('preHandler', hook)
  // The two OPEN routes, mirroring index.ts:214 (health) and :235 (auth). They live in
  // index.ts rather than a register*Routes function, so without these the open-set filter
  // below would be testing nothing and the /api/health positive control would 404.
  app.get('/api/health', async () => ({ ok: true }))
  app.get('/api/auth', async () => ({ ok: true, required: true }))
  registerSessionRoutes(app, stub())
  registerNotebookRoutes(app, stub(), stub())
  registerPaneRoutes(app, stub())
  registerFsRoutes(app)
  registerGitRoutes(app)
  registerConnectorRoutes(app, stub())
  registerUsageRoutes(app)
  // index.ts:259 registers this directly rather than via a register*Routes function, so
  // it is re-declared here. See the LIMITATION note at the bottom of this file.
  app.all('/jupyter/*', async () => ({ proxied: true }))
  return { app, routes }
}

// The guard prefixes makeAuthHook tests (auth.ts:147).
const GUARDS = ['/api/', '/jupyter/']

function evasions(url: string): string[] {
  const p = GUARDS.find((g) => url.startsWith(g))
  if (!p) return []
  const out = new Set<string>()
  for (let i = 1; i < p.length; i++) {
    const code = p.charCodeAt(i).toString(16).padStart(2, '0')
    out.add(p.slice(0, i) + '%' + code + p.slice(i + 1) + url.slice(p.length))
    out.add(p.slice(0, i) + '%' + code.toUpperCase() + p.slice(i + 1) + url.slice(p.length))
  }
  return [...out]
}

// A same-origin browser fetch minus the auth cookie. sec-fetch-site satisfies the
// /api/fs/* onRequest CSRF guard (fsApi.ts:106) so that AUTH is the deciding gate there
// — otherwise a 403 would mask what we are measuring. The JSON body matters too: Fastify
// parses the body BEFORE preHandler (which is exactly why the real bypass got its body
// parsed), so a bodyless POST would 400 ahead of the gate and hide the result.
async function probe(app: FastifyInstance, method: string, url: string): Promise<number> {
  const hasBody = method !== 'GET' && method !== 'HEAD'
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { 'sec-fetch-site': 'same-origin', ...(hasBody ? { 'content-type': 'application/json' } : {}) },
    ...(hasBody ? { payload: '{}' } : {}),
  })
  return res.statusCode
}

// --- 1. the real hook --------------------------------------------------------
{
  const { app, routes } = buildApp(makeAuthHook(AUTH))
  await app.ready()

  const OPEN = new Set(['/api/health', '/api/auth'])
  const gated = routes.filter((r) => !OPEN.has(r.url))
  // No silent caps: say what was probed oddly rather than quietly covering less.
  const parametric = gated.filter((r) => r.url.includes(':'))
  if (parametric.length) {
    console.log(`   (note: ${parametric.length} parametric route(s) probed with the literal pattern: ${parametric.map((r) => r.url).join(', ')})`)
  }
  console.log(`   sweeping ${gated.length} gated route(s) from Fastify's own table\n`)
  check('route table is non-empty (enumeration works at all)', gated.length > 10, `${gated.length} routes`)

  const baselineBad: string[] = []
  for (const r of gated) {
    const s = await probe(app, r.method, r.url)
    if (s !== 401) baselineBad.push(`${r.method} ${r.url} -> ${s}`)
  }
  check('every gated route 401s unauthenticated', baselineBad.length === 0, baselineBad.slice(0, 6).join('; '))

  const bypasses: string[] = []
  for (const r of gated) {
    for (const url of evasions(r.url)) {
      const s = await probe(app, r.method, url)
      if (s !== 401 && s !== 404) bypasses.push(`${r.method} ${url} -> ${s}`)
    }
  }
  check('no percent-encoding of the guard prefix reaches a handler', bypasses.length === 0,
    bypasses.slice(0, 6).join('; ') + (bypasses.length > 6 ? ` (+${bypasses.length - 6} more)` : ''))

  // NEGATIVE CONTROL — see design note 3.
  const after = await probe(app, 'GET', '/api/%73ession/list')
  check('encoding AFTER the guard prefix is still gated (proves we are not over-flagging)', after === 401, `status ${after}`)

  // POSITIVE CONTROLS, on dependency-free routes only, so no stub is ever exercised.
  const health = await probe(app, 'GET', '/api/health')
  check('/api/health is reachable unauthenticated (open set intact)', health !== 401, `status ${health}`)
  const authed = await app.inject({
    method: 'GET',
    url: '/api/agents',
    headers: { 'sec-fetch-site': 'same-origin', authorization: `Bearer ${AUTH.token}` },
  })
  check('an AUTHENTICATED request is not gated', authed.statusCode === 200, `status ${authed.statusCode}`)

  await app.close()
}

// --- 2. self-check: prove the harness can actually detect the bug ------------
// A verbatim rebuild of the pre-fix hook (auth.ts:137-153, before the decode fix). If the
// sweep above ever stops being able to see this, it has gone blind and everything it
// reported is worthless — so that outcome is a FAILURE, not a pass.
{
  const vulnerableHook = (auth: Auth) => {
    const open = new Set(['/api/health', '/api/auth'])
    return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (!auth.required) return
      const urlPath = req.url.split('?')[0]          // <- the bug: the RAW url
      if (!urlPath.startsWith('/api/') && !urlPath.startsWith('/jupyter/')) return
      if (open.has(urlPath)) return
      if (!isAuthed(req.raw, auth)) {
        await reply.code(401).send({ error: 'unauthorized' })
      }
    }
  }
  const app = Fastify({ logger: false })
  app.addHook('preHandler', vulnerableHook(AUTH))
  // One stub route, not the whole sweep: a detected bypass here reaches a handler, and we
  // want that handler to be inert rather than a real git/fs/network call.
  app.get('/api/session/list', async () => ({ sessions: ['REAL DATA — THIS SHOULD NOT BE REACHABLE'] }))
  await app.ready()

  const leaked: string[] = []
  for (const url of evasions('/api/session/list')) {
    const s = await probe(app, 'GET', url)
    if (s !== 401 && s !== 404) leaked.push(`${url} -> ${s}`)
  }
  check('SELF-CHECK: the harness detects the known-vulnerable hook', leaked.length > 0,
    leaked.length
      ? leaked.join('; ')
      : 'HARNESS IS BLIND — inject() is normalizing the evasion away; this whole file proves nothing')
  await app.close()
}

// LIMITATION, stated rather than hidden: this MIRRORS index.ts's composition instead of
// importing it, because index.ts has top-level side effects (it listens, restores
// sessions, starts the MCP server). So a route registered DIRECTLY in index.ts — as
// /jupyter/* is at :259, and as /api/health and /api/auth are at :214 and :235 — is not
// caught automatically and has to be re-declared above. Extracting a side-effect-free
// buildApp() from index.ts would close that gap and is the natural follow-up to C1's
// interface change (tracked as C1b).
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
