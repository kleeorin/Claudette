// The connector OAuth token store (server/src/connectors/connectorCreds.ts).
//
// WHAT IS AT STAKE. This file holds REFRESH TOKENS — long-lived bearers for the operator's
// Google account, which unlike access tokens do not expire on their own. Two properties matter
// more than anything else it does: the file is 0600, and a failure NEVER silently destroys a
// token, because the only recovery is a human re-authorizing in a browser and the loss is
// discovered days later when one connector quietly stops working.
//
// NO REAL CREDENTIAL APPEARS HERE, and no token value is ever printed. Every planted token is
// obviously fake, and assertion messages fingerprint rather than echo — same pattern as
// usage-isolation-test.mts, for the same reason: the assertions that FAIL here are exactly the
// ones about mishandled tokens, so a naive message would print the secret in the run that
// proves the bug.

import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import path from 'path'
import { check, failed as fail } from './assert.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'claudette-creds-'))
process.env.CLAUDETTE_DATA_DIR = dir

const store = await import('../server/src/connectors/connectorCreds.js')
const { getToken, saveToken, removeToken, accountsFor, hasToken, resetConnectorCredsCache } = store

const file = path.join(dir, 'connector-creds.json')
// Named fakes, so a fingerprint can say WHICH one it saw without ever printing a value.
const FAKES: Record<string, string> = {
  'access-1': 'fake-access-token-one', 'refresh-1': 'fake-refresh-token-one',
  'access-2': 'fake-access-token-two', 'refresh-2': 'fake-refresh-token-two',
}
const fp = (v: unknown): string => {
  if (typeof v !== 'string') return String(v)
  for (const [name, tok] of Object.entries(FAKES)) if (v === tok) return `<${name}>`
  return `<redacted sha256:${createHash('sha256').update(v).digest('hex').slice(0, 8)} len=${v.length}>`
}
const tok = (over: Partial<{ connectorId: string; account: string; accessToken: string; refreshToken?: string; scopes: string[]; obtainedAt: number; expiresAt: number }> = {}) => ({
  connectorId: 'gcalendar', account: 'default',
  accessToken: FAKES['access-1'], refreshToken: FAKES['refresh-1'],
  scopes: ['https://www.googleapis.com/auth/calendar'], obtainedAt: Date.now(), ...over,
})

