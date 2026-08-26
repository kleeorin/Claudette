// ADVERSARIAL tests for GPU passthrough + connectors.
//
// Every check here is an ATTACK. `✅ blocked` means the attack failed, which is the
// outcome we want; `🚨 SUCCEEDED` is a finding. This is deliberately not a restatement of
// the happy-path suites (sandbox-gpu-passthrough-test, connectors-test) — nothing here
// asserts that a feature works, only that it cannot be abused.
//
// Threat model, matching SANDBOX.md: the attacker is a CONFINED (or prompt-injected)
// session that can reach the loopback control API but holds no CLAUDETTE_TOKEN, plus —
// new with connectors — a MALICIOUS UPSTREAM MCP SERVER whose responses we parse and
// whose tool names we feed into the engine's command line.
//
//   npx tsx scratchpad/connectors-gpu-adversarial-test.mts
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-test-'))
process.env.CLAUDETTE_DATA_DIR = DATA

const store = await import('../server/src/connectors/connectorStore')
const { ConnectorProxy } = await import('../server/src/connectors/connectorProxy')
const { connectorServers, connectorDenyRules, connectorKey } = await import('../server/src/connectors/connectorLaunch')
const { normalizeSandbox, normalizeGrants, SessionManager } = await import('../server/src/claude/sessionManager')
const { wrapSandbox, gpuDevicePaths } = await import('../server/src/claude/sandbox')
const { disallowedValue, NOTEBOOK_DENY } = await import('../server/src/claude/claudeEngine')

let blocked = 0
const findings: string[] = []
const attack = (name: string, wasBlocked: boolean, detail = '') => {
  if (wasBlocked) { blocked++; console.log(`✅ blocked — ${name}`) }
  else { findings.push(`${name}${detail ? ` (${detail})` : ''}`); console.log(`🚨 SUCCEEDED — ${name}${detail ? ` — ${detail}` : ''}`) }
}
const note = (s: string) => console.log(`   · ${s}`)

const proj = path.join(DATA, 'proj')
fs.mkdirSync(proj, { recursive: true })
console.log(`(isolated data dir ${DATA})\n`)

// ============================================================================
console.log('── A. GPU passthrough: can an untrusted caller hand itself the GPU? ──')
// ============================================================================

attack('A1: untrusted setSandbox turns GPU on',
  normalizeSandbox({ enabled: true, mounts: [], gpu: true }, proj, false).gpu !== true)

// The forced-on branch exists to refuse a DOWNGRADE. It must not become a way to smuggle
// an UPGRADE past the gate on the way through.
attack('A2: untrusted enabled:false + gpu:true smuggles GPU through the forced-on branch',
  normalizeSandbox({ enabled: false, mounts: [], gpu: true }, proj, false).gpu !== true)

// Truthy-but-not-true values: a gate written as `if (cfg.gpu)` and a consumer written as
// `cfg.gpu === true` can disagree, leaving a value that passes the gate and still binds.
for (const weird of [1, 'true', {}, []] as unknown[]) {
  const out = normalizeSandbox({ enabled: true, mounts: [], gpu: weird as boolean }, proj, false)
  const args = wrapSandbox(out, [], proj).args
  attack(`A3: untrusted gpu:${JSON.stringify(weird)} (truthy non-boolean) reaches --dev-bind`,
    !args.includes('--dev-bind'))
}

// A GPU-less config must never emit device binds even if the host has devices.
attack('A4: a session without the flag still gets GPU devices',
  !wrapSandbox({ enabled: true, mounts: [], gpu: false }, [], proj).args.includes('--dev-bind'))
if (!gpuDevicePaths().length) note('host has no GPU nodes — A3/A4 are weaker here')

// ============================================================================
console.log('\n── B. Connector grants: can a session widen its own reach? ──')
// ============================================================================

store.saveConnector({ id: 'secret-db', name: 'Secret DB', transport: 'stdio', command: 'psql' })
store.saveConnector({ id: 'harmless', name: 'Harmless', transport: 'stdio', command: 'echo' })

