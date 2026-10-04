import type { FastifyInstance } from 'fastify'
import type {
  WsClientMessage, ClaudeEvent, PermissionRequest, SessionState,
  CreateSessionRequest, CreateSessionResponse, ListSessionsResponse,
  SessionIdRequest, OkResponse, SetModeRequest, SetModeResult,
  ResumeIntoRequest, ConversationsResponse, ConversationResponse, SandboxConfig,
  SetAgentRequest, RenameSessionRequest, ListAgentsResponse,
  PermissionsResponse, EditRuleRequest, WriteResult,
  RewindPointsResponse, RewindPreviewResponse, RewindRequest, RewindResponse,
  TaskRecord, BashProcRecord, BashProcOutputResponse, TrustQueryResponse, TrustFolderRequest,
} from '@claudette/shared'
import { SessionManager } from '../claude/sessionManager'
import { isTrusted, setTrusted } from '../claude/trust'
import { listAgents } from '../claude/agents'
import { getEffective, addRule, removeRule } from '../claude/permissions'
import { listConversations, readConversation, listRewindPoints, forkConversationBefore } from '../claude/conversations'
import { previewRestore, restore } from '../git/shadowSnapshots'
import { WsHub } from '../ws/hub'
import { getSettings } from '../settings/settingsStore'

// The session API layer: HTTP lifecycle routes + a bridge from SessionManager's
// events to the WS hub (broadcast to every tab). Replaces ClaudeMaster's Electron
// IPC hub (main/index.ts + preload/index.ts). Turn I/O (send/interrupt/permission
// response) arrives over WS and is dispatched by handleSessionClientMessage.

// Subscribe to SessionManager events once and re-emit them over the hub.
export function bridgeSessionEvents(sessions: SessionManager, hub: WsHub): void {
  sessions.on('event', (id: string, event: ClaudeEvent) =>
    hub.broadcast({ type: 'session:event', id, event }))
  sessions.on('permission', (id: string, request: PermissionRequest) =>
    hub.broadcast({ type: 'session:permission', id, request }))
  // Mirror user turns + permission resolutions to EVERY client so all devices stay
  // in sync (not just whoever typed / answered) — see the ws.ts message docs.
  sessions.on('userTurn', (id: string, text: string, turnId?: string) =>
    hub.broadcast({ type: 'session:userTurn', id, text, turnId }))
  sessions.on('permissionResolved', (id: string, requestId: string) =>
    hub.broadcast({ type: 'session:permissionResolved', id, requestId }))
  sessions.on('stateChange', (id: string, state: SessionState) =>
    hub.broadcast({ type: 'session:state', id, state }))
  sessions.on('ready', (id: string, claudeSessionId: string) =>
    hub.broadcast({ type: 'session:ready', id, claudeSessionId }))
  sessions.on('exit', (id: string, failed: boolean, error: string) =>
    hub.broadcast({ type: 'session:exit', id, failed, error }))
  // Live subagent-registry updates → every tab, so tray cards settle from the
  // authoritative record even when a <task-notification> was evicted / never buffered.
  sessions.on('task', (id: string, tasks: TaskRecord[]) =>
    hub.broadcast({ type: 'session:tasks', id, tasks }))
  // Live background-shell registry → every tab, mirroring the subagent line above.
  // This is the ONLY way the panel ever learns anything: unlike agent cards, which the client
  // can rebuild from transcript items, a backgrounded shell's completion arrives solely as a
  // <task-notification> that the capped transcript ring may evict and that a device joining
  // mid-run never saw. No broadcast, no panel — the registry just fills up server-side.
  sessions.on('bashProcs', (id: string, procs: BashProcRecord[]) =>
    hub.broadcast({ type: 'session:bashProcs', id, procs }))
}

