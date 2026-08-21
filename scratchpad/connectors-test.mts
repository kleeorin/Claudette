// Tests for connectors — external MCP servers as per-session, operator-granted reach
// (shared/src/connectors.ts, server/src/connectors/*).
//
// The properties that matter, and why each is a test rather than a comment:
//   1. An id that breaks `mcp__<server>__<tool>` breaks EVERY turn of a granted session,
//      and an id containing '__' silently unmatches every deny rule written against it.
//   2. Secrets travel inward only. toView must redact headers, env, args AND the URL's
//      userinfo/query — an earlier draft leaked the last two while claiming otherwise.
//   3. Reach is trust-gated ON, the same shape as sandbox.enabled being gated OFF.
//   4. The proxy is what makes a grant real: the credential never reaches the session,
//      and a revocation bites the NEXT call with no relaunch.
//   5. A read-only role must not gain a mutating tool just because it arrived over MCP —
//      including when we have never probed the connector.
//
// Runs against a real loopback upstream, so the proxy is exercised end to end.
//   npx tsx scratchpad/connectors-test.mts
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'

// Isolate the catalog BEFORE anything imports the store (dataDir reads this at call time,
// but the import order still matters for the cache).
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-test-'))
process.env.CLAUDETTE_DATA_DIR = DATA

const {
  saveConnector, removeConnector, listConnectors, toView, getConnector, setTools, toolsOf,
  saveOAuthClient, removeOAuthClient, setAccountConnectors, listAccountConnectors,
  strictMode, setStrictMode, addImported, defaultGrants, resetConnectorCache, deleteCatalogFile,
} = await import('../server/src/connectors/connectorStore')
const { ConnectorProxy } = await import('../server/src/connectors/connectorProxy')
const { connectorServers, connectorDenyRules, connectorKey } = await import('../server/src/connectors/connectorLaunch')
const { normalizeGrants } = await import('../server/src/claude/sessionManager')
const { connectorIdError, toolNameUsable, denyAllRule, composedToolName } = await import('../shared/src/connectors')

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}
console.log(`(catalog isolated in ${DATA})\n`)

// --- 1. Id validation ---------------------------------------------------------
check('id: rejects underscores (they break mcp__server__tool attribution)', !!connectorIdError('my_server'))
check('id: rejects the reserved "app" (it would shadow the app-control server)', !!connectorIdError('app'))
check('id: rejects empty', !!connectorIdError(''))
check('id: rejects >24 chars', !!connectorIdError('a'.repeat(25)))
check('id: rejects leading hyphen', !!connectorIdError('-lead'))
check('id: accepts a normal slug', connectorIdError('github-issues') === null)
check('composed name: mcp__id__tool', composedToolName('gh', 'list') === 'mcp__gh__list')
check('tool name: rejects one too long once prefixed', !toolNameUsable('gh', 'x'.repeat(130)))
check('tool name: rejects illegal characters', !toolNameUsable('gh', 'bad name!'))
check('tool name: accepts a normal one', toolNameUsable('gh', 'list_issues'))
check('deny rule: whole-server form', denyAllRule('gh') === 'mcp__gh')

// --- 2. Store: validation on save --------------------------------------------
check('save: refuses http:// to a non-loopback host (bearer tokens on the wire)',
  saveConnector({ id: 'plain', name: 'Plain', transport: 'http', url: 'http://example.com/mcp' }).ok === false)
check('save: allows http:// to 127.0.0.1',
  saveConnector({ id: 'local', name: 'Local', transport: 'http', url: 'http://127.0.0.1:9/mcp' }).ok === true)
check('save: refuses an http connector with no url',
  saveConnector({ id: 'nourl', name: 'No URL', transport: 'http' }).ok === false)
check('save: refuses a stdio connector with no command',
  saveConnector({ id: 'nocmd', name: 'No cmd', transport: 'stdio' }).ok === false)
check('save: refuses an unknown oauth client ref',
  saveConnector({ id: 'oauthy', name: 'O', transport: 'http', url: 'https://x.test/mcp', oauthClientRef: 'nope' }).ok === false)

const gh = saveConnector({
  id: 'gh', name: 'GitHub', transport: 'http',
  url: 'https://user:s3cr3t@api.test/mcp?token=SUPERSECRET',
  headers: { Authorization: 'Bearer TOPSECRET' },
})
check('save: a valid http connector is stored', gh.ok === true)

