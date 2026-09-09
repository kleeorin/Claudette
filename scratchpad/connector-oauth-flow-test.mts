// The interactive connector OAuth flow: authorize, callback, refresh, and the bearer attach.
//
// Drives the REAL modules against a REAL local provider that speaks enough OAuth to be
// convincing and records what it was sent. Nothing reaches the internet: the "provider" is an
// http server on 127.0.0.1 and the connector's own upstream is another one.
//
// NO REAL CREDENTIAL APPEARS ANYWHERE. Every token is an obvious fake, and assertion messages
// fingerprint rather than echo — the failing assertions here are precisely the ones about
// mishandled credentials, so a naive message would print the secret in the run that proves the
// bug (the pattern from usage-isolation-test.mts).

import http from 'http'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { check, failed as fail } from './assert.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'claudette-oauthflow-'))
process.env.CLAUDETTE_DATA_DIR = dir

// --- a fake provider ----------------------------------------------------------------------
interface TokenReq { grant_type: string; code_verifier?: string; refresh_token?: string; client_secret?: string; redirect_uri?: string }
const tokenReqs: TokenReq[] = []
let issued = 0
let refreshDelayMs = 0
// Set when the provider decides a refresh should fail (to test the "dial unauthenticated" path).
let refuseRefresh = false

const provider = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', async () => {
    const form = Object.fromEntries(new URLSearchParams(body)) as unknown as TokenReq
    tokenReqs.push(form)
    if (form.grant_type === 'refresh_token' && refreshDelayMs) {
      await new Promise((r) => setTimeout(r, refreshDelayMs))
    }
    if (form.grant_type === 'refresh_token' && refuseRefresh) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))
      return
    }
    issued++
    // An id_token whose payload names the account. Unsigned on purpose — the code treats it as a
    // LABEL, never as an authentication decision, and this test pins that it is read that way.
    const claims = Buffer.from(JSON.stringify({ email: 'operator@example.com' })).toString('base64url')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      access_token: `fake-access-${issued}`,
      // A REFRESH response omits refresh_token — the shape that makes omit-means-keep matter.
      ...(form.grant_type === 'authorization_code' ? { refresh_token: 'fake-refresh-1' } : {}),
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/calendar',
      id_token: `x.${claims}.y`,
    }))
  })
})
await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r))
const providerPort = (provider.address() as AddressInfo).port

// --- the connector's own upstream, which records the Authorization it received -------------
const upstreamSaw: (string | null)[] = []
const upstream = http.createServer((req, res) => {
  upstreamSaw.push((req.headers.authorization as string) ?? null)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
const upstreamPort = (upstream.address() as AddressInfo).port

writeFileSync(path.join(dir, 'connectors.json'), JSON.stringify({
  connectors: [{
    id: 'testcal', name: 'Test Calendar', transport: 'http',
    url: `http://127.0.0.1:${upstreamPort}/mcp/v1`,
    oauthClientRef: 'cli', requiresOAuthClient: true,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  }],
  oauthClients: [{
    id: 'cli', name: 'Fake', clientId: 'fake-client-id', clientSecret: 'fake-client-secret',
    provider: 'custom',
    authorizeUrl: `http://127.0.0.1:${providerPort}/authorize`,
    tokenUrl: `http://127.0.0.1:${providerPort}/token`,
  }],
  accountConnectors: [], strict: false, builtinOverrides: {},
}))

const oauth = await import('../server/src/connectors/connectorOAuth.js')
const creds = await import('../server/src/connectors/connectorCreds.js')
const { ConnectorProxy } = await import('../server/src/connectors/connectorProxy.js')

const fpToken = (v: string | null | undefined): string => {
  if (!v) return String(v)
  const m = /^Bearer fake-access-(\d+)$/.exec(v)
  if (m) return `Bearer <fake-access-${m[1]}>`
  return `<redacted sha256:${createHash('sha256').update(v).digest('hex').slice(0, 8)}>`
}

const proxy = new ConnectorProxy(() => true)
const proxyPort = await proxy.start()
const routeUrl = proxy.urlFor('s1', 'testcal')
const call = (): Promise<void> => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: proxyPort, path: `/c/${routeUrl.split('/c/')[1]}`,
    method: 'POST', headers: { 'content-type': 'application/json' } },
  (res) => { res.resume(); res.on('end', () => resolve()) })
  req.on('error', () => resolve())
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }))
})

