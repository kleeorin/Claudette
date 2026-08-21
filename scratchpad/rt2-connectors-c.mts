// RED TEAM round 2, part C — proxy liveness (hang / no timeouts) and the deny-rule
// injection backstop against a hand-edited or imported catalog.
//   npx tsx scratchpad/rt2-connectors-c.mts
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rt2c-'))
process.env.CLAUDETTE_DATA_DIR = DATA

const store = await import('../server/src/connectors/connectorStore')
const { ConnectorProxy } = await import('../server/src/connectors/connectorProxy')
const { connectorDenyRules } = await import('../server/src/connectors/connectorLaunch')

const findings: string[] = []
const attack = (n: string, blocked: boolean, d = ''): void => {
  if (blocked) console.log(`✅ blocked — ${n}${d ? ` — ${d}` : ''}`)
  else { findings.push(n); console.log(`🚨 SUCCEEDED — ${n}${d ? ` — ${d}` : ''}`) }
}
console.log(`(isolated data dir ${DATA})\n`)

// A. Liveness ------------------------------------------------------------------------
const modes = { abortJson: true, abortStream: true, silent: true }
const upstream = http.createServer((req, res) => {
  const mode = req.headers['x-mode']
  if (mode === 'abort-json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"jsonrpc":"2.0",')
    setTimeout(() => res.socket?.destroy(), 20)
    return
  }
  if (mode === 'abort-stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: hi\n\n')
    setTimeout(() => res.socket?.destroy(), 20)
    return
  }
  // 'silent': accept the request and never answer (slowloris upstream).
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
const uport = (upstream.address() as AddressInfo).port
const proxy = new ConnectorProxy(() => true)
await proxy.start()
store.saveConnector({ id: 'evil', name: 'Evil', transport: 'http', url: `http://127.0.0.1:${uport}/mcp` })
const url = proxy.urlFor('s1', 'evil')

const probe = (mode: string, ms: number): Promise<string> => new Promise((resolve) => {
  const timer = setTimeout(() => { resolve(`HUNG (no response after ${ms}ms)`); req.destroy() }, ms)
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mode': mode } }, (res) => {
    let b = ''
    res.on('data', (c) => (b += c))
    res.on('end', () => { clearTimeout(timer); resolve(`completed ${res.statusCode} (${b.length}B)`) })
    res.on('error', (e) => { clearTimeout(timer); resolve(`res error ${(e as Error).message}`) })
  })
  req.on('error', (e) => { clearTimeout(timer); resolve(`req error ${(e as Error).message}`) })
  req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
})

for (const [mode, label] of [['abort-json', 'upstream aborts mid-JSON'], ['abort-stream', 'upstream aborts mid-stream'], ['silent', 'upstream never answers']] as const) {
  const r = await probe(mode, 3000)
  attack(`A: ${label} — does the session's request ever finish?`, !r.startsWith('HUNG'), r)
}
void modes

// B. Deny-rule injection backstop against catalog state that never went through
//    saveConnector (a hand-edited connectors.json, or an importer that skips validation).
fs.writeFileSync(path.join(DATA, 'connectors.json'), JSON.stringify({
  connectors: [{ id: 'a,Bash', name: 'x', transport: 'stdio', command: 'echo', tools: [{ name: 'y', write: true }] }],
  oauthClients: [],
  accountConnectors: [{ name: 'ev,Bash' }, { name: 'ok-one' }],
  strict: false,
}))
store.resetConnectorCache()
store.listConnectors()
const rules = connectorDenyRules({ granted: ['a,Bash'], accountAllow: [], readOnlyRole: true })
attack('B: a comma in a hand-edited catalog id/account name forges an extra --disallowedTools entry',
  !rules.some((r) => r.includes(',')), JSON.stringify(rules))

console.log(`\n${findings.length} finding(s)`)
upstream.close(); proxy.stop(); process.exit(0)
