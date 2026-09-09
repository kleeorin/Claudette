import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'fs'
import path from 'path'
import { dataDir } from '../util/dataDir'
import { errMessage } from '../util/errMessage'

// OAuth 2.0 Dynamic Client Registration (RFC 7591) — the path that lets a connector authorize
// with NO operator console step at all.
//
// WHY THIS EXISTS SEPARATELY FROM connectorOAuth.ts. It is a second way to ACQUIRE a credential,
// and the two have almost nothing in common: this one talks to a registration endpoint before any
// user is involved, and its input is a JSON document from a third party that we then store and
// later present as our own identity. Folding it into the existing exchange would have one code
// path serving two trust models. Kept apart so each can be read, tested and attacked on its own.
//
// EVERYTHING FROM THE PROVIDER IS UNTRUSTED INPUT. We fetch metadata over TLS, but "it came from
// the host we dialled" is not "it is well-formed and safe to act on". Every field is validated
// before use and every endpoint is re-checked to be https on the SAME origin we started from —
// see sameOrigin() below for the attack that guards against.

// --- discovery ---------------------------------------------------------------------------

// The RFC 8414 authorization-server metadata we actually use.
export interface AuthServerMeta {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  revocationEndpoint?: string
  codeChallengeMethods: string[]
  tokenEndpointAuthMethods: string[]
}

const FETCH_TIMEOUT_MS = 10_000

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const doc = await res.json() as unknown
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc as Record<string, unknown> : null
  } catch { return null }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// Is `candidate` https and on the same origin as `base`?
//
// ★ THE GUARD THAT MATTERS. Discovery means a third-party document TELLS US where to send things,
// and two of those things are secrets in the making: the registration endpoint receives a request
// we then trust the answer to, and the token endpoint receives authorization codes. A metadata
// document that pointed `token_endpoint` at an attacker's host would have us POST codes there —
// and the document is fetched from the resource, which is exactly the party a compromised or
// mis-configured connector definition could control.
// Requiring the SAME ORIGIN as the authorization server we resolved means a provider can only
// direct us to itself. It is deliberately stricter than the spec: RFC 8414 permits the issuer to
// name endpoints on other hosts, and a provider that legitimately does so will fail here and need
// an explicit exception — which is the right way round, because the failure is visible and a
// silent redirect of credentials is not.
function sameOrigin(candidate: string, base: string): boolean {
  try {
    const c = new URL(candidate)
    // https, OR plain http on LOOPBACK. That exception is not a convenience for tests: it is the
    // same rule connectorDefError already applies to connector URLs ("use https, or http on
    // 127.0.0.1"), and it exists because loopback traffic never crosses a network where anyone
    // could read it. Keeping the two rules identical matters more than either being stricter —
    // a provider that a connector may legally point at must also be one we may discover.
    const loopback = c.hostname === '127.0.0.1' || c.hostname === 'localhost' || c.hostname === '[::1]'
    if (c.protocol !== 'https:' && !(c.protocol === 'http:' && loopback)) return false
    return c.origin === new URL(base).origin
  } catch { return false }
}

