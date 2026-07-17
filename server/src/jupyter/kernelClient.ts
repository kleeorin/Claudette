import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import type { NbOutput, KernelStatus } from '@claudette/shared'

// Server-side Jupyter kernel client. Ported from ClaudeMaster's renderer client
// (`renderer/lib/kernelClient.ts`), inverted browser→server: node `ws` for the
// channels socket, node global `fetch` for the REST actions. It emits nbformat
// output dicts (`NbOutput`) straight — Claudette's doc stores outputs nbformat-
// native — instead of the renderer's normalized union. Heartbeat + reconnect kept.

export type { KernelStatus }

// A `null` count means the execution ended without a real reply (socket dropped
// mid-run); the cell should just clear its running state, not stamp a bogus [n].
type DoneFn = (count: number | null) => void

const HEARTBEAT_MS = 25_000
const HEARTBEAT_TIMEOUT_MS = 8_000
const MAX_RECONNECT = 5

export class KernelClient {
  private ws: WebSocket | null = null
  private sessionId = randomUUID()
  private pending = new Map<string, { onOutput: (o: NbOutput) => void; onDone: DoneFn }>()
  onStatusChange?: (status: KernelStatus) => void

  private everConnected = false
  private disposed = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private hbTimer: ReturnType<typeof setInterval> | null = null
  private hbDeadline: ReturnType<typeof setTimeout> | null = null
  private hbMsgId: string | null = null

  constructor(
    private baseUrl: string,
    private token: string,
    readonly kernelId: string,
  ) {}

