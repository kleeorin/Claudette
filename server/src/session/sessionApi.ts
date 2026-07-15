import type { FastifyInstance } from 'fastify'
import type {
  WsClientMessage, ClaudeEvent, PermissionRequest, SessionState,
  CreateSessionRequest, CreateSessionResponse, ListSessionsResponse,
  SessionIdRequest, OkResponse, SetModeRequest, SetModeResult,
  ResumeIntoRequest, ConversationsResponse, ConversationResponse, SandboxConfig,
} from '@claudette/shared'
import { SessionManager } from '../claude/sessionManager'
import { listConversations, readConversation } from '../claude/conversations'
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
  sessions.on('stateChange', (id: string, state: SessionState) =>
    hub.broadcast({ type: 'session:state', id, state }))
  sessions.on('ready', (id: string, claudeSessionId: string) =>
    hub.broadcast({ type: 'session:ready', id, claudeSessionId }))
  sessions.on('exit', (id: string, failed: boolean, error: string) =>
    hub.broadcast({ type: 'session:exit', id, failed, error }))
}

// Register the HTTP lifecycle routes on the Fastify app.
export function registerSessionRoutes(app: FastifyInstance, sessions: SessionManager): void {
  app.post<{ Body: CreateSessionRequest }>('/api/session/create', async (req): Promise<CreateSessionResponse> => {
    const b = req.body
    const id = sessions.create(
      b.name, b.cwd, b.rootDir, b.parentId, b.resume,
      b.claudeSessionId, b.agentId, b.model, b.permissionMode, b.sandbox,
    )
    return { id }
  })

  // Update a session's bwrap sandbox config (enable/disable, edit mounts). Applies
  // on the next launch — relaunch/restartFresh to bring it into force.
  app.post<{ Body: SessionIdRequest & { sandbox: SandboxConfig } }>(
    '/api/session/setSandbox', async (req): Promise<OkResponse> => ({
      ok: sessions.setSandbox(req.body.id, req.body.sandbox),
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

  app.post<{ Body: SetModeRequest }>('/api/session/setMode', async (req): Promise<SetModeResult> =>
    sessions.setPermissionMode(req.body.id, req.body.mode))

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
}

// Dispatch a client→server WS message that drives a session. Returns true if the
// message was a session topic (handled), false otherwise (e.g. ping) so the caller
// can fall through to other handlers.
export function handleSessionClientMessage(sessions: SessionManager, msg: WsClientMessage): boolean {
  switch (msg.type) {
    case 'session:send':
      sessions.sendUserTurn(msg.id, msg.text)
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
