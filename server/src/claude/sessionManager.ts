import { EventEmitter } from 'events'
import { homedir } from 'os'
import crypto from 'crypto'
import type {
  SessionInfo, SessionState, ClaudeEvent, PermissionRequest, PermissionDecision,
  PermissionMode, SetModeResult, SavedSession, SandboxConfig,
} from '@claudette/shared'
import { ClaudeEngine, claudeArgs } from './claudeEngine'
import { getAgent, SUBSESSION_REPORT_INSTRUCTION } from './agents'
import { wrapSandbox, sandboxAvailable } from './sandbox'

// Owns the set of Claude sessions and their engines. Ported from
// ClaudeMaster's main-process SessionManager, minus the remote/SSH spawn path
// (Phase 3) and the pty/TUI backend (Phase 3) — Phase 1 is local, native
// stream-json only. The lifecycle logic (create/launch/relaunch/destroy/resume/
// restartFresh, live permission-mode switch, startup fast-fail + resume
// fallback) is preserved. Consumers subscribe to its events and re-emit them
// over the app WebSocket (see the session API layer); this class stays
// transport-only and knows nothing about HTTP/WS.
//
// Events (all namespaced by session id):
//   event(id, ClaudeEvent)                 — stream-json transcript material
//   ready(id, claudeSessionId)             — system/init arrived
//   permission(id, PermissionRequest)      — a can_use_tool prompt awaits a decision
//   stateChange(id, SessionState)          — idle/running/waiting/exited
//   exit(id, failed: boolean, error: string) — engine gone (failed = startup failure)

interface Session extends SessionInfo {
  engine: ClaudeEngine | null   // null once the Claude process has exited (relaunchable)
  sandbox?: SandboxConfig       // requested bwrap confinement (see sandbox.ts / SANDBOX.md)
  sandboxed?: boolean           // EFFECTIVE: did the last launch actually wrap in bwrap
  claudeSessionId: string       // claude's own session id (for --resume)
  startedAt: number             // last launch time, for the fast-failure heuristic
  resume: boolean               // whether Claude was launched with --resume
  closing?: boolean             // set by destroy() so a kill isn't misread as a crash
  replacing?: boolean           // set by resumeInto() so the kill relaunches instead of exiting
  stderrTail: string            // recent stderr, so a fast failure can show why
  resumeFallbackTried?: boolean // retried a missing --resume target as a fresh session once
  sawInit?: boolean             // a system/init arrived this launch (distinguishes real turns from startup failures)
}

// A session that dies within this window of launching never really started
// (e.g. `claude: command not found`). We report those as failures (keep the row
// + show output) rather than silently removing the session.
const STARTUP_GRACE_MS = 4000
const TAIL_MAX = 2000

// Optional hooks the app injects (kept out of SessionManager's core so it stays
// transport-only). `mcpConfig` returns the --mcp-config string for a session
// (the app-control server); undefined skips it.
export interface SessionManagerOpts {
  mcpConfig?: (sessionId: string) => string | undefined
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()

  constructor(private readonly opts: SessionManagerOpts = {}) { super() }

  create(
    name: string,
    cwd: string,
    rootDir = cwd,
    parentId?: string,
    resume = false,
    claudeSessionId?: string,
    agentId?: string,
    model?: string,
    permissionMode?: PermissionMode,
    sandbox?: SandboxConfig,
  ): string {
    const id = crypto.randomUUID()
    const session: Session = {
      id, name, cwd, rootDir, parentId, agentId, model, permissionMode,
      sandbox: normalizeSandbox(sandbox, cwd),
      state: 'idle', engine: null, startedAt: 0, resume,
      claudeSessionId: claudeSessionId ?? crypto.randomUUID(),
      stderrTail: '',
    }
    this.sessions.set(id, session)
    this.launch(session)
    this.emit('changed')   // persist the new set (P1.19) — claudeSessionId exists upfront
    return id
  }

