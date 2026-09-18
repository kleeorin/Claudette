// The HTTP client's FAILURE handling — specifically, that a failed request presents as a
// failure rather than as a success carrying the wrong shape.
//
// ★ THE BUG THIS FILE EXISTS FOR, reported by the user: opening Settings showed
// "Cannot read properties of undefined (reading 'host')" and took the panel out entirely.
// The chain, each link of which is individually reasonable:
//   1. `/api/settings` has no route on the server (the UI was built ahead of the server half,
//      which client.ts says in a comment).
//   2. The server's /api 404 arm answers `{ error: 'not found' }` — VALID JSON.
//   3. `get()` did `return (await fetch(path)).json()` with no status check, so that body
//      resolved and was cast to AppSettingsResponse by the signature's `as T`.
//   4. SettingsPanel's `if (!data)` guard passed, because `{ error: 'not found' }` is truthy.
//   5. `environment.host` threw on undefined.
// The panel already had the correct behaviour written for a failed load — a "Could not load
// settings." message. It was unreachable, because step 3 meant the failure never threw.
//
// So these cases are about the CLASS, not the one endpoint: any non-2xx whose body happens to
// parse would do the same to any caller, and every `get` call site types a plain success shape.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { api, getHealth } from './client'

// Stand in for one fetch response. `text` and `json` both provided because the failure path
// reads text (to quote the server) and the success path reads json.
function reply(status: number, body: unknown) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(raw),
    text: async () => raw,
  } as unknown as Response
}

const mockFetch = (r: Response) => {
  const fn = vi.fn(async () => r)
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => { vi.unstubAllGlobals() })

describe('get() — a failed request must not arrive as a success', () => {
  it('REJECTS on the /api 404 body that caused the Settings crash', async () => {
    // Verbatim the shape server/src/index.ts's not-found arm sends for an /api path.
    mockFetch(reply(404, { error: 'not found' }))
    await expect(api.http.appSettings()).rejects.toThrow(/404/)
  })

  it('REJECTS on the auth 401 body, which is what a missing route looks like when auth is on', async () => {
    // The auth preHandler runs BEFORE route matching, so an unbuilt route and a bad token are
    // indistinguishable by status — both must reject, and for the same reason.
    mockFetch(reply(401, { ok: false, error: 'invalid token' }))
    await expect(api.http.appSettings()).rejects.toThrow(/401/)
  })

  it('quotes the server\'s own words in the error, for diagnosis', async () => {
    mockFetch(reply(500, { error: 'kaboom' }))
    await expect(getHealth()).rejects.toThrow(/kaboom/)
  })

  it('still rejects when the error body is unreadable, without masking the status', async () => {
    // An unparseable body must not turn a clean failure into a different, confusing one. The
    // status is the part that is always true, so it has to survive a broken body.
    const broken = {
      ok: false, status: 502,
      json: async () => { throw new Error('not json') },
      text: async () => { throw new Error('unreadable') },
    } as unknown as Response
    mockFetch(broken)
    await expect(getHealth()).rejects.toThrow(/502/)
  })

  it('resolves normally on a 2xx, so the guard has not broken the ordinary path', async () => {
    // The counterweight. A fix that rejected everything would also make every one of these
    // call sites "safe", and would be useless.
    const payload = { settings: {}, overrides: [], environment: { host: '127.0.0.1', port: 4319, dataDir: '/d', oauthRedirectUri: 'http://x/cb' } }
    mockFetch(reply(200, payload))
    await expect(api.http.appSettings()).resolves.toEqual(payload)
  })
})
