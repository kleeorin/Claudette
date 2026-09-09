import crypto from 'crypto'
import type { ConnectorDef, OAuthClient } from '@claudette/shared'
import { errMessage } from '../util/errMessage'
import { endpointsFor, scopesFor, warnOnUnsupportedScopes, presetParams } from './oauthProviders'
import { discoverAuthServer, registerClient } from './connectorDcr'
import { getConnector, getOAuthClient } from './connectorStore'
import { saveToken, getToken, accountsFor, removeToken, type ConnectorToken } from './connectorCreds'

// The interactive OAuth flow for catalog connectors: authorize, callback, refresh.
//
// NOTHING HERE IS REACHABLE FROM INSIDE A SANDBOX. These functions are driven by routes on the
// MAIN Fastify app, which sits behind the global auth hook, and the tokens they produce are
// read only by the proxy (server-side) — never handed to a session. See connectorOAuthApi.ts.

// --- pending authorizations -------------------------------------------------------------
//
// In memory ON PURPOSE, and the one piece of this feature that is deliberately NOT persisted.
// A pending authorization is a few-minute-long intent held by one browser tab; persisting it
// would mean a `state` value and a PKCE verifier surviving a restart, which is strictly more
// attack surface for a value whose entire job is to be short-lived and single-use. Losing them
// on restart costs the operator one click on "Connect" again.
interface Pending {
  connectorId: string
  // Absent for a DYNAMICALLY REGISTERED client: there is no OAuthClient record to point at.
  clientRef?: string
  // The resolved credentials and token endpoint travel WITH the pending entry rather than being
  // looked up again at callback time. Two reasons: a DCR client has no catalog record to look up,
  // and carrying them makes the exchange immune to the catalog changing mid-flow — an operator
  // editing a connector while a consent screen is open must not redirect the code exchange.
  clientId: string
  clientSecret?: string
  tokenUrl: string
  verifier: string
  scopes: string[]
  redirectUri: string
  createdAt: number
}

const pending = new Map<string, Pending>()

// How long an authorization may sit unfinished. Long enough to log in, pick an account and read
// a consent screen; short enough that an abandoned tab does not leave a usable `state` lying
// around for the rest of the process lifetime.
const PENDING_TTL_MS = 10 * 60_000

function sweep(): void {
  const cutoff = Date.now() - PENDING_TTL_MS
  for (const [k, p] of pending) if (p.createdAt < cutoff) pending.delete(k)
}

// PKCE S256. The verifier never leaves this process; only its hash goes to the provider, so an
// authorization code intercepted in transit cannot be redeemed without it.
function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// The redirect URI, computed from the RUNNING app's host and port rather than hardcoded.
//
// It must live on the MAIN app, not the proxy. The original reason given was that
// ConnectorProxy.start() listens on port 0 — a fresh random port every boot — so a redirect URI
// registered against it breaks at the next restart. That is true for a Google WEB APPLICATION
// client, where redirect URIs are pre-registered and matched EXACTLY including the port. It is
// NOT true for a DESKTOP APP client, which may use a loopback redirect on an arbitrary
// runtime-chosen port. So that argument alone would have evaporated the moment we supported
// desktop clients.
// THE DURABLE REASON, which holds for both: the callback carries an authorization code, and the
// proxy has no auth hook and no session context. On the main app the callback lands behind the
// global preHandler gate, on the origin the operator's browser is already authenticated to.
export function redirectUri(): string {
  const host = process.env.HOST ?? '127.0.0.1'
  const port = Number(process.env.PORT ?? 4319)
  // `localhost` and `127.0.0.1` are DIFFERENT strings to an exact-matching provider. We emit the
  // configured host and tell the operator to register exactly what the UI shows — which is why
  // this value is surfaced rather than documented as a constant.
  return `http://${host}:${port}/api/connectors/oauth/callback`
}

export type StartResult =
  | { ok: true; url: string; redirectUri: string }
  | { ok: false; error: string }

