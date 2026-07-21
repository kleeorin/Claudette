import { EventEmitter } from 'events'
import { homedir } from 'os'
import { existsSync } from 'fs'
import path from 'path'
import crypto from 'crypto'
import type {
  SessionInfo, SessionState, ClaudeEvent, PermissionRequest, PermissionDecision,
  PermissionMode, SetModeResult, SavedSession, SandboxConfig, TaskRecord,
} from '@claudette/shared'
import {
  isSubagentTool, isAsyncLaunchAck, parseTaskNotification, parseSystemTaskNotification,
  assistantToolUses, userToolResults, userEventText,
} from '@claudette/shared'
import { ClaudeEngine, claudeArgs } from './claudeEngine'
import { getAgent, isAgent, SUBSESSION_REPORT_INSTRUCTION } from './agents'
import { listRewindPoints } from './conversations'
import { snapshot, saveRef } from '../git/shadowSnapshots'
import { wrapSandbox, sandboxAvailable, sandboxSystemPrompt, sandboxKey, unsandboxedAllowed } from './sandbox'
import { markConfigExposed, isConfigExposed, scrubbedHostConfigDir } from './configProtection'

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
  // sandbox / sandboxed come from SessionInfo (see SANDBOX.md; sandboxed = EFFECTIVE)
  appliedSandboxKey?: string    // sandbox state actually in force at last launch (pending detection)
  sandboxApplyTimer?: ReturnType<typeof setTimeout>  // debounce for auto-apply-when-idle
  claudeSessionId: string       // claude's own session id (for --resume)
  startedAt: number             // last launch time, for the fast-failure heuristic
  resume: boolean               // whether Claude was launched with --resume
  closing?: boolean             // set by destroy() so a kill isn't misread as a crash
  replacing?: boolean           // set by resumeInto() so the kill relaunches instead of exiting
  stderrTail: string            // recent stderr, so a fast failure can show why
  resumeFallbackTried?: boolean // retried a missing --resume target as a fresh session once
  sawInit?: boolean             // a system/init arrived this launch (distinguishes real turns from startup failures)
  // A pre-turn working-tree snapshot (git commit sha) awaiting the turn's message
  // uuid, which is known only once the turn ends — see attachPendingSnapshot. Backs
  // /rewind code-restore (Phase 2). `text` matches the snapshot to its user turn.
  pendingSnapshot?: { commit: string; text: string }
}

// A session that dies within this window of launching never really started
// (e.g. `claude: command not found`). We report those as failures (keep the row
// + show output) rather than silently removing the session.
const STARTUP_GRACE_MS = 4000
const TAIL_MAX = 2000
// Cap the per-session in-memory transcript buffer (raw stream-json events kept for
// the connect-time snapshot). Bounds memory on very long sessions; the CLI's own
// .jsonl holds the complete history for /resume, so this only limits the live
// catch-up a freshly-connected device gets.
const TRANSCRIPT_CAP = 4000

// Optional hooks the app injects (kept out of SessionManager's core so it stays
// transport-only). `mcpConfig` returns the --mcp-config string for a session
// (the app-control server); undefined skips it.
export interface SessionManagerOpts {
  mcpConfig?: (sessionId: string) => string | undefined
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>()
  // Per-session transcript (raw stream-json events) + the current unanswered
  // permission prompt, so a client connecting mid-session can be handed a snapshot
  // (see session:snapshot / snapshot getters below). Kept separate from Session so
  // they never leak into persistence or toInfo().
  private transcripts = new Map<string, ClaudeEvent[]>()
  // sessionId → (requestId → request). A session can have MORE THAN ONE unanswered
  // prompt at once: when an assistant message contains several tool_uses the CLI
  // fires their can_use_tool requests in parallel. Keying by requestId (not a single
  // slot) is what stops a second prompt from shadowing the first — the shadowed one
  // used to stay blocked forever, so the session looked like it hung "working".
  private pendingPerms = new Map<string, Map<string, PermissionRequest>>()
  // sessionId → (Task/Agent tool_use id → record). The AUTHORITATIVE per-session subagent
  // registry — un-capped and persisted, unlike the transcript ring — so a background
  // agent's terminal outcome survives eviction, a never-buffered resume, or a restart,
  // and a tray card can always settle. Fed from the same engine event tap as buffer()
  // (recordTask) and force-settled when the engine dies (settleOpenTasks).
  private tasks = new Map<string, Map<string, TaskRecord>>()

  constructor(private readonly opts: SessionManagerOpts = {}) { super() }