// Send a freshly-connected socket the per-session catch-up it needs to render an
// in-progress session: the buffered transcript so far + any still-unanswered
// permission prompt. Called once per connect, AFTER session:list. Without this a
// device joining mid-session sees a blank stream and can't answer a pending prompt.
export function sendSessionSnapshots(sessions: SessionManager, hub: WsHub, ws: import('ws').WebSocket): void {
  for (const s of sessions.list()) {
    const events = sessions.transcriptOf(s.id)
    const pending = sessions.pendingPermissionsOf(s.id)
    const tasks = sessions.tasksOf(s.id)
    const bashProcs = sessions.bashProcsOf(s.id)
    // Include a registry-only session too: its transcript may have been evicted while a
    // settled subagent record — or a still-running background shell — needs to reach a
    // freshly-connected tab.
    if (events.length === 0 && pending.length === 0 && tasks.length === 0 && bashProcs.length === 0) continue
    // ★ bashProcs IS ALWAYS SENT WHEN THE REGISTRY IS NON-EMPTY, AND THAT IS LOAD-BEARING.
    // The client dispatches `procs ?? []` unconditionally on a snapshot, so a snapshot that
    // omitted this field would EMPTY the panel rather than leave it alone. That direction was
    // chosen deliberately on the client — a stale "still running" row that nothing can ever
    // retract is worse than a blank one, because it is indistinguishable from a real live
    // process and never self-corrects — but the two decisions only work together. Do not make
    // this conditional without changing the client in the same commit.
    hub.send(ws, { type: 'session:snapshot', id: s.id, events, pending, tasks, bashProcs })
  }
}

