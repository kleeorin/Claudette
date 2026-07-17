import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { WebSocketServer, WebSocket } from 'ws'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import type { WsClientMessage, HealthResponse } from '@claudette/shared'
import { SessionManager } from './claude/sessionManager'
import { sandboxAvailable } from './claude/sandbox'
import { WsHub } from './ws/hub'
import { bridgeSessionEvents, registerSessionRoutes, handleSessionClientMessage, sendSessionSnapshots } from './session/sessionApi'
import { loadState, saveState } from './session/sessionPersistence'
import { NotebookDocManager } from './notebook/notebookDocManager'
import { bridgeNotebookEvents, registerNotebookRoutes, handleNotebookClientMessage } from './notebook/notebookApi'
import { JupyterManager } from './jupyter/jupyterManager'
import { KernelManager } from './jupyter/kernelManager'
import { JupyterProxy } from './jupyter/jupyterProxy'
import { AppControlMcpServer } from './mcp/appControlServer'
import { registerNotebookTools } from './mcp/notebookTools'
import { ActivePaneRegistry } from './mcp/activePaneRegistry'
import { TurnNotebookRegistry } from './mcp/turnNotebookRegistry'
import { PaneManager } from './pane/paneManager'
import { bridgePaneEvents, registerPaneRoutes, handlePaneClientMessage } from './pane/paneApi'
import { registerFsRoutes } from './fs/fsApi'
import { registerGitRoutes } from './git/gitApi'
import { resolveAuth, makeAuthHook, isAuthed, authCookie } from './auth'

// Claudette app server. Single-user by design (PLAN §1). Binds loopback by
// default; when HOST exposes it beyond loopback, an access token is required
// (see auth.ts). HTTP (Fastify) for request/response lifecycle; a path-routed
// `ws` server for streaming. Phase 1 grows this into the notebook/pty/MCP/
// Jupyter-proxy surface.

const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 4319)
const VERSION = '0.1.0'

// Fail-closed: if HOST is non-loopback and no CLAUDETTE_TOKEN is set, this exits
// before we ever listen (see resolveAuth).
const auth = resolveAuth(HOST, process.env.CLAUDETTE_TOKEN)

const app = Fastify({ logger: true })

// Enforce the token on every route except the open ones (health + /api/auth).
app.addHook('preHandler', makeAuthHook(auth))

// The WS hub + the per-session active-pane registry are created first: the MCP
// notebook tools (registered below) read the registry to target the notebook the
// user is viewing, and `open_notebook` broadcasts a focus message through the hub.
const hub = new WsHub()
const activePanes = new ActivePaneRegistry()
// Per-turn "working notebook" pin: once Claude establishes which notebook a turn is
// about, path-unset tools stick to it even if the user navigates away (see
// TurnNotebookRegistry). Reset per turn via the 'userTurn' event below.
const turnNotebooks = new TurnNotebookRegistry()

// Core services.
const notebooks = new NotebookDocManager()
const jupyter = new JupyterManager()
const kernels = new KernelManager(notebooks, jupyter)
const jupyterProxy = new JupyterProxy()
// Point the browser-facing proxy at Jupyter once it lazily starts (first cell run).
kernels.onJupyterStart = (info) => jupyterProxy.setTarget(info)

// AppControl MCP server: notebook tools that mutate the doc directly. Its
// per-session --mcp-config is injected into each Claude launch via the hook below.
const mcp = new AppControlMcpServer()
registerNotebookTools(mcp, notebooks, kernels, activePanes, turnNotebooks, (sessionId, doc) => {
  kernels.setOwner(doc.notebookId, sessionId)   // Claude opened it in this session → dies with it
  notebooks.cancelClose(doc.notebookId)         // re-focusing a mid-close notebook keeps it open
  hub.broadcast({ type: 'session:focusPane', id: sessionId, notebookId: doc.notebookId, path: doc.path })
})
const sessions = new SessionManager({ mcpConfig: (sid) => mcp.configFor(sid) })
// Closing a session kills the kernels of notebooks opened in it.
sessions.on('destroyed', (id: string) => kernels.shutdownForSession(id))