  // (Re)spawn the Claude engine for a session and wire it up. Called on create
  // and on relaunch. Panes/notebook/etc. are independent of the engine, so a
  // session stays usable even if Claude fails to start.
  private launch(session: Session): void {
    const { id, cwd, resume, claudeSessionId } = session
    // The session runs as its agent (role): charter + tool scope + model. `general`
    // (the default) contributes nothing, so a plain session is unchanged.
    const agent = getAgent(session.agentId)
    // Per-session model override wins over the role's default model. Every
    // subsession (has a parentId) also gets the "report back when done" instruction
    // appended, so the orchestration loop closes even if the role charter doesn't
    // mention it.
    const systemPrompt = [agent.systemPrompt, session.parentId ? SUBSESSION_REPORT_INSTRUCTION : undefined]
      .filter(Boolean).join('\n\n') || undefined
    const args = claudeArgs({
      sessionId: claudeSessionId, resume, mcpConfig: this.opts.mcpConfig?.(id),
      model: session.model ?? agent.model,
      permissionMode: session.permissionMode,
      appendSystemPrompt: systemPrompt,
      allowedTools: agent.allowedTools,
      disallowedTools: agent.disallowedTools,
    })

    // Confinement decision (see SANDBOX.md): wrap `claude …` in bwrap only when the
    // session requests it AND the host can actually sandbox. Otherwise spawn claude
    // directly and record sandboxed=false so the UI never shows a false green light.
    const runCwd = cwd || homedir()
    const wantSandbox = !!session.sandbox?.enabled
    const canSandbox = wantSandbox && sandboxAvailable()
    const spawn = canSandbox
      ? wrapSandbox(session.sandbox!, args, runCwd)
      : { command: 'claude', args }
    session.sandboxed = canSandbox

    const engine = new ClaudeEngine({
      command: spawn.command,
      args: spawn.args,
      cwd: runCwd,
      env: process.env as Record<string, string>,
    })

    session.engine = engine
    session.startedAt = Date.now()
    session.state = 'idle'
    session.closing = false
    session.stderrTail = ''
    session.sawInit = false

    engine.on('event', (e: ClaudeEvent) => {
      if (e.type === 'stderr' && typeof e.text === 'string') {
        session.stderrTail = (session.stderrTail + e.text).slice(-TAIL_MAX)
      }
      // Swallow a `result` that arrives before this launch's init — it's a startup
      // failure (a missing --resume target emits subtype:error_during_execution then
      // exits), not a real turn result. Forwarding it would flash a bogus error
      // banner; the exit handler recovers by relaunching fresh.
      if (e.type === 'result' && !session.sawInit) return
      this.emit('event', id, e)
    })
    engine.on('ready', (sid: string) => {
      // claude may hand back a different id (e.g. on resume mismatch); trust it.
      session.sawInit = true
      session.claudeSessionId = sid
      this.emit('ready', id, sid)
    })
    engine.on('permission', (req: PermissionRequest) => this.emit('permission', id, req))
    engine.on('state', (state: 'idle' | 'running' | 'waiting') => this.setState(id, state))
    engine.on('exit', (code: number | null) => {
      // A resumeInto() kill: relaunch straight into the chosen conversation
      // rather than treating the exit as a crash/close.
      if (session.replacing) {
        session.replacing = false
        this.launch(session)
        this.emit('stateChange', id, session.state)
        return
      }
      // A --resume whose target conversation is gone (never written, /clear-ed, or
      // a stale saved id) makes claude print "No conversation found" and exit.
      // Retry once as a FRESH session, keeping the same id via --session-id so it
      // becomes resumable again. Timing-independent (not gated on the fast-fail
      // window).
      if (!session.closing && session.resume && !session.resumeFallbackTried
          && /no conversation found/i.test(session.stderrTail)) {
        session.resumeFallbackTried = true
        session.resume = false
        this.launch(session)
        this.emit('stateChange', id, session.state)
        return
      }
      // A startup failure = the engine exited before it ever emitted system/init
      // (e.g. `claude: not found`). Detect it by the MISSING init rather than by the
      // 4s window: a slow launch can take longer than the grace, and then the exit
      // would be misread as a normal close and the row silently removed. Keeping
      // !sawInit as the primary signal means "claude not found" always leaves the
      // session in place (error + Retry). The timing check stays as a secondary
      // catch for an init-less early death.
      const failedFast = !session.closing
        && (!session.sawInit || Date.now() - session.startedAt < STARTUP_GRACE_MS)
      if (failedFast) {
        session.engine = null
        session.state = 'exited'
        this.emit('exit', id, true, (session.stderrTail || `claude exited (code ${code})`).trim())
      } else {
        this.cleanup(id)
        this.emit('exit', id, false, '')
      }
    })

    engine.start()
  }