// Begin an authorization. Returns the provider URL for the operator's browser to visit.
export async function startAuthorization(connectorId: string): Promise<{ ok: true; url: string; redirectUri: string } | { ok: false; error: string }> {
  sweep()
  const def: ConnectorDef | undefined = getConnector(connectorId)
  if (!def) return { ok: false, error: 'No such connector.' }
  const uriEarly = redirectUri()

  // TWO WAYS TO GET A CLIENT, and they are tried in this order for a reason.
  //
  // DCR FIRST when the connector declares no operator client: a provider that supports dynamic
  // registration needs no console step, no pasted secret and no pre-registered redirect URI, so
  // for Atlassian the entire setup burden that makes the Google path awkward simply does not
  // exist. Falling back to "configure a client" only when the provider offers no registration
  // endpoint means the easy path is the default rather than the fallback.
  let clientId: string | undefined
  let clientSecret: string | undefined
  let ep: { authorizeUrl: string; tokenUrl: string; authorizeParams?: Record<string, string>; requiresScope?: string; revokeUrl?: string } | null = null

  if (!def.oauthClientRef && def.url) {
    const meta = await discoverAuthServer(def.url)
    if (meta?.registrationEndpoint) {
      const reg = await registerClient(connectorId, meta, uriEarly)
      if (!reg.ok) return { ok: false, error: `Could not register with ${meta.issuer}: ${reg.error}` }
      clientId = reg.client.clientId
      clientSecret = reg.client.clientSecret
      const preset = presetParams(def)
      ep = {
        authorizeUrl: meta.authorizationEndpoint,
        tokenUrl: meta.tokenEndpoint,
        authorizeParams: preset?.authorizeParams,
        requiresScope: preset?.requiresScope,
        revokeUrl: meta.revocationEndpoint,
      }
    }
  }

  if (!ep) {
    if (!def.oauthClientRef) {
      return { ok: false, error: 'This connector has no OAuth client configured yet, and its provider does not offer dynamic registration.' }
    }
    const client: OAuthClient | undefined = getOAuthClient(def.oauthClientRef)
    if (!client?.clientId?.trim()) return { ok: false, error: 'That OAuth client has no client id.' }
    const resolved = endpointsFor(client)
    if (!resolved) return { ok: false, error: 'That OAuth client needs an authorize URL and a token URL.' }
    clientId = client.clientId
    clientSecret = client.clientSecret
    ep = resolved
  }

  const base = scopesFor(connectorId, def.scopes)
  // A provider-REQUIRED scope is added rather than expected from the connector's declaration.
  // Atlassian issues no refresh token without `offline_access`, and a connector author has no
  // reason to know that — so it lives with the provider and is merged here.
  const required = ep.requiresScope
  const scopes = required && !base.includes(required) && base.length ? [...base, required] : base
  // REFUSE rather than default to "everything". An empty scope list is not a request for full
  // access; it is a missing declaration, and asking a provider for an unscoped token is how a
  // connector ends up holding more than it needs with nobody having chosen that.
  if (!scopes.length) {
    return { ok: false, error: `No OAuth scopes are declared for "${connectorId}", so there is nothing to request.` }
  }

  const { verifier, challenge } = pkce()
  const state = crypto.randomBytes(32).toString('base64url')
  const uri = uriEarly
  pending.set(state, {
    connectorId, clientRef: def.oauthClientRef, verifier, scopes, redirectUri: uri, createdAt: Date.now(),
    clientId: clientId as string, clientSecret, tokenUrl: ep.tokenUrl,
  })

  const u = new URL(ep.authorizeUrl)
  u.searchParams.set('client_id', clientId as string)
  u.searchParams.set('redirect_uri', uri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', scopes.join(' '))
  u.searchParams.set('state', state)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  // Google needs BOTH access_type=offline AND prompt=consent to return a refresh_token on a
  // re-authorization of a client the user has already approved. With only the first, the second
  // authorization returns an access token and NO refresh token, and the connector dies silently
  // an hour later with a 401 that looks like a server problem.
  for (const [k, v] of Object.entries(ep.authorizeParams ?? {})) u.searchParams.set(k, v)

  // Advisory only, and deliberately NOT awaited: it must never delay or block an authorization.
  // It catches the shape of mistake that is otherwise invisible until call time — asking for a
  // scope the resource does not advertise (the gdocs/gsheets Drive-scope case).
  if (def.url) void warnOnUnsupportedScopes(def.url, scopes)

  return { ok: true, url: u.toString(), redirectUri: uri }
}

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
  id_token?: unknown
  error?: unknown
  error_description?: unknown
}

