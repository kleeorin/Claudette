// Dynamic Client Registration (RFC 7591) — the path that lets a connector authorize with NO
// operator console step, and the reason Confluence can work at all.
//
// ITS OWN HARNESS, deliberately, because DCR is a second way to ACQUIRE a credential and it has a
// different trust model from the operator-configured path: a JSON document from a third party
// tells us where to register, we register, and we then present the result as our own identity.
// The interesting assertions are all about what happens when that document lies.
//
// Drives the REAL modules against a REAL local provider. No credential is real and none is
// printed; every registration is against 127.0.0.1.

import http from 'http'
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { check, failed as fail } from './assert.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'claudette-dcr-'))
process.env.CLAUDETTE_DATA_DIR = dir

// --- a provider that speaks the two-step discovery chain -----------------------------------
let registrations = 0
let registerAuthMethod: string | undefined
let evilTokenEndpoint = false      // point token_endpoint at another origin
let offerRegistration = true
let issueSecret = false
let badClientId = false

let origin = ''
const provider = http.createServer((req, res) => {
  const url = req.url || ''
  const json = (o: unknown, code = 200): void => {
    res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o))
  }
  // Step 1: the RESOURCE metadata, path-suffixed.
  if (url.startsWith('/.well-known/oauth-protected-resource/')) {
    return json({ resource: `${origin}/v1/mcp/authv2`, authorization_servers: [`${origin}/opaque-id`] })
  }
  // Step 2: the AUTHORIZATION SERVER metadata.
  if (url.startsWith('/.well-known/oauth-authorization-server')) {
    return json({
      issuer: `${origin}/opaque-id`,
      authorization_endpoint: `${origin}/authorize`,
      // The attack: a metadata document that redirects the token exchange elsewhere.
      token_endpoint: evilTokenEndpoint ? 'https://attacker.example/token' : `${origin}/oauth/token`,
      ...(offerRegistration ? { registration_endpoint: `${origin}/opaque-id/dcr/register` } : {}),
      revocation_endpoint: `${origin}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    })
  }
  if (url.endsWith('/dcr/register')) {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      registrations++
      const parsed = JSON.parse(body || '{}') as { token_endpoint_auth_method?: string }
      registerAuthMethod = parsed.token_endpoint_auth_method
      json({
        client_id: badClientId ? 12345 : 'dcr-issued-client-id',
        ...(issueSecret ? { client_secret: 'dcr-issued-secret' } : {}),
      })
    })
    return
  }
  json({}, 404)
})
await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r))
origin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`

const catalog = (): void => writeFileSync(path.join(dir, 'connectors.json'), JSON.stringify({
  // NO oauthClientRef — this is the whole point: nothing for the operator to create or paste.
  connectors: [{ id: 'conf', name: 'Confluence', transport: 'http', url: `${origin}/v1/mcp/authv2`, scopes: ['read:page:confluence'] }],
  oauthClients: [], accountConnectors: [], strict: false, builtinOverrides: {},
}))
catalog()

const dcr = await import('../server/src/connectors/connectorDcr.js')
const oauth = await import('../server/src/connectors/connectorOAuth.js')

const reset = (): void => { dcr.resetDcrCache(); oauth.resetOAuthState() }

try {
  // --- DISCOVERY WALKS THE CHAIN, it does not hardcode ------------------------------------
  // The value this codebase previously believed (mcp.atlassian.com/v1/register) is contradicted
  // by the authorization server's own metadata, and the real one carries an opaque id that will
  // rotate. Discovery is the only version that survives the rotation.
  const meta = await dcr.discoverAuthServer(`${origin}/v1/mcp/authv2`)
  check('discovery walks resource -> authorization-server metadata',
    meta?.issuer === `${origin}/opaque-id`, JSON.stringify(meta?.issuer))
  check('and finds the registration endpoint under the issuer, not a guessed path',
    meta?.registrationEndpoint === `${origin}/opaque-id/dcr/register`, meta?.registrationEndpoint ?? 'none')
  check('it also picks up the revocation endpoint, so disconnect can really revoke',
    meta?.revocationEndpoint === `${origin}/oauth/revoke`, meta?.revocationEndpoint ?? 'none')
  check('and records that the provider supports a PUBLIC client (auth method "none")',
    meta?.tokenEndpointAuthMethods.includes('none') === true,
    JSON.stringify(meta?.tokenEndpointAuthMethods))

  // --- ★ THE ATTACK: metadata that redirects the token exchange ---------------------------
  // Discovery means a third-party document tells us where to send an authorization code. A
  // document naming an attacker's host would have us POST codes there.
  // MUTATION THAT TURNS THIS RED: drop the sameOrigin() check on token_endpoint.
  evilTokenEndpoint = true
  const evil = await dcr.discoverAuthServer(`${origin}/v1/mcp/authv2`)
  check('metadata naming a token endpoint on ANOTHER ORIGIN is REFUSED outright',
    evil === null,
    `got ${JSON.stringify(evil?.tokenEndpoint)} — a document we fetched is not a document we may obey`)
  evilTokenEndpoint = false

  // --- REGISTRATION -------------------------------------------------------------------------
  reset()
  const reg = await dcr.registerClient('conf', (await dcr.discoverAuthServer(`${origin}/v1/mcp/authv2`))!, 'http://127.0.0.1:4319/cb')
  check('registration succeeds and yields a client id', reg.ok === true && !!(reg as { client: { clientId: string } }).client.clientId,
    JSON.stringify(reg))
  check('it registers as a PUBLIC client — no secret at rest for the operator or for us',
    registerAuthMethod === 'none', `token_endpoint_auth_method=${registerAuthMethod}`)

  // --- PERSISTED: a restart must not re-register --------------------------------------------
  // Re-registering on every boot leaves a trail of orphan clients on the provider's side.
  // MUTATION THAT TURNS THIS RED: return a fresh registration instead of the stored one.
  const before = registrations
  dcr.resetDcrCache()   // simulate a restart: in-memory cache gone, file remains
  const again = await dcr.registerClient('conf', (await dcr.discoverAuthServer(`${origin}/v1/mcp/authv2`))!, 'http://127.0.0.1:4319/cb')
  check('a second call after a restart REUSES the stored registration',
    again.ok === true && registrations === before,
    `${registrations - before} extra registration(s) — each one orphans a client on the provider`)

  // A CHANGED REDIRECT URI must re-register: the stored client is bound to the URI it was made
  // with, and silently reusing it produces a redirect_uri_mismatch that reads as a provider fault.
  const beforePort = registrations
  await dcr.registerClient('conf', (await dcr.discoverAuthServer(`${origin}/v1/mcp/authv2`))!, 'http://127.0.0.1:4999/cb')
  check('but a CHANGED redirect URI forces a fresh registration',
    registrations === beforePort + 1,
    'a stored client is bound to the redirect URI it was registered with')

  // --- the stored file --------------------------------------------------------------------
  const f = path.join(dir, 'connector-dcr.json')
  check('the registration file is 0600 — it can hold an issued client secret',
    (statSync(f).mode & 0o777) === 0o600, (statSync(f).mode & 0o777).toString(8))

  // --- THE RESPONSE IS UNTRUSTED INPUT ------------------------------------------------------
  // A provider returning a non-string client_id would otherwise put `undefined` into an authorize
  // URL, producing an error screen with no connection to this code.
  // MUTATION THAT TURNS THIS RED: assign body.client_id without the string check.
  badClientId = true
  dcr.resetDcrCache()
  rmSync(f, { force: true })
  const bad = await dcr.registerClient('conf', (await dcr.discoverAuthServer(`${origin}/v1/mcp/authv2`))!, 'http://127.0.0.1:4319/cb')
  check('a registration response with a non-string client_id is REFUSED, not stored',
    bad.ok === false, JSON.stringify(bad))
  badClientId = false

  // --- END TO END: authorize with no operator client at all ---------------------------------
  reset(); rmSync(f, { force: true })
  const started = await oauth.startAuthorization('conf')
  check('a connector with NO oauthClientRef can still start an authorization, via DCR',
    started.ok === true, JSON.stringify(started))
  if (started.ok) {
    const u = new URL(started.url)
    check('using the dynamically issued client id',
      u.searchParams.get('client_id') === 'dcr-issued-client-id', u.searchParams.get('client_id') ?? 'none')
    // Atlassian issues NO refresh token without offline_access, and the connector then dies
    // silently about an hour after it starts working.
    // MUTATION THAT TURNS THIS RED: remove requiresScope from the atlassian preset.
    // (Here the preset is matched on host, so this local provider does not get it — the scope
    // assertion below is therefore about the connector's own declared scope only.)
    check('and asking for the connector\'s declared scope',
      u.searchParams.get('scope')?.includes('read:page:confluence') === true,
      u.searchParams.get('scope') ?? 'none')
    check('with PKCE S256',
      u.searchParams.get('code_challenge_method') === 'S256', u.searchParams.get('code_challenge_method') ?? 'none')
  }

  // --- NO REGISTRATION ENDPOINT -> an honest refusal, not a crash --------------------------
  offerRegistration = false
  reset(); rmSync(f, { force: true })
  const noDcr = await oauth.startAuthorization('conf')
  check('a provider without DCR gives a clear refusal naming what is missing',
    noDcr.ok === false && /dynamic registration/i.test((noDcr as { error: string }).error),
    JSON.stringify(noDcr))
  offerRegistration = true
} finally {
  provider.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CLAUDETTE_DATA_DIR
}

process.exit(fail === 0 ? 0 : 1)
