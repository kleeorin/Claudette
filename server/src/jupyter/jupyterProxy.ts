import http from 'http'
import type { Duplex } from 'stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { JupyterInfo } from './jupyterManager'

// Reverse-proxies `/jupyter/*` (HTTP + WS upgrade) to the local Jupyter server,
// injecting the token server-side so the browser never sees it and everything is
// single-origin (matters for the phone/PWA + Tailscale front already built).
//
// Note: Claudette's kernel client is server-side and dials Jupyter directly, so
// this proxy is NOT on the execution path — it exists for the browser to reach
// Jupyter's REST/asset/output resources (rich outputs, /files) from one origin.
export class JupyterProxy {
  private info: JupyterInfo | null = null
  private target: { hostname: string; port: number } | null = null
  private wss = new WebSocketServer({ noServer: true })

  // Parse the upstream host ONCE per target change (not per proxied request).
  setTarget(info: JupyterInfo | null): void {
    this.info = info
    if (info) { const u = new URL(info.url); this.target = { hostname: u.hostname, port: Number(u.port) } }
    else this.target = null
  }
  get ready(): boolean { return this.info !== null }

  // Rewrite `/jupyter/<rest>` → `<jupyter-host>/<rest>`.
  private upstreamPath(url: string): string {
    return url.replace(/^\/jupyter/, '') || '/'
  }
  private host(): { hostname: string; port: number } {
    return this.target!   // non-null whenever this.info is (callers guard on this.info)
  }

  // HTTP: forward method/headers/body, add the token as an Authorization header.
  handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.info) { res.writeHead(503).end('jupyter not started'); return }
    const { hostname, port } = this.host()
    const proxied = http.request({
      hostname, port,
      method: req.method,
      path: this.upstreamPath(req.url || '/'),
      headers: { ...req.headers, host: `${hostname}:${port}`, authorization: `token ${this.info.token}` },
    }, (up) => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    })
    proxied.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('jupyter proxy error') })
    req.pipe(proxied)
  }

  // WS upgrade: bridge the browser socket to an upstream Jupyter socket (token in
  // the query, since ws clients can also carry it as a header — we set both).
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.info) { socket.destroy(); return }
    const { hostname, port } = this.host()
    const path = this.upstreamPath(req.url || '/')
    const sep = path.includes('?') ? '&' : '?'
    const upstreamUrl = `ws://${hostname}:${port}${path}${sep}token=${this.info.token}`

    this.wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(upstreamUrl, {
        headers: { authorization: `token ${this.info!.token}` },
      })
      const pending: Array<Buffer | string> = []
      upstream.on('open', () => { for (const m of pending) upstream.send(m); pending.length = 0 })
      client.on('message', (d) => {
        const m = d as Buffer
        if (upstream.readyState === WebSocket.OPEN) upstream.send(m); else pending.push(m)
      })
      upstream.on('message', (d) => {
        if (client.readyState === WebSocket.OPEN) client.send(d as Buffer)
      })
      const closeBoth = () => { client.close(); upstream.close() }
      client.on('close', closeBoth); upstream.on('close', closeBoth)
      client.on('error', closeBoth); upstream.on('error', closeBoth)
    })
  }
}
