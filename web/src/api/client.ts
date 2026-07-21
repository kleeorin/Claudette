import type {
  HealthResponse, WsClientMessage, WsServerMessage,
  ClaudeEvent, PermissionRequest, PermissionDecision, SessionInfo, SessionState,
  CreateSessionRequest, CreateSessionResponse, ListSessionsResponse,
  OkResponse, SetModeRequest, SetModeResult, PermissionMode,
  NotebookDoc, NotebookOp, CellLock, LockReason, KernelStatus,
  CreatePaneRequest, CreatePaneResponse, ListPanesResponse, AttachPaneResponse,
  ConversationMeta, ConversationsResponse, ConversationResponse,
  RewindPoint, RewindMode, RewindPreview, RewindPointsResponse, RewindPreviewResponse, RewindResponse,
  TaskRecord,
  FsListResponse, FilePreview, WriteResult,
  GitStatus, GitDiff, GitLog, GitBranches, GitResult,
  ActivePane, KernelSpecsResponse, SandboxConfig,
  AgentInfo, ListAgentsResponse,
  EffectivePermissions, PermissionScope, PermissionAction, PermissionsResponse,
  UsageResponse,
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

let ws: WebSocket | null = null
let backoff = 500
const outbox: WsClientMessage[] = []

function send(msg: WsClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  else outbox.push(msg)  // flushed on (re)connect
}

function dispatch(msg: WsServerMessage): void {
  switch (msg.type) {
    case 'session:list': lists.emit(msg.sessions); break
    case 'session:snapshot': snapshots.emit(msg.id, msg.events, msg.pending, msg.tasks); break
    case 'session:tasks': tasks.emit(msg.id, msg.tasks); break
    case 'session:event': events.emit(msg.id, msg.event); break
    case 'session:permission': permissions.emit(msg.id, msg.request); break
    case 'session:userTurn': userTurns.emit(msg.id, msg.text, msg.turnId); break
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
    // 'hello' / 'pong' are connection-liveness only.
  }
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const sock = new WebSocket(`${proto}://${location.host}/ws`)
  ws = sock
  sock.onopen = () => {
    backoff = 500
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
  // Streaming subscriptions (namespaced by session id, except list/connected).
  on: {
    event: (fn: Fn<[string, ClaudeEvent]>) => events.on(fn),
    snapshot: (fn: Fn<[string, ClaudeEvent[], PermissionRequest[] | undefined, TaskRecord[] | undefined]>) => snapshots.on(fn),
    // Live subagent-registry updates (session:tasks) — the durable tray-card fallback.
    tasks: (fn: Fn<[string, TaskRecord[]]>) => tasks.on(fn),
    permission: (fn: Fn<[string, PermissionRequest]>) => permissions.on(fn),
    // A user turn mirrored from the server (any device); turnId de-dupes the sender's echo.
    userTurn: (fn: Fn<[string, string, string | undefined]>) => userTurns.on(fn),
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
    paneExit: (fn: Fn<[string]>) => paneExits.on(fn),
    // Claude asked (via open_notebook) to focus a notebook in a given session.
    focusPane: (fn: Fn<[string, string, string]>) => focusPanes.on(fn),
  },
  // Turn I/O over WS.
  session: {
    sendTurn: (id: string, text: string, turnId?: string) => send({ type: 'session:send', id, text, turnId }),
    interrupt: (id: string) => send({ type: 'session:interrupt', id }),
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
    mkdir: (path: string) => post<WriteResult>('/api/fs/mkdir', { path }),
    rename: (from: string, to: string) => post<WriteResult>('/api/fs/rename', { from, to }),
    copy: (from: string, to: string) => post<WriteResult>('/api/fs/copy', { from, to }),
    remove: (path: string) => post<WriteResult>('/api/fs/delete', { path }),
    // A same-origin URL the browser can navigate to; the auth cookie rides along.
    downloadUrl: (path: string) => `/api/fs/download?path=${encodeURIComponent(path)}`,
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
    prune: (keep: string[]) => post<OkResponse>('/api/pane/prune', { keep }),
  },
}
