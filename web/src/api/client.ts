import type {
  HealthResponse, WsClientMessage, WsServerMessage,
  ClaudeEvent, PermissionRequest, PermissionDecision, SessionInfo, SessionState,
  CreateSessionRequest, CreateSessionResponse, ListSessionsResponse,
  OkResponse, SetModeRequest, SetModeResult, PermissionMode,
  TrustQueryResponse, TrustFolderRequest,
  NotebookDoc, NotebookOp, CellLock, LockReason, KernelStatus,
  CreatePaneRequest, CreatePaneResponse, ListPanesResponse, AttachPaneResponse,
  ConversationMeta, ConversationsResponse, ConversationResponse,
  RewindPoint, RewindMode, RewindPreview, RewindPointsResponse, RewindPreviewResponse, RewindResponse,
  TaskRecord,
  FsListResponse, FilePreview, WriteResult,
  GitStatus, GitDiff, GitLog, GitBranches, GitResult,
  ActivePane, KernelSpecsResponse, SandboxConfig, SandboxDefaultFolder, SandboxDefaultsResponse,
  AgentInfo, ListAgentsResponse,
  EffectivePermissions, PermissionScope, PermissionAction, PermissionsResponse,
  UsageResponse,
  ConnectorsResponse, ConnectorDef, ConnectorView, AccountConnector, StrictPreflight,
} from '@claudette/shared'

// The single place the SPA talks to the server — replaces ClaudeMaster's Electron
// `window.api`. HTTP for request/response lifecycle; one shared WebSocket for
// streaming, with the ported stores subscribing via `api.on.*` (same shape as the
// old IPC surface, so store code carries over almost unchanged).

// --- HTTP helpers ------------------------------------------------------------

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return res.json()
}

async function get<T>(path: string): Promise<T> {
  return (await fetch(path)).json()
}