// The account this consent belongs to. Read from the id_token when the provider issued one —
// its payload is NOT verified here and does not need to be: this value is a LABEL for keying and
// display, never an authentication decision. It arrived over TLS from the token endpoint we
// dialled, in response to a code we generated. Falls back to 'default'.
function accountFrom(body: TokenResponse): string {
  const idt = body.id_token
  if (typeof idt !== 'string') return 'default'
  const part = idt.split('.')[1]
  if (!part) return 'default'
  try {
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { email?: unknown; sub?: unknown }
    if (typeof claims.email === 'string' && claims.email) return claims.email
    if (typeof claims.sub === 'string' && claims.sub) return claims.sub
  } catch { /* not a JWT we understand — a label, not a decision */ }
  return 'default'
}

async function postForm(url: string, form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  const body = await res.json().catch(() => ({})) as TokenResponse
  if (!res.ok) {
    // The provider's own error text, which is the difference between "invalid_grant" (the user
    // must re-authorize) and "invalid_client" (the operator mistyped a secret). NEVER include
    // the form we sent — it holds the client secret and the refresh token.
    const detail = typeof body.error === 'string'
      ? `${body.error}${typeof body.error_description === 'string' ? `: ${body.error_description}` : ''}`
      : `HTTP ${res.status}`
    throw new Error(detail)
  }
  return body
}

// Map a token response onto a stored token.
//
// ★ refreshToken IS DELIBERATELY A PRESENT-AND-UNDEFINED KEY when the provider omits it. That is
// what makes connectorCreds.saveToken's omit-means-keep guard load-bearing: a refresh response
// routinely omits refresh_token because the old one is still valid, and the guard is what stops
// the stored long-lived credential being erased. Writing this as a conditional spread would make
// that guard untested and, worse, look unnecessary to the next reader.
function toStored(connectorId: string, account: string, scopes: string[], body: TokenResponse): ConnectorToken {
  const access = body.access_token
  if (typeof access !== 'string' || !access) throw new Error('the provider returned no access token')
  const granted = typeof body.scope === 'string' && body.scope.trim() ? body.scope.trim().split(/\s+/) : scopes
  return {
    connectorId,
    account,
    accessToken: access,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : undefined,
    scopes: granted,
    obtainedAt: Date.now(),
  }
}

// Finish an authorization: exchange the code for tokens and store them.
export async function completeAuthorization(state: string, code: string): Promise<{ ok: true; connectorId: string; account: string } | { ok: false; error: string }> {
  sweep()
  // SINGLE USE. Deleted before the exchange, not after, so a replayed callback cannot ride the
  // same pending entry — and so a slow or failed exchange does not leave a live `state` behind.
  const p = state ? pending.get(state) : undefined
  if (p) pending.delete(state)
  if (!p) return { ok: false, error: 'That authorization has expired or was already used. Start it again.' }
  if (!code) return { ok: false, error: 'The provider returned no authorization code.' }

  try {
    const body = await postForm(p.tokenUrl, {
      grant_type: 'authorization_code',
      code,
      client_id: p.clientId,
      // A PUBLIC client has no secret and must not send an empty one. That covers both a Google
      // Desktop app client and an Atlassian dynamic registration that asked for auth method
      // 'none' — the two paths that spare the operator a secret entirely.
      ...(p.clientSecret?.trim() ? { client_secret: p.clientSecret } : {}),
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
    })
    const account = accountFrom(body)
    saveToken(toStored(p.connectorId, account, p.scopes, body))
    return { ok: true, connectorId: p.connectorId, account }
  } catch (e) {
    return { ok: false, error: errMessage(e) }
  }
}

