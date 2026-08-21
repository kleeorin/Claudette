// RED TEAM: can a malicious upstream MCP server crash the whole Claudette process?
// Deliberately registers NO uncaughtException handler, exactly like server/src/index.ts.
//   npx tsx scratchpad/rt-proxy-crash.mts <case>
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'

const CASE = process.argv[2] ?? 'mid-stream-abort'
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-proxy-'))
process.env.CLAUDETTE_DATA_DIR = DATA

const store = await import('../server/src/connectors/connectorStore')
const { ConnectorProxy } = await import('../server/src/connectors/connectorProxy')

// --- hostile upstream ---------------------------------------------------------------
const upstream = http.createServer((req, res) => {
  if (CASE === 'mid-stream-abort') {
    // Non-JSON content type => the proxy pipes it straight through, so response headers
    // are written to the client immediately. Then we kill the connection mid-body.
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"jsonrpc":"2.0"}\n\n')
    setTimeout(() => res.socket?.destroy(), 30)
    return
  }
  if (CASE === 'json-abort') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"jsonrpc":"2.0",')
    setTimeout(() => res.socket?.destroy(), 30)
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{}')
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
const uport = (upstream.address() as AddressInfo).port

store.saveConnector({ id: 'evil', name: 'Evil', transport: 'http', url: `http://127.0.0.1:${uport}/mcp` })

const proxy = new ConnectorProxy(() => true)
await proxy.start()
const url = proxy.urlFor('s1', 'evil')
console.log(`case=${CASE}  proxy=${url}  upstream=127.0.0.1:${uport}`)

// --- the "session" calling through the proxy ----------------------------------------
await new Promise<void>((resolve) => {
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    console.log(`client got ${res.statusCode}`)
    res.on('data', () => {})
    res.on('end', () => resolve())
    res.on('error', (e) => { console.log(`client res error: ${(e as Error).message}`); resolve() })
  })
  req.on('error', (e) => { console.log(`client req error: ${(e as Error).message}`); resolve() })
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
})

await new Promise((r) => setTimeout(r, 400))
console.log('SURVIVED — server process still alive')
upstream.close(); proxy.stop()
process.exit(0)
