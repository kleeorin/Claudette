import type { WebSocket } from 'ws'
import type { WsServerMessage } from '@claudette/shared'

// Tracks the set of connected app sockets and fans a server→client message out
// to all of them. Claudette is single-user, so every open tab mirrors the same
// session set — there's no per-socket subscription filtering (yet). Grows to
// carry pty/notebook/appcontrol topics alongside sessions.
export class WsHub {
  private clients = new Set<WebSocket>()

  add(ws: WebSocket): void {
    this.clients.add(ws)
    ws.on('close', () => this.clients.delete(ws))
    ws.on('error', () => this.clients.delete(ws))
  }

  // Send to one socket (e.g. the connect-time snapshot).
  send(ws: WebSocket, msg: WsServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  // Fan out to every connected socket.
  broadcast(msg: WsServerMessage): void {
    const data = JSON.stringify(msg)
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }
}