// Walk resource metadata -> authorization server metadata.
//
// The two-step chain is what makes this robust. Atlassian's registration endpoint is
// `https://auth.atlassian.com/<opaque-id>/dcr/register` — a different HOST and path from the
// `mcp.atlassian.com/v1/register` this codebase previously believed, and it carries an opaque id
// that will rotate. Hardcoding either string is a bug with a delay on it; discovering it is the
// only version that survives the rotation.
export async function discoverAuthServer(connectorUrl: string): Promise<AuthServerMeta | null> {
  const origin = (() => { try { return new URL(connectorUrl).origin } catch { return null } })()
  if (!origin) return null
  const resPath = new URL(connectorUrl).pathname.replace(/^\//, '')

  // RFC 9728 allows the path-suffixed form; try it before the bare one, because a resource that
  // serves both may describe a DIFFERENT resource at the bare path (Google does exactly this —
  // its two documents report `.../mcp/v1` and `.../mcp`).
  const candidates = [
    `${origin}/.well-known/oauth-protected-resource/${resPath}`,
    `${origin}/.well-known/oauth-protected-resource`,
  ]
  let servers: string[] = []
  for (const c of candidates) {
    const doc = await getJson(c)
    servers = strArray(doc?.authorization_servers)
    if (servers.length) break
  }
  if (!servers.length) return null

  // The FIRST advertised server, and only if it is https. Trying them all would mean falling back
  // to a second issuer when the first is merely unreachable, which turns a transient outage into
  // a silent change of who we authenticate against.
  const issuer = servers[0]
  // Same loopback exception as sameOrigin, and for the same reason.
  if (!/^https:\/\//.test(issuer) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(issuer)) return null

  // RFC 8414: the well-known path is inserted after the origin, before the issuer's own path.
  const iu = new URL(issuer)
  const asCandidates = [
    `${iu.origin}/.well-known/oauth-authorization-server${iu.pathname === '/' ? '' : iu.pathname}`,
    `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
    `${iu.origin}/.well-known/openid-configuration${iu.pathname === '/' ? '' : iu.pathname}`,
  ]
  for (const c of asCandidates) {
    const doc = await getJson(c)
    if (!doc) continue
    const authorizationEndpoint = str(doc.authorization_endpoint)
    const tokenEndpoint = str(doc.token_endpoint)
    if (!authorizationEndpoint || !tokenEndpoint) continue
    // Every endpoint must be https and on the issuer's own origin. See sameOrigin().
    if (!sameOrigin(authorizationEndpoint, issuer) || !sameOrigin(tokenEndpoint, issuer)) {
      console.warn(`[connector-dcr] ${c} advertises endpoints outside the issuer's origin — refusing to use it`)
      return null
    }
    const registrationEndpoint = str(doc.registration_endpoint)
    const revocationEndpoint = str(doc.revocation_endpoint)
    return {
      issuer: str(doc.issuer) ?? issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: registrationEndpoint && sameOrigin(registrationEndpoint, issuer) ? registrationEndpoint : undefined,
      revocationEndpoint: revocationEndpoint && sameOrigin(revocationEndpoint, issuer) ? revocationEndpoint : undefined,
      codeChallengeMethods: strArray(doc.code_challenge_methods_supported),
      tokenEndpointAuthMethods: strArray(doc.token_endpoint_auth_methods_supported),
    }
  }
  return null
}

// --- the registered client store -----------------------------------------------------------
//
// A registered client is a CREDENTIAL, so it lives beside the tokens in dataDir() (never
// bind-mounted into a box — see connectorCreds.ts for the full reachability argument) and is
// written 0600. Persisted because re-registering on every restart would leave a trail of orphan
// clients on the provider's side and lose whatever the operator had already consented to.

export interface RegisteredClient {
  connectorId: string
  issuer: string
  clientId: string
  clientSecret?: string        // SECRET — absent for a public client, which is what we prefer
  registeredAt: number
  redirectUri: string          // what we registered WITH; a mismatch later is a hard failure
}

interface DcrStore { clients: RegisteredClient[] }

const file = (): string => path.join(dataDir(), 'connector-dcr.json')
let cache: DcrStore | null = null

function isRegistered(x: unknown): x is RegisteredClient {
  if (!x || typeof x !== 'object') return false
  const c = x as Record<string, unknown>
  return typeof c.connectorId === 'string' && !!c.connectorId
    && typeof c.issuer === 'string' && !!c.issuer
    && typeof c.clientId === 'string' && !!c.clientId
    && (c.clientSecret === undefined || typeof c.clientSecret === 'string')
    && typeof c.redirectUri === 'string'
    && typeof c.registeredAt === 'number'
}

function load(): DcrStore {
  if (cache) return cache
  try {
    const p = file()
    if (!existsSync(p)) return (cache = { clients: [] })
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<DcrStore>
    const raw: unknown[] = Array.isArray(parsed.clients) ? parsed.clients : []
    const clients = raw.filter(isRegistered)
    if (clients.length !== raw.length) {
      // Count only — a registration row holds a client secret, so nothing from it goes to a log.
      console.warn(`[connector-dcr] dropped ${raw.length - clients.length} malformed registration(s); `
        + 'the affected connector will re-register on next connect.')
    }
    cache = { clients }
    return cache
  } catch (e) {
    // Unlike a refresh token, a lost registration is CHEAP: the next connect simply registers
    // again. So this does not move the file aside — there is nothing here a human could recover
    // that re-registering would not produce, and leaving stale client credentials lying around in
    // sidecar files is worse than losing them.
    console.error(`[connector-dcr] could not read registrations, starting empty: ${errMessage(e)}. `
      + 'Affected connectors will register again on next connect.')
    return (cache = { clients: [] })
  }
}

function persist(s: DcrStore): void {
  const p = file()
  const tmp = `${p}.tmp`
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, p)
  cache = s
}

