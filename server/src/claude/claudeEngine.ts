import { EventEmitter } from 'events'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { ClaudeEvent, PermissionRequest, PermissionDecision, PermissionMode } from '@claudette/shared'

// One running `claude` process, driven over the bidirectional stream-json
// protocol (see ../ClaudeMaster/PROTOCOL-stream-json.md, pinned against CLI
// 2.1.198). Instead of scraping ANSI from a pty TUI, we parse structured JSON
// events and speak the control protocol for permissions + interrupt.
//
// This class is transport-agnostic about local vs remote: the caller supplies
// the argv (either `claude …` directly, or `ssh <host> … exec claude …`). It
// only knows how to spawn, frame line-delimited JSON both ways, and translate
// the wire protocol into typed events. In Claudette the SessionManager owns it
// and re-emits its events over the app WebSocket (no Electron IPC).

// The pinned headless argv. `--permission-prompt-tool stdio` is the (help-hidden)
// sentinel that routes `can_use_tool` prompts over this control channel; without
// it the CLI silently auto-denies non-allowlisted tools.
export function claudeArgs(opts: {
  sessionId: string
  resume?: boolean
  mcpConfig?: string   // JSON string (or path) for --mcp-config; adds the app-control server
  model?: string
  permissionMode?: PermissionMode  // --permission-mode; omitted for 'default' (ordinary prompting)
  // --- agent/role config (see agents.ts) ---
  appendSystemPrompt?: string  // the agent's persistent charter → --append-system-prompt
  allowedTools?: string[]      // agent tool whitelist → --allowedTools
  disallowedTools?: string[]   // agent tool blacklist → MERGED into the NOTEBOOK_DENY value
  extra?: string[]
}): string[] {
  const a = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
  ]
  // --session-id sets a fresh id; --resume <id> continues an existing one. They
  // are mutually exclusive, so a resumed session reuses the id via --resume.
  if (opts.resume) a.push('--resume', opts.sessionId)
  else a.push('--session-id', opts.sessionId)
  // Add the app-control server WITHOUT --strict-mcp-config, so the user's own
  // configured MCP servers keep working alongside it.
  if (opts.mcpConfig) a.push('--mcp-config', opts.mcpConfig)
  if (opts.model) a.push('--model', opts.model)
  // 'default' is the CLI's own default, so only pass the flag for a real override.
  if (opts.permissionMode && opts.permissionMode !== 'default') a.push('--permission-mode', opts.permissionMode)
  // The agent's charter rides as an appended system prompt so the role persists
  // for the WHOLE session, not just the seeded first turn.
  if (opts.appendSystemPrompt) a.push('--append-system-prompt', opts.appendSystemPrompt)
  if (opts.allowedTools?.length) a.push('--allowedTools', opts.allowedTools.join(','))
  // Funnel .ipynb edits through the app-control notebook tools. A deny rule
  // (unlike the permission-handler guard in handlePermission) also beats an
  // "allow always" and acceptEdits mode — the cases where the tool never prompts.
  // NotebookEdit only ever targets notebooks, so deny it by name; scope the
  // general file tools to the .ipynb glob so normal code editing is unaffected.
  // The agent's own disallowed tools MERGE into this one value (a second
  // --disallowedTools flag would not reliably combine), so NOTEBOOK_DENY always
  // survives whatever role is chosen.
  a.push('--disallowedTools', disallowedValue(opts.disallowedTools))
  if (opts.extra) a.push(...opts.extra)
  return a
}

// The single --disallowedTools value: NOTEBOOK_DENY plus any agent-scoped denials.
export function disallowedValue(agentDisallowed?: string[]): string {
  return agentDisallowed?.length ? `${NOTEBOOK_DENY},${agentDisallowed.join(',')}` : NOTEBOOK_DENY
}

// Comma-separated (the flag accepts comma or space) so it's one unambiguous argv
// value. `**/*.ipynb` matches notebooks at any depth. NB: the exact path-glob
// matching is the one bit worth confirming live (a wrong glob silently fails to
// match — the handlePermission guard still covers the prompting path).
export const NOTEBOOK_DENY = 'NotebookEdit,Write(**/*.ipynb),Edit(**/*.ipynb)'

// The native file tools we intercept for notebooks, and where each carries its
// target path. If a call targets a .ipynb, return the deny message steering Claude
// to the app-control notebook tools; otherwise return null (allow normal handling).
function notebookGuard(toolName: string, input: Record<string, unknown> | undefined): string | null {
  const pathKey = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path'
  const nativeFileTools = new Set(['Write', 'Edit', 'NotebookEdit'])
  if (!nativeFileTools.has(toolName)) return null
  const target = input?.[pathKey]
  if (typeof target !== 'string' || !target.toLowerCase().endsWith('.ipynb')) return null
  return 'Claudette manages .ipynb files through its own tools — the native '
    + `${toolName} tool is disabled for notebooks. Use the app-control notebook tools instead: `
    + 'read_notebook to get the cell ids, then edit_cell / add_cell / insert_cell / delete_cell / '
    + 'move_cell / set_cell_type (addressed by notebook + cell id), or create_notebook for a new one, '
    + 'and run_cell / run_all to execute. These mutate the server-owned notebook document (edited live '
    + 'in every open view) instead of overwriting the file.'
}