const pg = saveConnector({
  id: 'pg', name: 'Postgres', transport: 'stdio',
  command: 'mcp-postgres', args: ['postgres://user:pw@db/app'], env: { PGPASSWORD: 'hunter2' },
})
check('save: a valid stdio connector is stored', pg.ok === true)

// --- 3. Redaction -------------------------------------------------------------
const ghView = toView(getConnector('gh')!)
const viewJson = JSON.stringify(ghView)
check('view: no header VALUE leaks', !viewJson.includes('TOPSECRET'))
check('view: header NAMES are shown (the operator has to see what is set)',
  ghView.headerKeys.includes('Authorization'))
check('view: URL userinfo does not leak', !viewJson.includes('s3cr3t'))
check('view: URL query does not leak', !viewJson.includes('SUPERSECRET'))
check('view: urlDisplay is scheme+host only', ghView.urlDisplay === 'https://api.test')
const pgView = toView(getConnector('pg')!)
const pgJson = JSON.stringify(pgView)
check('view: stdio env value does not leak', !pgJson.includes('hunter2'))
check('view: stdio args (connection strings) do not leak', !pgJson.includes('postgres://user:pw@db/app'))
check('view: hasArgs still reports that args exist', pgView.hasArgs === true)

// --- 4. Secrets are omit-means-keep ------------------------------------------
// The client never RECEIVES a secret, so a round-tripped edit form legitimately posts
// without one. Treating that as "clear it" would silently break the connector.
saveConnector({ id: 'gh', name: 'GitHub Renamed', transport: 'http', url: 'https://api.test/mcp' })
check('edit: omitting headers KEEPS them', getConnector('gh')!.headers?.Authorization === 'Bearer TOPSECRET')
check('edit: the display name did change', getConnector('gh')!.name === 'GitHub Renamed')

// --- 5. OAuth clients ---------------------------------------------------------
saveOAuthClient({ id: 'google', name: 'Google', clientId: 'cid', clientSecret: 'csecret' })
saveConnector({ id: 'gcal', name: 'Calendar', transport: 'http', url: 'https://cal.test/mcp', oauthClientRef: 'google' })
check('oauth client: cannot be deleted while a connector references it',
  removeOAuthClient('google').ok === false)
check('oauth client: secret is never in its view',
  !JSON.stringify((await import('../server/src/connectors/connectorStore')).oauthClientView(
    { id: 'google', name: 'Google', clientId: 'cid', clientSecret: 'csecret' })).includes('csecret'))
removeConnector('gcal')
check('oauth client: deletable once unreferenced', removeOAuthClient('google').ok === true)

// --- 6. Account connectors + strict mode persist -----------------------------
setAccountConnectors([{ name: 'gmail' }, { name: 'gmail' }, { name: '' }, { name: 'drive' }])
check('account: de-duped and blanks dropped (an empty name would emit the illegal rule "mcp__")',
  listAccountConnectors().map((a) => a.name).join(',') === 'gmail,drive')
setStrictMode(true)
resetConnectorCache()
check('persistence: strict mode survives a reload', strictMode() === true)
check('persistence: account connectors survive a reload', listAccountConnectors().length === 2)
check('persistence: connectors survive a reload', listConnectors().some((c) => c.id === 'gh'))
setStrictMode(false)

// --- 7. Import is idempotent --------------------------------------------------
const before = listConnectors().length
addImported([{ id: 'gh', name: 'dup', transport: 'http', url: 'https://x.test' }])
check('import: an existing id is skipped, not duplicated', listConnectors().length === before)
addImported([{ id: 'bad__id', name: 'bad', transport: 'http', url: 'https://x.test' }])
check('import: an invalid id is rejected', !listConnectors().some((c) => c.id === 'bad__id'))

// --- 8. enabledByDefault --------------------------------------------------------
check('defaults: nothing is granted by default until marked', !defaultGrants().includes('gh'))
saveConnector({ id: 'gh', name: 'GitHub Renamed', transport: 'http', url: 'https://api.test/mcp', enabledByDefault: true })
check('defaults: a marked connector is in the default grant set', defaultGrants().includes('gh'))
saveConnector({ id: 'gh', name: 'GitHub Renamed', transport: 'http', url: 'https://api.test/mcp', enabledByDefault: false })

// --- 9. Trust gate ------------------------------------------------------------
check('grants: an UNTRUSTED grant is refused', normalizeGrants(['gh'], [], false).connectors === undefined)
check('grants: a TRUSTED grant is kept', normalizeGrants(['gh'], [], true).connectors?.[0] === 'gh')
check('grants: an untrusted ACCOUNT allow is refused too',
  normalizeGrants([], ['gmail'], false).accountConnectors === undefined)