  relaunch(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    if (session.engine) return true
    // A relaunch of a session that already had a claude id resumes it.
    session.resume = true
    session.resumeFallbackTried = false
    this.launch(session)
    this.emit('stateChange', id, session.state)
    this.emit('changed')   // launch() recomputed `sandboxed` — propagate it
    return true
  }

  // Rebind a session to a past conversation and relaunch its engine with
  // --resume <claudeSessionId>. Backs the native /resume picker. If the engine
  // is running, the replacing flag makes its exit relaunch (see launch()).
  resumeInto(id: string, claudeSessionId: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.claudeSessionId = claudeSessionId
    session.resume = true
    session.resumeFallbackTried = false
    if (session.engine) {
      session.replacing = true
      session.engine.kill()
    } else {
      this.launch(session)
      this.emit('stateChange', id, session.state)
    }
    this.emit('changed')   // claudeSessionId changed → re-persist
  }

  // Restart a session with a brand-new conversation (fresh --session-id, no
  // resume) — the native /clear. Resets context; the caller clears the transcript.
  restartFresh(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.claudeSessionId = crypto.randomUUID()
    session.resume = false
    if (session.engine) {
      session.replacing = true
      session.engine.kill()
    } else {
      this.launch(session)
      this.emit('stateChange', id, session.state)
    }
    this.emit('changed')   // fresh claudeSessionId → re-persist
  }

  // --- turn I/O (replaces keystroke sendInput) -------------------------------

  sendUserTurn(id: string, text: string): void {
    this.sessions.get(id)?.engine?.sendUserTurn(text)
  }

  interrupt(id: string): void {
    this.sessions.get(id)?.engine?.interrupt()
  }

  respondPermission(id: string, requestId: string, decision: PermissionDecision): void {
    this.sessions.get(id)?.engine?.respondPermission(requestId, decision)
  }

  // Store the mode (so a relaunch keeps it), then apply it. Order of preference:
  //  1. a live switch over the control protocol (instant, no restart);
  //  2. if the CLI declines that (headless mode doesn't register the callback) and
  //     the session is idle, restart its engine resume-preserving so the flag takes
  //     effect now without losing the conversation;
  //  3. otherwise (no engine, or a turn in flight we won't interrupt) leave it
  //     stored to apply on the next launch.
  async setPermissionMode(id: string, mode: PermissionMode): Promise<SetModeResult> {
    const session = this.sessions.get(id)
    if (!session) return { applied: 'error', error: 'no such session' }
    session.permissionMode = mode
    this.emit('changed')   // mode is persisted + re-applied on restore
    if (!session.engine) return { applied: 'restart', mode, reason: 'session not running' }

    const r = await session.engine.setPermissionMode(mode)
    if (r.ok) return { applied: 'live', mode }

    // Live switch unavailable. Restart the engine to apply the launch flag, but
    // only when idle — killing a running turn would be worse than waiting.
    if (session.state === 'idle' && session.sawInit && session.claudeSessionId) {
      session.resume = true                 // resume the same conversation on relaunch
      session.resumeFallbackTried = false
      session.replacing = true              // exit handler relaunches instead of closing
      session.engine.kill()
      return { applied: 'relaunched', mode }
    }
    return { applied: 'restart', mode, reason: r.error }
  }