const panes = new PaneManager()
bridgeSessionEvents(sessions, hub)
bridgeNotebookEvents(notebooks, kernels, hub)
bridgePaneEvents(panes, hub)

// Session persistence (P1.19): debounce-save the set whenever it changes so a
// server restart restores it (each --resume'd into its saved conversation).
let shuttingDown = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
function persistSessions(): void {
  // Never persist while shutting down: shutdown() kills every engine, whose exit
  // handlers cleanup() the sessions and emit 'changed' — saving that empty set
  // would wipe the on-disk state we need to restore next boot.
  if (shuttingDown) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void saveState(sessions.saved()) }, 400)
}
sessions.on('changed', persistSessions)   // create/destroy/restartFresh/resumeInto/setMode
sessions.on('ready', persistSessions)     // claudeSessionId finalized
// Push a fresh session list to every tab whenever the set or a session's config
// changes, so new sessions and edited fields (e.g. sandbox status) reconcile live
// across tabs instead of only on reconnect.
sessions.on('changed', () => hub.broadcast({ type: 'session:list', sessions: sessions.list() }))
// When a session goes away, drop its active-pane record and its MCP url tokens
// (the latter was never released before — a small unbounded-map leak).
sessions.on('exit', (id: string) => { activePanes.release(id); turnNotebooks.release(id); mcp.release(id) })
// New user turn → drop the per-turn notebook pin so the turn's first tool call
// re-binds to whatever the user is viewing now (see TurnNotebookRegistry).
sessions.on('userTurn', (id: string) => turnNotebooks.clear(id))

// Reap all Claude engines when the server goes down so bwrap/claude children don't
// orphan and linger. Covers Ctrl-C (SIGINT), `kill`/`tsx watch` restarts (SIGTERM),
// and terminal close (SIGHUP). SIGTERM each engine's process group, then SIGKILL any
// survivor just before exit — no reliance on --die-with-parent.
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  // Flush the live set NOW, then block further saves: shutdown() kills every engine,
  // whose exit handlers cleanup() the sessions and emit 'changed' — persisting that
  // empty set would clobber the state we restore next boot. Snapshot before killing.
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  void saveState(sessions.saved())
  sessions.shutdown()
  kernels.destroy()   // kill the Jupyter server (and with it every notebook kernel)
  setTimeout(() => { sessions.killHard(); process.exit(0) }, 800)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, shutdown)

app.get('/api/health', async (): Promise<HealthResponse> => ({
  ok: true,
  version: VERSION,
  ts: Date.now(),
  sandboxAvailable: sandboxAvailable(),
  homeDir: homedir(),
}))

// Token bootstrap: open the app once as `…/api/auth?token=<secret>` (or the SPA
// forwards a `?token=` from its own URL here) to set the httpOnly auth cookie.
// After this, the cookie rides every request + the WS upgrade automatically.
app.get<{ Querystring: { token?: string } }>('/api/auth', async (req, reply) => {
  if (!auth.required || !auth.token) return { ok: true, required: false }
  const presented = req.query.token
  if (!presented || presented !== auth.token) return reply.code(401).send({ ok: false, error: 'invalid token' })
  // Add Secure when the request came in over https (Tailscale serve / Cloudflare).
  const https = (req.headers['x-forwarded-proto'] === 'https') || (req.raw.socket as { encrypted?: boolean }).encrypted === true
  reply.header('set-cookie', authCookie(auth.token) + (https ? '; Secure' : ''))
  return { ok: true, required: true }
})

registerSessionRoutes(app, sessions)
registerNotebookRoutes(app, notebooks, kernels)
registerPaneRoutes(app, panes)
registerFsRoutes(app)
registerGitRoutes(app)

// Reverse-proxy the browser's Jupyter REST/asset requests through our origin, with
// the token injected server-side (auth-gated in makeAuthHook). hijack() hands the
// raw socket to the proxy so Fastify doesn't touch the body.
app.all('/jupyter/*', (req, reply) => {
  reply.hijack()
  jupyterProxy.handleHttp(req.raw, reply.raw)
})