// Register the HTTP lifecycle routes on the Fastify app.
export function registerSessionRoutes(app: FastifyInstance, sessions: SessionManager): void {
  // One background shell's output. GET because it is a read; the id and toolId are path
  // params so the route is cacheable-shaped and shows up in Fastify's route table, which is
  // what auth-route-coverage-test.mts enumerates — a route added another way could ship
  // unprotected without that sweep noticing.
  app.get<{ Params: { id: string; toolId: string } }>('/api/session/:id/bashProc/:toolId/output',
    async (req, reply): Promise<BashProcOutputResponse> => {
      const r = sessions.bashProcOutput(req.params.id, req.params.toolId)
      if (!r.ok) {
        // 404: the client asked about something the registry does not have. Deliberately an
        // HTTP error as well as `ok:false`, so it cannot be mistaken for an empty result by a
        // caller that only looks at the status.
        reply.code(404)
        return { ok: false, error: r.error }
      }
      return r.read.retrievable
        ? { ok: true, retrievable: true, output: r.read.output, truncated: r.read.truncated }
        : { ok: true, retrievable: false, reason: r.read.reason }
    })

  app.post<{ Body: CreateSessionRequest }>('/api/session/create', async (req): Promise<CreateSessionResponse> => {
    const b = req.body
    // ★ THE APP-SETTINGS FALLBACK, AND `??` IS THE WHOLE OF IT — OMITTED, NOT FALSY.
    // `??` falls back only for null/undefined, which is exactly the rule these three need: a
    // request that OMITS the field gets the operator's stored default, and a request that
    // SENDS one keeps it. `||` would be a bug with teeth here — `permissionMode: 'default'`
    // is a real, explicit "ask me each time", and under `||` it is falsy-adjacent thinking
    // away from being silently replaced by a stored 'bypassPermissions'. Turning a user's
    // explicit request for prompting into allow-all is the worst outcome this route has.
    //
    // ★ SCOPE — THIS ROUTE ONLY, DELIBERATELY. `defaultPermissionMode` may legitimately hold
    // `bypassPermissions`, and this route passes `trusted: true`, so a stored elevated default
    // IS honoured for every session created through it. That is defensible because it is
    // operator configuration set through an auth-gated UI — but it is also why the fallback
    // must not be pushed down into `sessions.create`. `employ_teammate` calls that method
    // DIRECTLY with seven positional arguments (no mode, untrusted), so a hired teammate
    // cannot pick up a stored elevated default; moving this lookup inside create() would
    // silently hand every teammate the operator's allow-all.
    const settings = getSettings()
    const id = sessions.create(
      b.name, b.cwd, b.rootDir, b.parentId, b.resume,
      b.claudeSessionId,
      b.agentId ?? settings.defaultAgentId,
      b.model ?? settings.defaultModel,
      b.permissionMode ?? settings.defaultPermissionMode,
      b.sandbox,
      /* trusted */ true,   // this route is auth-gated → the operator, may disable the sandbox
    )
    return { id }
  })

  // Update a session's bwrap sandbox config (enable/disable, edit mounts). Applies
  // on the next launch — relaunch/restartFresh to bring it into force.
  app.post<{ Body: SessionIdRequest & { sandbox: SandboxConfig } }>(
    '/api/session/setSandbox', async (req): Promise<OkResponse> => ({
      ok: sessions.setSandbox(req.body.id, req.body.sandbox, /* trusted */ true),
    }))

  // Grant or revoke a session's right to HIRE teammates (employ_teammate /
  // dismiss_teammate). Trusted because this route is auth-gated — it is the operator's
  // own browser. SessionManager refuses an untrusted grant precisely so a sandboxed
  // session that reached the loopback API could not give itself a team (SANDBOX.md
  // "Control-plane escape"). Messaging tools are never gated; only roster management is.
  app.post<{ Body: SessionIdRequest & { teamEmploy: boolean } }>(
    '/api/session/setTeamEmploy', async (req): Promise<OkResponse> => ({
      ok: sessions.setTeamEmploy(req.body.id, !!req.body.teamEmploy, /* trusted */ true),
    }))

  // Workspace trust (see claude/trust.ts). A folder whose .claude/settings.local.json
  // grants permissions is honoured only once trusted; the New Session dialog checks this
  // and prompts before creating. Both routes are auth-gated → the operator.
  app.get<{ Querystring: { cwd?: string } }>(
    '/api/session/trust', async (req): Promise<TrustQueryResponse> => ({
      trusted: typeof req.query.cwd === 'string' ? isTrusted(req.query.cwd) : false,
    }))

  app.post<{ Body: TrustFolderRequest }>(
    '/api/session/trust', async (req): Promise<OkResponse> => {
      if (req.body?.cwd) setTrusted(req.body.cwd)
      return { ok: true }
    })

  app.get('/api/session/list', async (): Promise<ListSessionsResponse> => ({
    sessions: sessions.list(),
  }))

  app.post<{ Body: SessionIdRequest }>('/api/session/destroy', async (req): Promise<OkResponse> => {
    sessions.destroy(req.body.id)
    return { ok: true }
  })

  app.post<{ Body: SessionIdRequest }>('/api/session/relaunch', async (req): Promise<OkResponse> => ({
    ok: sessions.relaunch(req.body.id),
  }))

  // Resume-preserving restart that applies a config change (e.g. sandbox mounts) even
  // to a running engine — /api/session/relaunch is a no-op on a live session.
  app.post<{ Body: SessionIdRequest }>('/api/session/relaunchApply', async (req): Promise<OkResponse> => {
    sessions.relaunchApply(req.body.id)
    return { ok: true }
  })

  app.post<{ Body: SetModeRequest }>('/api/session/setMode', async (req): Promise<SetModeResult> =>
    // Auth-gated route ⇒ the operator; only this path may set a widening mode.
    sessions.setPermissionMode(req.body.id, req.body.mode, /* trusted */ true))

  // Change a session's role — relaunches (resume-preserving) to apply the new charter.
  // Set a session's model. Takes effect on the user's NEXT TURN — see setModel. `/api/session/
  // relaunchApply` is the force button for "apply now" and needs nothing added here.
  app.post<{ Body: { id: string; model?: string } }>('/api/session/setModel', async (req): Promise<OkResponse> => ({
    ok: sessions.setModel(req.body.id, req.body.model),
  }))

  app.post<{ Body: SetAgentRequest }>('/api/session/setAgent', async (req): Promise<OkResponse> => ({
    ok: sessions.setAgent(req.body.id, req.body.agentId),
  }))

  // Rename a session (display name only).
  app.post<{ Body: RenameSessionRequest }>('/api/session/rename', async (req): Promise<OkResponse> => ({
    ok: sessions.rename(req.body.id, req.body.name),
  }))

  // The selectable roles for the New Session dialog / role picker.
  app.get('/api/agents', async (): Promise<ListAgentsResponse> => ({ agents: listAgents() }))

  // Permission Control Center — a GUI over Claude's own settings files (keyed by the
  // session cwd + its agent role). Read the merged picture; add/remove a rule at a
  // chosen scope. Per-session mode still goes through /api/session/setMode.
  app.get<{ Querystring: { cwd: string; agentId?: string } }>(
    '/api/session/permissions', async (req): Promise<PermissionsResponse> => ({
      permissions: await getEffective(req.query.cwd, req.query.agentId),
    }))
  app.post<{ Body: EditRuleRequest }>('/api/session/perms/addRule', async (req): Promise<WriteResult> =>
    addRule(req.body.cwd, req.body.scope, req.body.action, req.body.value))
  app.post<{ Body: EditRuleRequest }>('/api/session/perms/removeRule', async (req): Promise<WriteResult> =>
    removeRule(req.body.cwd, req.body.scope, req.body.action, req.body.value))

  // /clear — restart the session on a brand-new conversation (fresh --session-id).
  app.post<{ Body: SessionIdRequest }>('/api/session/restartFresh', async (req): Promise<OkResponse> => {
    sessions.restartFresh(req.body.id)
    return { ok: true }
  })

  // /resume — rebind the session's engine to a past conversation (--resume <id>).
  app.post<{ Body: ResumeIntoRequest }>('/api/session/resumeInto', async (req): Promise<OkResponse> => {
    sessions.resumeInto(req.body.id, req.body.claudeSessionId)
    return { ok: true }
  })

  // The /resume picker: list resumable conversations for a folder, and read one back.
  app.get<{ Querystring: { cwd: string } }>('/api/session/conversations', async (req): Promise<ConversationsResponse> => ({
    conversations: await listConversations(req.query.cwd),
  }))
  app.get<{ Querystring: { cwd: string; id: string } }>('/api/session/conversation', async (req): Promise<ConversationResponse> => ({
    events: await readConversation(req.query.cwd, req.query.id),
  }))

  // /rewind — the rewindable user turns of a session's CURRENT conversation. Resolved
  // from the live session (its cwd + claude session id) so the client needn't track
  // which conversation is in force.
  app.get<{ Querystring: { id: string } }>('/api/session/rewindPoints', async (req): Promise<RewindPointsResponse> => {
    const info = sessions.get(req.query.id)
    const claudeId = sessions.claudeSessionId(req.query.id)
    if (!info || !claudeId) return { points: [] }
    return { points: await listRewindPoints(info.cwd, claudeId) }
  })

  // /rewind — what a code-restore to this turn would change (files reverted/deleted),
  // for the confirm dialog. null when the turn has no working-tree snapshot.
  app.get<{ Querystring: { id: string; uuid: string } }>('/api/session/rewindPreview', async (req): Promise<RewindPreviewResponse> => {
    const info = sessions.get(req.query.id)
    if (!info) return { preview: null }
    return { preview: await previewRestore(info.cwd, req.query.uuid) }
  })

  // /rewind — rewind to just before `uuid`. Per `mode`: 'conversation' forks the
  // transcript + resumes into the fork (original left intact, undoable via /resume);
  // 'code' restores the working tree to the turn's snapshot; 'both' does both. The
  // code restore runs FIRST so a failure there aborts before the conversation moves.
  app.post<{ Body: RewindRequest }>('/api/session/rewind', async (req): Promise<RewindResponse> => {
    const { id, uuid, mode, deleteNewer } = req.body
    const info = sessions.get(id)
    const claudeId = sessions.claudeSessionId(id)
    if (!info || !claudeId) return { ok: false, error: 'no such session' }

    let reverted: number | undefined, deleted: number | undefined
    if (mode === 'code' || mode === 'both') {
      const res = await restore(info.cwd, uuid, !!deleteNewer)
      if (!res.ok) return { ok: false, error: res.error }
      reverted = res.reverted; deleted = res.deleted
    }

    let newId: string | undefined, cleared: boolean | undefined
    if (mode === 'conversation' || mode === 'both') {
      const fork = await forkConversationBefore(info.cwd, claudeId, uuid)
      if (!fork) return { ok: false, error: 'rewind point not found in this conversation', reverted, deleted }
      if ('empty' in fork) {
        // Rewinding to before the first prompt = an empty conversation → start fresh
        // rather than resume a contentless fork (which Claude rejects and can't relaunch).
        sessions.restartFresh(id)
        cleared = true
      } else {
        newId = fork.newId
        sessions.resumeInto(id, newId)
      }
    }
    return { ok: true, newId, cleared, reverted, deleted }
  })
}