check('grants: empty stays absent, not []', normalizeGrants([], [], true).connectors === undefined)
check('grants: duplicates collapse', normalizeGrants(['gh', 'gh'], [], true).connectors?.length === 1)
check('connectorKey: order-independent', connectorKey(['a', 'b'], []) === connectorKey(['b', 'a'], []))
check('connectorKey: distinguishes a real change', connectorKey(['a'], []) !== connectorKey(['a', 'b'], []))

// --- 10. Launch composition ---------------------------------------------------
const fakeProxy = { urlFor: (s: string, c: string) => `http://127.0.0.1:1/c/tok-${s}-${c}` } as unknown as InstanceType<typeof ConnectorProxy>
const servers = connectorServers('sess1', ['gh', 'pg', 'ghost'], fakeProxy)
check('launch: an http connector becomes a PROXY url, not its real one',
  JSON.stringify(servers.gh).includes('127.0.0.1') && !JSON.stringify(servers.gh).includes('api.test'))
check('launch: the credential is NOT in the session config', !JSON.stringify(servers).includes('TOPSECRET'))
check('launch: a stdio connector is carried verbatim (the ENGINE spawns it, inside the box)',
  (servers.pg as { command: string; env: Record<string, string> }).command === 'mcp-postgres'
  && (servers.pg as { env: Record<string, string> }).env.PGPASSWORD === 'hunter2')
check('launch: a grant naming a deleted connector is skipped, not fatal', servers.ghost === undefined)

// --- 11. Deny rules -----------------------------------------------------------
const denyPlain = connectorDenyRules({ granted: ['gh'], accountAllow: [], readOnlyRole: false })
check('deny: an UNGRANTED account connector is denied', denyPlain.includes('mcp__gmail') && denyPlain.includes('mcp__drive'))
const denyAllowed = connectorDenyRules({ granted: [], accountAllow: ['gmail'], readOnlyRole: false })
check('deny: an ALLOWED account connector is not denied', !denyAllowed.includes('mcp__gmail'))
check('deny: the other account connector still is', denyAllowed.includes('mcp__drive'))

// Read-only role, connector never probed → the WHOLE server is denied (fail closed).
check('deny: read-only role + UNPROBED connector denies the whole server',
  connectorDenyRules({ granted: ['gh'], accountAllow: [], readOnlyRole: true }).includes('mcp__gh'))
check('deny: a normal role does NOT get the whole-server deny',
  !connectorDenyRules({ granted: ['gh'], accountAllow: [], readOnlyRole: false }).includes('mcp__gh'))

setTools('gh', [
  { name: 'list_issues', write: false },
  { name: 'create_issue', write: true },
])
const roDeny = connectorDenyRules({ granted: ['gh'], accountAllow: [], readOnlyRole: true })
check('deny: read-only role + probed → the WRITE tool is denied', roDeny.includes('mcp__gh__create_issue'))
check('deny: read-only role + probed → the READ tool is allowed', !roDeny.includes('mcp__gh__list_issues'))
check('deny: read-only role + probed → no longer denies the whole server', !roDeny.includes('mcp__gh'))
const rwDeny = connectorDenyRules({ granted: ['gh'], accountAllow: [], readOnlyRole: false })
check('deny: a normal role keeps the write tool', !rwDeny.includes('mcp__gh__create_issue'))
check('deny: no duplicate rules', new Set(roDeny).size === roDeny.length)

// A tool name we cannot express as a rule — too long once prefixed, or carrying characters
// that would break the comma-joined argv value — costs the WHOLE server, for every role.
// Fail closed and loud: a hand-built rule containing that name was an injection vector
// (adversarial C1), and leaving the tool exposed fails the entire turn.
saveConnector({ id: 'oddtools', name: 'Odd', transport: 'stdio', command: 'x' })
setTools('oddtools', [{ name: 'fine', write: false }, { name: 'x'.repeat(130), write: false }])
const oddDeny = connectorDenyRules({ granted: ['oddtools'], accountAllow: [], readOnlyRole: false })
check('deny: an unusable tool name denies the WHOLE server, for every role',
  oddDeny.includes('mcp__oddtools'), oddDeny.join(' '))
check('deny: no rule containing the unusable name is emitted',
  !oddDeny.some((r) => r.includes('x'.repeat(20))))