export function getRegisteredClient(connectorId: string, issuer: string): RegisteredClient | undefined {
  return load().clients.find((c) => c.connectorId === connectorId && c.issuer === issuer)
}

export function saveRegisteredClient(c: RegisteredClient): RegisteredClient {
  const s = load()
  const i = s.clients.findIndex((x) => x.connectorId === c.connectorId && x.issuer === c.issuer)
  const clients = i >= 0 ? s.clients.map((x, n) => (n === i ? c : x)) : [...s.clients, c]
  persist({ clients })
  return c
}

export function resetDcrCache(): void { cache = null }

// --- registration ----------------------------------------------------------------------------

// Register this installation as an OAuth client, or return the one already registered.
//
// PUBLIC CLIENT BY PREFERENCE. Atlassian advertises `none` in token_endpoint_auth_methods_supported,
// so we ask for it: a public client has NO secret, which means one less long-lived credential at
// rest and nothing for the operator to paste. We only fall back to a confidential registration if
// the provider does not offer `none`, and then the issued secret is stored 0600 like any other.
export async function registerClient(
  connectorId: string, meta: AuthServerMeta, redirectUri: string,
): Promise<{ ok: true; client: RegisteredClient } | { ok: false; error: string }> {
  const existing = getRegisteredClient(connectorId, meta.issuer)
  // A registration is bound to the redirect URI it was made with. If the app's port changed, the
  // stored client is unusable and silently re-using it produces a redirect_uri_mismatch that
  // looks like a provider fault, so re-register instead.
  if (existing && existing.redirectUri === redirectUri) return { ok: true, client: existing }
  if (!meta.registrationEndpoint) return { ok: false, error: 'This provider does not offer dynamic client registration.' }

  const wantsPublic = meta.tokenEndpointAuthMethods.includes('none')
  let body: Record<string, unknown>
  try {
    const res = await fetch(meta.registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        client_name: 'Claudette',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: wantsPublic ? 'none' : 'client_secret_post',
        application_type: 'native',
      }),
    })
    body = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) {
      const err = str(body.error) ?? `HTTP ${res.status}`
      const desc = str(body.error_description)
      return { ok: false, error: desc ? `${err}: ${desc}` : err }
    }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }

  // THE RESPONSE IS UNTRUSTED. A provider that returned a non-string client_id would otherwise put
  // `undefined` into an authorize URL, producing an error screen with no connection to this code.
  const clientId = str(body.client_id)
  if (!clientId) return { ok: false, error: 'The registration response contained no client id.' }
  const clientSecret = str(body.client_secret)

  return {
    ok: true,
    client: saveRegisteredClient({
      connectorId,
      issuer: meta.issuer,
      clientId,
      // Store a secret only if one was issued. Asking for a public client and being handed a
      // secret anyway is legal and worth keeping — but it is also worth noticing.
      ...(clientSecret ? { clientSecret } : {}),
      registeredAt: Date.now(),
      redirectUri,
    }),
  }
}
