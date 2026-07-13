import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import * as pty from 'node-pty'

// One shell pane = one pty. Ported from ClaudeMaster's `main/paneManager.ts`,
// LOCAL branch only — the remote/SSH interactive spawn is Phase 3, dropped here as
// SessionManager's remote path was. Transport-agnostic: it just emits, the WS
// bridge (paneApi.ts) fans output/exit to the browser and feeds input/resize back.
//
// Events: 'output' (id, data) · 'exit' (id)
export class PaneManager extends EventEmitter {
  private panes = new Map<string, pty.IPty>()

  create(cwd: string): string {
    const id = randomUUID()
    const shell = process.env.SHELL || '/bin/bash'
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: cwd || homedir(),
      env: process.env as Record<string, string>,
    })
    this.panes.set(id, proc)
    proc.onData((data) => this.emit('output', id, data))
    proc.onExit(() => { this.panes.delete(id); this.emit('exit', id) })
    return id
  }

  sendInput(id: string, data: string): void { this.panes.get(id)?.write(data) }
  resize(id: string, cols: number, rows: number): void { this.panes.get(id)?.resize(cols, rows) }
  destroy(id: string): void { this.panes.get(id)?.kill(); this.panes.delete(id) }
  destroyAll(): void { for (const id of [...this.panes.keys()]) this.destroy(id) }
}