  // The subagent records for a session (for the connect snapshot + persistence).
  tasksOf(id: string): TaskRecord[] { return [...(this.tasks.get(id)?.values() ?? [])] }

  // Append an event to a session's transcript buffer, capped at TRANSCRIPT_CAP
  // (oldest dropped). The live UI shows user PROMPTS via the userTurn mirror, not the
  // event stream, and sendUserTurn records them here itself — so drop the CLI's
  // string-content user echo to avoid a double prompt on replay. Tool-result user
  // events (array content) are real transcript material and are kept.
  private buffer(id: string, e: ClaudeEvent): void {
    // Drop only the CLI's echo of a user PROMPT (mirrored via userTurn) — but KEEP
    // system-injected turns like <task-notification>, which drive agent-tray state. The
    // invariant: a reconnect snapshot reconstructs the same state the live stream did;
    // without it, a device joining after a background agent finished replays it as running.
    if (e.type === 'user') {
      const content = (e as { message?: { content?: unknown } }).message?.content
      if (typeof content === 'string' && !content.includes('<task-notification>')) return
    }
    const buf = this.transcripts.get(id) ?? []
    buf.push(e)
    if (buf.length > TRANSCRIPT_CAP) buf.splice(0, buf.length - TRANSCRIPT_CAP)
    this.transcripts.set(id, buf)
  }

