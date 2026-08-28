import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { WebSocketServer, WebSocket } from 'ws'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import type { WsClientMessage, HealthResponse } from '@claudette/shared'
import { SessionManager } from './claude/sessionManager'
import { sandboxAvailable, gpuDevicePaths } from './claude/sandbox'
import { SessionConfinement } from './claude/sessionConfinement'
import { reclaimStrandedHostConfigs } from './claude/configProtection'
import { WsHub } from './ws/hub'
import { FileWatchRegistry } from './fs/fileWatchRegistry'
import { bridgeSessionEvents, registerSessionRoutes, handleSessionClientMessage, sendSessionSnapshots } from './session/sessionApi'
import { loadState, saveState } from './session/sessionPersistence'
import { NotebookDocManager } from './notebook/notebookDocManager'
import { bridgeNotebookEvents, registerNotebookRoutes, handleNotebookClientMessage } from './notebook/notebookApi'
import { KernelManager } from './jupyter/kernelManager'
import { JupyterProxy } from './jupyter/jupyterProxy'
import { AppControlMcpServer } from './mcp/appControlServer'
import { registerNotebookTools } from './mcp/notebookTools'
import { registerTeamTools } from './mcp/teamTools'
import { TeamMailbox } from './mcp/teamMailbox'
import { ActivePaneRegistry } from './mcp/activePaneRegistry'
import { TurnNotebookRegistry } from './mcp/turnNotebookRegistry'
import { PaneManager } from './pane/paneManager'
import { bridgePaneEvents, registerPaneRoutes, handlePaneClientMessage } from './pane/paneApi'
import { registerFsRoutes } from './fs/fsApi'
import { registerGitRoutes } from './git/gitApi'
import { registerConnectorRoutes } from './connectors/connectorApi'
import { ConnectorProxy } from './connectors/connectorProxy'
import { connectorServers, connectorDenyRules } from './connectors/connectorLaunch'
import { strictMode, defaultGrants } from './connectors/connectorStore'
import { registerUsageRoutes } from './usage/usageApi'
import { resolveAuth, makeAuthHook, isAuthed, safeEqual, authCookie, tokenFilePath } from './auth'

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

// Live file sync: watch what the editors have open and broadcast disk changes. The message
// carries no content — the client re-reads through GET /api/fs/read, which already owns the
// kind/truncation/binary logic, so putting text on the socket would mean a second
// implementation of readPreview and the second one is the one that drifts.
const fileWatches = new FileWatchRegistry((e) =>
  hub.broadcast({ type: e.kind === 'removed' ? 'fs:removed' : 'fs:changed', path: e.path }))
hub.onClose((ws) => fileWatches.release(ws))
const activePanes = new ActivePaneRegistry()
// Per-turn "working notebook" pin: once Claude establishes which notebook a turn is
// about, path-unset tools stick to it even if the user navigates away (see
// TurnNotebookRegistry). Reset per turn via the 'userTurn' event below.
const turnNotebooks = new TurnNotebookRegistry()

// Core services.
const notebooks = new NotebookDocManager()
// The single confinement seam every server-side actor uses to confine work done ON
// BEHALF OF a session — the kernel it runs, the terminal it spawns, the files its MCP
// tools touch (SANDBOX.md). One object, so the fail-closed default (unresolved session →
// deny, never host) is enforced identically everywhere instead of re-derived per site.
// `sessions` is assigned below; the lookup closure only runs later, at use time.
const confinement = new SessionConfinement((id) => sessions.get(id))
// A notebook's kernel runs in its owning session's box: KernelManager resolves the owner
// through `confinement` and spawns a Jupyter server confined to that box, so notebook
// execution can't escape the mounts (and an unowned notebook is refused, not run host).
const kernels = new KernelManager(notebooks, confinement)
const jupyterProxy = new JupyterProxy()
// Point the browser-facing proxy at Jupyter once it lazily starts (first cell run).
kernels.onJupyterStart = (info) => jupyterProxy.setTarget(info)

