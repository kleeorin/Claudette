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
  parseTaskStarted, taskIdOfNotification,
  assistantToolUses, userToolResults, userEventText,
} from '@claudette/shared'
import { ClaudeEngine, claudeArgs } from './claudeEngine'
import { getAgent, isAgent, COORDINATOR_INSTRUCTION, MEMBER_INSTRUCTION } from './agents'
import { listRewindPoints, projectDir } from './conversations'
import { buildEditorContext } from './editorContext'
import { snapshot, saveRef } from '../git/shadowSnapshots'
import { wrapSandbox, sandboxAvailable, sandboxSystemPrompt, sandboxKey, unsandboxedAllowed } from './sandbox'
import { markConfigExposed, isConfigExposed, scrubbedHostConfigDir, releaseHostConfigDir } from './configProtection'

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
  applyTimer?: ReturnType<typeof setTimeout>  // debounce for auto-apply-when-idle (sandbox AND charter)
  // Was the COORDINATOR charter in the system prompt at the last launch? A session
  // becomes a coordinator the moment it gains its first member and stops being one when
  // it loses its last, so this tracks what's actually in force vs. what should be —
  // exactly the appliedSandboxKey pattern, and applied by the same idle-debounced relaunch.
  appliedCoordinator?: boolean
  // …and whether the MEMBER charter was. Needed as its own field because membership is
  // read off `parentId`, which cleanup() clears when a coordinator is destroyed — without
  // this, launchStale had no term that noticed, so a promoted orphan kept being told to
  // report to a coordinator that no longer exists.
  appliedMember?: boolean
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
  // What the session is currently viewing (its active content tab), so a user turn
  // can carry ambient "edit this file" context for the open CODE file. Notebooks are
  // steered separately via the path-less app-control tools, so they're ignored here.
  activePane?: (sessionId: string) => { path: string; isNotebook: boolean } | null | undefined
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
    // Never buffer token-level partials. --include-partial-messages emits ONE stream_event
    // per token, so a single busy turn could push several thousand of them through a
    // TRANSCRIPT_CAP of 4000 and evict the events that actually carry state — assistant
    // messages, tool results, task notifications — leaving a reconnecting device with a
    // snapshot of the last message or two. They're also redundant: the completed
    // `assistant` event that follows re-materializes the same text, which is exactly how a
    // device joining mid-turn catches up today. Dropping them costs nothing and gives the
    // cap back to meaningful history.
    if (e.type === 'stream_event') return
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
    teamEmploy?: boolean,
  ): string {
    const session = this.register(
      name, cwd, rootDir, parentId, resume, claudeSessionId,
      agentId, model, permissionMode, sandbox, trusted, teamEmploy,
    )
    this.launch(session)
    // This session's parent may have just gained its first member and become a
    // coordinator — bring the coordinator charter into force (idle-debounced, so no
    // turn is killed for it).
    if (parentId) this.scheduleApply(parentId)
    this.emit('changed')   // persist the new set (P1.19) — claudeSessionId exists upfront
    return session.id
  }

  // Build and register a session WITHOUT launching it. Split out of create() for boot
  // restore, which must have the whole set in the map before anything spawns: launch()
  // decides the coordinator charter from childrenOf(), so a parent launched before its
  // members were registered would come up as a plain session and then need a relaunch
  // to gain its charter — an extra spawn per coordinator on every boot, racing the
  // startup fast-fail grace window.
  private register(
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
    trusted = false,
    teamEmploy?: boolean,
  ): Session {
    const id = crypto.randomUUID()
    // SANDBOXED TOGETHER BY DEFAULT: a teammate created without an explicit config
    // inherits its coordinator's, so extra mounts the operator granted the coordinator
    // (a docs tree, a sibling repo) reach the team too — rather than the teammate
    // getting the generic cwd-only default and finding half the workspace missing.
    // Mounts are cloned so a later edit to one session's config can't alias the other's.
    //
    // The inherited config counts as TRUSTED even from an in-process caller, and that is
    // not a hole: it is a copy of a config the operator already approved for the parent,
    // and the parent's own claude is what asks. A coordinator can therefore only ever
    // hand a teammate the confinement it already has — never less. An EXPLICIT config
    // from an untrusted caller still goes through the normal refusal in normalizeSandbox.
    const inherited = !sandbox && parentId ? this.sessions.get(parentId)?.sandbox : undefined
    const requested: SandboxConfig | undefined = sandbox
      ?? (inherited ? { ...inherited, mounts: inherited.mounts.map((m) => ({ ...m })) } : undefined)
    const session: Session = {
      id, name, cwd, rootDir, parentId, agentId, model, permissionMode, teamEmploy,
      sandbox: normalizeSandbox(requested, cwd, trusted || !!inherited),
      state: 'idle', engine: null, startedAt: 0, resume,
      claudeSessionId: claudeSessionId ?? crypto.randomUUID(),
      stderrTail: '',
    }
    this.sessions.set(id, session)
    return session
  }

  // A session's team members: the sessions carrying its id as parentId. The star has
  // exactly two levels, so a member's own children are always empty.
  childrenOf(id: string): SessionInfo[] {
    return [...this.sessions.values()].filter((s) => s.parentId === id).map((s) => this.toInfo(s))
  }

  // Cheap "does it lead a team?" — runs on every idle transition of every session via
  // scheduleApply, where childrenOf's map through toInfo() (which recomputes sandboxKey
  // per child) would be wasted work.
  private hasChildren(id: string): boolean {
    for (const s of this.sessions.values()) if (s.parentId === id) return true
    return false
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
    // Per-session model override wins over the role's default model. The team charters
    // make a session aware of its place in the star: a member (has a parentId) learns it
    // reports upward and talks to nobody else; a session that HAS members learns it is
    // the coordinator. Neither carries the roster — that changes as teammates come and
    // go, so it's served live by list_team instead of forcing a relaunch. A sandboxed
    // session also gets a note describing its mounts so it treats hidden paths as
    // "outside the sandbox", not "missing".
    const isCoordinator = this.hasChildren(id)
    const systemPrompt = [
      agent.systemPrompt,
      session.parentId ? MEMBER_INSTRUCTION : undefined,
      isCoordinator ? COORDINATOR_INSTRUCTION : undefined,
      canSandbox ? sandboxSystemPrompt(session.sandbox!, runCwd) : undefined,
    ].filter(Boolean).join('\n\n') || undefined
    session.appliedCoordinator = isCoordinator
    session.appliedMember = !!session.parentId
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
      const scrubbed = scrubbedHostConfigDir(id)
      if (!scrubbed) {
        // FAIL CLOSED. Falling back to the real config dir here used to keep the launch
        // alive — but this branch is, by definition, host-mode against a config a confined
        // session could have written hooks into, and `--setting-sources user` below would
        // then point the unsandboxed child at the UNSCRUBBED settings. That is the exact
        // execution the scrub exists to prevent, so a scrub we couldn't build refuses the
        // launch (same shape as the wrapSandbox refusal above) instead of quietly running
        // it unprotected. Re-sandboxing the session, or clearing the exposure, unblocks it.
        session.engine = null
        session.state = 'exited'
        this.emit('stateChange', id, 'exited')
        this.emit('exit', id, true, 'Could not build a scrubbed config for this unsandboxed session, and its config dir has been exposed to a sandboxed session. Refusing to launch rather than risk running hooks on the host — enable the sandbox for this session, or check the server log.')
        return
      }
      launchEnv = { ...process.env, CLAUDE_CONFIG_DIR: scrubbed } as Record<string, string>
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
      // If this was a host-mode session on a scrubbed config mirror, salvage a token it
      // refreshed into that mirror back to the shared config dir and drop the mirror
      // (configProtection.ts: an atomic-rename creds write replaces the symlink, so the
      // fresh token would otherwise be stranded there while every other reader keeps the
      // stale one — the "Not logged in" loop). No-op for a sandboxed session, which has no
      // mirror. Must run BEFORE the relaunch branches below, which rebuild it.
      releaseHostConfigDir(id)
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
        // Reusing the id via --session-id only works if no transcript file exists for it.
        // A file DOES exist when the resume target was a contentless fork (e.g. rewind to
        // the first turn) — then --session-id errors "already in use" and bricks the
        // session. Take a fresh id in that case so the fallback can always relaunch.
        if (existsSync(path.join(projectDir(session.cwd), `${session.claudeSessionId}.jsonl`))) {
          session.claudeSessionId = crypto.randomUUID()
          this.emit('changed')   // claudeSessionId changed → re-persist
        }
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
    // The conversation is being swapped out from under this session, so any per-conversation
    // team state (e.g. "this teammate has been asked for its handover") no longer applies to
    // what comes back. Emitted BEFORE the kill: the `replacing` branch of the exit handler
    // returns without emitting 'exit', so listeners hanging off that would never hear.
    this.emit('restarted', id)
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
    this.emit('restarted', id)           // see resumeInto: per-conversation team state is void
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

  // `origin` distinguishes a turn the HUMAN typed from one the team mailbox injected.
  // Both are user turns as far as the CLI is concerned, but they must not be treated
  // alike upstream: the mailbox's loop budget is reset by human input, so if an injected
  // message counted as human, every team message would refill the very budget meant to
  // bound it and the runaway protection would be worthless.
  // Resolves TRUE only if the turn was actually handed to a live engine. The team mailbox
  // depends on that answer: it must not consider a queued message delivered when the write
  // silently went nowhere.
  async sendUserTurn(id: string, text: string, turnId?: string, origin: 'user' | 'team' = 'user'): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session?.engine || session.replacing || session.closing) return false
    // Last chance to key the PREVIOUS turn's snapshot before we drop it. attachPendingSnapshot
    // normally runs on that turn's assistant/result events, but if the CLI flushed its user
    // line only AFTER `result` — timing that varies by CLI version and disk — no event is left
    // to retry on, and clearing here would lose the snapshot permanently and in silence. That
    // is one of the two ways a machine ends up with /rewind's Code option greyed out forever.
    if (session.pendingSnapshot) {
      await this.attachPendingSnapshot(session)
      if (session.pendingSnapshot) {
        console.warn('[rewind] a working-tree snapshot was taken but never matched to a turn — '
          + 'code rewind will be unavailable for it (the CLI\'s stored user line never equalled what we sent)')
      }
    }
    // Snapshot the working tree BEFORE the turn runs (git-only; no-op elsewhere), so
    // /rewind can later restore code to this pre-edit state. Awaited so the capture
    // lands before Claude can edit; keyed to the turn's uuid when the turn ends.
    session.pendingSnapshot = undefined
    const commit = await snapshot(session.cwd).catch(() => null)
    // The snapshot is a git commit — on a large tree it takes long enough for a relaunch
    // (restartFresh / relaunchApply / resumeInto) to land inside this await. Checking only
    // `engine` is not enough: during a replace the OLD engine object is still referenced
    // but its stdin is closed, and ClaudeEngine.write swallows the write-after-end, so the
    // turn would vanish with no error. `replacing`/`closing` mark exactly that window.
    //
    // EVERYTHING WITH A SIDE EFFECT HAPPENS AFTER THIS CHECK, and that ordering is load-
    // bearing: the mirror below is what every client renders and what a reconnect replays,
    // so emitting it before we knew the write would land meant a turn we then reported as
    // undelivered had already been shown to the user — and the mailbox, doing the right
    // thing, re-queued and delivered it again, printing it twice.
    if (!session.engine || session.replacing || session.closing) return false
    if (commit) session.pendingSnapshot = { commit, text }
    // A new user message = a new turn: notify listeners so per-turn state (e.g. the
    // notebook "working target" pin) resets and re-binds to the user's current view,
    // AND so every client mirrors the message (text/turnId), not just the sender.
    this.emit('userTurn', id, text, turnId, origin)
    // Record the prompt in the snapshot buffer so a late-joining device sees the
    // question, not just the answer (the live stream carries no renderable prompt —
    // buffer() drops the CLI's string echo, so this is the single source).
    const buf = this.transcripts.get(id) ?? []
    buf.push({ type: 'user', message: { content: text } } as unknown as ClaudeEvent)
    if (buf.length > TRANSCRIPT_CAP) buf.splice(0, buf.length - TRANSCRIPT_CAP)
    this.transcripts.set(id, buf)
    // Send the CLI the user's text plus ambient editor context for the open code file
    // (so "edit this file" resolves) — but ONLY the raw text is buffered/broadcast/
    // snapshotted above, so the block never shows in the UI or perturbs rewind keying.
    const pane = this.opts.activePane?.(id)
    const engineText = pane && !pane.isNotebook ? text + buildEditorContext(pane.path) : text
    // The engine's own answer, not an assumption: a process that died microseconds ago is
    // still non-null here (child is cleared on the exit event), and the stdin write would
    // be discarded in silence.
    return session.engine.sendUserTurn(engineText)
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
      // task_started pairs the CLI's own task id with the tool_use id we key cards by.
      // That pairing is what makes a subagent stoppable: stop_task accepts only the
      // former, the tray only ever sees the latter. Recorded on whichever card is already
      // registered from the Task tool_use (the assistant event always precedes the start).
      const started = parseTaskStarted(e)
      if (started?.toolUseId) {
        const rec = m.get(started.toolUseId)
        if (rec && rec.taskId !== started.taskId) { rec.taskId = started.taskId; changed = true }
      }
      // Late pickup: an agent already running when we attached has no task_started on our
      // stream, but its terminal notification carries the pair too. Too late to stop it,
      // and only worth recording while it could still matter.
      const settled = taskIdOfNotification(e)
      if (settled) {
        const rec = m.get(settled.toolUseId)
        if (rec && !rec.taskId) { rec.taskId = settled.taskId; changed = true }
      }
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

  // Stop one subagent of a session, addressed by the Task tool-use id the tray holds.
  // Translates to the CLI's own task id here so no client has to know both exist.
  // Resolves ok:false (never throws) when the session is gone, the card is unknown, or
  // no task_started was ever seen for it — the UI hides the button in that last case, but
  // a stale click from another device must not take the process down.
  async stopTask(id: string, toolId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const session = this.sessions.get(id)
    if (!session?.engine) return { ok: false, error: 'session not running' }
    const taskId = this.tasks.get(id)?.get(toolId)?.taskId
    if (!taskId) return { ok: false, error: 'this agent has no stoppable task id (it started before this server attached, or was replayed from a resumed conversation)' }
    return session.engine.stopTask(taskId)
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
      if (s.applyTimer) clearTimeout(s.applyTimer)
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
    const { id, name, cwd, rootDir, parentId, agentId, model, permissionMode, sandbox, sandboxed, teamEmploy, state } = s
    // Pending = a running engine whose applied sandbox differs from the requested one
    // (auto-applies on idle; visible only while a turn holds it off).
    const sandboxPending = !!s.engine && sandboxKey(sandbox, cwd) !== s.appliedSandboxKey
    return { id, name, cwd, rootDir, parentId, agentId, model, permissionMode, sandbox, sandboxed, sandboxPending, teamEmploy, state }
  }

  // Can this session take a turn RIGHT NOW? Distinct from state, and stricter than
  // "an engine object exists": between a kill and the relaunch that replaces it, the
  // old engine is still referenced but its process is gone, so a turn written to it
  // goes into a closed pipe and is lost silently. `replacing` marks exactly that window
  // (restartFresh / relaunchApply / resumeInto all set it), and `closing` marks a
  // session on its way out. The team mailbox relies on this to hold a cleared session's
  // own handover until its fresh engine is really up.
  hasEngine(id: string): boolean {
    const s = this.sessions.get(id)
    return !!s?.engine && !s.replacing && !s.closing
  }

  // May this session hire and dismiss teammates? Off unless the operator turned it on.
  canEmploy(id: string): boolean {
    return !!this.sessions.get(id)?.teamEmploy
  }

  // Flip the "employ team allowed" toggle. TRUST-GATED for the same reason
  // normalizeSandbox refuses an untrusted `enabled:false` (SANDBOX.md "Control-plane
  // escape"): a sandboxed session can reach the loopback control API, so without this
  // gate it could grant ITSELF employment rights and then spawn teammates. `trusted` is
  // set only by the auth-gated HTTP route (the operator's own browser) and by boot
  // restore of an already-approved value — never by an in-process/MCP caller.
  setTeamEmploy(id: string, value: boolean, trusted = false): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    if (value && !trusted) {
      console.warn('[team] ignoring untrusted request to enable employment — only the operator may grant a session hiring rights')
      return false
    }
    if (session.teamEmploy === value) return true   // no-op
    session.teamEmploy = value
    this.emit('changed')
    return true
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
    this.scheduleApply(id)   // apply now if idle, else when the turn ends
    return true
  }

  // Does what's RUNNING differ from what the session's config now says it should be?
  // Two independent reasons, both fixed only by relaunching: the sandbox mounts changed,
  // or the session crossed the 0↔1 members line and so gained/lost the coordinator
  // charter. Both are read at launch, and relaunchApply re-runs launch(), which recomputes
  // BOTH — which is exactly why one scheduler serves both.
  private launchStale(s: Session): boolean {
    return sandboxKey(s.sandbox, s.cwd) !== s.appliedSandboxKey
      || this.hasChildren(s.id) !== !!s.appliedCoordinator
      || !!s.parentId !== !!s.appliedMember
  }

  // Auto-apply a pending config change by a resume-preserving relaunch — but only when
  // the session is IDLE (killing a live turn would be worse than waiting). Debounced so a
  // burst of edits, or hiring three teammates at once, coalesces into ONE relaunch. When
  // busy this no-ops; setState re-invokes it on the next idle.
  //
  // This was two near-identical schedulers with a timer each. Merging them is not just
  // tidier: independently-armed timers could both fire in the same idle window, and the
  // second relaunch would kill the engine the first had just respawned.
  private scheduleApply(id: string): void {
    const session = this.sessions.get(id)
    if (!session || !session.engine) return        // nothing running to update
    if (!this.launchStale(session)) return         // already in force
    if (session.state !== 'idle') return           // wait; retried on idle
    if (session.applyTimer) clearTimeout(session.applyTimer)
    session.applyTimer = setTimeout(() => {
      const s = this.sessions.get(id)
      if (!s) return
      s.applyTimer = undefined
      // `replacing` matters here: a relaunch already in flight will re-read the config
      // when it comes back up, so firing a second one would kill the fresh engine — and
      // with it any turn just delivered into it.
      if (s.engine && s.state === 'idle' && !s.replacing && !s.closing && this.launchStale(s)) {
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
    return list.map((s) => {
      const tasks = this.tasksOf(s.id)
      return {
        name: s.name, cwd: s.cwd, rootDir: s.rootDir,
        parentIndex: s.parentId != null ? indexOf.get(s.parentId) : undefined,
        agentId: s.agentId, model: s.model, permissionMode: s.permissionMode,
        sandbox: s.sandbox,
        teamEmploy: s.teamEmploy,
        claudeSessionId: s.claudeSessionId,
        tasks: tasks.length ? tasks : undefined,
      }
    })
  }

  // Recreate saved sessions, each resumed into its conversation (--resume). Called
  // once at boot; returns the new ids in saved order (so parentIndex can be mapped).
  restore(saved: SavedSession[]): string[] {
    const ids: string[] = []
    // TWO PASSES. Register the whole set first so parentage is complete before anything
    // spawns — otherwise a restored coordinator would launch without its charter (its
    // members not yet in the map) and have to be relaunched to get it.
    const registered: Session[] = []
    for (const s of saved) {
      const parentId = s.parentIndex != null ? ids[s.parentIndex] : undefined
      const session = this.register(
        s.name, s.cwd, s.rootDir, parentId,
        /* resume */ !!s.claudeSessionId, s.claudeSessionId,
        s.agentId, s.model, s.permissionMode, s.sandbox,
        /* trusted */ true,   // a persisted config was already operator-approved
        s.teamEmploy,         // …including the employment grant
      )
      registered.push(session)
      const id = session.id
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
    for (const session of registered) this.launch(session)
    this.emit('changed')
    return ids
  }

  private setState(id: string, state: SessionState): void {
    const session = this.sessions.get(id)
    if (!session || session.state === state) return
    session.state = state
    this.emit('stateChange', id, state)
    // A turn just ended — apply any sandbox or team-charter change that was waiting for idle.
    if (state === 'idle') {
      this.scheduleApply(id)
    }
  }

  private cleanup(id: string): void {
    const s = this.sessions.get(id)
    if (s?.applyTimer) clearTimeout(s.applyTimer)
    const parentId = s?.parentId
    this.sessions.delete(id)
    // PROMOTE any members this session led. Left alone they'd keep a parentId pointing at
    // a session that no longer exists, which reads as neither member nor coordinator: the
    // team tools would tell them "you are the coordinator" while refusing every send, and
    // they'd keep the member charter telling them to report to a parent that is gone —
    // live Claude processes with no way to talk to anyone. Promoting makes them ordinary
    // top-level sessions, which is both true and usable; scheduleApply drops their member
    // charter on the next idle.
    for (const child of this.sessions.values()) {
      if (child.parentId !== id) continue
      child.parentId = undefined
      this.scheduleApply(child.id)
    }
    this.transcripts.delete(id)   // free the snapshot buffers with the session
    this.pendingPerms.delete(id)
    this.tasks.delete(id)         // free the subagent registry with the session
    // A coordinator that just lost its LAST member is a plain session again — drop the
    // coordinator charter the same idle-debounced way it was applied, so a disbanded
    // team doesn't leave a session still being told to delegate to nobody.
    if (parentId) this.scheduleApply(parentId)
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
    : { enabled: sandbox.enabled, mounts: sandbox.mounts, sandboxTerminals: sandbox.sandboxTerminals }
  // `sandboxTerminals` needs no trust gate: it only ever RAISES confinement (terminals
  // are host shells by default), and a confined session can't drive a pane anyway —
  // that needs the app token, which never enters a box (SANDBOX.md "Terminal-pane
  // escape").
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
    // Carry `sandboxTerminals` through. Per the note above it only ever RAISES
    // confinement, so dropping it here would have this forced-on branch — which exists
    // purely to refuse a downgrade — quietly perform a different downgrade of its own.
    return { enabled: true, mounts: cfg.mounts, sandboxTerminals: cfg.sandboxTerminals }
  }
  return cfg
}