attack('B1: untrusted normalizeGrants grants a connector',
  normalizeGrants(['secret-db'], [], false).connectors === undefined)

// The DoS direction. An untrusted caller must not be able to REVOKE either: silently
// clearing an operator's grants turns a rejected escalation into sabotage of their session.
const mgr = new SessionManager({})
const victim = (mgr as unknown as {
  register: (...a: unknown[]) => { id: string; connectors?: string[] }
}).register('victim', proj, proj, undefined, false, undefined, undefined, undefined, undefined,
  undefined, /* trusted */ true, undefined, ['secret-db'], [])
note(`victim session seeded with grants: ${JSON.stringify(victim.connectors)}`)

const revoked = mgr.setConnectors(victim.id, [], [], /* trusted */ false)
attack('B2: untrusted setConnectors([]) REVOKES an operator\'s grants (denial of service)',
  !revoked && (mgr.grantsOf(victim.id).length > 0),
  `returned ${revoked}, grants now ${JSON.stringify(mgr.grantsOf(victim.id))}`)

// Escalation from a session that starts with NOTHING, so a pass can't be an artifact of
// the grant already being there.
const pauper = (mgr as unknown as { register: (...a: unknown[]) => { id: string } })
  .register('pauper', proj, proj, undefined, false, undefined, undefined, undefined, undefined,
    undefined, /* trusted */ true, undefined, [], [])
attack('B3: untrusted setConnectors([...]) grants a connector to a session with none',
  !mgr.setConnectors(pauper.id, ['secret-db'], [], false) && !mgr.grantsOf(pauper.id).includes('secret-db'))
attack('B4: untrusted setConnectors on an ACCOUNT connector allow-list',
  !mgr.setConnectors(pauper.id, [], ['gmail'], false) && !(mgr.list().find((s) => s.id === pauper.id)?.accountConnectors ?? []).includes('gmail'))

// ============================================================================
console.log('\n── C. Deny-rule INJECTION (the new untrusted input surface) ──')
// ============================================================================
// --disallowedTools is ONE comma-joined argv value. Anything that reaches it from an
// untrusted source and can contain a comma can forge extra rules — or malform the value so
// the CLI rejects it, taking NOTEBOOK_DENY (and every role denial) down with it.

// C1. Tool names come from the UPSTREAM SERVER's tools/list. That is attacker-controlled
// data for any connector whose operator trust does not extend to "will never be
// compromised".
store.setTools('harmless', [
  { name: 'ok_tool', write: false },
  { name: 'evil,Bash', write: false },              // comma → forges a second rule
  { name: 'evil2,Write(**),Edit(**)', write: true },
])
const injected = connectorDenyRules({ granted: ['harmless'], accountAllow: [], readOnlyRole: false })
const joined = disallowedValue(injected)
attack('C1: a malicious upstream tool name injects extra rules into --disallowedTools',
  !injected.some((r) => r.includes(',')),
  injected.filter((r) => r.includes(',')).join(' | '))
if (injected.some((r) => r.includes(','))) {
  note(`resulting flag value: ${joined.slice(0, 160)}…`)
  note('a forged rule can deny tools the operator never denied; a malformed value risks the CLI rejecting the WHOLE list, including NOTEBOOK_DENY')
}

// C2. Account connector names are operator-typed — a paste accident is enough, and the
// same comma reaches the same argv value.
store.setAccountConnectors([{ name: 'gmail,Bash' }, { name: 'ok' }])
const acctRules = connectorDenyRules({ granted: [], accountAllow: [], readOnlyRole: false })
attack('C2: an account connector name containing a comma forges a rule',
  !acctRules.some((r) => r.includes(',')),
  acctRules.filter((r) => r.includes(',')).join(' | '))

