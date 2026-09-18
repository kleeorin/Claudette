// BUILT-IN CONNECTORS — are they really merged at read time, and really overridable?
//
//   npx tsx scratchpad/builtin-connectors-test.mts
//
// GROUP C: no browser, no server, no ports. Drives connectorStore against an isolated
// CLAUDETTE_DATA_DIR.
//
// ── WHAT THIS IS DEFENDING ───────────────────────────────────────────────────────────
// The design decision was built-ins IN CODE, merged into the catalog on every read, rather
// than SEEDED into connectors.json on first run. The difference is invisible until the day
// we correct a URL: a seeded install keeps the broken one forever with no signal. Every
// assertion below is really one question — "is this still a merge, or has something quietly
// turned it into a copy?" — because a copy is what regression looks like here, and it looks
// identical from the UI on the day it happens.
//
// ── [hole] NOT COVERED ───────────────────────────────────────────────────────────────
// The endpoints themselves. Nothing here dials Atlassian or Google, so a wrong URL is
// invisible to this file — it checks the MECHANISM. Also uncovered: the UI affordance for
// `needsSetup` (that the toggle is BLOCKED rather than merely styled) lives in web/src and
// belongs to a browser harness.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CONNECTOR_ID_RE } from '@claudette/shared'

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'builtins-'))
process.env.CLAUDETTE_DATA_DIR = DATA

const store = await import('../server/src/connectors/connectorStore')
const { BUILTIN_CONNECTORS } = await import('../server/src/connectors/builtins')
// needsSetup is derived from BOTH the OAuth client and an authorized token (see oauthReady in
// connectorStore.ts), so reaching the fully-configured state at all requires writing a token.
// connector-creds.json lives under dataDir() too, so the CLAUDETTE_DATA_DIR above isolates it
// along with everything else — this never touches the operator's real credentials.
const creds = await import('../server/src/connectors/connectorCreds')

import { withMarks, passed as pass, failed as fail } from './assert.mjs'
// Indented two spaces, as this file has always printed. See withMarks in assert.mjs.
const ok = withMarks({ indent: '  ' })
const view = (id: string) => {
  const d = store.listConnectors().find((c) => c.id === id)
  return d ? store.toView(d) : undefined
}
const catalogFile = (): string => path.join(DATA, 'connectors.json')
const stored = (): { connectors?: { id: string }[]; builtinOverrides?: Record<string, unknown> } =>
  fs.existsSync(catalogFile()) ? JSON.parse(fs.readFileSync(catalogFile(), 'utf8')) : {}

// ── [1] present with no configuration at all ───────────────────────────────────────
ok('[1] built-ins appear in a catalog that has never been written to',
  BUILTIN_CONNECTORS.every((b) => store.listConnectors().some((c) => c.id === b.id)),
  `catalog=${store.listConnectors().map((c) => c.id).join(',')}`)
ok('[1b] …and nothing was written to disk to make that true (merge, not seed)',
  !fs.existsSync(catalogFile()), `connectors.json exists=${fs.existsSync(catalogFile())}`)

// ── [2] they arrive OFF ────────────────────────────────────────────────────────────
// `enabledByDefault` means "grant to every NEW session"; a connector that arrives switched
// on everywhere is the ungoverned behaviour the whole feature exists to replace.
ok('[2] no built-in is granted to new sessions by default',
  BUILTIN_CONNECTORS.every((b) => !store.defaultGrants().includes(b.id)),
  `defaultGrants=${JSON.stringify(store.defaultGrants())}`)

// ── [3] ids are legal, and comma-free ──────────────────────────────────────────────
// The id IS the MCP server name the engine sees. A comma forges an extra --disallowedTools
// entry (guarded live in rt2-connectors-c.mts), so this is a security property, not style.
ok('[3] every built-in id satisfies CONNECTOR_ID_RE and contains no comma',
  BUILTIN_CONNECTORS.every((b) => CONNECTOR_ID_RE.test(b.id) && !b.id.includes(',')),
  BUILTIN_CONNECTORS.map((b) => b.id).join(','))

// ── [4] the three-state distinction: needs-setup is DERIVED ────────────────────────
ok('[4a] Confluence does NOT need setup (Atlassian does Dynamic Client Registration)',
  view('confluence')?.needsSetup !== true)