  connect(): Promise<void> { return this.openSocket() }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws')
      const ws = new WebSocket(`${wsUrl}/api/kernels/${this.kernelId}/channels`, {
        headers: { Authorization: `token ${this.token}` },
      })
      this.ws = ws
      ws.on('open', () => {
        this.everConnected = true
        this.reconnectAttempts = 0
        this.startHeartbeat()
        resolve()
      })
      // 'error' fires just before 'close'; let handleClose own recovery. Only
      // reject the (initial) connect promise here.
      ws.on('error', (e) => reject(e))
      ws.on('message', (data) => this.handleMessage(JSON.parse(data.toString())))
      ws.on('close', () => this.handleClose())
    })
  }

  private handleMessage(msg: Record<string, unknown>) {
    // Any inbound frame proves the socket is alive — clear the liveness deadline.
    this.clearHeartbeatDeadline()

    const header = msg.header as Record<string, string>
    const content = msg.content as Record<string, unknown>
    const parentId = (msg.parent_header as Record<string, string>)?.msg_id
    const entry = parentId ? this.pending.get(parentId) : undefined

    switch (header.msg_type) {
      case 'status': {
        const state = content.execution_state as KernelStatus
        // Skip BOTH the momentary 'busy' AND the paired 'idle' our own heartbeat
        // (kernel_info_request) causes — letting the idle through would flip the
        // kernel to idle mid-run and clear the running cell while it's still going.
        if (parentId && parentId === this.hbMsgId) break
        this.onStatusChange?.(state)
        break
      }
      case 'stream':
        entry?.onOutput({ output_type: 'stream', name: content.name as string, text: content.text as string })
        break
      case 'execute_result':
        entry?.onOutput({ output_type: 'execute_result', data: content.data, execution_count: content.execution_count as number, metadata: content.metadata ?? {} })
        break
      case 'display_data':
        entry?.onOutput({ output_type: 'display_data', data: content.data, metadata: content.metadata ?? {} })
        break
      case 'error':
        entry?.onOutput({ output_type: 'error', ename: content.ename as string, evalue: content.evalue as string, traceback: (content.traceback as string[]) ?? [] })
        break
      case 'execute_reply':
        if (entry && parentId) {
          entry.onDone(content.execution_count as number)
          this.pending.delete(parentId)
        }
        break
      // kernel_info_reply is the heartbeat's response — handled by the deadline clear.
    }
  }

  execute(code: string, onOutput: (o: NbOutput) => void, onDone: DoneFn): string {
    const msgId = randomUUID()
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      onOutput({ output_type: 'error', ename: 'KernelConnectionError', evalue: 'The kernel connection is not open. Try Restart kernel.', traceback: [] })
      onDone(null)
      return msgId
    }
    this.pending.set(msgId, { onOutput, onDone })
    try {
      this.ws.send(JSON.stringify({
        header: { msg_id: msgId, msg_type: 'execute_request', session: this.sessionId, username: '', date: new Date().toISOString(), version: '5.3' },
        parent_header: {}, metadata: {},
        content: { code, silent: false, store_history: true, user_expressions: {}, allow_stdin: false, stop_on_error: true },
        buffers: [], channel: 'shell',
      }))
    } catch (err) {
      this.pending.delete(msgId)
      onOutput({ output_type: 'error', ename: 'KernelSendError', evalue: `Failed to send to kernel: ${String(err)}`, traceback: [] })
      onDone(null)
    }
    return msgId
  }

  // ---- Connection health -------------------------------------------------

  private startHeartbeat() {
    this.stopHeartbeat()
    this.hbTimer = setInterval(() => this.ping(), HEARTBEAT_MS)
    this.ping()
  }
  private stopHeartbeat() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null }
    this.clearHeartbeatDeadline()
  }
  private clearHeartbeatDeadline() {
    if (this.hbDeadline) { clearTimeout(this.hbDeadline); this.hbDeadline = null }
  }

  // Cheap liveness probe on the CONTROL channel (not shell — shell queues behind a
  // running cell, so a long cell would trip a bogus dead-kernel reconnect).
  private ping() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const msgId = randomUUID()
    this.hbMsgId = msgId
    try {
      this.ws.send(JSON.stringify({
        header: { msg_id: msgId, msg_type: 'kernel_info_request', session: this.sessionId, username: '', date: new Date().toISOString(), version: '5.3' },
        parent_header: {}, metadata: {}, content: {}, buffers: [], channel: 'control',
      }))
    } catch {
      this.forceReconnect()
      return
    }
    this.clearHeartbeatDeadline()
    this.hbDeadline = setTimeout(() => this.forceReconnect(), HEARTBEAT_TIMEOUT_MS)
  }

  private forceReconnect() {
    if (this.disposed) return
    const ws = this.ws
    if (ws) {
      ws.removeAllListeners()
      try { ws.close() } catch { /* already closing */ }
    }
    this.ws = null
    this.handleClose()
  }

  private handleClose() {
    this.stopHeartbeat()
    if (this.disposed || !this.everConnected) return
    this.failPending('Kernel connection lost — reconnecting…')
    this.onStatusChange?.('starting')
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.disposed || this.reconnectTimer) return
    if (this.reconnectAttempts >= MAX_RECONNECT) { this.onStatusChange?.('dead'); return }
    const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempts)
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.disposed) return
      this.openSocket().catch(() => this.scheduleReconnect())
    }, delay)
  }

  private failPending(message: string) {
    for (const { onOutput, onDone } of this.pending.values()) {
      onOutput({ output_type: 'error', ename: 'KernelConnectionError', evalue: message, traceback: [] })
      onDone(null)
    }
    this.pending.clear()
  }

  // ---- REST actions ------------------------------------------------------

  interrupt(): Promise<void> { return this.post('interrupt') }
  restart(): Promise<void> {
    // A restart kills the current kernel process, so any in-flight execute never
    // gets its execute_reply — resolve those `pending` runs now (count = null, no
    // error output) so their promises settle and the running state clears, instead
    // of leaking the entry and stranding the cell as "running" forever.
    this.abortPending()
    return this.post('restart')
  }

  // Resolve every in-flight execution as ended-without-a-reply, WITHOUT appending an
  // error output (unlike failPending, which surfaces a connection error). Used when
  // we deliberately end the runs — e.g. a restart.
  private abortPending() {
    for (const { onDone } of this.pending.values()) onDone(null)
    this.pending.clear()
  }
  private post(action: string): Promise<void> {
    return fetch(`${this.baseUrl}/api/kernels/${this.kernelId}/${action}`, {
      method: 'POST', headers: { Authorization: `token ${this.token}` },
    }).then(() => undefined)
  }
  shutdown(): Promise<void> {
    return fetch(`${this.baseUrl}/api/kernels/${this.kernelId}`, {
      method: 'DELETE', headers: { Authorization: `token ${this.token}` },
    }).then(() => undefined).catch(() => undefined)
  }

  dispose(): void {
    this.disposed = true
    this.stopHeartbeat()
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.ws) { this.ws.removeAllListeners(); this.ws.close(); this.ws = null }
    this.failPending('Kernel disposed.')
  }
}