setTools('oddtools', [{ name: 'fine', write: false }, { name: 'evil,Bash', write: false }])
check('deny: a comma-bearing tool name never reaches the rule list',
  !connectorDenyRules({ granted: ['oddtools'], accountAllow: [], readOnlyRole: false }).some((r) => r.includes(',')))

// --- 12. The proxy, end to end ------------------------------------------------
// A fake upstream that records what it received, so we can prove the credential arrived
// THERE and not in the session's config.
let upstreamAuth: string | undefined
const upstream = http.createServer((req, res) => {
  upstreamAuth = req.headers.authorization
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const msg = JSON.parse(body || '{}') as { id?: unknown; method?: string }
    if (msg.method === 'unauthorized') { res.writeHead(401).end('{}'); return }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { tools: [
        { name: 'read_thing', annotations: { readOnlyHint: true } },
        { name: 'write_thing' },
      ] },
    }))
  })
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
const upPort = (upstream.address() as AddressInfo).port
saveConnector({ id: 'live', name: 'Live', transport: 'http', url: `http://127.0.0.1:${upPort}/mcp`, headers: { Authorization: 'Bearer LIVE-SECRET' } })

// The grant check the proxy consults — a mutable set, so we can revoke mid-run exactly
// as ungranting a live session does.
const grants = new Set<string>(['live'])
const proxy = new ConnectorProxy((_sid, cid) => grants.has(cid))
await proxy.start()
const url = proxy.urlFor('sess1', 'live')

const callProxy = (method: string, target = url): Promise<{ status: number; body: string }> =>
  new Promise((resolve) => {
    const u = new URL(target)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
    })
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method }))
  })

const ok = await callProxy('tools/list')
check('proxy: a granted call reaches upstream', ok.status === 200 && ok.body.includes('read_thing'))
check('proxy: the credential is added SERVER-SIDE (upstream saw it)', upstreamAuth === 'Bearer LIVE-SECRET')
check('proxy: tools were learned from the passing tools/list reply', (toolsOf('live') ?? []).length === 2)
check('proxy: readOnlyHint:true → write:false', toolsOf('live')!.find((t) => t.name === 'read_thing')!.write === false)
check('proxy: MISSING hint → write:true (a client must not trust annotations)',
  toolsOf('live')!.find((t) => t.name === 'write_thing')!.write === true)

// Revocation, with no relaunch and no new URL.
grants.delete('live')
const revoked = await callProxy('tools/list')
check('proxy: REVOCATION bites the next call, with no relaunch', revoked.status === 403)
check('proxy: the refusal is JSON-RPC so the CLI shows a reason', revoked.body.includes('not granted'))
grants.add('live')

// An unknown token is indistinguishable from a revoked one.
const bogus = await callProxy('tools/list', `http://127.0.0.1:${proxy.portNumber}/c/not-a-real-token`)
check('proxy: an unknown token is refused', bogus.status === 404)

// Released tokens stop working — a dead session's URL must not outlive it.
proxy.release('sess1')
const afterRelease = await callProxy('tools/list')
check('proxy: release() retires the session’s tokens', afterRelease.status === 404)

// 401 upstream is classified as needs-auth, not "the server is broken".
const url2 = proxy.urlFor('sess2', 'live')
await callProxy('unauthorized', url2)
check('proxy: a 401 upstream is recorded as needs-auth',
  toView(getConnector('live')!).health === 'needs-auth')

proxy.stop()
upstream.close()

// --- 12b. The catalog file itself ---------------------------------------------
// It holds API tokens, stdio env vars and OAuth secrets. Two properties matter: it lives
// in dataDir() (never bind-mounted into a box — see connectorStore's header), and it is
// not world-readable.
const catalogPath = path.join(DATA, 'connectors.json')
check('catalog: written inside dataDir()', fs.existsSync(catalogPath))
check('catalog: mode is 0600 (it holds credentials)',
  (fs.statSync(catalogPath).mode & 0o777) === 0o600,
  '0' + (fs.statSync(catalogPath).mode & 0o777).toString(8))

