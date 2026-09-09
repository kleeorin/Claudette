// Connector OAuth authorization state — the decisions, tested without a DOM.
//
// WHY THESE ARE PURE. The states that matter most are the ones a render test struggles to
// stage: two authorized accounts on a connector the server considers fully set up, and a
// `needsSetup` row that already has a client. Both are ordinary server states and neither is
// reachable by clicking.
//
// MUTATIONS (measured 2026-09-08). `ran=N` is recorded for every one, per the rule now in
// scratchpad/assert.mjs: a mutant that fails to PARSE yields zero failures exactly as a clean
// pass does, so a red set without an executed count is one assumption short of a proof.
//   C1  authState: move the `accounts.length > 1` check BELOW `if (!c.needsSetup)`
//       → the multi-account-while-ready case reds ALONE. That is the whole reason the check
//         is first: two authorized accounts means a token exists, so `needsSetup` is false
//         and the row would read 'ready' while the server dials unauthenticated.
//   C2  authState: `return c.oauthClientRef ? 'needs-authorization' : 'needs-client'`
//       → always 'needs-client'. The client-configured case reds.
//   C3  canConnect: include 'multi-account'
//       → the multi-account case reds. Offering Connect there invites a THIRD account onto a
//         connector that already refuses to dial because it cannot choose between two.
//   C4  isOAuthConnector: drop the `needsSetup` arm
//       → the no-client-yet case reds; a connector whose client was never created is exactly
//         the one that most needs the block rendered.
//   All four ran=15 (later 16, once the D2 gap below was closed) and exit 1 — the executed
//   count held constant across every run, which is what establishes that none of them crashed
//   instead of failing.
//   C6  authState ignores oauthClientReady and infers from the ref again
//       → the SET-ref-with-ready-false case reds, and nothing else. That asymmetry is the
//         point: the fallback cases still pass, because the fallback is still correct where
//         the field is absent.
//   C7  canConnect admits a state not in the connectable pair
//       → the population query reds. A per-state list would not have.
//   XX  a patch matching no text must REFUSE, not silently run the unmutated file.
import { describe, it, expect } from 'vitest'
import { authState, canConnect, isOAuthConnector, CONNECTOR_AUTH_STATES, type OAuthConnectorFields } from './connectorAuth'

// A connector needing an operator-created OAuth client (the Google shape): headerKeys/envKeys
// are empty and required on the view, so they are supplied rather than cast away.
const C = (over: Partial<OAuthConnectorFields> = {}): OAuthConnectorFields =>
  ({ headerKeys: [], envKeys: [], transport: 'http', ...over })

// ★ THE CONFLUENCE SHAPE — a DCR connector, exactly as toView builds it. NO needsSetup, NO
// oauthClientRef, NO oauthClientReady, because the builtin declares no `requiresOAuthClient`
// and `oauthReady()` short-circuits to true before any of them are set. This fixture is the
// one the old code got wrong, and it is written from the server's actual output rather than
// from what the states looked like they ought to be.
const DCR = (over: Partial<OAuthConnectorFields> = {}): OAuthConnectorFields =>
  ({ headerKeys: [], envKeys: [], transport: 'http', ...over })

describe('authState', () => {
  it('a fully set-up connector with one authorized account is ready', () => {
    expect(authState(C({ oauthClientRef: 'g1' }), ['me@example.com'])).toBe('ready')
  })

  it('needsSetup with no client ref means the client is missing', () => {
    expect(authState(C({ needsSetup: true }), [])).toBe('needs-client')
  })

  it('needsSetup WITH a usable client means nobody has authorized yet', () => {
    expect(authState(C({ needsSetup: true, oauthClientRef: 'g1', oauthClientReady: true }), [])).toBe('needs-authorization')
  })

  // ★ THE CASE THE SERVER FIELD EXISTS FOR, and the one the old inference got wrong.
  // A ref can be SET and still not resolve — `oauthClientUsable` also requires the secret,
  // which the browser cannot see. Inferring from the ref alone reported 'needs-authorization'
  // and offered a Connect button that 400s. The server now answers the question it can
  // actually answer, and this pins that the answer is believed over the ref.
  it('a SET ref with oauthClientReady=false is needs-client, not needs-authorization', () => {
    expect(authState(C({ needsSetup: true, oauthClientRef: 'g1', oauthClientReady: false }), []))
      .toBe('needs-client')
  })

  // The fallback survives only where nothing better exists — an older server, or a row where
  // the field is deliberately not emitted.
  it('falls back to the ref when the server did not send the field', () => {
    expect(authState(C({ needsSetup: true, oauthClientRef: 'g1' }), [])).toBe('needs-authorization')
    expect(authState(C({ needsSetup: true }), [])).toBe('needs-client')
  })

  // ★ THE ORDERING CASE. Two authorized accounts means a token exists, so the server reports
  // needsSetup=false — this would read 'ready' while the connector dials as nobody.
  it('TWO accounts outrank ready, because the server refuses to choose', () => {
    expect(authState(C({ oauthClientRef: 'g1' }), ['a@x.com', 'b@x.com'])).toBe('multi-account')
  })

  it('…and outranks needsSetup too', () => {
    expect(authState(C({ needsSetup: true, oauthClientRef: 'g1' }), ['a@x.com', 'b@x.com'])).toBe('multi-account')
  })
})