ok('[4b] a Google entry DOES need setup (Google has no DCR)',
  view('gmail')?.needsSetup === true)
// ★ A HALF-CONFIGURED CLIENT MUST NOT COUNT. saveOAuthClient requires a clientId but not a
// secret, so "the ref resolves" is a weaker test than "a flow could complete". If this
// cleared needsSetup, the UI would unblock the toggle and the operator would land in the
// fail-at-connect state that was rejected in favour of blocking.
store.saveOAuthClient({ id: 'half', name: 'H', clientId: 'cid', clientSecret: '' })
store.setBuiltinOverride('gmail', { oauthClientRef: 'half' })
ok('[4b2] an OAuth client with NO SECRET does not count as configured',
  view('gmail')?.needsSetup === true,
  view('gmail')?.needsSetup === true ? '' : '← the toggle would unblock into a connect that cannot succeed')
// ★★ SETUP IS A THREE-STATE CHAIN, NOT A SWITCH — CORRECTED 2026-09-17 AGAINST MEASUREMENT.
// [4c] used to assert that pointing a row at a saved OAuth client CLEARS needs-setup, and it
// had been failing for days. The test was wrong, not the code. `oauthReady()` deliberately
// requires the WHOLE chain — `oauthClientUsable(ref) && hasToken(id)` — and its comment gives
// the reason: a client with no authorized token is exactly the fail-at-connect state that
// blocking exists to prevent. The operator pastes a client id, the row goes green, the toggle
// unblocks, and every tool call 401s. Clearing needs-setup at step one would deliver the very
// trap the feature was designed around.
//
// The three states, as measured:
//   no client          → needsSetup, hint "Needs a Google OAuth client (…)"
//   client, no token   → needsSetup, hint "Client configured — now connect the account …"
//   client AND token   → needsSetup absent
store.saveOAuthClient({ id: 'goog', name: 'G', clientId: 'cid', clientSecret: 'sec' })
store.setBuiltinOverride('gmail', { oauthClientRef: 'goog' })
ok('[4c] a configured client alone does NOT clear needs-setup — a token is still required',
  view('gmail')?.needsSetup === true && view('gmail')?.oauthClientRef === 'goog',
  `needsSetup=${String(view('gmail')?.needsSetup)} ref=${String(view('gmail')?.oauthClientRef)}`)
// The row must say which step is outstanding. Telling an operator who has already created a
// client to go and create one is how a correct blocker reads as a broken app — and it is the
// only thing distinguishing this state from the previous one on screen.
ok('[4c2] …and the hint ADVANCES to name the outstanding step, rather than repeating step one',
  view('gmail')?.oauthClientReady === true
    && !!view('gmail')?.setupHint && /connect the account/i.test(view('gmail')!.setupHint!),
  JSON.stringify(view('gmail')?.setupHint))
// Completing the chain is what actually clears it. This is the assertion [4c] was reaching for
// before the OAuth work moved the goalposts, and without it nothing here proves needsSetup can
// EVER go false — the whole block would pass against a row permanently stuck at "needs setup".
creds.saveToken({ connectorId: 'gmail', account: 'default', accessToken: 'at', scopes: ['s'] })
ok('[4c3] ★ completing the chain (client AND token) DOES clear needs-setup',
  view('gmail')?.needsSetup === undefined,
  `needsSetup=${String(view('gmail')?.needsSetup)} — if this never clears, every assertion above passes vacuously`)
// ★ THE ASSERTION THAT PROVES IT IS DERIVED RATHER THAN STORED — and it now runs from the
// CLEARED state, which is the only place it can prove anything.
// ⚠ IT USED TO RUN FROM THE "client, no token" STATE, WHERE needsSetup WAS ALREADY true. It
// therefore passed no matter what the code did: a stored flag, a derived one, or a constant
// `true` are indistinguishable from there. It was GREEN THROUGHOUT the period [4c] was red —
// a check reporting success in exactly the state it was meant to catch.
store.removeOAuthClient('goog')
ok('[4d] DELETING that client puts it straight back to needs-setup (derived, not stored)',
  view('gmail')?.needsSetup === true,
  view('gmail')?.needsSetup === true ? '' : '← a stale stored flag would report configured forever')