// A stable id for THIS TAB, used to claim terminal panes (see pane.prune). sessionStorage
// is the right store: unique per tab (so a phone can't speak for the desktop) yet it
// survives a reload (so a refreshed tab re-claims its own ptys instead of orphaning
// them). Not crypto.randomUUID — that's undefined outside a secure context, and Claudette
// is routinely opened over plain http on a LAN.
let clientKey: string | null = null
function clientId(): string {
  if (clientKey) return clientKey
  const fresh = `tab-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  try {
    clientKey = sessionStorage.getItem('claudette.clientId') ?? fresh
    sessionStorage.setItem('claudette.clientId', clientKey)
  } catch {
    clientKey = fresh   // storage blocked (private mode) — a per-load id still claims fine
  }
  return clientKey
}

export async function getHealth(): Promise<HealthResponse> {
  return get<HealthResponse>('/api/health')
}

// --- WebSocket hub (client side) ---------------------------------------------

type Unsub = () => void
type Fn<A extends unknown[]> = (...a: A) => void

function channel<A extends unknown[]>() {
  const set = new Set<Fn<A>>()
  return {
    on(fn: Fn<A>): Unsub { set.add(fn); return () => set.delete(fn) },
    emit(...a: A): void { for (const fn of set) fn(...a) },
  }
}

const events = channel<[string, ClaudeEvent]>()
// [id, buffered events, pending permission, subagent registry] — the connect-time
// per-session catch-up. `tasks` lets a reconnecting tab settle cards even when the
// transcript no longer carries the completion.
const snapshots = channel<[string, ClaudeEvent[], PermissionRequest[] | undefined, TaskRecord[] | undefined]>()
const tasks = channel<[string, TaskRecord[]]>()   // [id, subagent registry] — live updates
const permissions = channel<[string, PermissionRequest]>()
const userTurns = channel<[string, string, string | undefined]>()   // [id, text, turnId]
const sendFailed = channel<[string, string | undefined]>()          // [id, turnId] — turn never reached a live engine
const permsResolved = channel<[string, string]>()                   // [id, requestId]
const states = channel<[string, SessionState]>()
const readies = channel<[string, string]>()
const exits = channel<[string, boolean, string]>()
const lists = channel<[SessionInfo[]]>()
const connected = channel<[boolean]>()
const nbUpdates = channel<[NotebookDoc]>()
const nbFocuses = channel<[string, string, boolean]>()   // [notebookId, cellId, reveal]
const nbLocks = channel<[string, CellLock[]]>()
const nbKernels = channel<[string, KernelStatus]>()
const nbRunning = channel<[string, string[]]>()          // [notebookId, running cellIds]
const paneOutputs = channel<[string, string]>()
const paneExits = channel<[string]>()
const focusPanes = channel<[string, string, string]>()   // [sessionId, notebookId, path]
const focusFiles = channel<[string, string]>()           // [sessionId, path]
// A watched file changed / vanished on disk. Path only — the subscriber re-reads through
// GET /api/fs/read, so readPreview stays the single implementation of "what is this file".
const fsChanges = channel<[string]>()
const fsRemovals = channel<[string]>()
// Paths this page has asked the server to watch, with a LOCAL refcount. Survives the
// socket so the watches can be re-armed on reconnect — see api.fs.watch for why.
const watched = new Map<string, number>()

let ws: WebSocket | null = null
// Has the socket EVER been open in this page load? Set once in `sock.onopen`, never cleared.
// This is a different question from `isConnected()` and the difference is the whole point:
// readyState cannot distinguish "never connected yet" from "was connected and dropped", and a
// subscriber that wants to know whether an incoming `connected(true)` is a RECONNECT needs
// exactly that distinction. See the `wasDown` seed in the sessions store.
let everConnected = false
let backoff = 500
const outbox: WsClientMessage[] = []

function send(msg: WsClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  else outbox.push(msg)  // flushed on (re)connect
}

// Send only if the socket is up, never queue. For messages that describe STATE rather than
// an event: the state is re-sent wholesale on connect, so queuing an individual change
// would double-apply it. `watched` is the only such state today.
function sendLive(msg: WsClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function dispatch(msg: WsServerMessage): void {
  switch (msg.type) {
    case 'session:list': lists.emit(msg.sessions); break
    case 'session:snapshot': snapshots.emit(msg.id, msg.events, msg.pending, msg.tasks); break
    case 'session:tasks': tasks.emit(msg.id, msg.tasks); break
    case 'session:event': events.emit(msg.id, msg.event); break
    case 'session:permission': permissions.emit(msg.id, msg.request); break
    case 'session:userTurn': userTurns.emit(msg.id, msg.text, msg.turnId); break
    case 'session:sendFailed': sendFailed.emit(msg.id, msg.turnId); break
    case 'session:permissionResolved': permsResolved.emit(msg.id, msg.requestId); break
    case 'session:state': states.emit(msg.id, msg.state); break
    case 'session:ready': readies.emit(msg.id, msg.claudeSessionId); break
    case 'session:exit': exits.emit(msg.id, msg.failed, msg.error); break
    case 'notebook:update': nbUpdates.emit(msg.doc); break
    case 'notebook:focus': nbFocuses.emit(msg.notebookId, msg.cellId, msg.reveal); break
    case 'notebook:locks': nbLocks.emit(msg.notebookId, msg.locks); break
    case 'notebook:kernel': nbKernels.emit(msg.notebookId, msg.status); break
    case 'notebook:running': nbRunning.emit(msg.notebookId, msg.cellIds); break
    case 'pane:output': paneOutputs.emit(msg.id, msg.data); break
    case 'pane:exit': paneExits.emit(msg.id); break
    case 'session:focusPane': focusPanes.emit(msg.id, msg.notebookId, msg.path); break
    case 'session:focusFile': focusFiles.emit(msg.id, msg.path); break
    case 'fs:changed': fsChanges.emit(msg.path); break
    case 'fs:removed': fsRemovals.emit(msg.path); break
    // 'hello' / 'pong' are connection-liveness only.
  }
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const sock = new WebSocket(`${proto}://${location.host}/ws`)
  ws = sock
  sock.onopen = () => {
    backoff = 500
    // ORDER IS LOAD-BEARING: this must precede `connected.emit(true)`. `channel.emit` runs its
    // subscribers SYNCHRONOUSLY, so a handler that asks `hasEverConnected()` while servicing
    // this very emit sees `true` only if the flag is already set. Reversed, a subscriber shaped
    // like the sessions store's seed (`hasEverConnected() && !isConnected()`) would get the
    // wrong answer on the exact edge it exists to classify. No current subscriber does that —
    // this is not a live bug — but the seed pattern invites one, so do not tidy these three
    // statements into a different order.
    everConnected = true
    // Re-arm file watches BEFORE connected.emit. The server keys them per socket and
    // released this page's on the old socket's close, so a watch that was delivered
    // successfully is nonetheless gone; `watched` is the authoritative set (watch/unwatch
    // never queue), making this a state re-sync rather than a replay of missed messages.
    //
    // ORDER IS LOAD-BEARING, for the same family of reason as the three statements above.
    // `channel.emit` runs subscribers SYNCHRONOUSLY, so a subscriber that calls
    // api.fs.watch(path) inside this emit would send its own fs:watch (n === 1) and then be
    // re-sent by a loop iterating a `watched` that now contains it — two watches against a
    // socket that will only ever send one unwatch. That is exactly the leak the sendLive
    // note warns about, reached through a different door. No current subscriber does this
    // (they route through React state and run after onopen returns), which is why it is a
    // trap rather than a bug; re-arming first makes it unreachable instead of unlikely.
    for (const path of watched.keys()) sock.send(JSON.stringify({ type: 'fs:watch', path }))
    connected.emit(true)
    for (const m of outbox.splice(0)) sock.send(JSON.stringify(m))
  }
  sock.onmessage = (e) => {
    let msg: WsServerMessage
    try { msg = JSON.parse(e.data) } catch { return }
    dispatch(msg)
  }
  const retry = (): void => {
    if (ws !== sock) return  // already reconnected
    ws = null
    connected.emit(false)
    setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, 8000)
  }
  sock.onclose = retry
  sock.onerror = () => sock.close()
}

