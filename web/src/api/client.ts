import type {
  HealthResponse, WsClientMessage, WsServerMessage,
  ClaudeEvent, PermissionRequest, PermissionDecision, SessionInfo, SessionState,
  CreateSessionRequest, CreateSessionResponse, ListSessionsResponse,
  OkResponse, SetModeRequest, SetModeResult, PermissionMode,
  NotebookDoc, NotebookOp, CellLock, LockReason, KernelStatus,
  CreatePaneRequest, CreatePaneResponse,
  ConversationMeta, ConversationsResponse, ConversationResponse,
  FsListResponse, FilePreview, WriteResult,
  GitStatus, GitDiff, GitLog, GitBranches, GitResult,
  ActivePane,
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

export async function getHealth(): Promise<HealthResponse> {
  return (await fetch('/api/health')).json()
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
const permissions = channel<[string, PermissionRequest]>()
const states = channel<[string, SessionState]>()
const readies = channel<[string, string]>()
const exits = channel<[string, boolean, string]>()
const lists = channel<[SessionInfo[]]>()
const connected = channel<[boolean]>()
const nbUpdates = channel<[NotebookDoc]>()
const nbFocuses = channel<[string, string, boolean]>()   // [notebookId, cellId, reveal]
const nbLocks = channel<[string, CellLock[]]>()
const nbKernels = channel<[string, KernelStatus]>()
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
    case 'session:event': events.emit(msg.id, msg.event); break
    case 'session:permission': permissions.emit(msg.id, msg.request); break
    case 'session:state': states.emit(msg.id, msg.state); break
    case 'session:ready': readies.emit(msg.id, msg.claudeSessionId); break
    case 'session:exit': exits.emit(msg.id, msg.failed, msg.error); break
    case 'notebook:update': nbUpdates.emit(msg.doc); break
    case 'notebook:focus': nbFocuses.emit(msg.notebookId, msg.cellId, msg.reveal); break
    case 'notebook:locks': nbLocks.emit(msg.notebookId, msg.locks); break
    case 'notebook:kernel': nbKernels.emit(msg.notebookId, msg.status); break
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
    permission: (fn: Fn<[string, PermissionRequest]>) => permissions.on(fn),
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
    paneOutput: (fn: Fn<[string, string]>) => paneOutputs.on(fn),
    paneExit: (fn: Fn<[string]>) => paneExits.on(fn),
    // Claude asked (via open_notebook) to focus a notebook in a given session.
    focusPane: (fn: Fn<[string, string, string]>) => focusPanes.on(fn),
  },
  // Turn I/O over WS.
  session: {
    sendTurn: (id: string, text: string) => send({ type: 'session:send', id, text }),
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
      (await (await fetch('/api/session/list')).json() as ListSessionsResponse).sessions,
    destroySession: (id: string) => post<OkResponse>('/api/session/destroy', { id }),
    relaunch: (id: string) => post<OkResponse>('/api/session/relaunch', { id }),
    setMode: (id: string, mode: PermissionMode) => post<SetModeResult>('/api/session/setMode', { id, mode } as SetModeRequest),
    restartFresh: (id: string) => post<OkResponse>('/api/session/restartFresh', { id }),
    resumeInto: (id: string, claudeSessionId: string) => post<OkResponse>('/api/session/resumeInto', { id, claudeSessionId }),
    listConversations: async (cwd: string): Promise<ConversationMeta[]> =>
      (await (await fetch(`/api/session/conversations?cwd=${encodeURIComponent(cwd)}`)).json() as ConversationsResponse).conversations,
    readConversation: async (cwd: string, id: string): Promise<ClaudeEvent[]> =>
      (await (await fetch(`/api/session/conversation?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(id)}`)).json() as ConversationResponse).events,
  },
  // Notebook: HTTP for open/create/save/conflict; ops + locks over WS. The doc is
  // server-owned — these send intents; the authoritative state comes back via
  // `on.notebookUpdate`.
  notebook: {
    open: (path: string) => post<{ doc?: NotebookDoc; error?: string }>('/api/notebook/open', { path }),
    create: (path: string) => post<{ doc?: NotebookDoc; error?: string }>('/api/notebook/create', { path }),
    save: (notebookId: string) => post<OkResponse>('/api/notebook/save', { notebookId }),
    reload: (notebookId: string) => post<OkResponse>('/api/notebook/reload', { notebookId }),
    keepMine: (notebookId: string) => post<OkResponse>('/api/notebook/keepMine', { notebookId }),
    op: (op: NotebookOp) => send({ type: 'notebook:op', op }),
    claim: (notebookId: string, cellId: string, reason: LockReason) =>
      send({ type: 'notebook:claim', notebookId, cellId, reason }),
    release: (notebookId: string, cellId: string) =>
      send({ type: 'notebook:release', notebookId, cellId }),
  },
  // Filesystem browse (read-only) for the file/folder picker. `path` omitted ⇒ home.
  fs: {
    list: async (path?: string): Promise<FsListResponse> =>
      (await fetch(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`)).json(),
    read: async (path: string): Promise<FilePreview> =>
      (await fetch(`/api/fs/read?path=${encodeURIComponent(path)}`)).json(),
    write: (path: string, text: string) => post<WriteResult>('/api/fs/write', { path, text }),
    createFile: (path: string) => post<WriteResult>('/api/fs/createFile', { path }),
    mkdir: (path: string) => post<WriteResult>('/api/fs/mkdir', { path }),
  },
  // Git panel: reads over GET (cwd + params in the query), mutations over POST.
  // Every call carries the session's cwd — git runs there.
  git: {
    status: async (cwd: string): Promise<GitStatus> =>
      (await fetch(`/api/git/status?cwd=${encodeURIComponent(cwd)}`)).json(),
    diff: async (cwd: string, file: string, staged: boolean, untracked: boolean): Promise<GitDiff> =>
      (await fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}&staged=${staged ? 1 : 0}&untracked=${untracked ? 1 : 0}`)).json(),
    log: async (cwd: string, limit = 100): Promise<GitLog> =>
      (await fetch(`/api/git/log?cwd=${encodeURIComponent(cwd)}&limit=${limit}`)).json(),
    show: async (cwd: string, hash: string): Promise<GitDiff> =>
      (await fetch(`/api/git/show?cwd=${encodeURIComponent(cwd)}&hash=${encodeURIComponent(hash)}`)).json(),
    branches: async (cwd: string): Promise<GitBranches> =>
      (await fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`)).json(),
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
  },
  // Terminal pane: create/destroy over HTTP; input/resize over WS; output/exit via on.*.
  pane: {
    create: (cwd: string) => post<CreatePaneResponse>('/api/pane/create', { cwd } as CreatePaneRequest),
    destroy: (id: string) => post<OkResponse>('/api/pane/destroy', { id }),
    input: (id: string, data: string) => send({ type: 'pane:input', id, data }),
    resize: (id: string, cols: number, rows: number) => send({ type: 'pane:resize', id, cols, rows }),
  },
}