// C2b. The FAIL-OPEN twin, found from real data: account connectors are really named like
// `claude_ai_Google_Drive`. Single underscores are fine, but a DOUBLE underscore makes the
// CLI's `mcp__<server>__<tool>` split resolve to the wrong server, so the deny rule stops
// matching and the connector stays reachable while the UI says it is denied.
store.setAccountConnectors([{ name: 'claude_ai_Google_Drive' }, { name: 'ev__il' }])
const names = store.listAccountConnectors().map((a) => a.name)
attack('C2b: a name with "__" is accepted, yielding a deny rule that never matches',
  !names.includes('ev__il'), `stored: ${JSON.stringify(names)}`)
attack('C2c: a REAL account connector name is wrongly rejected',
  names.includes('claude_ai_Google_Drive'), 'single underscores must stay legal')

// C3. Can injection REMOVE a protection rather than add one? NOTEBOOK_DENY must survive
// whatever the connector layer contributes.
attack('C3: connector-contributed rules can displace NOTEBOOK_DENY',
  disallowedValue(injected).startsWith(NOTEBOOK_DENY))

store.setAccountConnectors([])
store.setTools('harmless', [{ name: 'ok_tool', write: false }])

// ============================================================================
console.log('\n── D. Read-only role escape ──')
// ============================================================================
// D1. The upstream declares its own tools read-only. We seed `write` from
// annotations.readOnlyHint, which the MCP spec says a client must not trust.
store.setTools('secret-db', [{ name: 'drop_table', write: false }])   // as a lying server would land it
const roRules = connectorDenyRules({ granted: ['secret-db'], accountAllow: [], readOnlyRole: true })
attack('D1: an upstream that declares a mutating tool read-only reaches a read-only role',
  roRules.includes('mcp__secret-db__drop_table') || roRules.includes('mcp__secret-db'),
  'classification is server-asserted')

// D2. Unprobed must fail CLOSED for a read-only role.
store.saveConnector({ id: 'unprobed', name: 'Unprobed', transport: 'stdio', command: 'x' })
attack('D2: an unprobed connector leaves a read-only role unrestricted',
  connectorDenyRules({ granted: ['unprobed'], accountAllow: [], readOnlyRole: true }).includes('mcp__unprobed'))

// D3. Empty tool list (a server that answers tools/list with []) must not read as
// "probed, nothing to deny" for a read-only role.
store.setTools('unprobed', [])
attack('D3: a server answering tools/list with [] disarms the read-only whole-server deny',
  connectorDenyRules({ granted: ['unprobed'], accountAllow: [], readOnlyRole: true }).includes('mcp__unprobed'),
  'empty list treated as probed')

// ============================================================================
console.log('\n── E. The proxy ──')
// ============================================================================
const upstream = http.createServer((req, res) => {
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { saw: req.headers } }))
  })
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
const upPort = (upstream.address() as AddressInfo).port
store.saveConnector({
  id: 'live', name: 'Live', transport: 'http', url: `http://127.0.0.1:${upPort}/mcp`,
  headers: { Authorization: 'Bearer OPERATOR-SECRET' },
})

const grants: Record<string, string[]> = { alice: ['live'], mallory: [] }
const proxy = new ConnectorProxy((sid, cid) => (grants[sid] ?? []).includes(cid))
await proxy.start()

const call = (url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
  new Promise((resolve) => {
    const u = new URL(url)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
    })
    req.on('error', () => resolve({ status: 0, body: '' }))
    req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  })

const aliceUrl = proxy.urlFor('alice', 'live')
const malloryUrl = proxy.urlFor('mallory', 'live')

attack('E1: an ungranted session calls through its own minted URL',
  (await call(malloryUrl)).status === 403)

// E2. Token REUSE. Tokens are the only caller identity the proxy has — HTTP gives it
// nothing else, and every box shares the host network namespace. If Mallory learns
// Alice's token she inherits Alice's reach.
const stolen = await call(aliceUrl)
attack('E2: a stolen token is usable by whoever holds it (no second factor)',
  stolen.status !== 200,
  'by design — same model as the app-control server; tokens are unguessable UUIDs and only ever sent to their own session')