  // Connect-time snapshot inputs (see session:snapshot): the buffered transcript
  // and any still-unanswered permission prompt for a session.
  transcriptOf(id: string): ClaudeEvent[] { return this.transcripts.get(id) ?? [] }
  pendingPermissionsOf(id: string): PermissionRequest[] { return [...(this.pendingPerms.get(id)?.values() ?? [])] }

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
    // Only an auth-gated HTTP caller (the operator) or boot-restore may pass a
    // sandbox with enabled:false; an untrusted/in-process caller can't lower it.
    trusted = false,
  ): string {
    const id = crypto.randomUUID()
    const session: Session = {
      id, name, cwd, rootDir, parentId, agentId, model, permissionMode,
      sandbox: normalizeSandbox(sandbox, cwd, trusted),
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
    // Decide confinement first so it can inform the system prompt (a sandboxed
    // session is told what it can see — see sandboxSystemPrompt).
    const runCwd = cwd || homedir()
    const canSandbox = !!session.sandbox?.enabled && sandboxAvailable()
    // Per-session model override wins over the role's default model. Every
    // subsession (has a parentId) also gets the "report back when done" instruction
    // appended, so the orchestration loop closes even if the role charter doesn't
    // mention it. A sandboxed session also gets a note describing its mounts so it
    // treats hidden paths as "outside the sandbox", not "missing".
    const systemPrompt = [
      agent.systemPrompt,
      session.parentId ? SUBSESSION_REPORT_INSTRUCTION : undefined,
      canSandbox ? sandboxSystemPrompt(session.sandbox!, runCwd) : undefined,
    ].filter(Boolean).join('\n\n') || undefined
    const args = claudeArgs({
      sessionId: claudeSessionId, resume, mcpConfig: this.opts.mcpConfig?.(id),
      model: session.model ?? agent.model,
      permissionMode: session.permissionMode,
      appendSystemPrompt: systemPrompt,
      allowedTools: agent.allowedTools,
      disallowedTools: agent.disallowedTools,
    })

    // Confinement (see SANDBOX.md): wrap `claude …` in bwrap only when the session
    // requests it AND the host can actually sandbox (decided above). Otherwise spawn
    // claude directly. Record sandboxed so the UI never shows a false green light.
    // wrapSandbox can THROW (e.g. it refuses to give a dropped cwd a writable mount it
    // can't make read-only — better a visible startup error than silently-lost writes);
    // surface that as an exited session rather than crashing the create/relaunch call.
    let spawn: { command: string; args: string[] }
    try {
      spawn = canSandbox ? wrapSandbox(session.sandbox!, args, runCwd) : { command: 'claude', args }
    } catch (e) {
      session.engine = null
      session.state = 'exited'
      const msg = e instanceof Error ? e.message : 'sandbox setup failed'
      this.emit('stateChange', id, 'exited')
      this.emit('exit', id, true, msg)
      return
    }
    session.sandboxed = canSandbox

    // Cross-session hook poisoning (SANDBOX.md, configProtection.ts). A confined
    // session's config becomes "exposed" — a later HOST-MODE session against it gets a
    // scrubbed config mirror (hooks/mcpServers stripped) so nothing the box could have
    // written to settings executes unsandboxed. bwrap ignores the child env (--clearenv
    // sets CLAUDE_CONFIG_DIR itself), so this override only bites the host-mode branch.
    let launchEnv = process.env as Record<string, string>
    if (canSandbox) {
      markConfigExposed(runCwd)
    } else if (isConfigExposed(runCwd)) {
      const scrubbed = scrubbedHostConfigDir()
      if (scrubbed) launchEnv = { ...process.env, CLAUDE_CONFIG_DIR: scrubbed } as Record<string, string>
      // Single host-execution chokepoint: an exposed config can carry hooks/MCP a confined
      // session wrote at ANY scope. Read only the (scrubbed) user config, ignore project +
      // local entirely — so create-after-launch project settings, settings.local.json, and
      // project-scope hooks are all inert. --strict-mcp-config keeps Claudette's own
      // app-control server (it rides --mcp-config) while dropping settings-defined MCP. No
      // per-file pin can be raced here; the pin/scrub layers become defense-in-depth.
      spawn = { ...spawn, args: [...spawn.args, '--setting-sources', 'user', '--strict-mcp-config'] }
    }

    session.appliedSandboxKey = sandboxKey(session.sandbox, runCwd)   // what's now actually running

    const engine = new ClaudeEngine({
      command: spawn.command,
      args: spawn.args,
      cwd: runCwd,
      env: launchEnv,
      permissionMode: session.permissionMode,   // so "allow all" auto-approves without the CLI's cooperation
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
      this.buffer(id, e)   // keep for the connect-time snapshot (late-joining devices)
      this.recordTask(id, e)   // authoritative subagent registry (durable tray-card state)
      // Key this turn's pre-turn working-tree snapshot to its message uuid so /rewind
      // can restore code to this point. Fired on the FIRST assistant event (the user
      // line, with its uuid, is on disk by the time the model replies) so the snapshot
      // ref is written early in the turn — not racing a client that opens /rewind the
      // instant the turn ends. `result` is a fallback if no assistant event appeared.
      if (e.type === 'assistant' || e.type === 'result') void this.attachPendingSnapshot(session)
    })
    engine.on('ready', (sid: string) => {
      // claude may hand back a different id (e.g. on resume mismatch); trust it.
      session.sawInit = true
      session.claudeSessionId = sid
      this.emit('ready', id, sid)
    })
    engine.on('permission', (req: PermissionRequest) => {
      // Track EVERY outstanding prompt by requestId (parallel tool_uses ⇒ several at
      // once) so a late-joining device gets them all and none gets shadowed.
      const m = this.pendingPerms.get(id) ?? new Map<string, PermissionRequest>()
      m.set(req.requestId, req)
      this.pendingPerms.set(id, m)
      this.emit('permission', id, req)
    })
    engine.on('permissionResolved', (requestId: string) => {
      this.pendingPerms.get(id)?.delete(requestId)   // drop just the answered prompt
      this.emit('permissionResolved', id, requestId)
    })
    engine.on('state', (state: 'idle' | 'running' | 'waiting') => {
      if (state === 'idle') this.pendingPerms.delete(id)   // no prompt outlives an idle turn
      this.setState(id, state)
    })
    engine.on('exit', (code: number | null) => {
      // The engine (and its in-process subagents) just died — settle any task still
      // marked running so no tray card is stranded, whatever exit path we take below.
      this.settleOpenTasks(id)
      // A resumeInto() kill: relaunch straight into the chosen conversation
      // rather than treating the exit as a crash/close.
      if (session.replacing) {
        session.replacing = false
        this.launch(session)                    // recomputes appliedSandboxKey
        this.emit('stateChange', id, session.state)
        this.emit('changed')                    // sandboxPending may have cleared → refresh UI
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

  // Restart the engine to APPLY a config change (sandbox mounts, etc.), preserving
  // the conversation via --resume. Unlike relaunch() below — which no-ops on a live
  // engine because it's for re-spawning a DEAD one — this restarts a running engine
  // too (kill → the exit handler relaunches via the `replacing` flag, re-reading the
  // updated config). Without this, added mounts never take effect on a live session.
  relaunchApply(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    session.resume = true
    session.resumeFallbackTried = false
    if (session.engine) {
      session.replacing = true
      session.engine.kill()
    } else {
      this.launch(session)
      this.emit('stateChange', id, session.state)
      this.emit('changed')
    }
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
    this.transcripts.delete(id)          // rebinding to another conversation → drop old buffer
    this.pendingPerms.delete(id)
    this.tasks.delete(id)                // different conversation → its subagents are irrelevant
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
    this.transcripts.delete(id)          // fresh conversation → drop the old snapshot buffer
    this.pendingPerms.delete(id)
    this.tasks.delete(id)                // fresh conversation → no carried-over subagents
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

  async sendUserTurn(id: string, text: string, turnId?: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session?.engine) return
    // A new user message = a new turn: notify listeners so per-turn state (e.g. the
    // notebook "working target" pin) resets and re-binds to the user's current view,
    // AND so every client mirrors the message (text/turnId), not just the sender.
    this.emit('userTurn', id, text, turnId)
    // Record the prompt in the snapshot buffer so a late-joining device sees the
    // question, not just the answer (the live stream carries no renderable prompt —
    // buffer() drops the CLI's string echo, so this is the single source).
    const buf = this.transcripts.get(id) ?? []
    buf.push({ type: 'user', message: { content: text } } as unknown as ClaudeEvent)
    if (buf.length > TRANSCRIPT_CAP) buf.splice(0, buf.length - TRANSCRIPT_CAP)
    this.transcripts.set(id, buf)
    // Snapshot the working tree BEFORE the turn runs (git-only; no-op elsewhere), so
    // /rewind can later restore code to this pre-edit state. Awaited so the capture
    // lands before Claude can edit; keyed to the turn's uuid when the turn ends.
    session.pendingSnapshot = undefined
    const commit = await snapshot(session.cwd).catch(() => null)
    if (commit) session.pendingSnapshot = { commit, text }
    if (!session.engine) return   // engine may have exited during the await
    session.engine.sendUserTurn(text)
  }

  // Key a turn's pending pre-turn snapshot to the uuid of its user message, so a rewind
  // point — also uuid-keyed — maps straight to it. Called repeatedly through the turn;
  // it no-ops once keyed (pending cleared) and only commits on a CONFIDENT match — the
  // latest not-yet-snapshotted turn whose text equals what we sent. If the user line
  // isn't on disk yet (no match), pending is left for a later call to resolve, so we
  // never mis-key this snapshot onto an earlier turn. Best effort: a non-git session or
  // a never-matching turn simply leaves no code snapshot.
  private async attachPendingSnapshot(session: Session): Promise<void> {
    const pending = session.pendingSnapshot
    if (!pending) return
    try {
      const points = await listRewindPoints(session.cwd, session.claudeSessionId)
      const match = [...points].reverse().find((p) => !p.hasSnapshot && p.text === pending.text.trim())
      if (!match) return   // user line not on disk yet — retry on a later event
      session.pendingSnapshot = undefined   // clear only once we've found the turn to key
      await saveRef(session.cwd, match.uuid, pending.commit)
    } catch { /* leave pending; a later event (or result) retries */ }
  }

  // Fold one raw stream-json event into the subagent registry. Runs from the same tap
  // as buffer(), so it captures a subagent's identity when its Task tool_use is first
  // seen — meaning a card can be reconstructed even after both the tool_use and the
  // <task-notification> are evicted from the ring. Emits 'task' (live UI) + 'changed'
  // (persist) only when something actually changed.
  private recordTask(id: string, e: ClaudeEvent): void {
    const m = this.tasks.get(id) ?? new Map<string, TaskRecord>()
    let changed = false
    if (e.type === 'assistant') {
      for (const b of assistantToolUses(e)) {
        if (!isSubagentTool(b.name) || m.has(b.id)) continue
        const input = b.input as { subagent_type?: string; description?: string; prompt?: string }
        m.set(b.id, {
          toolId: b.id,
          type: input.subagent_type || 'agent',
          description: input.description || 'Subagent task',
          prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
          launched: false,
          status: 'running',
        })
        changed = true
      }
    } else if (e.type === 'user') {
      for (const tr of userToolResults(e)) {
        const rec = m.get(tr.toolUseId)
        if (!rec) continue
        // The async-launch ack marks a background agent launched (still running); any
        // OTHER tool_result for a Task is a foreground agent's terminal output.
        if (isAsyncLaunchAck(tr.content)) {
          if (!rec.launched) { rec.launched = true; changed = true }
        } else if (rec.status === 'running') {
          rec.status = 'done'; changed = true
        }
      }
      // A <task-notification> user turn is the terminal signal on older CLIs.
      const notif = parseTaskNotification(userEventText(e))
      const rec = notif ? m.get(notif.toolUseId) : undefined
      if (notif && rec && rec.status === 'running') {
        rec.status = notif.isError ? 'failed' : 'done'
        rec.summary = notif.summary
        changed = true
      }
    } else if (e.type === 'system') {
      // The current CLI delivers that same terminal signal as a `system` event
      // (subtype task_notification) instead — settle the background card off it, else
      // a completed background agent hangs "running" until the engine exits/restarts.
      const notif = parseSystemTaskNotification(e)
      const rec = notif ? m.get(notif.toolUseId) : undefined
      if (notif && rec && rec.status === 'running') {
        rec.status = notif.isError ? 'failed' : 'done'
        rec.summary = notif.summary
        changed = true
      }
    }
    if (changed) {
      this.tasks.set(id, m)
      this.emit('task', id, this.tasksOf(id))
      this.emit('changed')   // persist created/settled tasks (throttled by the save timer)
    }
  }

  // The liveness fallback the client lacks: when a session's engine dies (crash, close,
  // relaunch, resume-fallback), its in-process subagents die with it — so mark every
  // still-'running' task terminal. A card for a dead agent can then never stay "running",
  // even if its <task-notification> never arrived. Only called on engine death — never on
  // turn-idle — so a genuinely-live background agent isn't settled early.
  private settleOpenTasks(id: string, reason = 'Agent ended (session stopped)'): void {
    const m = this.tasks.get(id)
    if (!m) return
    let changed = false
    for (const rec of m.values()) {
      if (rec.status !== 'running') continue
      rec.status = 'failed'
      if (!rec.summary) rec.summary = reason
      changed = true
    }
    if (changed) { this.emit('task', id, this.tasksOf(id)); this.emit('changed') }
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
    // User closed this session — tear down resources owned by it (e.g. notebook
    // kernels). Distinct from 'exit', which also fires on a crash.
    this.emit('destroyed', id)
    if (session.engine) {
      session.engine.kill()  // fires exit → cleanup + 'exit'
    } else {
      this.cleanup(id)
      this.emit('exit', id, false, '')
    }
  }

  // Server going down: kill every engine so no bwrap/claude children orphan and
  // linger (the common cause of leftover processes after Ctrl-C or a tsx-watch
  // restart). shutdown() SIGTERMs each process group; killHard() SIGKILLs whatever
  // survives, called just before the process exits.
  shutdown(): void {
    for (const s of this.sessions.values()) {
      if (s.sandboxApplyTimer) clearTimeout(s.sandboxApplyTimer)
      s.closing = true
      s.engine?.kill()
    }
  }

  killHard(): void {
    for (const s of this.sessions.values()) s.engine?.killForce()
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
    // Pending = a running engine whose applied sandbox differs from the requested one
    // (auto-applies on idle; visible only while a turn holds it off).
    const sandboxPending = !!s.engine && sandboxKey(sandbox, cwd) !== s.appliedSandboxKey
    return { id, name, cwd, rootDir, parentId, agentId, model, permissionMode, sandbox, sandboxed, sandboxPending, state }
  }

  // Change a session's role (agent). The charter/tool-scope/model are read at launch,
  // so we bring the change into force with a resume-preserving relaunch — the new
  // engine picks up the new role while keeping the conversation. Persisted (agentId is
  // re-applied on restore). Returns false for an unknown id or agentId.
  setAgent(id: string, agentId: string): boolean {
    const session = this.sessions.get(id)
    if (!session || !isAgent(agentId)) return false
    if (session.agentId === agentId || (!session.agentId && agentId === 'general')) return true  // no-op
    session.agentId = agentId
    this.emit('changed')
    this.relaunchApply(id)   // re-spawn with the new charter/tools/model (keeps the conversation)
    return true
  }

  // Rename a session (display name only). Ignores an empty name. Persisted.
  rename(id: string, name: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    const trimmed = name.trim()
    if (!trimmed) return false
    session.name = trimmed
    this.emit('changed')
    return true
  }

  // Change a session's sandbox config. Applies on the next launch (relaunch/restart);
  // we don't hot-swap a running engine. Persisted so a restart keeps it.
  setSandbox(id: string, sandbox: SandboxConfig, trusted = false): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.sandbox = normalizeSandbox(sandbox, session.cwd, trusted)
    this.emit('changed')
    this.scheduleSandboxApply(id)   // apply now if idle, else when the turn ends
    return true
  }

  // Auto-apply a pending sandbox change (mounts differ from what's running) by a
  // resume-preserving relaunch — but only when the session is IDLE (killing a live
  // turn would be worse than waiting). Debounced so a burst of mount edits coalesces
  // into one relaunch. When busy, this no-ops; setState re-invokes it on the next idle.
  private scheduleSandboxApply(id: string): void {
    const session = this.sessions.get(id)
    if (!session || !session.engine) return                          // nothing running to update
    if (sandboxKey(session.sandbox, session.cwd) === session.appliedSandboxKey) return  // already in force
    if (session.state !== 'idle') return                             // wait; retried on idle
    if (session.sandboxApplyTimer) clearTimeout(session.sandboxApplyTimer)
    session.sandboxApplyTimer = setTimeout(() => {
      const s = this.sessions.get(id)
      if (!s) return
      s.sandboxApplyTimer = undefined
      if (s.engine && s.state === 'idle' && sandboxKey(s.sandbox, s.cwd) !== s.appliedSandboxKey) {
        this.relaunchApply(id)
      }
    }, 700)
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
      tasks: this.tasksOf(s.id).length ? this.tasksOf(s.id) : undefined,
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
        /* trusted */ true,   // a persisted config was already operator-approved
      )
      ids.push(id)
      // Rehydrate the subagent registry. Any task persisted as 'running' can't actually
      // be — its in-process agent died with the previous server — so settle it to failed
      // so a restored session never shows a card stuck running.
      if (s.tasks?.length) {
        const m = new Map<string, TaskRecord>()
        for (const t of s.tasks) {
          m.set(t.toolId, t.status === 'running'
            ? { ...t, status: 'failed', summary: t.summary ?? 'Agent ended (server restarted)' }
            : t)
        }
        this.tasks.set(id, m)
      }
    }
    return ids
  }

  private setState(id: string, state: SessionState): void {
    const session = this.sessions.get(id)
    if (!session || session.state === state) return
    session.state = state
    this.emit('stateChange', id, state)
    // A turn just ended — apply any sandbox change that was waiting for idle.
    if (state === 'idle') this.scheduleSandboxApply(id)
  }

  private cleanup(id: string): void {
    const s = this.sessions.get(id)
    if (s?.sandboxApplyTimer) clearTimeout(s.sandboxApplyTimer)
    this.sessions.delete(id)
    this.transcripts.delete(id)   // free the snapshot buffers with the session
    this.pendingPerms.delete(id)
    this.tasks.delete(id)         // free the subagent registry with the session
    this.emit('changed')   // set shrank → re-persist
  }
}

// A stable key of the sandbox state that WOULD be applied at launch: 'off' when
// Sandbox is ON BY DEFAULT (see SANDBOX.md): when the caller passes no config we seed
// { enabled: true, mounts: [cwd rw] } — the convenient default. An explicit config is
// honored AS-IS: cwd is now OPTIONAL (rw / ro / removed), so we never force it back in.
// The obligatory data mounts (global + local .claude) are added at launch by
// wrapSandbox, and claude's working dir stays valid via its --chdir handling there.
// Whether the sandbox is actually in force is decided at launch (host capability) and
// reported via `sandboxed`.
export function normalizeSandbox(sandbox: SandboxConfig | undefined, cwd: string, trusted = false): SandboxConfig {
  const cfg: SandboxConfig = !sandbox
    ? { enabled: true, mounts: cwd ? [{ path: cwd, mode: 'rw' }] : [] }
    : { enabled: sandbox.enabled, mounts: sandbox.mounts }
  // Confinement must NOT be lowerable by an UNTRUSTED request. A sandboxed session
  // that reaches the loopback control API (SANDBOX.md "Control-plane escape") could
  // otherwise ask for enabled:false and get an unconfined session — but it can't
  // authenticate: wrapSandbox never leaks CLAUDETTE_TOKEN into the box, so an in-box
  // caller has no token. `trusted` is set only by the auth-gated HTTP handlers (the
  // operator's own browser) and by boot restore of a previously-approved config.
  // Everything else stays forced-on unless the operator opted in at launch
  // (CLAUDETTE_ALLOW_UNSANDBOXED=1), a capability an in-box caller can't grant itself.
  if (!cfg.enabled && !trusted && !unsandboxedAllowed()) {
    console.warn('[sandbox] ignoring untrusted sandbox.enabled=false — set CLAUDETTE_ALLOW_UNSANDBOXED=1 to permit unconfined sessions')
    return { enabled: true, mounts: cfg.mounts }
  }
  return cfg
}