// Dispatch a client→server WS message that drives a session. Returns true if the
// message was a session topic (handled), false otherwise (e.g. ping) so the caller
// can fall through to other handlers.
export function handleSessionClientMessage(sessions: SessionManager, msg: WsClientMessage, hub: WsHub): boolean {
  switch (msg.type) {
    case 'session:send':
      // sendUserTurn is async and its boolean is the ONLY signal that the turn reached a
      // live engine. Dropping it made a send into the mid-relaunch/mid-close/just-died
      // window vanish with no trace: the false returns run before any side effect, so no
      // userTurn is emitted, no state flips, nothing renders — while the client had
      // already appended its optimistic echo, leaving the message looking sent forever.
      // The team mailbox has always inspected this same boolean and re-queued on false;
      // only the human path threw it away. We do not retry here — a silent retry is what
      // printed turns twice before — we tell the sender instead.
      // ★ A PENDING MODEL IS APPLIED HERE, BEFORE THE TURN — this is what "next turn" means.
      // applyModelForTurn resolves only once the replacement engine is up, so the turn is not
      // delivered into the `replacing` window that the guards in sendUserTurn reject. It is a
      // no-op (and resolves immediately) when nothing is pending, which is almost every send.
      void sessions.applyModelForTurn(msg.id)
        .then(() => sessions.sendUserTurn(msg.id, msg.text, msg.turnId))
        .then((delivered) => { if (!delivered) hub.broadcast({ type: 'session:sendFailed', id: msg.id, turnId: msg.turnId }) })
        .catch(() => hub.broadcast({ type: 'session:sendFailed', id: msg.id, turnId: msg.turnId }))
      return true
    case 'session:interrupt':
      sessions.interrupt(msg.id)
      return true
    case 'session:stopTask':
      // Fire-and-forget: the outcome the user cares about is the card settling, which
      // arrives on the normal task_notification path. A rejection here (stale card, dead
      // session) is logged, not surfaced — there's nothing for them to act on.
      void sessions.stopTask(msg.id, msg.toolId).then((r) => {
        if (!r.ok) console.warn(`[session] stop_task for ${msg.toolId} declined: ${r.error}`)
      })
      return true
    case 'session:killBash':
      // Fire-and-forget for the same reason session:stopTask is: the outcome the user cares
      // about is the row settling, and that arrives on the normal <task-notification> path —
      // the same one a shell that finishes by itself takes. Nothing is painted from this
      // return value, deliberately: the engine answers a stop for an already-finished or
      // unknown task with SUCCESS, so acting on ok:true would report a kill we never made.
      //
      // ★ stopBashProc, NOT stopTask. They take the same-shaped arguments and consult
      // DIFFERENT registries — stopTask resolves toolId against the subagent map, which never
      // holds a shell, so routing kills through it declines every one of them before the CLI
      // is ever asked. See the note on stopBashProc in sessionManager.ts.
      void sessions.stopBashProc(msg.id, msg.toolId).then((r) => {
        if (!r.ok) console.warn(`[session] kill_bash for ${msg.toolId} declined: ${r.error}`)
      })
      return true
    case 'session:clearBashProcs': {
      // Fire-and-forget like killBash: the outcome the user cares about is the list repainting,
      // and that arrives on the normal `session:bashProcs` broadcast. Nothing is painted here.
      const r = sessions.clearBashProcs(msg.id, msg.toolIds)
      // Logged, not surfaced. A refusal means an id named a RUNNING record, which the UI does
      // not offer to clear — so it indicates a race or a second client, which is worth seeing
      // in a log and not worth a dialog about a row that is still visibly there and working.
      if (r.refused > 0) console.warn(`[session] clearBashProcs: refused ${r.refused} still-running record(s)`)
      return true
    }
    case 'session:permission':
      sessions.respondPermission(msg.id, msg.requestId, msg.decision)
      return true
    default:
      return false
  }
}