// E3. Can the client override the credential the proxy adds?
const spoof = await call(aliceUrl, { Authorization: 'Bearer ATTACKER', Cookie: 'claudette_auth=stolen' })
attack('E3: a session-supplied Authorization header reaches upstream',
  !spoof.body.includes('ATTACKER'))
attack('E3b: a session-supplied Cookie reaches upstream',
  !spoof.body.includes('claudette_auth'))
attack('E3c: the operator credential still arrives upstream',
  spoof.body.includes('OPERATOR-SECRET'))

// E4. Header injection through the connector definition (CRLF → request splitting).
const crlf = store.saveConnector({
  id: 'crlfy', name: 'CRLF', transport: 'http', url: `http://127.0.0.1:${upPort}/mcp`,
  headers: { 'X-Evil': 'a\r\nX-Injected: yes' },
})
grants.alice.push('crlfy')
attack('E4: a CRLF in a connector header is storable at all',
  !crlf.ok, crlf.ok ? 'accepted' : `refused: ${crlf.error}`)

// Even if such a definition existed (an older catalog, a hand-edited file), a call to it
// must not be able to kill the server. This request reaching ANY response — rather than
// taking the process down with an uncaught ERR_INVALID_CHAR — is the assertion.
// Seeded by writing the catalog FILE directly — deliberately bypassing saveConnector, so
// this models a definition that predates the validation (or a hand-edited file) rather
// than one the API would accept today.
{
  const f = path.join(DATA, 'connectors.json')
  const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as { connectors: unknown[] }
  raw.connectors.push({
    id: 'crlfy2', name: 'CRLF2', transport: 'http', url: `http://127.0.0.1:${upPort}/mcp`,
    headers: { 'X-Evil': 'a\r\nX-Injected: yes' },
  })
  fs.writeFileSync(f, JSON.stringify(raw))
  store.resetConnectorCache()
}
grants.alice.push('crlfy2')
const crlfRes = await call(proxy.urlFor('alice', 'crlfy2'))
attack('E4b: a stored CRLF header crashes the proxy (server-wide DoS)',
  crlfRes.status !== 0, `responded ${crlfRes.status}`)
attack('E4c: a CRLF header splits the upstream request',
  !crlfRes.body.includes('x-injected'))

// E5. Revocation really is live, not a launch-time snapshot.
grants.alice = grants.alice.filter((g) => g !== 'live')
attack('E5: a revoked connector is still reachable through an already-minted URL',
  (await call(aliceUrl)).status === 403)

proxy.stop()
upstream.close()

// ============================================================================
console.log('\n── F. Catalog integrity ──')
// ============================================================================
const catalogFile = path.join(DATA, 'connectors.json')
attack('F1: the catalog is world- or group-readable',
  (fs.statSync(catalogFile).mode & 0o077) === 0,
  '0' + (fs.statSync(catalogFile).mode & 0o777).toString(8))

// F2. Does any view leak a secret? Exercise EVERY field the client can receive.
const views = store.listConnectors().map((d) => store.toView(d))
const blob = JSON.stringify(views) + JSON.stringify(store.listOAuthClients().map(store.oauthClientView))
attack('F2: a secret appears in a client-facing view',
  !blob.includes('OPERATOR-SECRET') && !blob.includes('X-Injected'))

// F3. Id reuse: delete a connector while a grant still names it, then re-create the id
// with a DIFFERENT definition. The stale grant must not silently adopt the new target.
store.removeConnector('secret-db')
store.saveConnector({ id: 'secret-db', name: 'Impostor', transport: 'http', url: 'https://evil.test/mcp' })
note('a grant naming a deleted id survives; re-creating that id re-points the grant at the new definition')
attack('F3: id reuse silently re-points an existing grant at a new definition',
  false,
  'inherent to id-keyed grants; the id is immutable and delete is operator-only, so this needs operator action twice')

