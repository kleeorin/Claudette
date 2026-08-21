// RED TEAM round 2: can a malicious (or merely rude) upstream MCP server, or a granted
// session, take the whole Claudette process down through ConnectorProxy?
// No uncaughtException handler is registered here — exactly like server/src/index.ts.
//   npx tsx scratchpad/rt2-proxy-crash.mts <case>
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'

const CASE = process.argv[2] ?? 'epipe-during-upload'
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rt2-proxy-'))
process.env.CLAUDETTE_DATA_DIR = DATA

const store = await import('../server/src/connectors/connectorStore')
const { ConnectorProxy } = await import('../server/src/connectors/connectorProxy')

// --- hostile / rude upstream --------------------------------------------------------
const upstream = http.createServer((req, res) => {
  switch (CASE) {
    case 'epipe-during-upload':
      // Answer + hang up WITHOUT draining the request body. This is what any real server
      // does on 413 Payload Too Large. Non-JSON content-type so the proxy takes the
      // pipe-through branch and writes response headers to the session immediately.
      res.writeHead(413, { 'content-type': 'text/plain' })
      res.end('too big')
      setTimeout(() => res.socket?.resetAndDestroy?.() ?? res.socket?.destroy(), 10)
      return
    case 'reset-after-json':
      // A complete JSON reply, then an RST.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}')
      setTimeout(() => res.socket?.resetAndDestroy?.() ?? res.socket?.destroy(), 20)
      return
    case 'client-abort-during-pipe': {
      // A slow stream the session gives up on halfway through.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let n = 0
      const t = setInterval(() => {
        n++
        try { res.write(`data: ${'x'.repeat(64 * 1024)}\n\n`) } catch { clearInterval(t) }
        if (n > 200) { clearInterval(t); res.end() }
      }, 5)
      req.on('close', () => clearInterval(t))
      return
    }
    default:
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
  }
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
const uport = (upstream.address() as AddressInfo).port

store.saveConnector({ id: 'evil', name: 'Evil', transport: 'http', url: `http://127.0.0.1:${uport}/mcp` })
const proxy = new ConnectorProxy(() => true)
await proxy.start()
const url = proxy.urlFor('s1', 'evil')
console.log(`case=${CASE} proxy=${url} upstream=127.0.0.1:${uport}`)

process.on('uncaughtException', (e) => {
  // Report it the way node would (then exit non-zero), so the harness can tell a crash
  // from a hang. server/src/index.ts installs no such handler, so in production this is
  // process death.
  console.log(`🚨 UNCAUGHT EXCEPTION (in production this kills Claudette): ${(e as Error).stack}`)
  process.exit(9)
})

await new Promise<void>((resolve) => {
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    console.log(`client got ${res.statusCode}`)
    let got = 0
    res.on('data', (c) => {
      got += c.length
      if (CASE === 'client-abort-during-pipe' && got > 128 * 1024) {
        console.log('client aborts mid-stream')
        req.destroy()
        setTimeout(resolve, 200)
      }
    })
    res.on('end', () => resolve())
    res.on('error', (e) => { console.log(`client res error: ${(e as Error).message}`); resolve() })
  })
  req.on('error', (e) => { console.log(`client req error: ${(e as Error).message}`); resolve() })
  if (CASE === 'epipe-during-upload') {
    // A big body the session is entitled to send (a tools/call argument, say). The proxy
    // is still pumping it upstream when the upstream hangs up.
    const chunk = Buffer.alloc(1 << 20, 0x41)
    let i = 0
    const pump = (): void => {
      while (i < 64) { i++; if (!req.write(chunk)) { req.once('drain', pump); return } }
      req.end()
    }
    pump()
  } else {
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  }
})

await new Promise((r) => setTimeout(r, 700))
console.log('SURVIVED — process still alive')
upstream.close(); proxy.stop()
process.exit(0)