// --- refresh ------------------------------------------------------------------------------

// Refresh a little BEFORE the token actually expires. A token that expires between the check and
// the upstream's receipt of it produces a 401 that reads exactly like a revoked grant.
const EXPIRY_SKEW_MS = 60_000

// SINGLE-FLIGHT, keyed by (connector, account). Google ROTATES refresh tokens: a refresh returns
// a new one and invalidates the old. Two sessions dialling the same connector as the same account
// at the same moment would otherwise each POST the same refresh token, and the second exchange
// invalidates the credential the first just stored — leaving a connector that fails until a human
// re-authorizes. Not theoretical: many sessions share one connector by design.
const inFlight = new Map<string, Promise<ConnectorToken | null>>()

const flightKey = (connectorId: string, account: string): string => `${connectorId} ${account}`

// The access token to present upstream, refreshing if needed. Null when there is nothing usable —
// the caller must then dial WITHOUT a bearer rather than with a broken one, so the provider's own
// challenge reaches the client.
// WHICH ACCOUNT DO WE DIAL AS? The (connector, account) keying makes a token belong to a
// person, but the proxy is handed only a connector id — so this is where the two meet, and it is
// a question the design did not answer until a test asked it.
//
//   · exactly one authorized account  -> use it. The overwhelmingly common case for a
//     single-user install, and there is nothing to choose.
//   · none                            -> null; dial unauthenticated so the provider challenges.
//   · MORE THAN ONE                   -> REFUSE, loudly, and dial unauthenticated.
//
// That last one is the whole reason the keying exists. Picking "the first" or "the newest" would
// have Claudette act as one person while the operator believes it is acting as another, with NO
// VISIBLE DIFFERENCE — the exact failure per-account keying was introduced to prevent, delivered
// by the code that consumes it. Refusing is fail-closed, it is visible (the provider's own 401
// reaches the client), and it creates the pressure to add explicit per-session account selection
// rather than letting a silent guess stand in for it.
function resolveAccount(connectorId: string, account?: string): string | null {
  if (account) return account
  const all = accountsFor(connectorId)
  if (all.length === 1) return all[0]
  if (all.length === 0) return null
  console.warn(`[connector-oauth] ${connectorId} is authorized by ${all.length} accounts and no account was `
    + 'specified for this call, so no token is being attached. Disconnect the accounts you do not '
    + 'want, or select one explicitly — guessing would act as one person while looking like another.')
  return null
}

export async function accessTokenFor(connectorId: string, account?: string): Promise<string | null> {
  const resolved = resolveAccount(connectorId, account)
  if (!resolved) return null
  const stored = getToken(connectorId, resolved)
  if (!stored) return null
  const fresh = stored.expiresAt === undefined || stored.expiresAt - EXPIRY_SKEW_MS > Date.now()
  if (fresh) return stored.accessToken
  if (!stored.refreshToken) {
    // Expired with no way to renew. Returning the stale token would produce a 401 that looks like
    // a revoked grant; returning null makes the proxy dial unauthenticated, which surfaces the
    // provider's own challenge and is the honest signal that re-authorization is needed.
    return null
  }

  const k = flightKey(connectorId, resolved)
  const existing = inFlight.get(k)
  if (existing) return (await existing)?.accessToken ?? null

  const flight = (async (): Promise<ConnectorToken | null> => {
    const client = getOAuthClient(getConnector(connectorId)?.oauthClientRef ?? '')
    const ep = client ? endpointsFor(client) : null
    if (!client?.clientId?.trim() || !ep) return null
    try {
      const body = await postForm(ep.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken as string,
        client_id: client.clientId,
        ...(client.clientSecret?.trim() ? { client_secret: client.clientSecret } : {}),
      })
      return saveToken(toStored(connectorId, resolved, stored.scopes, body))
    } catch (e) {
      // Log the provider's reason WITHOUT the credential. `invalid_grant` here means the refresh
      // token has been revoked or rotated away and only a human can fix it.
      console.warn(`[connector-oauth] refresh failed for ${connectorId} (${resolved}): ${errMessage(e)}`)
      return null
    }
  })()

  inFlight.set(k, flight)
  try {
    return (await flight)?.accessToken ?? null
  } finally {
    inFlight.delete(k)
  }
}

