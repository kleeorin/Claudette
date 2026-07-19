import type {
  ClaudeEvent, PermissionRequest, PermissionDecision, PermissionMode,
  SessionInfo, SessionState, SetModeResult, ConversationMeta, ActivePane, SandboxConfig,
  AgentInfo, EffectivePermissions, PermissionScope, PermissionAction, WriteResult,
} from './types'
import type { NotebookDoc, NotebookOp, CellLock, LockReason, KernelStatus, KernelSpec } from './notebook'

// The app WebSocket envelope. One socket per browser tab; topics are multiplexed
// on the `type` field. The unions below are the typed contract for both ends;
// they grow as Phase 1 topics land (pty, notebook:update, appcontrol). Because
// Claudette is single-user, server→client events are broadcast to every open tab
// (all tabs mirror the same session set).

// --- client → server ---------------------------------------------------------

export type WsClientMessage =
  | { type: 'ping' }
  // Native turn I/O for a session (lifecycle create/list/destroy/… is HTTP).
  | { type: 'session:send'; id: string; text: string; turnId?: string }
  | { type: 'session:interrupt'; id: string }
  | { type: 'session:permission'; id: string; requestId: string; decision: PermissionDecision }
  // What a session is currently viewing (its active content tab), published on tab/
  // session switch. `pane` is null when the Claude tab is focused. Backs the
  // path-less, active-pane-targeted app-control notebook tools (read_active_pane,
  // and the cell tools when Claude omits `path`).
  | { type: 'session:activePane'; id: string; pane: ActivePane | null }
  // Notebook ops + locks from a UI (human origin). The server holds the
  // authoritative doc; the UI is a view that sends ops and renders `notebook:update`.
  // (Wired for the notebook UI in P1.15; the types land now so the server broadcasts
  // have a typed channel.)
  | { type: 'notebook:op'; op: NotebookOp }
  | { type: 'notebook:claim'; notebookId: string; cellId: string; reason: LockReason }
  | { type: 'notebook:release'; notebookId: string; cellId: string }
  // Terminal pane I/O (lifecycle create/destroy is HTTP). Keystrokes + resize go up;
  // pty output + exit come back down (namespaced by pane id).
  | { type: 'pane:input'; id: string; data: string }
  | { type: 'pane:resize'; id: string; cols: number; rows: number }

// --- server → client ---------------------------------------------------------

export type WsServerMessage =
  | { type: 'hello'; version: string }
  | { type: 'pong'; ts: number }
  // A snapshot of all sessions, sent on connect so a fresh tab renders the list.
  | { type: 'session:list'; sessions: SessionInfo[] }
  // Per-session connect-time snapshot: the buffered transcript so far + ALL
  // still-unanswered permission prompts (the CLI can have several outstanding at once
  // when an assistant message fires multiple tool_uses). Sent to a freshly-connected
  // socket so a
  // device joining an in-progress session (e.g. the phone) sees the conversation
  // AND can answer a pending "allow" prompt, instead of a blank stream. Events are
  // replayed like a resumed conversation; `pending` is set only if one awaits.
  | { type: 'session:snapshot'; id: string; events: ClaudeEvent[]; pending?: PermissionRequest[] }
  // Per-session streaming events (namespaced by session id).
  | { type: 'session:event'; id: string; event: ClaudeEvent }
  | { type: 'session:permission'; id: string; request: PermissionRequest }
  // A user turn, broadcast to EVERY client so all mirror it (not just the sender's
  // optimistic echo). turnId lets the sender de-dupe its own optimistic message.
  | { type: 'session:userTurn'; id: string; text: string; turnId?: string }
  // A pending permission prompt was resolved (answered, auto-denied, or the session
  // ended) — every client clears that prompt, so a non-answering device (e.g. the
  // phone) isn't left stuck on a dead prompt.
  | { type: 'session:permissionResolved'; id: string; requestId: string }
  | { type: 'session:state'; id: string; state: SessionState }
  | { type: 'session:ready'; id: string; claudeSessionId: string }
  | { type: 'session:exit'; id: string; failed: boolean; error: string }
  // Authoritative notebook doc pushed after every applied op / external reload, and
  // the current human-held cell locks. Full-doc snapshots for now (deltas are a
  // later optimization). Broadcast to every tab (single-user; all tabs mirror it).
  | { type: 'notebook:update'; doc: NotebookDoc }
  // The cell a just-applied op touched, so the view can select + reveal it. `reveal`
  // is true for Claude's edits and for structural ops (add/insert/delete/move/type) —
  // the view scrolls those into view; a plain human text edit (typing/undo) only
  // re-selects, so it never yanks the scroll while the user is in the cell.
  | { type: 'notebook:focus'; notebookId: string; cellId: string; reveal: boolean }
  | { type: 'notebook:locks'; notebookId: string; locks: CellLock[] }
  | { type: 'notebook:kernel'; notebookId: string; status: KernelStatus }
  // The set of cells currently executing (or queued) for a notebook — server-owned
  // and authoritative, so the per-cell running spinner reflects reality instead of a
  // single global busy→idle edge (which fires early, leaks on heartbeats, or never
  // fires on a dead/restarted kernel). Replaces the client's optimistic set.
  | { type: 'notebook:running'; notebookId: string; cellIds: string[] }
  // Steer a session's UI to focus a notebook tab — emitted when Claude calls the
  // app-control `open_notebook` tool so the notebook it's about to work on becomes
  // the one the user is looking at (in that same session). The doc itself arrives
  // via a `notebook:update`; this only moves focus.
  | { type: 'session:focusPane'; id: string; notebookId: string; path: string }
  | { type: 'pane:output'; id: string; data: string }
  | { type: 'pane:exit'; id: string }

