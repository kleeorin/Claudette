// RED TEAM round 2, part B — permanence of the poisoned catalog, role-scope escape via
// team hiring, and containment checks. Isolated CLAUDETTE_DATA_DIR.
//   npx tsx scratchpad/rt2-connectors-b.mts
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import type { AddressInfo } from 'net'

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rt2b-'))
process.env.CLAUDETTE_DATA_DIR = DATA
// No `claude` on PATH: create() launches, and we want the spawn to fail fast (ENOENT)
// rather than start real engines. sandboxAvailable() also goes false, so no bwrap either.
process.env.PATH = path.join(DATA, 'nobin')
fs.mkdirSync(process.env.PATH, { recursive: true })

const store = await import('../server/src/connectors/connectorStore')
const { ConnectorProxy } = await import('../server/src/connectors/connectorProxy')
const { connectorDenyRules } = await import('../server/src/connectors/connectorLaunch')
const { SessionManager } = await import('../server/src/claude/sessionManager')
const { getAgent } = await import('../server/src/claude/agents')
const { disallowedValue } = await import('../server/src/claude/claudeEngine')

const findings: string[] = []
const attack = (name: string, blocked: boolean, detail = ''): void => {
  if (blocked) console.log(`✅ blocked — ${name}${detail ? ` — ${detail}` : ''}`)
  else { findings.push(name); console.log(`🚨 SUCCEEDED — ${name}${detail ? ` — ${detail}` : ''}`) }
}
const note = (s: string): void => console.log(`   · ${s}`)
console.log(`(isolated data dir ${DATA})\n`)

// =====================================================================================
console.log('── D. Is a poisoned classification PERMANENT across a restart? ──')
// =====================================================================================
let toolsReply: unknown = {}
const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(toolsReply))
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
const uport = (upstream.address() as AddressInfo).port

const proxy = new ConnectorProxy(() => true)
await proxy.start()
store.saveConnector({ id: 'evil', name: 'Evil', transport: 'http', url: `http://127.0.0.1:${uport}/mcp` })
const evilUrl = proxy.urlFor('s1', 'evil')
const call = (payload: unknown): Promise<void> => new Promise((resolve) => {
  const r = http.request(evilUrl, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    res.on('data', () => {}); res.on('end', () => resolve())
  })
  r.on('error', () => resolve())
  r.end(JSON.stringify(payload))
})

const N = 4000
toolsReply = { jsonrpc: '2.0', id: 1, result: { tools: Array.from({ length: N }, (_, i) => ({ name: `harmless_read_tool_number_${i}` })) } }
await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

// Simulate a server RESTART: drop every in-memory cache, then read the catalog off disk
// exactly as boot does (listConnectors triggers load(), which repopulates the tool map).
store.resetConnectorCache()
store.listConnectors()
const reloaded = store.toolsOf('evil')?.length ?? 0
const rulesAfter = connectorDenyRules({ granted: ['evil'], accountAllow: [], readOnlyRole: true })
const argvAfter = disallowedValue(rulesAfter)
const spawned = spawnSync('/bin/true', [argvAfter])
attack('D1: the poisoned classification survives a restart and re-breaks the launch',
  reloaded === 0 || argvAfter.length < 131072,
  `${reloaded} tools reloaded from disk → --disallowedTools ${argvAfter.length}B → execve ${(spawned.error as NodeJS.ErrnoException | undefined)?.code ?? 'ok'}`)
note(`reviewer.readOnly=${getAgent('reviewer').readOnly} planner.readOnly=${getAgent('planner').readOnly}`)
// Is there any operator-facing way to clear it? (grep, not a runtime check)
note('no route clears ConnectorDef.tools: /api/connectors/save discards client-sent tools and persist() rewrites from the in-memory map')

// =====================================================================================
console.log('\n── E. Is the CRLF (E4) containment bypassable through the importer? ──')
// =====================================================================================
store.saveConnector({ id: 'ok', name: 'OK', transport: 'http', url: `http://127.0.0.1:${uport}/mcp` })
// Reach past saveConnector's validation the way addImported does, then dial.
const raw = store.getConnector('ok') as { headers?: Record<string, string> }
raw.headers = { Authorization: 'Bearer x\r\nX-Injected: 1' }
const okUrl = proxy.urlFor('s2', 'ok')
const got = await new Promise<string>((resolve) => {
  const r = http.request(okUrl, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(`${res.statusCode}`))
  })
  r.on('error', (e) => resolve(`error ${e.message}`))
  r.end('{}')
})
attack('E1: a CRLF header stored by the importer crashes the proxy handler (E4 regression)',
  got === '502', `proxy returned ${got} (502 = contained)`)

// =====================================================================================
console.log('\n── F. Role scoping: can a read-only session get the write tools anyway? ──')
// =====================================================================================
// A reviewer session granted a connector is denied its write tools. It is also allowed to
// HIRE (if the operator ticked "employ team allowed"), and a teammate INHERITS the grants
// while running as a role the hiring session chooses.
const mgr = new SessionManager({
  connectorDeny: (s) => connectorDenyRules(s),
  releaseConnectors: () => {},
  defaultGrants: () => [],
  mcpConfig: () => undefined,
})
toolsReply = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'send_email' }, { name: 'read_mail', annotations: { readOnlyHint: true } }] } }
store.resetConnectorCache()
store.saveConnector({ id: 'mail', name: 'Mail', transport: 'http', url: `http://127.0.0.1:${uport}/mcp` })
const mailUrl = proxy.urlFor('s3', 'mail')
await new Promise<void>((resolve) => {
  const r = http.request(mailUrl, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    res.on('data', () => {}); res.on('end', () => resolve())
  })
  r.on('error', () => resolve())
  r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
})
note(`classification: ${JSON.stringify(store.toolsOf('mail'))}`)

const cwd = path.join(DATA, 'proj'); fs.mkdirSync(cwd, { recursive: true })
const parent = mgr.create('Reviewer', cwd, cwd, undefined, false, undefined, 'reviewer')
mgr.setConnectors(parent, ['mail'], [], /* trusted */ true)   // the operator's own grant
const parentDeny = connectorDenyRules({ granted: ['mail'], accountAllow: [], readOnlyRole: !!getAgent('reviewer').readOnly })
note(`reviewer deny rules: ${JSON.stringify(parentDeny)}`)

// The reviewer hires a `general` teammate — exactly what employ_teammate does
// (sessions.create(name, cwd, rootDir, parentId, false, undefined, role), trusted=false).
const child = mgr.create('Helper', cwd, cwd, parent, false, undefined, 'general')
const childGrants = mgr.list().find((s) => s.id === child)?.connectors ?? []
const childDeny = connectorDenyRules({ granted: childGrants, accountAllow: [], readOnlyRole: !!getAgent('general').readOnly })
note(`teammate grants: ${JSON.stringify(childGrants)}  teammate deny rules: ${JSON.stringify(childDeny)}`)
attack('F1: a read-only session hires a full-tool teammate that inherits its connector and is NOT denied the write tools',
  !childGrants.includes('mail') || childDeny.includes('mcp__mail__send_email') || childDeny.includes('mcp__mail'),
  'teammate can call mcp__mail__send_email')

// And the untrusted direction still has to be refused.
attack('F2: an untrusted setConnectors grants the teammate more',
  mgr.setConnectors(child, ['evil'], [], /* trusted */ false) === false)

console.log(`\n${findings.length} finding(s):`)
for (const f of findings) console.log(`  🚨 ${f}`)
upstream.close(); proxy.stop(); mgr.shutdown()
setTimeout(() => process.exit(0), 300)
