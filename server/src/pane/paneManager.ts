import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import * as pty from 'node-pty'
import { wrapCommand, sandboxAvailable } from '../claude/sandbox'
import { DENY_ALL_SANDBOX, type Confinement, type SessionConfinement } from '../claude/sessionConfinement'

// One shell pane = one pty. Ported from ClaudeMaster's `main/paneManager.ts`,
// LOCAL branch only — the remote/SSH interactive spawn is Phase 3, dropped here as
// SessionManager's remote path was. Transport-agnostic: it just emits, the WS
// bridge (paneApi.ts) fans output/exit to the browser and feeds input/resize back.
//
// SECURITY (SANDBOX.md "Terminal-pane escape"): a pane used to be a bare host shell
// even for a sandboxed session — an unsandboxed process one WS frame away. Now a
// pane for a confined session runs its shell INSIDE that session's bwrap box (same
// mounts/env-clearing as its Claude), and every pane gets the app's own control
// token scrubbed from its env.
//
// Events: 'output' (id, data) · 'exit' (id)

interface PaneSpawn { command: string; args: string[]; cwd: string; env: Record<string, string> }

// process.env minus our own secrets, so even an UNCONFINED pane never hands the child
// CLAUDETTE_TOKEN (a confined pane also gets bwrap --clearenv on top). Also what the
// bwrap launcher itself runs with — bwrap needs PATH to be found; it clears the env
// for the shell regardless.
function sanitizedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || k.startsWith('CLAUDETTE')) continue
    out[k] = v
  }
  return out
}

// Decide how to spawn a pane's shell from the session's confinement decision:
//   host     → a bare host shell (matching an unconfined session), env-scrubbed.
//   confined → the shell wrapped in the SESSION's box (wrapCommand — the same
//              confinement as its Jupyter kernels, minus Claude's creds).
//   deny     → a data-mount-less box: the shell runs but reaches nothing. We cannot
//              confine an unresolved session without a working sandbox, so refuse
//              rather than silently drop it to a host shell.
// The terminal's own cwd is honored as the box-internal --chdir (per-terminal UX); if it
// falls outside the mounts, wrapCommand presents it as an empty read-only dir —
// confinement is from the mounts, never the chdir. Exported for unit testing the argv.
export function paneSpawnSpec(cwd: string, c: Confinement): PaneSpawn {
  const shell = process.env.SHELL || '/bin/bash'
  const env = sanitizedEnv()
  if (c.mode === 'host') return { command: shell, args: [], cwd: cwd || homedir(), env }
  if (c.mode === 'deny' && !sandboxAvailable())
    throw new Error('pane: refusing to spawn a shell for an unresolved session (host cannot sandbox)')
  const box = c.mode === 'confined' ? { cfg: c.cfg, cwd: c.cwd } : { cfg: DENY_ALL_SANDBOX, cwd: cwd || homedir() }
  const { command, args } = wrapCommand(box.cfg, cwd || box.cwd, shell, [])
  return { command, args, cwd: box.cwd || homedir(), env }
}

export class PaneManager extends EventEmitter {
  private panes = new Map<string, pty.IPty>()
  // Which session owns each pane, so killing a session reaps its terminals
  // server-side (a live browser isn't required to drive the cleanup).
  private owner = new Map<string, string>()

  // `confinement` resolves a session's box so its terminal is confined to match (see
  // SANDBOX.md). A pane created with NO sessionId is a deliberate operator terminal
  // (token-gated), so it runs on the host; a pane whose sessionId doesn't resolve fails
  // closed (deny) instead of dropping to a host shell.
  constructor(private confinement: SessionConfinement) {
    super()
  }

  create(cwd: string, cols?: number, rows?: number, sessionId?: string): string {
    const id = randomUUID()
    const c: Confinement = sessionId ? this.confinement.resolve(sessionId) : { mode: 'host' }
    const spec = paneSpawnSpec(cwd, c)
    const proc = pty.spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      // Spawn at the client's real fitted size when known. A wrong initial size
      // desyncs the shell's cursor from what xterm renders (typed chars overwrite
      // the prompt; history recall shifts a line) until the first resize lands.
      cols: cols && cols > 0 ? cols : 80,
      rows: rows && rows > 0 ? rows : 24,
      cwd: spec.cwd,
      env: spec.env,
    })
    this.panes.set(id, proc)
    if (sessionId) this.owner.set(id, sessionId)
    proc.onData((data) => this.emit('output', id, data))
    proc.onExit(() => { this.panes.delete(id); this.owner.delete(id); this.emit('exit', id) })
    return id
  }

  sendInput(id: string, data: string): void { this.panes.get(id)?.write(data) }
  resize(id: string, cols: number, rows: number): void { this.panes.get(id)?.resize(cols, rows) }
  destroy(id: string): void { this.panes.get(id)?.kill(); this.panes.delete(id); this.owner.delete(id) }
  destroyAll(): void { for (const id of [...this.panes.keys()]) this.destroy(id) }
  // Kill every pty owned by a session (called when that session is destroyed).
  destroyForSession(sessionId: string): void {
    for (const [id, sid] of [...this.owner]) if (sid === sessionId) this.destroy(id)
  }
}