describe('canConnect', () => {
  it('offers Connect while a client or an authorization is missing', () => {
    expect(canConnect('needs-client')).toBe(true)
    expect(canConnect('needs-authorization')).toBe(true)
  })
  // ★ A QUERY OVER THE POPULATION, NOT A LIST OF THE STATES I HAPPEN TO KNOW.
  // Filtering the exported set means a FIFTH state cannot quietly become connectable: if one
  // is added and canConnect says yes, this reds and someone has to decide deliberately. Naming
  // 'ready' and 'multi-account' here would have gone on passing while saying nothing about it.
  // Connecting a third account cannot resolve a refusal caused by having two, which is why
  // 'multi-account' must not appear.
  it('exactly these states are connectable — checked across the whole set', () => {
    expect(CONNECTOR_AUTH_STATES.filter(canConnect)).toEqual(['needs-client', 'needs-authorization'])
  })
})

describe('isOAuthConnector', () => {
  it('is true for a row needing setup and for a configured one', () => {
    expect(isOAuthConnector(C({ needsSetup: true }))).toBe(true)
    expect(isOAuthConnector(C({ oauthClientRef: 'g1' }))).toBe(true)
  })
  // ⚠ THIS TEST CHANGED SHAPE ON 2026-09-09, and the change is a real behaviour change rather
  // than a fixture tidy-up. It used to pass `C()` — no fields at all — and expect false. Under
  // the DCR fallback that same shape (http, no header names, no env names) is now treated as
  // OAuth-capable ON PURPOSE, because it is indistinguishable from Confluence. So "ordinary"
  // has to mean "carries some other credential mechanism, or is not dialled by us at all",
  // which is what the cases below assert. The old assertion caught the change correctly; it is
  // updated rather than deleted so the reason is recorded where the expectation lives.
  // ★ ADDED AFTER MUTATION C4 PRODUCED NO RED AT ran=25. Dropping the `needsSetup` arm from
  // isOAuthConnector went undetected, because every fixture here is http with no header or env
  // names — so the credential-absence FALLBACK caught them all and the arm it was meant to pin
  // was doing no work in any test. The count is what made that call safe: 25 assertions ran and
  // none failed, so it was a real gap rather than a mutant that never executed.
  // This is the one shape only that arm can save: a connector the server says needs setup,
  // which ALSO carries a credential name, so the fallback refuses it.
  it('a connector needing setup is OAuth even when it carries a header name', () => {
    expect(isOAuthConnector(C({ needsSetup: true, headerKeys: ['X-Api-Key'] }))).toBe(true)
    expect(isOAuthConnector(C({ oauthClientRef: 'g1', envKeys: ['TOKEN'] }))).toBe(true)
  })

  it('is false for a connector that has another credential mechanism', () => {
    expect(isOAuthConnector(C({ headerKeys: ['Authorization'] }))).toBe(false)
    expect(isOAuthConnector(C({ transport: 'stdio' }))).toBe(false)
  })
})

// ★★ DYNAMIC CLIENT REGISTRATION — the shape that was invisible to this module until
// 2026-09-09, found by a user asking whether their Confluence tool worked. ★★
//
// Atlassian supports OAuth 2.1 DCR, so the Confluence builtin carries no
// `requiresOAuthClient`. The server's `oauthReady()` returns true immediately for such a
// connector, so it emits NO needsSetup, NO oauthClientRef and NO oauthClientReady — and both
// functions here read exactly those fields. The result was the worst possible pairing: the one
// connector that needs no operator setup was the one with no way to authorize it, and it
// reported itself ALREADY AUTHORIZED while holding no token.
//
// MUTATIONS (measured 2026-09-09, ran=N recorded per the rule in scratchpad/assert.mjs):
//   C8  isOAuthConnector drops the credential-absence fallback (`return false` after the
//       operator-client checks) → the DCR-offers-Connect case reds. ran=17.
//   C9  authState returns 'ready' when `!c.needsSetup`, as it used to
//       → the DCR-with-no-accounts case reds; every operator-client case stays green, which is
//         the asymmetry showing the old rule was right for one family and wrong for the other.
//         ran=17.
//   C10 isOAuthConnector ignores `oauthCapable` and falls through to the inference
//       → the server-says-no case reds. Pins that the server's answer OUTRANKS the guess, so
//         adding the field cannot be undone by the fallback still being there.
describe('a DCR connector (Confluence) — no client fields at all', () => {
  it('is recognised as an OAuth connector, so the authorization block renders', () => {
    expect(isOAuthConnector(DCR())).toBe(true)
  })

  // ★ THE ONE THE USER HIT. Zero authorizations must not read as connected: the proxy would
  // dial unauthenticated while the UI said it was ready.
  it('with NO authorized account it needs authorization — it is NOT ready', () => {
    expect(authState(DCR(), [])).toBe('needs-authorization')
  })

  it('…and offers Connect in that state', () => {
    expect(canConnect(authState(DCR(), []))).toBe(true)
  })

  it('once one account has authorized, it is ready', () => {
    expect(authState(DCR(), ['me@example.com'])).toBe('ready')
  })

  // The fallback is an inference from the ABSENCE of any other credential mechanism, so a
  // connector that carries one must not be swept in.
  it('an http connector with a static auth header is NOT treated as OAuth', () => {
    expect(isOAuthConnector(C({ headerKeys: ['Authorization'] }))).toBe(false)
    expect(isOAuthConnector(C({ envKeys: ['API_TOKEN'] }))).toBe(false)
  })

  it('a stdio connector is never OAuth', () => {
    expect(isOAuthConnector(C({ transport: 'stdio' }))).toBe(false)
  })

  // ★ THE SERVER'S ANSWER OUTRANKS THE INFERENCE, so `oauthCapable` landing cannot be
  // undermined by the fallback still being present underneath it.
  it('an explicit oauthCapable from the server wins over the inference, both ways', () => {
    expect(isOAuthConnector(C({ oauthCapable: false }))).toBe(false)
    expect(isOAuthConnector(C({ oauthCapable: true, headerKeys: ['Authorization'] }))).toBe(true)
  })
})
