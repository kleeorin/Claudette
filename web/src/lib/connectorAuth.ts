// Connector OAuth authorization state — the DECISIONS, kept out of the component so they can
// be asserted rather than described. Same reason `dotStateFor` was extracted from App.tsx:
// nothing in this repo imports a component tree, so a rule that lives inline in one is a rule
// with no test at any layer.
import type { ConnectorView } from '@claudette/shared'

// FOUR states, not the two the UI had. `needsSetup` is a single boolean covering two very
// different situations — no usable client, and a usable client with nobody authorized — and
// the operator's next action is completely different in each. Telling someone who has just
// created a client to go and create one is how a correct blocker reads as a broken app.
//   ready               client usable AND a token held: the connector can dial as someone
//   needs-client        no usable OAuth client yet — the operator must register one
//   needs-authorization client is configured, nobody has authorized it yet
//   multi-account       MORE THAN ONE account authorized — the server refuses to guess
//
// Declared as a VALUE first and the type derived from it, so the set can be queried at
// runtime rather than re-listed by anything that needs to reason over all of them. A test
// that names the states it happens to know about is an enumeration with a silent expiry
// date; one that filters this array keeps answering after a fifth state is added.
export const CONNECTOR_AUTH_STATES = [
  'ready', 'needs-client', 'needs-authorization', 'multi-account',
] as const
export type ConnectorAuthState = typeof CONNECTOR_AUTH_STATES[number]

// The shape this module reads. `oauthCapable` is NOT on ConnectorView yet — it is the one
// field the server would need to answer this exactly, and it is declared here as an optional
// local extension so the code consumes it the moment it lands, exactly as `oauthClientReady`
// was consumed once Landing added it. Delete this extension then, and widen the Pick.
export type OAuthConnectorFields =
  Pick<ConnectorView, 'needsSetup' | 'oauthClientRef' | 'oauthClientReady' | 'transport' | 'headerKeys' | 'envKeys'>
  & { oauthCapable?: boolean }

// ★ IS THIS AN OAUTH CONNECTOR AT ALL? THE CLIENT CANNOT ANSWER THIS EXACTLY, AND HERE IS WHY.
// `requiresOAuthClient` lives on ConnectorDef and never reaches the browser. The previous
// version of this function read `needsSetup || oauthClientRef` and was described as exact. It
// was not: it is exact only for connectors that need an OPERATOR-CREATED client.
//
// A connector using DYNAMIC CLIENT REGISTRATION has neither field. Confluence is precisely
// that — Atlassian supports OAuth 2.1 DCR, so the builtin carries no `requiresOAuthClient`,
// `oauthReady()` therefore short-circuits to true, and the server emits no `needsSetup`, no
// `oauthClientRef` and no `oauthClientReady`. The old test returned FALSE for it, so the whole
// authorization block was skipped and the one connector that can work with no operator setup
// at all was the one with no way to authorize it. Found 2026-09-09 by executing this function
// against a confluence-shaped view rather than reading it.
//
// So: the SERVER'S ANSWER when it exists, then the operator-client signals, then a fallback
// justified by absence rather than by a list. An http connector carrying no header names and
// no env names has no other credential mechanism available to it — OAuth is the only way it
// could authenticate. That is an inference, and it can be wrong for a genuinely public MCP
// server needing no auth at all; the cost of that is a Connect button whose `/start` answers
// 400 with a reason the UI already surfaces. It fails LOUDLY and recoverably, which is the
// trade this codebase prefers over the alternative — the connector that works out of the box
// being unusable because we could not prove it was OAuth.
export function isOAuthConnector(c: OAuthConnectorFields): boolean {
  if (c.oauthCapable !== undefined) return c.oauthCapable
  if (c.needsSetup || c.oauthClientRef) return true
  return c.transport === 'http' && (c.headerKeys?.length ?? 0) === 0 && (c.envKeys?.length ?? 0) === 0
}

// ★ MULTI-ACCOUNT IS CHECKED FIRST, AND THAT ORDERING IS THE POINT.
// Server behaviour: one authorized account → use it; none → dial unauthenticated; MORE THAN
// ONE → refuse and dial unauthenticated, deliberately, because guessing would have Claudette
// act as one person while the operator believes it is acting as another. Two authorized
// accounts means `hasToken` is true, so `needsSetup` is FALSE and the row would otherwise
// read 'ready' — a connector silently dialling unauthenticated while the UI says it is
// connected. That is the exact invisible failure the refusal exists to prevent, so the state
// that surfaces it has to outrank the one that hides it.
export function authState(c: OAuthConnectorFields, accounts: readonly string[]): ConnectorAuthState {
  if (accounts.length > 1) return 'multi-account'

  // ★ AN UNUSABLE CLIENT OUTRANKS EVERYTHING BELOW, because authorizing again cannot fix it.
  // This also covers the case where a token exists but the client was deleted afterwards: the
  // connector holds a credential it can no longer refresh, and saying 'ready' there would be
  // the same lie in a rarer costume.
  if (c.needsSetup && c.oauthClientReady === false) return 'needs-client'
  // Older server, or a row where the field is not emitted: fall back to the ref, which is the
  // only other client signal that reaches the browser.
  if (c.needsSetup && c.oauthClientReady === undefined && !c.oauthClientRef) return 'needs-client'

  // ★ 'ready' NOW MEANS A TOKEN IS HELD, AND IT IS DERIVED FROM THE ACCOUNTS, NOT FROM
  // `needsSetup`. This is the second half of the 2026-09-09 fix and the more dangerous half.
  // The old rule was `if (!c.needsSetup) return 'ready'`, which is correct ONLY for connectors
  // that need an operator client — for those, the server folds "has a token" into needsSetup.
  // A DCR connector short-circuits that check server-side, so `needsSetup` is absent whether or
  // not anybody has ever authorized it, and Confluence with ZERO authorized accounts reported
  // 'ready'. The proxy would have dialled unauthenticated while the UI said it was connected:
  // the same invisible failure the multi-account refusal exists to prevent, arrived at from the
  // other direction. Counting the authorizations answers the question directly instead of
  // inferring it from a flag that means something narrower.
  if (accounts.length === 1) return 'ready'
  return 'needs-authorization'
}

// Whether to offer the Connect button. Not simply `state !== 'ready'`: offering it in the
// multi-account state would invite a THIRD authorization onto a connector that already
// refuses to dial because it cannot choose between two.
export function canConnect(state: ConnectorAuthState): boolean {
  return state === 'needs-client' || state === 'needs-authorization'
}
