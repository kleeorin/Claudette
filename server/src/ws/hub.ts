import type { WebSocket } from 'ws'
import type { WsServerMessage } from '@claudette/shared'

// Tracks the set of connected app sockets and fans a server→client message out
// to all of them. Claudette is single-user, so every open tab mirrors the same
// session set — there's no per-socket subscription filtering (yet). Grows to
// carry pty/notebook/appcontrol topics alongside sessions.
export class WsHub {
  private clients = new Set<WebSocket>()
  private closeHooks: ((ws: WebSocket) => void)[] = []

  add(ws: WebSocket): void {
    this.clients.add(ws)
    const drop = (): void => {
      if (!this.clients.delete(ws)) return   // already dropped: close AND error both fire
      for (const cb of this.closeHooks) { try { cb(ws) } catch { /* a hook must not take the socket down */ } }
    }
    ws.on('close', drop)
    ws.on('error', drop)
  }

  // Run when a socket goes away. Added for the file-watch registry: without it an
  // abandoned tab leaks its inotify watch for the life of the process, and the hub was the
  // only thing that knew the socket had gone. Guarded against double-fire, because 'close'
  // and 'error' can BOTH arrive for one socket and a hook that releases refcounts must not
  // run twice for a single disconnect — the second run would release watches another tab
  // still holds. Hooks are best-effort and their throws are swallowed: cleanup failing is
  // not a reason to lose the connection teardown.
  onClose(cb: (ws: WebSocket) => void): void { this.closeHooks.push(cb) }

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