// --- 12c. Importing what the CLI already has ----------------------------------
// Strict mode makes hand-configured servers disappear; importing is what turns that from
// "your servers vanished" into "they're listed here, grant them per session". Exercised
// against a real config tree, since the scanner's whole job is reading these shapes.
const { scanExistingServers } = await import('../server/src/connectors/connectorImport')
const proj = path.join(DATA, 'proj')
fs.mkdirSync(path.join(proj, '.claude'), { recursive: true })
fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({
  mcpServers: {
    // No `type`: the CLI infers stdio from `command`, http from `url`. Hand-written
    // entries routinely omit it, so the importer must infer the same way.
    'My_Local Server': { command: 'run-me', args: ['--flag'], env: { TOK: 'x' } },
    remote: { url: 'https://remote.test/mcp', headers: { Authorization: 'Bearer k' } },
    legacy: { type: 'sse', url: 'https://old.test/sse' },
    broken: { type: 'http' },
  },
}))
fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({
  mcpServers: { remote: { url: 'https://SHOULD-NOT-WIN.test/mcp' }, extra: { command: 'extra-cmd' } },
}))
const scan = scanExistingServers(proj)
const byId = new Map(scan.candidates.map((c) => [c.def.id, c.def]))
check('import: infers stdio from `command` with no explicit type', byId.get('my-local-server')?.transport === 'stdio')
check('import: slugs a name with underscores/spaces into a legal id', byId.has('my-local-server'))
check('import: carries stdio args + env (the engine will spawn it)',
  byId.get('my-local-server')?.args?.[0] === '--flag' && byId.get('my-local-server')?.env?.TOK === 'x')
check('import: infers http from `url`', byId.get('remote')?.transport === 'http')
check('import: skips the deprecated SSE transport rather than silently changing protocol',
  scan.skipped.some((s) => s.name === 'legacy' && /SSE/.test(s.reason)))
check('import: skips an http entry with no url', scan.skipped.some((s) => s.name === 'broken'))
// Precedence, not just de-duplication: .mcp.json (project scope) must beat
// .claude/settings.json, matching the CLI's local > project > user ordering. Reading the
// least specific scope first would import a stale global URL and drop the current one.
check('import: the MORE SPECIFIC scope wins a duplicated name',
  byId.get('remote')?.url === 'https://remote.test/mcp',
  byId.get('remote')?.url)
check('import: reads settings.json as well as .mcp.json', byId.has('extra'))
check('import: nothing arrives granted (enabledByDefault false)',
  scan.candidates.every((c) => c.def.enabledByDefault === false))
check('import: records where each came from', scan.candidates.every((c) => !!c.def.importedFrom))

// --- 13. The launch argv, as SessionManager composes it -----------------------
// The integration point where a mistake is invisible until a session misbehaves: the
// role's own denials and the connector layer's must land in ONE --disallowedTools value
// (a second flag would not reliably combine), and strict mode must actually reach argv.
const { claudeArgs, NOTEBOOK_DENY } = await import('../server/src/claude/claudeEngine')
const { AGENTS } = await import('../server/src/claude/agents')

const agent = AGENTS.reviewer
const connDeny = connectorDenyRules({ granted: ['gh'], accountAllow: [], readOnlyRole: !!agent.readOnly })
const argv = claudeArgs({
  sessionId: 'sid', mcpConfig: JSON.stringify({ mcpServers: { app: {}, ...connectorServers('sess1', ['gh'], fakeProxy) } }),
  allowedTools: agent.allowedTools,
  disallowedTools: [...(agent.disallowedTools ?? []), ...connDeny],
  extra: ['--strict-mcp-config'],
})
const denyValue = argv[argv.indexOf('--disallowedTools') + 1]
check('argv: exactly ONE --disallowedTools flag',
  argv.filter((a) => a === '--disallowedTools').length === 1)
check('argv: NOTEBOOK_DENY survives the merge', denyValue.startsWith(NOTEBOOK_DENY))
check('argv: the role’s own denials are in it', denyValue.includes('Write'))
check('argv: the connector denials are in it too', denyValue.includes('mcp__gh__create_issue'))
check('argv: ungranted account connectors are denied in it', denyValue.includes('mcp__gmail'))
check('argv: --strict-mcp-config reaches the command line', argv.includes('--strict-mcp-config'))
const cfgArg = argv[argv.indexOf('--mcp-config') + 1]
check('argv: the granted connector is in --mcp-config', cfgArg.includes('"gh"'))
check('argv: the app-control server is still there alongside it', cfgArg.includes('"app"'))
check('argv: no credential anywhere on the command line', !argv.join(' ').includes('TOPSECRET'))

check('reviewer is marked read-only (Bash alone would not have caught it)', AGENTS.reviewer.readOnly === true)
check('implementer is NOT read-only', !AGENTS.implementer.readOnly)

// --- cleanup ------------------------------------------------------------------
deleteCatalogFile()
fs.rmSync(DATA, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