// Test seam: drop pending authorizations and in-flight refreshes.
export function resetOAuthState(): void {
  pending.clear()
  inFlight.clear()
}

// For tests and for the UI's "how many authorizations are half-finished" — never the values.
export function pendingCount(): number {
  sweep()
  return pending.size
}

// --- revocation ------------------------------------------------------------------------------

// Disconnect an account, revoking AT THE PROVIDER where the provider supports it.
//
// This turns a limitation into a capability. The old behaviour — and the wording in CONNECTORS.md
// that described it — was that disconnecting removed only our copy, leaving the grant live in the
// user's account until they went and revoked it themselves. That was never a design choice; it
// was what we could deliver. Both Google (oauth2.googleapis.com/revoke) and Atlassian (advertised
// as revocation_endpoint) publish one, so for those providers "Disconnect" can mean what an
// operator already assumes it means.
//
// THE ORDER MATTERS: revoke FIRST, forget SECOND, and forget even if the revoke fails. Forgetting
// first would drop the only copy of the credential we need in order to revoke it, converting a
// recoverable network blip into a grant that stays live forever with nothing left to revoke it
// with. Revoking first and forgetting regardless means the worst case is a stale grant at the
// provider that the operator can still clear by hand — which is exactly where they were before.
//
// Returns what actually happened, because "revoked" and "forgotten" are different promises and
// the UI must not make the stronger one on the weaker outcome.
export async function disconnectAccount(connectorId: string, account?: string): Promise<{ removed: number; revoked: number; revokeFailed: number }> {
  const targets = account ? [account] : accountsFor(connectorId)
  let revoked = 0
  let revokeFailed = 0

  for (const acct of targets) {
    const stored = getToken(connectorId, acct)
    if (!stored) continue
    const url = await revokeUrlFor(connectorId)
    if (!url) continue          // provider publishes none; forgetting is all we can do
    // The REFRESH token where we have one: revoking it invalidates the whole grant, whereas
    // revoking only the access token leaves the refresh token able to mint more.
    const token = stored.refreshToken ?? stored.accessToken
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ token }).toString(),
      })
      // RFC 7009 says a server returns 200 even for an already-invalid token, so a non-200 is a
      // real failure rather than "it was already gone".
      if (res.ok) revoked++
      else { revokeFailed++; console.warn(`[connector-oauth] revoke returned HTTP ${res.status} for ${connectorId} (${acct})`) }
    } catch (e) {
      revokeFailed++
      console.warn(`[connector-oauth] could not revoke ${connectorId} (${acct}): ${errMessage(e)}`)
    }
  }

  // Forget regardless — see the ordering note above.
  const removed = removeToken(connectorId, account)
  return { removed, revoked, revokeFailed }
}

// Where to send a revocation for this connector, or null if the provider publishes none.
// Resolved rather than stored: a revocation endpoint is metadata, and metadata we cached at
// registration time is metadata that can be stale by the time it matters.
async function revokeUrlFor(connectorId: string): Promise<string | null> {
  const def = getConnector(connectorId)
  if (!def) return null
  if (def.oauthClientRef) {
    const client = getOAuthClient(def.oauthClientRef)
    const ep = client ? endpointsFor(client) : null
    if (ep?.revokeUrl) return ep.revokeUrl
  }
  if (!def.url) return null
  const meta = await discoverAuthServer(def.url)
  return meta?.revocationEndpoint ?? null
}