// The WS connects lazily — only after the auth gate confirms we're authenticated
// (an unauthenticated upgrade is rejected by the server and would just spin the
// reconnect loop). Idempotent.
let wsStarted = false
export function ensureWs(): void {
  if (wsStarted) return
  wsStarted = true
  connect()
}

// --- auth ---------------------------------------------------------------------

// Send a token to the bootstrap endpoint; on success the server sets the httpOnly
// cookie that then rides every request + the WS upgrade. Returns whether it took.
export async function submitToken(token: string): Promise<boolean> {
  const res = await fetch(`/api/auth?token=${encodeURIComponent(token)}`)
  return res.ok
}

// Are we allowed in? Probes a gated endpoint (401 ⇒ token needed). Also handles
// the one-time `?token=…` bootstrap in the URL (set the cookie, then strip it so
// the secret doesn't linger in history / the address bar).
export async function checkAuth(): Promise<boolean> {
  const url = new URL(location.href)
  const bootstrap = url.searchParams.get('token')
  if (bootstrap) {
    await submitToken(bootstrap)
    url.searchParams.delete('token')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }
  const res = await fetch('/api/session/list', { headers: { accept: 'application/json' } })
  return res.status !== 401
}

// --- the api surface ---------------------------------------------------------

export const api = {
  // The socket's CURRENT state. True only while OPEN — CONNECTING, CLOSING, CLOSED and a null
  // socket all read false, which is correct for every caller: during a drop `retry()` nulls
  // `ws` before emitting, and in the window between `close()` and `onclose` the socket is
  // CLOSING, so "not usable right now" is the honest answer in both.
  isConnected: (): boolean => ws !== null && ws.readyState === WebSocket.OPEN,
  // Whether the socket has been open at least once this page load. NOT a substitute for
  // `isConnected` and not interchangeable with it: `connected` is a plain channel with no
  // replay, so a subscriber that mounts mid-outage never observes the down-edge, and asking
  // "am I open?" cannot tell *never connected yet* from *was connected and dropped*. That
  // distinction is the entire question when deciding whether an incoming `connected(true)` is
  // a RECONNECT, and it is the one readyState cannot answer — a freshly constructed socket is
  // CONNECTING, never OPEN, so a readyState-only seed reads "down" on every healthy startup.
  hasEverConnected: (): boolean => everConnected,
  // Streaming subscriptions (namespaced by session id, except list/connected).
  on: {
    event: (fn: Fn<[string, ClaudeEvent]>) => events.on(fn),
    snapshot: (fn: Fn<[string, ClaudeEvent[], PermissionRequest[] | undefined, TaskRecord[] | undefined]>) => snapshots.on(fn),
    // Live subagent-registry updates (session:tasks) — the durable agent-card fallback.
    tasks: (fn: Fn<[string, TaskRecord[]]>) => tasks.on(fn),
    permission: (fn: Fn<[string, PermissionRequest]>) => permissions.on(fn),
    // A user turn mirrored from the server (any device); turnId de-dupes the sender's echo.
    userTurn: (fn: Fn<[string, string, string | undefined]>) => userTurns.on(fn),
    // A send that never reached a live claude process. The optimistic echo is already
    // in the transcript under this turnId, so the UI marks THAT item undelivered rather
    // than appending anything — see chat.tsx MARK_UNDELIVERED.
    sendFailed: (fn: Fn<[string, string | undefined]>) => sendFailed.on(fn),
    // A pending permission prompt was resolved — clear it on every client.
    permissionResolved: (fn: Fn<[string, string]>) => permsResolved.on(fn),
    stateChange: (fn: Fn<[string, SessionState]>) => states.on(fn),
    ready: (fn: Fn<[string, string]>) => readies.on(fn),
    exit: (fn: Fn<[string, boolean, string]>) => exits.on(fn),
    list: (fn: Fn<[SessionInfo[]]>) => lists.on(fn),
    connected: (fn: Fn<[boolean]>) => connected.on(fn),
    notebookUpdate: (fn: Fn<[NotebookDoc]>) => nbUpdates.on(fn),
    // The cell a just-applied op touched (notebookId, cellId, reveal).
    notebookFocus: (fn: Fn<[string, string, boolean]>) => nbFocuses.on(fn),
    notebookLocks: (fn: Fn<[string, CellLock[]]>) => nbLocks.on(fn),
    notebookKernel: (fn: Fn<[string, KernelStatus]>) => nbKernels.on(fn),
    // The authoritative set of running/queued cells for a notebook (server-owned).
    notebookRunning: (fn: Fn<[string, string[]]>) => nbRunning.on(fn),
    paneOutput: (fn: Fn<[string, string]>) => paneOutputs.on(fn),
    // An open editor's file moved on disk. Broadcast to every socket (the hub does no
    // per-socket filtering), so a subscriber MUST compare the path against its own.
    fsChanged: (fn: Fn<[string]>) => fsChanges.on(fn),
    fsRemoved: (fn: Fn<[string]>) => fsRemovals.on(fn),
    paneExit: (fn: Fn<[string]>) => paneExits.on(fn),
    // Claude asked (via open_notebook) to focus a notebook in a given session.
    focusPane: (fn: Fn<[string, string, string]>) => focusPanes.on(fn),
    // Claude asked (via open_file) to focus a plain file in a given session.
    focusFile: (fn: Fn<[string, string]>) => focusFiles.on(fn),
  },
  // Turn I/O over WS.
  session: {
    sendTurn: (id: string, text: string, turnId?: string) => send({ type: 'session:send', id, text, turnId }),
    interrupt: (id: string) => send({ type: 'session:interrupt', id }),
    // Stop one subagent, leaving the parent turn running.
    stopTask: (id: string, toolId: string) => send({ type: 'session:stopTask', id, toolId }),
    respondPermission: (id: string, requestId: string, decision: PermissionDecision) =>
      send({ type: 'session:permission', id, requestId, decision }),
    // Publish what a session is currently viewing (its active content tab, or null
    // for the Claude tab) so the app-control notebook tools can target it.
    setActivePane: (id: string, pane: ActivePane | null) =>
      send({ type: 'session:activePane', id, pane }),
  },
  // Lifecycle over HTTP.
  http: {
    createSession: (req: CreateSessionRequest) => post<CreateSessionResponse>('/api/session/create', req),
    // Workspace trust: is this cwd trusted, and mark it trusted (see server/claude/trust.ts).
    checkTrust: async (cwd: string): Promise<boolean> =>
      (await get<TrustQueryResponse>(`/api/session/trust?cwd=${encodeURIComponent(cwd)}`)).trusted,
    trustFolder: (cwd: string) => post<OkResponse>('/api/session/trust', { cwd } as TrustFolderRequest),
    listSessions: async (): Promise<SessionInfo[]> =>
      (await get<ListSessionsResponse>('/api/session/list')).sessions,
    destroySession: (id: string) => post<OkResponse>('/api/session/destroy', { id }),
    relaunch: (id: string) => post<OkResponse>('/api/session/relaunch', { id }),
    relaunchApply: (id: string) => post<OkResponse>('/api/session/relaunchApply', { id }),
    setMode: (id: string, mode: PermissionMode) => post<SetModeResult>('/api/session/setMode', { id, mode } as SetModeRequest),
    setAgent: (id: string, agentId: string) => post<OkResponse>('/api/session/setAgent', { id, agentId }),
    rename: (id: string, name: string) => post<OkResponse>('/api/session/rename', { id, name }),
    listAgents: async (): Promise<AgentInfo[]> => (await get<ListAgentsResponse>('/api/agents')).agents,
    setSandbox: (id: string, sandbox: SandboxConfig) => post<OkResponse>('/api/session/setSandbox', { id, sandbox }),
    // Grant/revoke a session's right to hire teammates. Only this auth-gated route can:
    // the server refuses an untrusted grant so a confined session can't hire itself a team.
    setTeamEmploy: (id: string, teamEmploy: boolean) => post<OkResponse>('/api/session/setTeamEmploy', { id, teamEmploy }),
    // --- saved folder defaults (SandboxDefaultFolder) -------------------------
    // The operator's standing list of favourite folders, offered as one-click mounts in
    // every session's sandbox editor. INSTALL-WIDE like the connector catalog above, and
    // like it the list is only ever a menu: an entry mounts nothing until it is ticked,
    // and the tick goes through setSandbox. Every write answers with the WHOLE list, so a
    // caller never reconciles a patch against what it thought it had.
    sandboxDefaults: () => get<SandboxDefaultsResponse>('/api/sandbox/defaults'),
    saveSandboxDefault: (f: SandboxDefaultFolder) =>
      post<SandboxDefaultsResponse & { error?: string }>('/api/sandbox/defaults/save', f),
    removeSandboxDefault: (path: string) =>
      post<SandboxDefaultsResponse>('/api/sandbox/defaults/delete', { path }),
    // --- connectors (see CONNECTORS.md) --------------------------------------
    // The CATALOG is global (one per install); the GRANT is per session. Two scopes, two
    // surfaces: the Claudette deck edits the catalog, the sandbox panel edits a session's
    // grants. Every write here is auth-gated, which is what makes it "trusted" server-side.
    listConnectors: () => get<ConnectorsResponse>('/api/connectors'),
    saveConnector: (def: ConnectorDef) =>
      post<{ connector?: ConnectorView; error?: string }>('/api/connectors/save', def),
    deleteConnector: (id: string) => post<OkResponse>('/api/connectors/delete', { id }),
    setAccountConnectors: (accountConnectors: AccountConnector[]) =>
      post<{ accountConnectors: AccountConnector[] }>('/api/connectors/account', { accountConnectors }),
    connectorPreflight: (cwd: string) =>
      get<StrictPreflight>(`/api/connectors/preflight?cwd=${encodeURIComponent(cwd)}`),
    importConnectors: (cwd: string) =>
      post<{ added: string[]; skipped: { name: string; source: string; reason: string }[] }>('/api/connectors/import', { cwd }),
    setStrictMcp: (enabled: boolean) => post<{ strict: boolean }>('/api/connectors/strict', { enabled }),
    // Per-session grants. Returns an error string for an unknown connector id rather than
    // letting a typo sit inert in the grant list.
    setSessionConnectors: (id: string, connectors: string[], accountConnectors: string[]) =>
      post<OkResponse & { error?: string }>('/api/session/setConnectors', { id, connectors, accountConnectors }),
    restartFresh: (id: string) => post<OkResponse>('/api/session/restartFresh', { id }),
    resumeInto: (id: string, claudeSessionId: string) => post<OkResponse>('/api/session/resumeInto', { id, claudeSessionId }),
    listConversations: async (cwd: string): Promise<ConversationMeta[]> =>
      (await get<ConversationsResponse>(`/api/session/conversations?cwd=${encodeURIComponent(cwd)}`)).conversations,
    readConversation: async (cwd: string, id: string): Promise<ClaudeEvent[]> =>
      (await get<ConversationResponse>(`/api/session/conversation?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(id)}`)).events,
    // /rewind: the current conversation's rewindable user turns; a code-restore preview
    // for one turn; and the rewind itself (conversation fork and/or code restore).
    rewindPoints: async (id: string): Promise<RewindPoint[]> =>
      (await get<RewindPointsResponse>(`/api/session/rewindPoints?id=${encodeURIComponent(id)}`)).points,
    rewindPreview: async (id: string, uuid: string): Promise<RewindPreview | null> =>
      (await get<RewindPreviewResponse>(`/api/session/rewindPreview?id=${encodeURIComponent(id)}&uuid=${encodeURIComponent(uuid)}`)).preview,
    rewind: (id: string, uuid: string, mode: RewindMode, deleteNewer?: boolean) =>
      post<RewindResponse>('/api/session/rewind', { id, uuid, mode, deleteNewer }),
    // Plan-quota usage (session/weekly %), polled — see useUsage. Account-global.
    usage: (): Promise<UsageResponse> => get<UsageResponse>('/api/usage'),
  },
  // Notebook: HTTP for open/create/save/conflict; ops + locks over WS. The doc is
  // server-owned — these send intents; the authoritative state comes back via
  // `on.notebookUpdate`.
  notebook: {
    open: (path: string, sessionId?: string) => post<{ doc?: NotebookDoc; error?: string }>('/api/notebook/open', { path, sessionId }),
    create: (path: string, sessionId?: string) => post<{ doc?: NotebookDoc; error?: string }>('/api/notebook/create', { path, sessionId }),
    close: (notebookId: string, save = false) => post<OkResponse>('/api/notebook/close', { notebookId, save }),
    save: (notebookId: string) => post<OkResponse>('/api/notebook/save', { notebookId }),
    reload: (notebookId: string) => post<OkResponse>('/api/notebook/reload', { notebookId }),
    keepMine: (notebookId: string) => post<OkResponse>('/api/notebook/keepMine', { notebookId }),
    undo: (notebookId: string) => post<OkResponse>('/api/notebook/undo', { notebookId }),
    redo: (notebookId: string) => post<OkResponse>('/api/notebook/redo', { notebookId }),
    clearOutputs: (notebookId: string) => post<OkResponse>('/api/notebook/clearOutputs', { notebookId }),
    kernelSpecs: () => get<KernelSpecsResponse>('/api/notebook/kernelspecs'),
    kernelRestart: (notebookId: string) => post<OkResponse>('/api/notebook/kernel/restart', { notebookId }),
    kernelInterrupt: (notebookId: string) => post<OkResponse>('/api/notebook/kernel/interrupt', { notebookId }),
    kernelShutdown: (notebookId: string) => post<OkResponse>('/api/notebook/kernel/shutdown', { notebookId }),
    kernelSetSpec: (notebookId: string, name: string) => post<OkResponse>('/api/notebook/kernel/setSpec', { notebookId, name }),
    op: (op: NotebookOp) => send({ type: 'notebook:op', op }),
    claim: (notebookId: string, cellId: string, reason: LockReason) =>
      send({ type: 'notebook:claim', notebookId, cellId, reason }),
    release: (notebookId: string, cellId: string) =>
      send({ type: 'notebook:release', notebookId, cellId }),
  },
  // Filesystem browse (read-only) for the file/folder picker. `path` omitted ⇒ home.
  fs: {
    list: (path?: string): Promise<FsListResponse> =>
      get<FsListResponse>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    read: (path: string): Promise<FilePreview> =>
      get<FilePreview>(`/api/fs/read?path=${encodeURIComponent(path)}`),
    write: (path: string, text: string) => post<WriteResult>('/api/fs/write', { path, text }),
    createFile: (path: string) => post<WriteResult>('/api/fs/createFile', { path }),
    // Upload one file into `dir`: stream its bytes as the raw request body (no JSON
    // base64 bloat / body cap). Server names it after `file.name` inside `dir`.
    // Always RESOLVES to a WriteResult — never throws. The failures that matter here
    // (an expired cookie's 401, a proxy's HTML 413/502, the network dropping mid-file)
    // all produce a body `res.json()` rejects on, and a rejection from this one call
    // would abort the caller's whole batch loop with nothing shown to the user.
    upload: async (dir: string, file: File): Promise<WriteResult> => {
      try {
        const res = await fetch(`/api/fs/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
        })
        const body = await res.json().catch(() => null) as { ok?: unknown; error?: unknown } | null
        if (typeof body?.ok === 'boolean') return body as WriteResult
        const why = typeof body?.error === 'string' ? body.error : `upload failed (HTTP ${res.status})`
        return { ok: false, error: why }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'upload failed' }
      }
    },
    mkdir: (path: string) => post<WriteResult>('/api/fs/mkdir', { path }),
    rename: (from: string, to: string) => post<WriteResult>('/api/fs/rename', { from, to }),
    copy: (from: string, to: string) => post<WriteResult>('/api/fs/copy', { from, to }),
    remove: (path: string) => post<WriteResult>('/api/fs/delete', { path }),
    // A same-origin URL the browser can navigate to; the auth cookie rides along.
    downloadUrl: (path: string) => `/api/fs/download?path=${encodeURIComponent(path)}`,
    // Ask the server to watch / stop watching a path for this client.
    //
    // Two things happen here that a bare `send` would get wrong, and both are about the
    // fact that the server's refcount is keyed PER SOCKET:
    //
    // 1. RE-ARM AFTER A RECONNECT. A watch is not a message that can sit in `outbox` — it
    //    was delivered successfully, so nothing retains it — but the socket it was
    //    registered against is gone, and the server released everything that socket held
    //    when it closed. Without re-sending on the next open, live sync silently stops
    //    working after any drop (a server restart, a laptop sleep, a network blip) and the
    //    editor goes back to its pre-live behaviour with nothing on screen to say so. A
    //    feature that fails by becoming invisible is the worst kind to leave unhandled.
    // 2. COLLAPSE TO ONE WATCH PER PATH PER SOCKET. Two editors open on the same file each
    //    call watch/unwatch; sending both would make the re-arm (which can only send one
    //    per path) leave the server's count lower than the unwatches that will follow.
    //    Counting locally and only talking to the server on the 0↔1 edge makes the wire
    //    contract exactly one watch and one unwatch per path, which is trivially idempotent.
    //
    // Both use `sendLive`, so neither is ever QUEUED. A watch is state, not an event: the
    // whole set is re-sent on connect, so an outboxed fs:watch would arrive and then be
    // re-armed a second time — one watch too many against a socket that will only ever send
    // one unwatch, which is a leaked watch that nothing can cancel. An fs:unwatch during an
    // outage is moot for the same reason the re-arm is needed: the server released every
    // watch this page held the moment the old socket closed.
    watch: (path: string) => {
      const n = (watched.get(path) ?? 0) + 1
      watched.set(path, n)
      if (n === 1) sendLive({ type: 'fs:watch', path })
    },
    unwatch: (path: string) => {
      // Never watched → nothing to release. Without this, `(undefined ?? 1) - 1` is 0 and we
      // send a real fs:unwatch for a path this client never held: harmless server-side, but
      // a message that should not exist, and one a future per-socket assertion could trip on.
      const held = watched.get(path)
      if (held === undefined) return
      const n = held - 1
      if (n > 0) { watched.set(path, n); return }
      watched.delete(path)
      sendLive({ type: 'fs:unwatch', path })
    },
  },
  // Permission Control Center: read the merged picture over GET (cwd + agent in the
  // query); add/remove a rule over POST. Per-session mode uses http.setMode.
  perms: {
    get: async (cwd: string, agentId?: string): Promise<EffectivePermissions> =>
      (await get<PermissionsResponse>(`/api/session/permissions?cwd=${encodeURIComponent(cwd)}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ''}`)).permissions,
    addRule: (cwd: string, scope: PermissionScope, action: PermissionAction, value: string) =>
      post<WriteResult>('/api/session/perms/addRule', { cwd, scope, action, value }),
    removeRule: (cwd: string, scope: PermissionScope, action: PermissionAction, value: string) =>
      post<WriteResult>('/api/session/perms/removeRule', { cwd, scope, action, value }),
  },
  // Git panel: reads over GET (cwd + params in the query), mutations over POST.
  // Every call carries the session's cwd — git runs there.
  git: {
    status: (cwd: string): Promise<GitStatus> =>
      get<GitStatus>(`/api/git/status?cwd=${encodeURIComponent(cwd)}`),
    diff: (cwd: string, file: string, staged: boolean, untracked: boolean): Promise<GitDiff> =>
      get<GitDiff>(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}&staged=${staged ? 1 : 0}&untracked=${untracked ? 1 : 0}`),
    log: (cwd: string, limit = 100): Promise<GitLog> =>
      get<GitLog>(`/api/git/log?cwd=${encodeURIComponent(cwd)}&limit=${limit}`),
    show: (cwd: string, hash: string): Promise<GitDiff> =>
      get<GitDiff>(`/api/git/show?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}`),
    branches: (cwd: string): Promise<GitBranches> =>
      get<GitBranches>(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`),
    stage: (cwd: string, file: string) => post<GitResult>('/api/git/stage', { cwd, file }),
    unstage: (cwd: string, file: string) => post<GitResult>('/api/git/unstage', { cwd, file }),
    stageAll: (cwd: string) => post<GitResult>('/api/git/stageAll', { cwd }),
    stageTracked: (cwd: string) => post<GitResult>('/api/git/stageTracked', { cwd }),
    unstageAll: (cwd: string) => post<GitResult>('/api/git/unstageAll', { cwd }),
    commit: (cwd: string, message: string) => post<GitResult>('/api/git/commit', { cwd, message }),
    createBranch: (cwd: string, name: string) => post<GitResult>('/api/git/createBranch', { cwd, name }),
    checkoutBranch: (cwd: string, name: string) => post<GitResult>('/api/git/checkoutBranch', { cwd, name }),
    deleteBranch: (cwd: string, name: string, force: boolean) => post<GitResult>('/api/git/deleteBranch', { cwd, name, force }),
    mergeBranch: (cwd: string, name: string) => post<GitResult>('/api/git/mergeBranch', { cwd, name }),
    fetch: (cwd: string) => post<GitResult>('/api/git/fetch', { cwd }),
    pull: (cwd: string) => post<GitResult>('/api/git/pull', { cwd }),
    push: (cwd: string, setUpstream = false) => post<GitResult>('/api/git/push', { cwd, setUpstream }),
  },
  // Terminal pane: create/destroy over HTTP; input/resize over WS; output/exit via on.*.
  // list/attach/prune drive refresh survival — a reloaded client reattaches to its
  // saved ptys (replaying `attach`'s scrollback) and prunes the orphans.
  pane: {
    create: (cwd: string, cols?: number, rows?: number, sessionId?: string) => post<CreatePaneResponse>('/api/pane/create', { cwd, cols, rows, sessionId } as CreatePaneRequest),
    destroy: (id: string) => post<OkResponse>('/api/pane/destroy', { id }),
    input: (id: string, data: string) => send({ type: 'pane:input', id, data }),
    resize: (id: string, cols: number, rows: number) => send({ type: 'pane:resize', id, cols, rows }),
    list: () => get<ListPanesResponse>('/api/pane/list'),
    attach: (id: string) => post<AttachPaneResponse>('/api/pane/attach', { id }),
    // Claim + sweep: tell the server which panes THIS tab holds. Anything no tab claims
    // is an orphan and dies; another device's terminals are untouched (see ws.ts).
    prune: (keep: string[]) => post<OkResponse>('/api/pane/prune', { client: clientId(), keep }),
  },
}