// AppControl MCP server: notebook tools that mutate the doc directly. Its
// per-session --mcp-config is injected into each Claude launch via the hook below.
const mcp = new AppControlMcpServer()
registerNotebookTools(mcp, notebooks, kernels, activePanes, turnNotebooks, (sessionId, doc) => {
  // Claude opened it in this session → dies with it. The refusal is deliberately ignored
  // here: focusing a notebook executes nothing, so a claim declined for lowering
  // confinement just means it keeps its tighter owner — which is the safe outcome. Writes
  // and runs go through claimOwnership, which does surface the refusal.
  void kernels.setOwner(doc.notebookId, { session: sessionId })
  notebooks.cancelClose(doc.notebookId)         // re-focusing a mid-close notebook keeps it open
  hub.broadcast({ type: 'session:focusPane', id: sessionId, notebookId: doc.notebookId, path: doc.path })
}, (sessionId, path) => {
  // open_file on a plain file: nothing to own or keep alive server-side (no doc, no
  // kernel) — just move the calling session's view onto it.
  hub.broadcast({ type: 'session:focusFile', id: sessionId, path })
}, confinement)
// The connector proxy stands between a granted session and an HTTP connector, so the
// credential never enters a box and a revocation bites the very next call. Its grant
// check reads the LIVE session record (not what the engine launched with) — that is what
// makes ungranting immediate. Constructed before SessionManager because the manager's
// launch hooks below mint URLs from it.
// Annotated (rather than inferred) to break a circular inference: the proxy's grant check
// closes over `sessions`, whose options build URLs from the proxy.
const connectorProxy: ConnectorProxy = new ConnectorProxy(
  (sid: string, cid: string): boolean => sessions.isGranted(sid, cid),
)
const sessions = new SessionManager({
  // Claudette's own app-control server plus whatever catalog connectors this session was
  // granted, in ONE mcpServers object — the CLI takes a single --mcp-config.
  mcpConfig: (sid, granted) => JSON.stringify({
    mcpServers: { ...mcp.serversFor(sid), ...connectorServers(sid, granted, connectorProxy) },
  }),
  connectorDeny: (s) => connectorDenyRules(s),
  strictMcp: () => strictMode(),
  releaseConnectors: (sid) => connectorProxy.release(sid),
  defaultGrants,
  activePane: (sid) => activePanes.get(sid) ?? null,
})
// Team messaging: the mailbox injects a session-to-session message as a user turn in
// the recipient, holding it while that session is mid-turn. It's wired from OUT HERE
// rather than inside SessionManager so neither module imports the other — the manager
// emits 'stateChange'/'userTurn', the mailbox listens (see the handlers below).
const teamMailbox = new TeamMailbox({
  info: (id) => sessions.get(id),
  // Await the real answer rather than assuming: sendUserTurn takes a git snapshot before
  // writing, and a relaunch landing inside that await would swallow the turn silently.
  deliver: (id, text) => sessions.sendUserTurn(id, text, undefined, 'team'),
})
const team = registerTeamTools(mcp, sessions, teamMailbox)
// Terminal panes are confined to their owning session's box (SANDBOX.md
// "Terminal-pane escape") — through the same `confinement` seam as kernels/notebook tools.
const panes = new PaneManager(confinement)
// Closing a session kills the kernels of notebooks opened in it, and any terminal
// ptys it owns (server-side, so it happens even with no browser connected).
sessions.on('destroyed', (id: string) => { kernels.shutdownForSession(id); panes.destroyForSession(id) })

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
sessions.on('exit', (id: string) => {
  activePanes.release(id); turnNotebooks.release(id); mcp.release(id)
  // The exit-interview marks are per-CONVERSATION, and an engine death makes it unknowable
  // whether the teammate ever read the directive — so drop them and let the coordinator
  // re-ask. Failing safe matters here: a stale mark means the teammate's next ordinary
  // status report gets filed as the role's permanent handover and destroys it.
  team.release(id)
  // Queued MAIL is different: a startup fast-fail keeps the session in the map on purpose
  // so the operator can hit Retry, and its messages are still worth delivering when it
  // comes back. Only drop those when the session is really gone.
  if (!sessions.get(id)) teamMailbox.release(id)
})
// A conversation swap (the human's /clear, or resuming into another conversation) never
// emits 'exit' — the `replacing` branch relaunches instead. Without this, a teammate that
// had been asked for its handover kept that mark across a clear, and the fresh context,
// which had never been asked anything, was destroyed by its next ordinary report.
sessions.on('restarted', (id: string) => team.release(id))
// New user turn → drop the per-turn notebook pin so the turn's first tool call
// re-binds to whatever the user is viewing now (see TurnNotebookRegistry). A turn the
// mailbox injected is a real turn for that purpose, so the pin resets either way — but
// only a turn the HUMAN typed refills the team's message budget, or every team message
// would top up the very allowance meant to bound the team's chatter.
sessions.on('userTurn', (id: string, _text: string, _turnId: string | undefined, origin?: 'user' | 'team') => {
  turnNotebooks.clear(id)
  if (origin !== 'team') teamMailbox.onHumanTurn(id)
})
// Members we have already told their coordinator about, so a turn that hits several
// permission prompts in a row notifies ONCE rather than on every waiting→running→waiting
// flap. Cleared on `idle` — the turn ending is what makes the next block a new episode
// worth reporting, and it is also the point at which the teammate is demonstrably unstuck.
const notifiedBlocked = new Set<string>()