try {
  // --- nothing stored --------------------------------------------------------------------
  check('a fresh install holds no tokens', !hasToken('gcalendar') && getToken('gcalendar') === undefined,
    JSON.stringify(accountsFor('gcalendar')))
  check('and writes no file until something is saved', !existsSync(file), file)

  // --- 0600, the property that makes the rest worth doing ---------------------------------
  saveToken(tok())
  check('the token file is 0600 — no other user on the host can read a refresh token',
    (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8))
  check('and the token round-trips', fp(getToken('gcalendar')?.accessToken) === '<access-1>',
    fp(getToken('gcalendar')?.accessToken))

  // --- KEYED BY (connector, account) ------------------------------------------------------
  // The whole point of the composite key: a second person authorizing the same connector must
  // not silently overwrite the first, which would leave session one acting as user two with no
  // visible change at all.
  // MUTATION THAT TURNS THIS RED: key on connectorId alone in keyOf().
  saveToken(tok({ account: 'someone-else@example.com', accessToken: FAKES['access-2'], refreshToken: FAKES['refresh-2'] }))
  check('a second ACCOUNT on the same connector is a separate grant, not an overwrite',
    accountsFor('gcalendar').length === 2, JSON.stringify(accountsFor('gcalendar')))
  check('and each account keeps its own token',
    fp(getToken('gcalendar', 'default')?.accessToken) === '<access-1>'
      && fp(getToken('gcalendar', 'someone-else@example.com')?.accessToken) === '<access-2>',
    `${fp(getToken('gcalendar', 'default')?.accessToken)} / ${fp(getToken('gcalendar', 'someone-else@example.com')?.accessToken)}`)

  // --- REFRESH TOKEN IS OMIT-MEANS-KEEP ---------------------------------------------------
  // A refresh RESPONSE routinely omits refresh_token because the old one is still valid.
  // Writing it through verbatim erases the only long-lived credential held and turns the next
  // expiry into a silent re-auth prompt.
  // MUTATION THAT TURNS THIS RED: drop the `?? c.tokens[i].refreshToken` from saveToken.
  //
  // ★ THE KEY IS PRESENT AND undefined, NOT ABSENT, AND THAT DISTINCTION IS THE WHOLE TEST.
  // An earlier version of this passed an object with no refreshToken key at all and was
  // VACUOUS: spreading an object that lacks a key does not overwrite the existing one, so
  // `{...stored, ...incoming}` preserved the refresh token by accident and the assertion stayed
  // green with the guard deleted. Present-and-undefined is also the shape the real refresh path
  // produces — mapping a token response writes `refreshToken: resp.refresh_token`, which IS the
  // key, set to undefined, when the provider omits it. That spread DOES clobber, which is
  // exactly what the `??` exists to stop.
  const asRefreshResponseWould: { connectorId: string; account: string; accessToken: string; refreshToken?: string; scopes: string[]; obtainedAt: number } = {
    connectorId: 'gcalendar', account: 'default', accessToken: 'fake-access-token-refreshed',
    refreshToken: undefined,   // the provider omitted it; the old one is still valid
    scopes: ['s'], obtainedAt: Date.now(),
  }
  check('the refresh path really does present refreshToken as a PRESENT undefined key',
    'refreshToken' in asRefreshResponseWould && asRefreshResponseWould.refreshToken === undefined,
    'otherwise the assertion below cannot falsify — a merely absent key is preserved by any spread')
  saveToken(asRefreshResponseWould)
  check('a refresh that omits refresh_token KEEPS the stored one rather than erasing it',
    fp(getToken('gcalendar')?.refreshToken) === '<refresh-1>',
    `refresh token is now ${fp(getToken('gcalendar')?.refreshToken)} — omit-means-keep, or the next expiry needs a human`)
  check('while the new access token DID replace the old one',
    getToken('gcalendar')?.accessToken === 'fake-access-token-refreshed',
    fp(getToken('gcalendar')?.accessToken))

  // --- removal ----------------------------------------------------------------------------
  check('removing one account leaves the other',
    removeToken('gcalendar', 'default') === 1 && accountsFor('gcalendar').length === 1,
    JSON.stringify(accountsFor('gcalendar')))
  check('removing an unknown grant reports 0 rather than throwing',
    removeToken('gcalendar', 'nobody@example.com') === 0, 'callers need to tell revoked from absent')
  saveToken(tok())
  check('and removing with no account named forgets every grant for the connector',
    removeToken('gcalendar') === 2 && !hasToken('gcalendar'), JSON.stringify(accountsFor('gcalendar')))

  // --- VALIDATE ON LOAD, not only on save -------------------------------------------------
  // A row with a non-string accessToken becomes `Authorization: Bearer undefined` at the proxy,
  // and the upstream answers 401 — indistinguishable from an expired token, so whoever debugs
  // it re-authorizes instead of looking at this file. Good rows either side, because a lone bad
  // row cannot tell "drop the row" from "empty the list".
  // MUTATION THAT TURNS THIS RED: drop the `.filter(isToken)` in load().
  writeFileSync(file, JSON.stringify({ tokens: [
    { connectorId: 'gdrive', account: 'default', accessToken: FAKES['access-1'], scopes: [], obtainedAt: 1 },
    { connectorId: 'gmail', account: 'default', accessToken: 12345, scopes: [], obtainedAt: 1 },
    { connectorId: 'gdocs', account: '', accessToken: FAKES['access-2'], scopes: [], obtainedAt: 1 },
    { connectorId: 'gsheets', account: 'default', accessToken: FAKES['access-2'], scopes: [], obtainedAt: 1 },
  ] }))
  resetConnectorCredsCache()
  check('a malformed token row is dropped on LOAD, and the good rows either side survive',
    hasToken('gdrive') && hasToken('gsheets') && !hasToken('gmail') && !hasToken('gdocs'),
    `gdrive=${hasToken('gdrive')} gsheets=${hasToken('gsheets')} gmail=${hasToken('gmail')} gdocs=${hasToken('gdocs')}`)
  check('and no caller can receive a non-string access token',
    [getToken('gdrive'), getToken('gsheets')].every((t) => typeof t?.accessToken === 'string'),
    'Bearer undefined reads as an expired token and sends the debugger to the wrong place')

  // --- AN UNPARSEABLE FILE MUST NOT COST EVERY ACCOUNT ITS TOKEN --------------------------
  // Starting empty caches {tokens: []}, so the next authorization persists over the file and
  // destroys every OTHER account's refresh token with it — five silent re-auths discovered days
  // apart. Moving it aside first is what makes that recoverable.
  // MUTATION THAT TURNS THIS RED: remove the renameSync from load()'s catch.
  const sidecars = () => readdirSync(dir).filter((f) => f.endsWith('.corrupt'))
  for (const f of sidecars()) rmSync(path.join(dir, f), { force: true })
  const corrupt = '{ "tokens": [ truncated mid-write'
  writeFileSync(file, corrupt)
  resetConnectorCredsCache()
  check('an unparseable creds file starts empty rather than taking the server down',
    accountsFor('gdrive').length === 0, 'must not throw at load')
  const kept = sidecars().map((f) => readFileSync(path.join(dir, f), 'utf8'))
  check('and the unreadable bytes are MOVED ASIDE — refresh tokens may still be recoverable by hand',
    kept.includes(corrupt),
    sidecars().length ? `sidecar(s) ${JSON.stringify(sidecars())}` : 'no .corrupt sidecar — the tokens are gone for good')
  check('the preserved sidecar is ALSO 0600 — it still holds refresh tokens',
    sidecars().every((f) => (statSync(path.join(dir, f)).mode & 0o777) === 0o600),
    sidecars().map((f) => (statSync(path.join(dir, f)).mode & 0o777).toString(8)).join())
  saveToken(tok({ connectorId: 'gcalendar' }))
  check('so an authorization after the corruption cannot have destroyed the original bytes',
    readdirSync(dir).filter((f) => f.endsWith('.corrupt'))
      .map((f) => readFileSync(path.join(dir, f), 'utf8')).includes(corrupt),
    'the next write must not be what destroys the evidence')

  // --- the file itself --------------------------------------------------------------------
  // A positive, structural assertion: the persisted shape is what load() expects. Phrased as
  // "parses and has a tokens array", not as a negated substring against prose.
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { tokens?: unknown }
  check('the persisted file is a {tokens: [...]} document, the shape load() reads back',
    Array.isArray(onDisk.tokens), JSON.stringify(Object.keys(onDisk)))
} finally {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CLAUDETTE_DATA_DIR
}

process.exit(fail === 0 ? 0 : 1)