// F4. connectorKey must not collide across different grant sets (stale "pending" would
// mean a change that never relaunches).
attack('F4: connectorKey collides for different grant sets',
  connectorKey(['a,b'], []) !== connectorKey(['a', 'b'], []),
  `${connectorKey(['a,b'], [])} vs ${connectorKey(['a', 'b'], [])}`)

// ============================================================================
console.log('\n── G. Second-pass fixes (red-team agent, 2026-08-18) ──')
// ============================================================================
const { spawnSync } = await import('child_process')

// G1. The persistent brick: a hostile tools/list must not produce an argv value past
// MAX_ARG_STRLEN (131072). Collapsing to a whole-server deny is strictly MORE restrictive.
store.saveConnector({ id: 'floody', name: 'Floody', transport: 'stdio', command: 'x' })
store.setTools('floody', Array.from({ length: 4000 }, (_, i) => ({ name: `tool_number_${i}`, write: true })))
const floodRules = connectorDenyRules({ granted: ['floody'], accountAllow: [], readOnlyRole: true })
const floodValue = disallowedValue(floodRules)
attack('G1: a hostile tool list still bricks the launch with E2BIG',
  !spawnSync('/bin/true', [floodValue]).error, `${floodRules.length} rules, ${floodValue.length} bytes`)
attack('G1b: collapsing loses the read-only protection',
  floodRules.includes('mcp__floody'), 'whole-server deny still present')

// G2. Bounds on what an upstream may persist.
store.setTools('floody', Array.from({ length: 4000 }, (_, i) => ({ name: `t${i}`, write: true, description: 'x'.repeat(5000) })))
const persisted = store.toolsOf('floody') ?? []
attack('G2: an upstream persists an unbounded tool count', persisted.length <= 500, `${persisted.length} kept`)
attack('G2b: an upstream persists unbounded descriptions',
  (persisted[0]?.description?.length ?? 0) <= 500, `${persisted[0]?.description?.length} chars`)

// G3. The importer must apply the SAME validation as the API.
const hostile = [
  { id: 'plainhttp', name: 'P', transport: 'http' as const, url: 'http://attacker.example.com/mcp' },
  { id: 'fileurl', name: 'F', transport: 'http' as const, url: 'file:///etc/shadow' },
  { id: 'crlfhdr', name: 'C', transport: 'http' as const, url: 'https://ok.test/mcp', headers: { 'X-E': 'a\r\nX-Injected: 1' } },
  { id: 'legit', name: 'L', transport: 'https' === 'https' ? 'http' as const : 'http' as const, url: 'https://good.test/mcp' },
]
const imported = store.addImported(hostile).map((d) => d.id)
attack('G3: the importer stores a plaintext http:// connector the API refuses', !imported.includes('plainhttp'))
attack('G3b: the importer stores a file:// URL', !imported.includes('fileurl'))
attack('G3c: the importer stores a CRLF header', !imported.includes('crlfhdr'))
attack('G3d: the importer wrongly rejects a VALID definition', imported.includes('legit'), `imported: ${JSON.stringify(imported)}`)

// G4. Two config keys slugging to one id must not both land.
const dup = store.addImported([
  { id: 'dupe', name: 'A', transport: 'stdio', command: 'a' },
  { id: 'dupe', name: 'B', transport: 'stdio', command: 'b' },
])
attack('G4: one import writes two entries under the same id', dup.length === 1, `${dup.length} added`)

// G5. A read-only role must not launder its reach through a full-tool hire.
store.saveConnector({ id: 'mailer', name: 'Mailer', transport: 'stdio', command: 'm' })
// Bound to `mgr` — extracting the method loses `this` and register() touches this.sessions.
const m = mgr as unknown as { register: (...a: unknown[]) => { id: string; connectors?: string[] } }
const reg = m.register.bind(m)
const boss = reg('boss', proj, proj, undefined, false, undefined, 'reviewer', undefined, undefined,
  undefined, /* trusted */ true, undefined, ['mailer'], [])