// A session just came free → hand it anything its teammates sent while it was busy.
// A session that went to `waiting` is a different case entirely: it is blocked on a
// permission prompt (claudeEngine sets that state nowhere else) and will NOT drain its
// queue, so its coordinator has to be told or the team deadlocks in silence — the
// coordinator ends its turn believing the teammate is merely busy.
//
// Safe to send from here: mailbox.send() only queues + arms a setTimeout, so it cannot
// reenter SessionManager on this stack. And it cannot loop — only MEMBERS notify, always
// upward, and a coordinator has no parentId to notify in turn.
sessions.on('stateChange', (id: string, state: string) => {
  if (state === 'idle') { notifiedBlocked.delete(id); teamMailbox.onIdle(id); return }
  if (state !== 'waiting' || notifiedBlocked.has(id)) return
  const me = sessions.get(id)
  if (!me?.parentId) return                     // not a member (or a promoted orphan)
  const coordinator = sessions.get(me.parentId)
  if (!coordinator) return
  notifiedBlocked.add(id)
  // Rides the ordinary mailbox path, budget included: this is information the coordinator
  // needs, not privileged traffic, and giving it a bypass would put a second unaccounted
  // writer into queue/budget state that is carefully reasoned about. Once-per-turn per
  // member keeps the cost at most one message per teammate against a budget of 40.
  teamMailbox.send(coordinator.id, {
    from: me.name, role: me.agentId ?? 'general', sessionId: me.id, kind: 'report',
    body: `[automatic notice — not written by ${me.name}] ${me.name} is BLOCKED on a permission `
      + 'prompt and cannot act, or receive anything you send, until the operator approves it in '
      + `that session. Messages you send to ${me.name} will queue but will not be delivered. If `
      + 'this is holding up the work, tell the user which session needs them.',
  })
})

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
  // Stop the mailbox before the engines die, so its drain/retry timers can't fire during
  // the 800ms grace and re-arm against sessions that are on their way out.
  teamMailbox.dispose()
  sessions.shutdown()
  kernels.destroy()   // kill the Jupyter server (and with it every notebook kernel)
  panes.destroyAll()  // kill every terminal pty (don't rely on SIGHUP-on-fd-close)
  setTimeout(() => { sessions.killHard(); process.exit(0) }, 800)
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, shutdown)

