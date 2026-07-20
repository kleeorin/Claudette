import type { FastifyInstance } from 'fastify'
import type {
  WsClientMessage, ClaudeEvent, PermissionRequest, SessionState,
  CreateSessionRequest, CreateSessionResponse, ListSessionsResponse,
  SessionIdRequest, OkResponse, SetModeRequest, SetModeResult,
  ResumeIntoRequest, ConversationsResponse, ConversationResponse, SandboxConfig,
  SetAgentRequest, RenameSessionRequest, ListAgentsResponse,
  PermissionsResponse, EditRuleRequest, WriteResult,
  RewindPointsResponse, RewindRequest, RewindResponse,
} from '@claudette/shared'
import { SessionManager } from '../claude/sessionManager'
import { listAgents } from '../claude/agents'
import { getEffective, addRule, removeRule } from '../claude/permissions'
import { listConversations, readConversation, listRewindPoints, forkConversationBefore } from '../claude/conversations'
import { WsHub } from '../ws/hub'

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
}

// Send a freshly-connected socket the per-session catch-up it needs to render an
// in-progress session: the buffered transcript so far + any still-unanswered
// permission prompt. Called once per connect, AFTER session:list. Without this a
// device joining mid-session sees a blank stream and can't answer a pending prompt.
export function sendSessionSnapshots(sessions: SessionManager, hub: WsHub, ws: import('ws').WebSocket): void {
  for (const s of sessions.list()) {
    const events = sessions.transcriptOf(s.id)
    const pending = sessions.pendingPermissionsOf(s.id)
    if (events.length === 0 && pending.length === 0) continue
    hub.send(ws, { type: 'session:snapshot', id: s.id, events, pending })
  }
}

// Register the HTTP lifecycle routes on the Fastify app.
export function registerSessionRoutes(app: FastifyInstance, sessions: SessionManager): void {
  app.post<{ Body: CreateSessionRequest }>('/api/session/create', async (req): Promise<CreateSessionResponse> => {
    const b = req.body
    const id = sessions.create(
      b.name, b.cwd, b.rootDir, b.parentId, b.resume,
      b.claudeSessionId, b.agentId, b.model, b.permissionMode, b.sandbox,
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
    sessions.setPermissionMode(req.body.id, req.body.mode))

  // Change a session's role — relaunches (resume-preserving) to apply the new charter.
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

  // /rewind — fork the session's current conversation to just before `uuid` and resume
  // the engine into the fork. The original conversation is untouched (the fork is a
  // copy), so the rewind can be undone by resuming the original via /resume.
  app.post<{ Body: RewindRequest }>('/api/session/rewind', async (req): Promise<RewindResponse> => {
    const info = sessions.get(req.body.id)
    const claudeId = sessions.claudeSessionId(req.body.id)
    if (!info || !claudeId) return { ok: false, error: 'no such session' }
    const newId = await forkConversationBefore(info.cwd, claudeId, req.body.uuid)
    if (!newId) return { ok: false, error: 'rewind point not found in this conversation' }
    sessions.resumeInto(req.body.id, newId)
    return { ok: true, newId }
  })
}

// Dispatch a client→server WS message that drives a session. Returns true if the
// message was a session topic (handled), false otherwise (e.g. ping) so the caller
// can fall through to other handlers.
export function handleSessionClientMessage(sessions: SessionManager, msg: WsClientMessage): boolean {
  switch (msg.type) {
    case 'session:send':
      sessions.sendUserTurn(msg.id, msg.text, msg.turnId)
      return true
    case 'session:interrupt':
      sessions.interrupt(msg.id)
      return true
    case 'session:permission':
      sessions.respondPermission(msg.id, msg.requestId, msg.decision)
      return true
    default:
      return false
  }
}