interface EngineSpawn {
  command: string          // 'claude' locally, or 'ssh' for a remote
  args: string[]           // claudeArgs(...) locally, or ssh args wrapping it
  cwd: string              // process cwd (local dir, or homedir for ssh)
  env: Record<string, string>
}

type PendingPermission = { request: PermissionRequest; resolve: (d: PermissionDecision) => void }

export interface ClaudeEngineEvents {
  event: (e: ClaudeEvent) => void            // any parsed stream-json event, for the transcript
  permission: (req: PermissionRequest) => void
  permissionResolved: (requestId: string) => void   // a pending prompt was answered → clear it everywhere
  state: (state: 'idle' | 'running' | 'waiting') => void
  ready: (sessionId: string) => void         // fired on the init event
  exit: (code: number | null) => void
}

export class ClaudeEngine extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ''
  private pending = new Map<string, PendingPermission>()
  // Resolvers for control_requests WE send (interrupt/set_permission_mode/…),
  // keyed by request_id; settled when the matching control_response arrives.
  private pendingControl = new Map<string, (r: { ok: true } | { ok: false; error: string }) => void>()
  private nextControlId = 1
  private _state: 'idle' | 'running' | 'waiting' = 'idle'
  private _turnActive = false

  constructor(private readonly spawnCfg: EngineSpawn) {
    super()
  }

  get state(): 'idle' | 'running' | 'waiting' { return this._state }
  get alive(): boolean { return this.child != null }

  start(): void {
    const { command, args, cwd, env } = this.spawnCfg
    // detached: put the child in its OWN process group so we can signal the whole
    // tree (bwrap → claude → any tool subprocesses) with process.kill(-pid). Without
    // this a kill hits only bwrap, and a sandboxed claude can orphan on shutdown.
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    // Claude's own logs/errors go to stderr; surface as diagnostic events, don't crash.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.emit('event', { type: 'stderr', text: chunk } as ClaudeEvent))
    // If the process dies while we're mid-write, the pipe errors asynchronously with
    // EPIPE; unhandled, that's an uncaught exception that crashes the server. Swallow
    // it — the 'exit' handler below already deals with the process being gone.
    child.stdin.on('error', () => {})

    // Both a normal exit and an async spawn failure ('error' — e.g. the command
    // isn't on PATH, which fires 'error' and may never fire 'exit') tear the engine
    // down the same way; `terminated` makes sure we only do it — and emit 'exit' —
    // once even if both events arrive. Without the 'error' listener, a spawn failure
    // would be an uncaught EventEmitter throw that crashes the whole server.
    let terminated = false
    const terminate = (code: number | null): void => {
      if (terminated) return
      terminated = true
      this.child = null
      // Fail any in-flight permission prompts so the client doesn't hang, and tell
      // every client to clear them (a non-answering device would otherwise be stuck).
      for (const [requestId, { resolve }] of this.pending) {
        resolve({ behavior: 'deny', message: 'session ended' })
        this.emit('permissionResolved', requestId)
      }
      this.pending.clear()
      // Settle any in-flight control requests we sent (e.g. set_permission_mode).
      for (const settle of this.pendingControl.values()) settle({ ok: false, error: 'session ended' })
      this.pendingControl.clear()
      this.setState('idle')
      this.emit('exit', code)
    }

    child.on('exit', (code) => terminate(code))
    child.on('error', (err) => {
      // Surface why it failed to start (this becomes the session's stderrTail, shown
      // as "Claude not available" + Retry), then settle as a startup failure.
      this.emit('event', { type: 'stderr', text: `failed to start: ${err.message}\n` } as ClaudeEvent)
      terminate(null)
    })
  }

  // Send a user turn (text, and later blocks). Marks the turn active → 'running'.
  sendUserTurn(text: string): void {
    if (!this.child) return
    this.write({ type: 'user', message: { role: 'user', content: text } })
    this._turnActive = true
    this.setState('running')
  }

  // Client→server interrupt control request (replaces sending ESC to a pty).
  interrupt(): void {
    if (!this.child) return
    this.write({ type: 'control_request', request_id: this.controlId(), request: { subtype: 'interrupt' } })
  }

  // Live mid-session permission-mode switch (the SDK's onSetPermissionMode path;
  // the TUI's Shift-Tab equivalent). Resolves ok:true if the CLI accepts it, or
  // ok:false with the CLI's error (e.g. the callback isn't registered in this
  // context) so the caller can fall back to "applies on restart". Resolves
  // ok:false immediately if the process is gone or never answers.
  setPermissionMode(mode: PermissionMode): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.child) return Promise.resolve({ ok: false, error: 'session not running' })
    const requestId = `set-mode-${this.controlId()}`
    return new Promise((resolve) => {
      const done = (r: { ok: true } | { ok: false; error: string }): void => {
        if (!this.pendingControl.has(requestId)) return
        this.pendingControl.delete(requestId)
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => done({ ok: false, error: 'timed out waiting for CLI' }), 2000)
      this.pendingControl.set(requestId, done)
      this.write({ type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode } })
    })
  }

  // Answer a can_use_tool prompt. `requestId` echoes the CLI's request_id.
  respondPermission(requestId: string, decision: PermissionDecision): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    p.resolve(decision)
    this.emit('permissionResolved', requestId)   // tell every client to clear the prompt
    // Back to running if the turn is still going; the next result flips to idle.
    if (this._turnActive) this.setState('running')
  }

  // Graceful stop: SIGTERM the whole process group, then SIGKILL it if it hasn't
  // exited. Group-targeted (see `detached` in start) so bwrap AND the claude inside
  // it AND any tool subprocesses all go — no orphans.
  kill(): void {
    const pid = this.child?.pid
    try { this.child?.stdin.end() } catch { /* pipe may be gone */ }
    if (pid == null) return
    this.signalGroup(pid, 'SIGTERM')
    setTimeout(() => { if (this.child?.pid === pid) this.signalGroup(pid, 'SIGKILL') }, 3000)
  }

  // Immediate hard kill of the process group — used on server shutdown, where we
  // can't wait out a graceful exit.
  killForce(): void {
    const pid = this.child?.pid
    if (pid != null) this.signalGroup(pid, 'SIGKILL')
  }

  private signalGroup(pid: number, sig: NodeJS.Signals): void {
    // Negative pid = the whole process group (child is a group leader via detached).
    // Fall back to signalling just the process if the group send fails.
    try { process.kill(-pid, sig) } catch { try { process.kill(pid, sig) } catch { /* already gone */ } }
  }

  // --- internals -------------------------------------------------------------

  private controlId(): string { return `cm-${this.nextControlId++}` }

  private write(obj: unknown): void {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) return  // process gone; the write would EPIPE
    stdin.write(JSON.stringify(obj) + '\n')
  }

  private setState(s: 'idle' | 'running' | 'waiting'): void {
    if (this._state === s) return
    this._state = s
    this.emit('state', s)
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl: number
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl)
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try { obj = JSON.parse(line) } catch { continue }
      this.handle(obj)
    }
  }

  private handle(o: Record<string, unknown>): void {
    const type = o.type as string

    if (type === 'control_request' && (o.request as Record<string, unknown>)?.subtype === 'can_use_tool') {
      this.handlePermission(o)
      return
    }
    // control_response to a control_request WE sent (interrupt / set_permission_mode
    // / …). Match by request_id and settle its resolver; nothing to render.
    if (type === 'control_response') {
      const resp = o.response as Record<string, unknown> | undefined
      const rid = resp?.request_id as string | undefined
      const settle = rid ? this.pendingControl.get(rid) : undefined
      if (settle) {
        settle(resp?.subtype === 'error'
          ? { ok: false, error: (resp.error as string) ?? 'request failed' }
          : { ok: true })
      }
      return
    }

    // Everything else is transcript material; forward verbatim + typed.
    this.emit('event', o as unknown as ClaudeEvent)

    if (type === 'system' && (o.subtype as string) === 'init') {
      const sid = o.session_id as string
      this.emit('ready', sid)
    } else if (type === 'result') {
      this._turnActive = false
      this.setState('idle')
    }
  }

  private handlePermission(o: Record<string, unknown>): void {
    const requestId = o.request_id as string
    const r = o.request as Record<string, unknown>
    const req: PermissionRequest = {
      requestId,
      toolName: r.tool_name as string,
      displayName: (r.display_name as string) ?? (r.tool_name as string),
      input: r.input as Record<string, unknown>,
      toolUseId: r.tool_use_id as string,
      description: r.description as string | undefined,
      suggestions: (r.permission_suggestions as unknown[]) ?? [],
    }

    // Funnel .ipynb edits through Claudette's own notebook tools: auto-deny the
    // native file tools on notebooks (no user prompt), steering Claude to the app
    // tools that mutate the server-owned document instead of clobbering the file.
    // Done here (not via --disallowedTools) so it's an exact path check, not a glob.
    const notebookDeny = notebookGuard(req.toolName, req.input)
    if (notebookDeny) {
      this.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: notebookDeny } },
      })
      return
    }
    // Register the resolver; the CLI blocks until we send the control_response.
    this.pending.set(requestId, {
      request: req,
      resolve: (decision) => {
        this.write({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: decision.behavior === 'allow'
              ? {
                  behavior: 'allow',
                  updatedInput: decision.updatedInput ?? req.input,
                  // "allow always": apply/persist the request's suggestions.
                  ...(decision.updatedPermissions ? { updatedPermissions: decision.updatedPermissions } : {}),
                }
              : { behavior: 'deny', message: decision.message ?? 'Denied' },
          },
        })
      },
    })
    this.setState('waiting')
    this.emit('permission', req)
  }
}