app.get('/api/health', async (req): Promise<HealthResponse> => ({
  ok: true,
  version: VERSION,
  ts: Date.now(),
  sandboxAvailable: sandboxAvailable(),
  // /api/health is in the auth hook's OPEN set, so everything here is disclosed
  // unauthenticated. The GPU node list is host hardware inventory and has no business
  // being readable pre-auth (and on a non-loopback bind, by anyone who can reach the
  // port), so it is served only to an authenticated caller. The UI always is —
  // SessionsProvider, the only consumer, mounts inside AuthGate.
  //
  // homeDir gets the same treatment, for the same reason: it discloses the OS username
  // and the home path to anyone who can reach the port, which is exactly what you want
  // before guessing a `?token=` or naming a path under ~/.claude. `ok`/`version`/`ts` are
  // what an unauthenticated liveness probe legitimately needs; host facts are not.
  ...(isAuthed(req.raw, auth) ? { gpuDevices: gpuDevicePaths(), homeDir: homedir() } : {}),
}))

// Token bootstrap: open the app once as `…/api/auth?token=<secret>` (or the SPA
// forwards a `?token=` from its own URL here) to set the httpOnly auth cookie.
// After this, the cookie rides every request + the WS upgrade automatically.
app.get<{ Querystring: { token?: string } }>('/api/auth', async (req, reply) => {
  if (!auth.required || !auth.token) return { ok: true, required: false }
  const presented = req.query.token
  // safeEqual, not !==: this is the only unauthenticated, unrate-limited endpoint whose
  // whole job is checking a token, i.e. the one place a timing oracle is actually
  // reachable. isAuthed has always used the constant-time compare; this didn't.
  if (!presented || !safeEqual(presented, auth.token)) return reply.code(401).send({ ok: false, error: 'invalid token' })
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
registerConnectorRoutes(app, sessions)
registerUsageRoutes(app)

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
    // Live file sync. Keyed by the SOCKET so a closed tab releases exactly what it held;
    // see fileWatchRegistry's cleanup note for why the socket is both the refcount key and
    // the release trigger.
    if (msg.type === 'fs:watch') { fileWatches.watch(msg.path, ws); return }
    if (msg.type === 'fs:unwatch') { fileWatches.unwatch(msg.path, ws); return }
    if (handleNotebookClientMessage(notebooks, kernels, msg)) return
    if (handlePaneClientMessage(panes, msg)) return
    handleSessionClientMessage(sessions, msg, hub)
  })
})

async function start(): Promise<void> {
  // Salvage any OAuth token a previous run stranded in a host-mode config mirror, before
  // restore() below can relaunch sessions (and rebuild mirrors) on top of it. A hard kill
  // used to leave a refreshed token orphaned there forever, so every other reader kept the
  // expired one and Claude asked to log in again (configProtection.ts).
  reclaimStrandedHostConfigs()
  // Start the MCP server first so `configFor` has a real port before any session
  // launches with its --mcp-config.
  const mcpPort = await mcp.start()
  app.log.info(`AppControl MCP server on http://127.0.0.1:${mcpPort}`)
  // Same ordering requirement as the MCP server: a restored session launches with its
  // connector URLs, so the proxy needs a real port before restore() runs.
  const proxyPort = await connectorProxy.start()
  app.log.info(`Connector proxy on http://127.0.0.1:${proxyPort}${strictMode() ? ' (strict MCP mode ON)' : ''}`)
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
    app.log.info(`Access token REQUIRED (${maskToken(auth.token!)}). Authenticate a device once via <origin>/?token=…` +
      ` — full token: $CLAUDETTE_TOKEN or ${tokenFilePath()}`)
  } else {
    app.log.info('Access token DISABLED (CLAUDETTE_NO_AUTH=1, loopback-only). Anything that can reach this port — including sandboxed sessions — has full control.')
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