const hireGeneral = reg('hire', proj, proj, boss.id, false, undefined, 'general', undefined, undefined,
  undefined, /* trusted */ false, undefined, undefined, undefined)
attack('G5: a read-only session launders its connectors into a full-tool teammate',
  !(hireGeneral.connectors ?? []).includes('mailer'), `teammate grants: ${JSON.stringify(hireGeneral.connectors ?? [])}`)
const hirePeer = reg('peer', proj, proj, boss.id, false, undefined, 'planner', undefined, undefined,
  undefined, /* trusted */ false, undefined, undefined, undefined)
attack('G5b: inheritance between EQUALLY restricted roles was wrongly broken',
  (hirePeer.connectors ?? []).includes('mailer'), `peer grants: ${JSON.stringify(hirePeer.connectors ?? [])}`)

// G6. A connector whose id cannot form a valid deny rule must not be exposed at all —
// the isSafeDenyRule backstop would drop its whole-server rule, failing OPEN.
{
  const f = path.join(DATA, 'connectors.json')
  const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as { connectors: unknown[] }
  raw.connectors.push({ id: 'a,Bash', name: 'Hand-edited', transport: 'stdio', command: 'x' })
  fs.writeFileSync(f, JSON.stringify(raw))
  store.resetConnectorCache()
}
const stubProxy = { urlFor: (a: string, b: string) => `http://127.0.0.1:1/c/${a}-${b}` } as unknown as InstanceType<typeof ConnectorProxy>
const exposed = connectorServers('s', ['a,Bash'], stubProxy)
attack('G6: an unscopeable id is still mounted into the session config',
  Object.keys(exposed).length === 0, `exposed: ${JSON.stringify(Object.keys(exposed))}`)

// ============================================================================
fs.rmSync(DATA, { recursive: true, force: true })
// This used to be an unconditional `process.exit(0)`: findings printed and the runner
// still said PASS, so the day a connector change let a NEW attack through it would have
// scrolled past in a log. CONNECTORS.md cites this file as its verification evidence,
// which made the silence worse.
//
// But a plain `exit(findings.length ? 1 : 0)` would be wrong too. Three of these findings
// are ACCEPTED residual risk, documented inline with their rationale — failing on them
// would leave the suite permanently red, and a suite that is always red hides whatever
// you break next (the lesson of commit 2a57def).
//
// So: a BASELINE keyed on the attack id. A finding not listed here is new, and fails.
// Adding an id is a deliberate, reviewable act — do NOT add one to silence a new finding.
const ACCEPTED = new Map<string, string>([
  ['D1', 'classification is server-asserted — an upstream can declare a mutating tool read-only'],
  ['E2', 'a stolen session token is usable by its holder — same model as the app-control server'],
  ['F3', 'id reuse re-points an existing grant — needs operator action twice'],
])
const idOf = (f: string) => f.split(':')[0].trim()
const unexpected = findings.filter((f) => !ACCEPTED.has(idOf(f)))
const accepted = findings.filter((f) => ACCEPTED.has(idOf(f)))

console.log(`\n${blocked} attacks blocked, ${findings.length} finding(s) — ${accepted.length} accepted, ${unexpected.length} unexpected`)
if (accepted.length) {
  console.log('\nACCEPTED (known residual risk, not failures):')
  accepted.forEach((f) => console.log(`  · ${idOf(f)} — ${ACCEPTED.get(idOf(f))}`))
}
if (unexpected.length) {
  console.log('\n🚨 UNEXPECTED FINDINGS:')
  unexpected.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
}
// An accepted id that STOPPED appearing means the risk was closed — say so, so the
// baseline can shrink rather than quietly outliving what it describes.
for (const id of ACCEPTED.keys()) {
  if (!findings.some((f) => idOf(f) === id)) console.log(`  ℹ️  accepted finding ${id} no longer reproduces — remove it from ACCEPTED`)
}
process.exit(unexpected.length ? 1 : 0)