try {
  // --- BEFORE AUTHORIZATION: dial unauthenticated, do not invent a bearer -----------------
  upstreamSaw.length = 0
  await call()
  check('before any authorization the upstream receives NO bearer',
    upstreamSaw.length === 1 && upstreamSaw[0] === null,
    `upstream saw ${fpToken(upstreamSaw[0])} — a made-up credential masks the provider's own challenge`)

  // --- START: PKCE S256 + a state we did not choose ---------------------------------------
  // startAuthorization became async when DCR landed: it may now walk discovery and register
  // before it can build the URL.
  const started = await oauth.startAuthorization('testcal')
  check('starting an authorization succeeds', started.ok === true, JSON.stringify(started))
  if (!started.ok) throw new Error('cannot continue')
  const u = new URL(started.url)
  check('the authorize URL uses PKCE with S256, never `plain`',
    u.searchParams.get('code_challenge_method') === 'S256' && !!u.searchParams.get('code_challenge'),
    `method=${u.searchParams.get('code_challenge_method')}`)
  check('the code_challenge is a HASH, not the verifier itself',
    (u.searchParams.get('code_challenge')?.length ?? 0) >= 43
      && u.searchParams.get('code_challenge') !== u.searchParams.get('code_verifier'),
    'sending the verifier as the challenge would defeat PKCE entirely')
  check('it requests exactly the connector\'s declared scope, not a wildcard',
    u.searchParams.get('scope') === 'https://www.googleapis.com/auth/calendar',
    `scope=${u.searchParams.get('scope')}`)
  check('and the redirect_uri points at the MAIN app callback, which is auth-gated',
    u.searchParams.get('redirect_uri')?.endsWith('/api/connectors/oauth/callback') === true,
    u.searchParams.get('redirect_uri') ?? 'none')
  const state = u.searchParams.get('state') ?? ''
  check('a state parameter is present and long enough to be unguessable',
    state.length >= 32, `state length ${state.length}`)

  // --- CSRF: a callback with a state we never issued is refused ----------------------------
  // MUTATION THAT TURNS THIS RED: accept the callback without looking `state` up.
  const forged = await oauth.completeAuthorization('a-state-nobody-issued', 'some-code')
  check('a callback carrying an unknown state is REFUSED — the CSRF guard',
    forged.ok === false,
    `${JSON.stringify(forged)} — without this, any page could complete an authorization into our store`)
  check('and the forged callback exchanged nothing with the provider',
    tokenReqs.length === 0, `${tokenReqs.length} token request(s) were made for a forged state`)

  // --- COMPLETE ----------------------------------------------------------------------------
  const done = await oauth.completeAuthorization(state, 'the-auth-code')
  check('the real callback completes', done.ok === true, JSON.stringify(done))
  check('and the verifier was sent to the token endpoint, completing PKCE',
    !!tokenReqs[0]?.code_verifier, 'no code_verifier reached the provider')
  check('the verifier matches the challenge that was advertised',
    createHash('sha256').update(tokenReqs[0].code_verifier as string).digest('base64url')
      === u.searchParams.get('code_challenge'),
    'the exchanged verifier must hash to the advertised challenge')
  check('the account is taken from the id_token, so a second person is a separate grant',
    creds.accountsFor('testcal').join() === 'operator@example.com',
    JSON.stringify(creds.accountsFor('testcal')))

  // --- SINGLE USE: the same state cannot be replayed ---------------------------------------
  // MUTATION THAT TURNS THIS RED: delete the pending entry AFTER the exchange instead of before.
  const replay = await oauth.completeAuthorization(state, 'the-auth-code')
  check('the same state cannot be replayed — it is single-use',
    replay.ok === false, JSON.stringify(replay))

  // --- THE BEARER REACHES THE UPSTREAM -----------------------------------------------------
  upstreamSaw.length = 0
  await call()
  check('after authorization the proxy attaches the operator\'s bearer',
    upstreamSaw.length === 1 && upstreamSaw[0] === 'Bearer fake-access-1',
    `upstream saw ${fpToken(upstreamSaw[0])}`)

  // --- SINGLE-FLIGHT REFRESH ---------------------------------------------------------------
  // Google ROTATES refresh tokens: two concurrent refreshes each POST the same one, and the
  // second exchange invalidates what the first just stored — leaving a connector that fails
  // until a human re-authorizes.
  // MUTATION THAT TURNS THIS RED: drop the inFlight map from accessTokenFor.
  const stored = creds.getToken('testcal', 'operator@example.com')
  creds.saveToken({ ...stored!, expiresAt: Date.now() - 1000 })   // force it stale
  tokenReqs.length = 0
  refreshDelayMs = 60
  const many = await Promise.all([1, 2, 3, 4, 5].map(() => oauth.accessTokenFor('testcal', 'operator@example.com')))
  refreshDelayMs = 0
  const refreshes = tokenReqs.filter((t) => t.grant_type === 'refresh_token').length
  check('five concurrent callers trigger exactly ONE refresh, not five',
    refreshes === 1,
    `${refreshes} refresh exchanges — each extra one invalidates the token the previous stored`)
  check('and every concurrent caller gets the same fresh token',
    new Set(many).size === 1 && typeof many[0] === 'string',
    `${new Set(many.map((m) => fpToken(m))).size} distinct results: ${JSON.stringify([...new Set(many.map((m) => fpToken(m)))])}`)

  // --- OMIT-MEANS-KEEP, end to end ---------------------------------------------------------
  // The refresh response above omitted refresh_token. If that erased the stored one, the NEXT
  // expiry has nothing to renew with and the connector silently needs a human.
  check('the refresh did not erase the long-lived refresh token',
    creds.getToken('testcal', 'operator@example.com')?.refreshToken === 'fake-refresh-1',
    'omit-means-keep must survive the real refresh path, not just a unit call')

  // --- A DEAD GRANT DIALS UNAUTHENTICATED, IT DOES NOT SEND A BROKEN BEARER -----------------
  // So the provider's own challenge (WWW-Authenticate is not stripped from responses) reaches
  // the client, instead of being masked by a credential we already knew was dead.
  refuseRefresh = true
  const dead = creds.getToken('testcal', 'operator@example.com')
  creds.saveToken({ ...dead!, expiresAt: Date.now() - 1000 })
  upstreamSaw.length = 0
  await call()
  check('when the refresh is refused the proxy dials WITHOUT a bearer rather than with a dead one',
    upstreamSaw.length === 1 && upstreamSaw[0] === null,
    `upstream saw ${fpToken(upstreamSaw[0])} — a known-dead bearer produces a 401 that reads as a server fault`)
  refuseRefresh = false

  // --- TWO ACCOUNTS: REFUSE TO GUESS -------------------------------------------------------
  // The (connector, account) keying exists so a second person's authorization cannot silently
  // stand in for the first's. That guarantee is only real if the DIAL side honours it: picking
  // "the first" or "the newest" would have Claudette act as one person while the operator
  // believes it is acting as another, with no visible difference — the very failure the keying
  // was introduced to prevent, delivered by the code that consumes it.
  // This gap was invisible until the flow ran end to end: the token is keyed by the real account
  // while the proxy knew only a connector id, so the lookup missed entirely.
  // MUTATION THAT TURNS THIS RED: in resolveAccount, `return all[0]` instead of refusing.
  const one = creds.getToken('testcal', 'operator@example.com')!
  creds.saveToken({ ...one, account: 'someone-else@example.com', expiresAt: Date.now() + 3_600_000 })
  creds.saveToken({ ...one, expiresAt: Date.now() + 3_600_000 })
  check('with two authorized accounts and no choice made, NO token is attached',
    (await oauth.accessTokenFor('testcal')) === null,
    'guessing an account acts as one person while looking like another')
  upstreamSaw.length = 0
  await call()
  check('and the proxy dials unauthenticated rather than as an arbitrary user',
    upstreamSaw.length === 1 && upstreamSaw[0] === null,
    `upstream saw ${fpToken(upstreamSaw[0])}`)
  check('but naming the account explicitly still works — the refusal is about GUESSING',
    typeof (await oauth.accessTokenFor('testcal', 'operator@example.com')) === 'string',
    'an explicit choice must not be blocked by the ambiguity guard')

  // --- THE BUILT-IN SCOPES, AND THE OVER-GRANT THEY MUST NOT COMMIT ------------------------
  // Verified 2026-09 against each endpoint's RFC 9728 metadata. Two were originally wrong from
  // the API-name pattern and would have consented cleanly then failed at call time.
  const { BUILTIN_SCOPES, scopesFor } = await import('../server/src/connectors/oauthProviders.js')
  // MUTATION THAT TURNS THIS RED: drop the Drive scope from gdocs or gsheets.
  check('gdocs and gsheets ask for a DRIVE scope alongside their own — they are not standalone',
    BUILTIN_SCOPES.gdocs.includes('https://www.googleapis.com/auth/drive')
      && BUILTIN_SCOPES.gsheets.includes('https://www.googleapis.com/auth/drive'),
    `gdocs=${BUILTIN_SCOPES.gdocs.join(' ')} gsheets=${BUILTIN_SCOPES.gsheets.join(' ')} — `
      + 'without Drive these consent cleanly and then fail on file access')
  // The scope that makes the whole per-connector decision matter. `https://mail.google.com/` is
  // unrestricted mailbox access, including permanent deletion; it is on Gmail's advertised MENU
  // but must never be what we ORDER. Asking for the advertised union would put that consent
  // screen in front of someone connecting their calendar.
  // MUTATION THAT TURNS THIS RED: set gmail's scopes to the advertised list.
  const all = Object.values(BUILTIN_SCOPES).flat()
  check('NO built-in asks for https://mail.google.com/ — unrestricted mailbox access',
    !all.includes('https://mail.google.com/'),
    `asked scopes include ${all.filter((x) => x.includes('mail.google.com')).join()}`)
  check('and gmail asks for the narrower gmail.modify instead',
    BUILTIN_SCOPES.gmail.join() === 'https://www.googleapis.com/auth/gmail.modify',
    BUILTIN_SCOPES.gmail.join())
  // Per-connector, not a union: connecting the calendar must not drag in Drive or Gmail.
  // MUTATION THAT TURNS THIS RED: make scopesFor return the union of every built-in.
  // Asserted through scopesFor(), the function that actually DECIDES, not the constant it
  // reads. Phrased against BUILTIN_SCOPES this stayed green under the union mutation — the
  // mutation changes the function, and the constant it inspects is untouched. Same shape as the
  // other vacuous-assertion traps today: the assertion must sit on the value the caller receives.
  check('a calendar authorization requests ONLY calendar scopes, never the union',
    scopesFor('gcalendar').length > 0 && scopesFor('gcalendar').every((x) => x.includes('/auth/calendar')),
    `scopesFor(gcalendar) = ${scopesFor('gcalendar').join(' ')} — connecting a calendar must not drag in Drive or Gmail`)
} finally {
  proxy.stop()
  provider.close()
  upstream.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CLAUDETTE_DATA_DIR
}

process.exit(fail === 0 ? 0 : 1)