  destroy(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.closing = true
    if (session.engine) {
      session.engine.kill()  // fires exit → cleanup + 'exit'
    } else {
      this.cleanup(id)
      this.emit('exit', id, false, '')
    }
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => this.toInfo(s))
  }

  get(id: string): SessionInfo | undefined {
    const s = this.sessions.get(id)
    return s ? this.toInfo(s) : undefined
  }

  private toInfo(s: Session): SessionInfo {
    const { id, name, cwd, rootDir, parentId, agentId, model, permissionMode, sandbox, sandboxed, state } = s
    return { id, name, cwd, rootDir, parentId, agentId, model, permissionMode, sandbox, sandboxed, state }
  }

  // Change a session's sandbox config. Applies on the next launch (relaunch/restart);
  // we don't hot-swap a running engine. Persisted so a restart keeps it.
  setSandbox(id: string, sandbox: SandboxConfig): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.sandbox = normalizeSandbox(sandbox, session.cwd)
    this.emit('changed')
    return true
  }

  // Claude's own session id, for persistence (--resume on restore).
  claudeSessionId(id: string): string | undefined {
    return this.sessions.get(id)?.claudeSessionId
  }

  // --- persistence (P1.19) ---------------------------------------------------

  // Snapshot the session set for saving. `parentIndex` encodes subsession parentage
  // positionally (ids are regenerated on restore).
  saved(): SavedSession[] {
    const list = [...this.sessions.values()]
    const indexOf = new Map(list.map((s, i) => [s.id, i]))
    return list.map((s) => ({
      name: s.name, cwd: s.cwd, rootDir: s.rootDir,
      parentIndex: s.parentId != null ? indexOf.get(s.parentId) : undefined,
      agentId: s.agentId, model: s.model, permissionMode: s.permissionMode,
      sandbox: s.sandbox,
      claudeSessionId: s.claudeSessionId,
    }))
  }

  // Recreate saved sessions, each resumed into its conversation (--resume). Called
  // once at boot; returns the new ids in saved order (so parentIndex can be mapped).
  restore(saved: SavedSession[]): string[] {
    const ids: string[] = []
    for (const s of saved) {
      const parentId = s.parentIndex != null ? ids[s.parentIndex] : undefined
      const id = this.create(
        s.name, s.cwd, s.rootDir, parentId,
        /* resume */ !!s.claudeSessionId, s.claudeSessionId,
        s.agentId, s.model, s.permissionMode, s.sandbox,
      )
      ids.push(id)
    }
    return ids
  }

  private setState(id: string, state: SessionState): void {
    const session = this.sessions.get(id)
    if (!session || session.state === state) return
    session.state = state
    this.emit('stateChange', id, state)
  }

  private cleanup(id: string): void {
    this.sessions.delete(id)
    this.emit('changed')   // set shrank → re-persist
  }
}

// Sandbox is ON BY DEFAULT (see SANDBOX.md): when the caller passes no config we
// seed { enabled: true, mounts: [cwd rw] }. An explicit config is honored as-is but
// we still guarantee the session's own cwd is present as a writable mount (claude
// must be able to work in the dir it was opened in). Whether the sandbox is actually
// in force is decided at launch (host capability) and reported via `sandboxed`.
function normalizeSandbox(sandbox: SandboxConfig | undefined, cwd: string): SandboxConfig {
  if (!sandbox) return { enabled: true, mounts: cwd ? [{ path: cwd, mode: 'rw' }] : [] }
  const hasCwd = cwd && sandbox.mounts.some((m) => m.path === cwd)
  const mounts = hasCwd || !cwd ? sandbox.mounts : [...sandbox.mounts, { path: cwd, mode: 'rw' as const }]
  return { enabled: sandbox.enabled, mounts }
}