// --- HTTP request/response ----------------------------------------------------

// GET /api/health
export interface HealthResponse {
  ok: boolean
  version: string
  ts: number
  // Whether this host can actually sandbox (bwrap present + userns permitted).
  // Functional probe, not "binary exists" — see SANDBOX.md. Drives the UI's
  // "enable sandbox" affordance and the "unavailable" messaging.
  sandboxAvailable: boolean
  // The server user's home directory — the sensible default cwd for new sessions,
  // terminals, and the folder picker (the client can't read the server's $HOME).
  homeDir: string
}

// POST /api/session/create
export interface CreateSessionRequest {
  name: string
  cwd: string
  rootDir?: string
  parentId?: string
  resume?: boolean
  claudeSessionId?: string
  agentId?: string
  model?: string
  permissionMode?: PermissionMode
  sandbox?: SandboxConfig  // omit ⇒ server seeds the default (enabled, cwd rw) when available
}
export interface CreateSessionResponse { id: string }

// GET /api/session/list
export interface ListSessionsResponse { sessions: SessionInfo[] }

// POST /api/session/destroy | /api/session/relaunch  { id }
export interface SessionIdRequest { id: string }
export interface OkResponse { ok: boolean }

// POST /api/session/setMode { id, mode } → SetModeResult
export interface SetModeRequest { id: string; mode: PermissionMode }
export type { SetModeResult }

// Re-export the session id request under intent-revealing aliases for routes.
export type DestroySessionRequest = SessionIdRequest
export type RelaunchSessionRequest = SessionIdRequest

// POST /api/session/setAgent { id, agentId } — change the session's role. Applied by
// a resume-preserving relaunch (new charter/tools/model take effect on the fresh engine).
export interface SetAgentRequest { id: string; agentId: string }
// POST /api/session/rename { id, name } — set the session's display name.
export interface RenameSessionRequest { id: string; name: string }
// GET /api/agents → the selectable roles (id/name/description).
export interface ListAgentsResponse { agents: AgentInfo[] }

// GET /api/session/permissions?cwd=…&agentId=…  → the merged permission picture
// read from Claude's own settings files (Permission Control Center).
export interface PermissionsResponse { permissions: EffectivePermissions }
// POST /api/session/perms/addRule | /api/session/perms/removeRule → WriteResult.
// Add/remove one allow/deny/ask rule in a chosen scope's settings file.
export interface EditRuleRequest { cwd: string; scope: PermissionScope; action: PermissionAction; value: string }
export type { WriteResult }

// POST /api/session/restartFresh { id }  — the native /clear (fresh conversation)
export type RestartFreshRequest = SessionIdRequest
// POST /api/session/resumeInto { id, claudeSessionId } — rebind to a past conversation
export interface ResumeIntoRequest { id: string; claudeSessionId: string }
// GET /api/session/conversations?cwd=…  → resumable conversations for that folder
export interface ConversationsResponse { conversations: ConversationMeta[] }
// GET /api/session/conversation?cwd=…&id=…  → the conversation replayed as events
export interface ConversationResponse { events: ClaudeEvent[] }

// POST /api/pane/create { cwd, cols?, rows?, sessionId? } → { id }   |   POST /api/pane/destroy { id }
// cols/rows let the client spawn the pty at the terminal's real size so the shell's
// line-editing geometry matches what xterm renders from the very first prompt.
// sessionId ties the pty to its owning session, so destroying the session reaps it.
export interface CreatePaneRequest { cwd: string; cols?: number; rows?: number; sessionId?: string }
export interface CreatePaneResponse { id: string }

// GET /api/notebook/kernelspecs → the kernels the user can pick, + Jupyter's default.
export interface KernelSpecsResponse { specs: KernelSpec[]; default: string }