// Single-origin serving of the built SPA (production / `launch.sh --build`): one
// HTTPS origin the phone/PWA + Tailscale-serve can front. In plain dev this dir
// doesn't exist — Vite serves the SPA and proxies /api + /ws here instead — so
// this whole block is skipped. Static assets are unauthenticated (they hold no
// secrets; the API + WS are what's gated), so the app shell can load and render
// the token screen before the cookie is set.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
if (existsSync(webDist)) {
  // wildcard (default) resolves each request against `root` from disk — so a
  // rebuilt bundle (new hashed filenames) is served without a server restart.
  // /api + /ws are explicit routes and take precedence over the static catch-all.
  app.register(fastifyStatic, { root: webDist })
  // SPA fallback: a GET for a route that isn't a real file or an /api|/ws path
  // returns index.html so client-side routing works on deep links / refresh.
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? ''
    if (req.method !== 'GET' || url.startsWith('/api') || url.startsWith('/ws')) {
      reply.code(404).send({ error: 'not found' })
      return
    }
    reply.sendFile('index.html')
  })
  app.log.info(`Serving built web from ${webDist}`)
}

// WebSocket in noServer mode so we can route by path on the raw HTTP server
// (leaves room for a /jupyter proxy upgrade alongside the app /ws in Phase 1).
const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (ws: WebSocket) => {
  hub.add(ws)
  // Connect-time snapshot so a fresh tab renders the current session list, then a
  // per-session catch-up (transcript-so-far + any pending permission) so a device
  // joining an in-progress session isn't left with a blank stream / stuck prompt.
  hub.send(ws, { type: 'hello', version: VERSION })
  hub.send(ws, { type: 'session:list', sessions: sessions.list() })
  sendSessionSnapshots(sessions, hub, ws)
  ws.on('message', (data) => {
    let msg: WsClientMessage
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (msg.type === 'ping') {
      hub.send(ws, { type: 'pong', ts: Date.now() })
      return
    }
    if (msg.type === 'session:activePane') {
      activePanes.set(msg.id, msg.pane)
      return
    }
    if (handleNotebookClientMessage(notebooks, kernels, msg)) return
    if (handlePaneClientMessage(panes, msg)) return
    handleSessionClientMessage(sessions, msg)
  })
})

async function start(): Promise<void> {
  // Start the MCP server first so `configFor` has a real port before any session
  // launches with its --mcp-config.
  const mcpPort = await mcp.start()
  app.log.info(`AppControl MCP server on http://127.0.0.1:${mcpPort}`)
  // Restore persisted sessions (each re-launched with --resume) before serving.
  const restored = sessions.restore(await loadState())
  if (restored.length) app.log.info(`Restored ${restored.length} session(s) from disk`)
  await app.listen({ host: HOST, port: PORT })
  app.server.on('upgrade', (req, socket, head) => {
    // Both upgrade paths carry the same-origin cookie; reject unauthenticated
    // sockets before completing the handshake.
    if (!isAuthed(req, auth)) { socket.destroy(); return }
    if (req.url && req.url.startsWith('/ws')) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    } else if (req.url && req.url.startsWith('/jupyter')) {
      // Bridge the browser's kernel/terminal WS to Jupyter (token injected).
      jupyterProxy.handleUpgrade(req, socket, head)
    } else {
      socket.destroy()
    }
  })
  app.log.info(`Claudette server ready on http://${HOST}:${PORT}`)
  if (auth.required) {
    app.log.info(`Access token REQUIRED. Authenticate a device once via: <origin>/?token=${maskToken(auth.token!)}`)
  } else {
    app.log.info('Access token: not set (loopback-only). Set CLAUDETTE_TOKEN + a non-loopback HOST to expose securely.')
  }
}

// Log a masked hint (don't dump the full secret into logs that may be shared).
function maskToken(t: string): string {
  return t.length <= 8 ? '••••' : `${t.slice(0, 4)}…${t.slice(-2)}`
}

start().catch((err) => {
  app.log.error(err)
  process.exit(1)
})
