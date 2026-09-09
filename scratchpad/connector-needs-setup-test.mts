// `needsSetup` must mean "this connector cannot work yet", not "no client is saved".
//
// THE ORDERING TRAP THIS PINS. ConnectorGrants.tsx blocks the grant toggle on `needsSetup`.
// If it clears as soon as an OAuth CLIENT is saved, the operator pastes a client id, the row
// goes green, the toggle unblocks — and every tool call 401s, because nobody has authorized
// anything yet. That is the fail-at-connect state the store's own comment says was "explicitly
// rejected in favour of blocking", reintroduced one step earlier in the chain.
// oauthClientUsable already made this argument once (a clientId without a secret is not a
// usable client). This is the same argument one step further: a usable client without a TOKEN
// is not a usable connector.

import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { check, failed as fail } from './assert.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'claudette-needsetup-'))
process.env.CLAUDETTE_DATA_DIR = dir

const catalog = (oauthClients: unknown[]): void => {
  writeFileSync(path.join(dir, 'connectors.json'), JSON.stringify({
    connectors: [], oauthClients, accountConnectors: [], strict: false,
    builtinOverrides: { gcalendar: { oauthClientRef: 'goog' } },
  }))
}

const store = await import('../server/src/connectors/connectorStore.js')
const creds = await import('../server/src/connectors/connectorCreds.js')

const CONFIDENTIAL = { id: 'goog', name: 'Google', clientId: 'fake-client-id', clientSecret: 'fake-client-secret', provider: 'google' }
const gcal = () => {
  store.resetConnectorCache()
  creds.resetConnectorCredsCache()
  const d = store.listConnectors().find((c) => c.id === 'gcalendar')
  return d ? store.toView(d, 0) : undefined
}
const tokenFor = (connectorId: string) => ({
  connectorId, account: 'default', accessToken: 'fake-access-token',
  refreshToken: 'fake-refresh-token', scopes: ['https://www.googleapis.com/auth/calendar'],
  obtainedAt: Date.now(),
})

try {
  // --- no client at all -------------------------------------------------------------------
  catalog([])
  check('with no OAuth client, the connector needs setup',
    gcal()?.needsSetup === true, JSON.stringify(gcal()?.needsSetup))
  check('and the hint tells the operator to CREATE a client',
    (gcal()?.setupHint ?? '').includes('Cloud Console'), gcal()?.setupHint)
  check('and the client half reports NOT ready, so the UI can say "create" rather than "connect"',
    gcal()?.oauthClientReady === false,
    `oauthClientReady=${JSON.stringify(gcal()?.oauthClientReady)} — the browser cannot see whether a ref resolves`)

  // --- a usable client, but nobody has authorized ------------------------------------------
  // THE ASSERTION THIS FILE EXISTS FOR.
  // MUTATION THAT TURNS THIS RED: drop `&& hasToken(d.id)` from oauthReady().
  catalog([CONFIDENTIAL])
  check('a saved, fully-configured client does NOT by itself clear needsSetup',
    gcal()?.needsSetup === true,
    `needsSetup=${JSON.stringify(gcal()?.needsSetup)} — a green toggle here means every tool call 401s`)
  check('and the hint now says AUTHORIZE, not "create a client"',
    (gcal()?.setupHint ?? '').includes('authorize'),
    `${JSON.stringify(gcal()?.setupHint)} — telling someone who just made a client to make one reads as a broken app`)

  // `oauthClientReady` must distinguish the two setup states STRUCTURALLY, so the UI never has
  // to parse the hint's prose to decide what to render.
  // MUTATION THAT TURNS THIS RED: derive oauthClientReady from `!!d.oauthClientRef` instead of
  // from oauthClientUsable — a dangling or secret-less ref then reads as ready to authorize.
  check('with a usable client but no token, the client half reports READY while setup is incomplete',
    gcal()?.oauthClientReady === true && gcal()?.needsSetup === true,
    `oauthClientReady=${JSON.stringify(gcal()?.oauthClientReady)} needsSetup=${JSON.stringify(gcal()?.needsSetup)}`)

  // --- authorized: only now is it ready ----------------------------------------------------
  creds.saveToken(tokenFor('gcalendar'))
  check('once an account is authorized, needsSetup clears',
    gcal()?.needsSetup === undefined,
    `needsSetup=${JSON.stringify(gcal()?.needsSetup)} after a token exists`)
  check('and no setup hint rides along with a row that needs no setup',
    gcal()?.setupHint === undefined, JSON.stringify(gcal()?.setupHint))

  // --- revoking puts it straight back ------------------------------------------------------
  // Derived on every read, never stored — the property the store already had for the client
  // and which must survive being extended to the token.
  creds.removeToken('gcalendar')
  check('removing the token returns the row to needs-setup immediately',
    gcal()?.needsSetup === true, 'derived on read, never stored')

  // A DANGLING ref — set, but resolving to nothing — is exactly the case a client-side guess from
  // `oauthClientRef` presence gets wrong, offering a Connect button that fails with a 400.
  creds.removeToken('gcalendar')
  catalog([])   // builtinOverrides still points gcalendar at 'goog', which no longer exists
  check('a DANGLING oauthClientRef reports the client half as NOT ready',
    gcal()?.oauthClientReady === false,
    `oauthClientReady=${JSON.stringify(gcal()?.oauthClientReady)} — a ref that resolves to nothing is not a usable client`)

  // --- a PUBLIC client needs no secret -----------------------------------------------------
  // Google's Desktop app client type is a public client: loopback redirect, PKCE, no secret.
  // oauthClientUsable's stated ASSUMPTION named this as the line to change if one were ever
  // supported. Pinned so that relaxation cannot silently extend to confidential clients.
  // MUTATION THAT TURNS THIS RED: require clientSecret for every provider again.
  catalog([{ id: 'goog', name: 'Google', clientId: 'fake-client-id', provider: 'google' }])
  creds.saveToken(tokenFor('gcalendar'))
  check('a PUBLIC (Desktop app) client with no secret is usable once authorized',
    gcal()?.needsSetup === undefined,
    `needsSetup=${JSON.stringify(gcal()?.needsSetup)} — a public PKCE client legitimately has no secret`)

  // ...but a CUSTOM/confidential client still must have one.
  // MUTATION THAT TURNS THIS RED: return true unconditionally in oauthClientUsable.
  creds.removeToken('gcalendar')
  catalog([{ id: 'goog', name: 'Custom', clientId: 'fake-client-id', provider: 'custom' }])
  creds.saveToken(tokenFor('gcalendar'))
  check('a CUSTOM client with no secret is still NOT usable — the relaxation is scoped to presets',
    gcal()?.needsSetup === true,
    `needsSetup=${JSON.stringify(gcal()?.needsSetup)} — dropping the secret requirement everywhere is the regression`)
} finally {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CLAUDETTE_DATA_DIR
}

process.exit(fail === 0 ? 0 : 1)