// Revoking only the TOKEN must also reopen setup, at the correct step. The two inputs to
// oauthReady are independent and either one going away must reopen it; testing only the client
// leg would leave `hasToken` free to be dropped from the conjunction unnoticed.
store.saveOAuthClient({ id: 'goog', name: 'G', clientId: 'cid', clientSecret: 'sec' })
store.setBuiltinOverride('gmail', { oauthClientRef: 'goog' })
creds.saveToken({ connectorId: 'gmail', account: 'default', accessToken: 'at', scopes: ['s'] })
ok('[4d2] …and so does revoking only the TOKEN, back to the connect-the-account step',
  (creds.removeToken('gmail'), view('gmail')?.needsSetup === true
    && /connect the account/i.test(view('gmail')?.setupHint ?? '')),
  `needsSetup=${String(view('gmail')?.needsSetup)} hint=${JSON.stringify(view('gmail')?.setupHint)}`)

// ── [4e] the hint travels WITH the state it explains ───────────────────────────────
// Carried on the view rather than duplicated in web/src: the text lives beside the
// definitions (BUILTIN_SETUP_HINT) so it cannot drift from them, and a copy in the client
// would recreate exactly the drift that placement avoids.
// Back to the virgin state for the hint check: clear the ref, the client AND the token, so
// this reads the STEP-ONE hint rather than the "now connect the account" one left behind by
// [4d2]. Without the token removal it would assert against whichever state happened to survive.
store.setBuiltinOverride('gmail', { oauthClientRef: undefined })
store.removeOAuthClient('goog')
creds.removeToken('gmail')
ok('[4e] a needs-setup row carries its per-product setupHint',
  !!view('gmail')?.setupHint && view('gmail')!.setupHint!.includes('Gmail'),
  JSON.stringify(view('gmail')?.setupHint))
ok('[4e2] …and a row that needs NO setup carries none (an instruction to do nothing reads as a fault)',
  view('confluence')?.setupHint === undefined)

// ── [5] an edit is an OVERRIDE, not a stored copy ──────────────────────────────────
// This is the assertion that catches the whole design silently reverting to seeding.
ok('[5] editing a built-in writes an override, and NO connector def, to disk',
  !(stored().connectors ?? []).some((c) => c.id === 'gmail') && !!stored().builtinOverrides?.gmail,
  `stored connectors=${JSON.stringify((stored().connectors ?? []).map((c) => c.id))}`)

// ── [6] hide is reversible, and it is not deletion ─────────────────────────────────
ok('[6a] removing a built-in hides it', store.removeConnector('gcalendar') && !view('gcalendar'))
store.resetConnectorCache()
ok('[6b] …and it stays hidden across a reload (the override persisted)', !view('gcalendar'))
store.setBuiltinOverride('gcalendar', { hidden: false })
ok('[6c] …and un-hiding brings it back (hiding is reversible, unlike deleting)', !!view('gcalendar'))

// ── [7] a user connector with the same id wins OUTRIGHT ────────────────────────────
// Not a field-by-field merge: blending two definitions the operator thinks are separate
// produces behaviour neither of them describes.
store.saveConnector({ id: 'confluence', name: 'My own Confluence', transport: 'http', url: 'https://example.invalid/mcp' })
const conf = store.listConnectors().filter((c) => c.id === 'confluence')
ok('[7a] exactly ONE entry survives the id collision', conf.length === 1, `count=${conf.length}`)
ok('[7b] …and it is the USER\'s, with no field inherited from the built-in',
  conf[0]?.name === 'My own Confluence' && conf[0]?.url === 'https://example.invalid/mcp' && !conf[0]?.builtin,
  `name=${conf[0]?.name} builtin=${conf[0]?.builtin}`)

// ── [8] built-in tool classification survives a restart ────────────────────────────
// A built-in has no stored def to hang `tools` on. If that classification lived only in
// memory, every built-in would contribute ZERO deny rules for the first turn after a
// restart — launch() is synchronous and runs from restore() with nothing dialled, so it
// cannot wait for a probe. Fail-open, at exactly the wrong moment.
store.setTools('gdrive', [{ name: 'read_file', write: false }, { name: 'write_file', write: true }])
store.resetConnectorCache()
ok('[8] tool classification for a built-in is PERSISTED, not held in memory',
  (store.toolsOf('gdrive') ?? []).length === 2,
  `toolsOf(gdrive)=${JSON.stringify(store.toolsOf('gdrive'))}`)

fs.rmSync(DATA, { recursive: true, force: true })
console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
