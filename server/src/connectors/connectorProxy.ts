import http from 'http'
import https from 'https'
import { randomUUID } from 'crypto'
import type { AddressInfo } from 'net'
import { URL } from 'url'
import { errMessage } from '../util/errMessage'
import { getConnector, setHealth, setTools } from './connectorStore'
import type { ConnectorTool } from '@claudette/shared'

// The loopback MCP proxy that stands between a granted session and an HTTP connector.
//
// WHY A PROXY AND NOT A DIRECT ENTRY. The obvious implementation writes the connector's
// real URL and Authorization header straight into the session's --mcp-config. That hands
// every granted session the CREDENTIAL — readable from inside the box (the config is on
// its argv), reusable outside Claudette, and impossible to revoke without a relaunch.
// Proxying keeps the secret server-side and makes the grant a live check rather than a
// launch-time snapshot:
//
//   • REVOCATION IS IMMEDIATE. Every request re-asks `isGranted`. Ungranting a connector
//     from a running session stops the very next tool call, with no relaunch. (Granting
//     still needs one: the engine reads its server list once at spawn and ignores
//     notifications/tools/list_changed — hence SessionInfo.connectorsPending.)
//   • THE TOKEN IS THE ATTRIBUTION. One random URL token per (session, connector), minted
//     at launch, exactly as AppControlMcpServer does it. A token identifies who is calling
//     and what they're calling, so a session cannot reach a connector it wasn't given even
//     though every box shares the host network namespace (no --unshare-net).
//   • WE SEE THE TRAFFIC. `tools/list` replies flow through here, which is where tool
//     classification comes from — see learnTools. That is the only probe in this build.
//
// stdio connectors are NOT proxied: their definitions are re-emitted verbatim so the
// ENGINE spawns them, which is what puts them inside the session's bwrap namespace. A
// child of this server would run on the host, outside every box (see connectors.ts).

export type GrantCheck = (sessionId: string, connectorId: string) => boolean

interface Route { sessionId: string; connectorId: string }

// Hop-by-hop and identity-bearing headers we must not forward upstream. Host is
// recomputed by the agent; the client's own auth is meaningless to the target and
// forwarding it would leak Claudette's loopback token to a third party.
const STRIP_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authorization', 'authorization', 'cookie', 'content-length',
])
const STRIP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length'])

// How long we wait for an upstream to respond before giving up on it.
const UPSTREAM_TIMEOUT_MS = 120_000
// How much of a JSON reply we are willing to hold in memory to classify it. Well past any
// honest tools/list; a reply larger than this is not classified rather than buffered.
const MAX_CLASSIFY_BYTES = 2 * 1024 * 1024
// How much of the request we tee to identify the JSON-RPC method. A tools/list call is a
// few hundred bytes; this is generous.
const REQ_SNIFF_BYTES = 64 * 1024
const TOOLS_LIST_RE = /"method"\s*:\s*"tools\/list"/

export class ConnectorProxy {
  private server: http.Server | null = null
  private port = 0
  private routes = new Map<string, Route>()

  constructor(private isGranted: GrantCheck) {}

  get portNumber(): number { return this.port }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.onRequest(req, res))
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port
        this.server = server
        resolve(this.port)
      })
    })
  }

  stop(): void { this.server?.close(); this.server = null }

  // Mint a proxy URL for one (session, connector). Called at launch while composing the
  // session's --mcp-config; the caller decides which ids are granted.
  urlFor(sessionId: string, connectorId: string): string {
    const token = randomUUID()
    this.routes.set(token, { sessionId, connectorId })
    return `http://127.0.0.1:${this.port}/c/${token}`
  }

  // Drop every token belonging to a session. Called on destroy and before each relaunch,
  // so a killed session's tokens die with it rather than accumulating for the process
  // lifetime (each launch mints fresh ones).
  release(sessionId: string): void {
    for (const [tok, r] of this.routes) if (r.sessionId === sessionId) this.routes.delete(tok)
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const m = /^\/c\/([^/?]+)/.exec(req.url || '')
    const route = m ? this.routes.get(m[1]) : undefined
    // An unknown token is indistinguishable from a revoked one on purpose: both mean
    // "this caller has no business here", and saying which would confirm a token guess.
    if (!route) return this.deny(res, 404, 'unknown connector endpoint')
    if (!this.isGranted(route.sessionId, route.connectorId)) {
      return this.deny(res, 403, `connector "${route.connectorId}" is not granted to this session`)
    }
    const def = getConnector(route.connectorId)
    if (!def || def.transport !== 'http' || !def.url) {
      return this.deny(res, 502, `connector "${route.connectorId}" is not a dialable HTTP connector`)
    }

    let target: URL
    try { target = new URL(def.url) } catch { return this.deny(res, 502, 'connector URL is unparseable') }

    // Forward the client's own MCP headers (content-type, accept, mcp-session-id,
    // mcp-protocol-version …) minus the hop-by-hop set, then layer the connector's
    // configured headers on top — those carry the credential and must win.
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (STRIP_REQUEST.has(k.toLowerCase()) || v === undefined) continue
      headers[k] = Array.isArray(v) ? v.join(', ') : v
    }
    for (const [k, v] of Object.entries(def.headers ?? {})) headers[k] = v

    // Building the upstream request can THROW — most sharply on a header value carrying a
    // CRLF or other illegal character, which Node rejects with ERR_INVALID_CHAR. Uncaught
    // inside an http handler that takes down the WHOLE Claudette server, so one badly
    // pasted header in one connector definition was a total denial of service. Contain it
    // to this one request.
    // Set from the request body below, before any response arrives (the upstream cannot
    // answer before it has been sent the call).
    let wantsToolList = false
    const agent = target.protocol === 'https:' ? https : http
    let upstream: http.ClientRequest
    try {
      upstream = agent.request(
        { protocol: target.protocol, hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers },
        (up) => {
        const status = up.statusCode ?? 502
        // 401/403 is the signature of an expired or missing credential, which is a
        // different operator action (re-auth) from "the server is down".
        if (status === 401 || status === 403) setHealth(def.id, 'needs-auth', `upstream returned ${status}`)
        else if (status >= 500) setHealth(def.id, 'error', `upstream returned ${status}`)
        else setHealth(def.id, 'connected')

        const out: Record<string, string | string[]> = {}
        for (const [k, v] of Object.entries(up.headers)) {
          if (STRIP_RESPONSE.has(k.toLowerCase()) || v === undefined) continue
          out[k] = v
        }
        // Streamable-HTTP MCP servers built on the official SDK answer `text/event-stream`
        // unless they are configured with enableJsonResponse, and the CLI's Accept offers
        // both — so gating capture on application/json alone meant the probe never ran
        // against the SDK default. `tools` then stayed undefined forever: the catalog
        // showed "tools not probed yet" permanently, and a read-only role was denied the
        // whole server for good. Fail-closed, but never resolving.
        const contentType = (up.headers['content-type'] ?? '').toString()
        const classifiable = contentType.includes('application/json') || contentType.includes('text/event-stream')
        // STREAM the reply through while capturing only a BOUNDED prefix for
        // classification. The previous version accumulated the entire JSON body into one
        // string with no cap: a 126 MB reply cost ~110 MB of RSS for a single request, and
        // past ~512 MB V8 throws `Invalid string length` inside this very handler — which
        // is not inside any try/catch, i.e. it would take the server down. Streaming also
        // means an SSE reply no longer needs a separate path.
        res.writeHead(status, out)
        let captured = ''
        // pipe(), not a hand-rolled `up.on('data', c => res.write(c))`: that ignored
        // res.write's return value and never paused the source, so a fast upstream feeding
        // a slow consumer buffered the whole reply in res's internal write queue. The
        // MAX_CLASSIFY_BYTES cap bounds `captured`, never the pass-through — a 126 MB reply
        // still cost ~126 MB of RSS if the reader stalled. pipe applies backpressure and
        // ends `res` for us; the data listener alongside it still sees every chunk.
        up.pipe(res)
        up.on('data', (c: Buffer) => {
          if (classifiable && wantsToolList && captured.length < MAX_CLASSIFY_BYTES) captured += c
        })
        up.on('end', () => { if (captured) this.learnTools(def.id, captured) })
        // A server-initiated abort emits neither 'end' nor 'error' on the request, so
        // without this the client's call hung forever and the socket pair stayed pinned.
        up.on('aborted', () => { res.destroy() })
        up.on('error', () => { res.destroy() })
      },
      )
    } catch (e) {
      setHealth(def.id, 'error', `could not build the upstream request: ${errMessage(e)}`)
      return this.deny(res, 502, `connector "${def.id}" has an unusable definition: ${errMessage(e)}`)
    }
    upstream.on('error', (e) => {
      setHealth(def.id, 'error', errMessage(e))
      // Only answer if nothing has been written yet — calling deny() after the head is out
      // throws ERR_HTTP_HEADERS_SENT, uncaught, in an http handler.
      if (!res.headersSent) this.deny(res, 502, `connector "${def.id}" is unreachable: ${errMessage(e)}`)
      else res.destroy()
    })
    // An upstream that accepts the connection and then never answers used to hang the
    // session's tool call indefinitely — there was no timeout anywhere in this proxy.
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      setHealth(def.id, 'error', `upstream did not respond within ${UPSTREAM_TIMEOUT_MS / 1000}s`)
      upstream.destroy()
      if (!res.headersSent) this.deny(res, 504, `connector "${def.id}" did not respond in time`)
      else res.destroy()
    })
    // Tee a bounded prefix of the REQUEST so we know whether this call was a tools/list.
    // learnTools used to run on EVERY JSON reply, so a tools/call response carrying
    // `result.tools` could silently rewrite the persisted classification at a moment of
    // the upstream's choosing. The comment claimed tools/list; the code never checked.
    // The client going away must take the upstream call with it. There was no abort path
    // at all: when an engine is killed mid tool call (relaunch, destroy, crash) the only
    // thing that eventually freed the socket pair was UPSTREAM_TIMEOUT_MS, so N killed
    // calls pinned N upstream sockets for two minutes each — and `release()` doesn't touch
    // requests already in flight.
    res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
    let reqHead = ''
    req.on('data', (c: Buffer) => { if (reqHead.length < REQ_SNIFF_BYTES) reqHead += c })
    req.on('end', () => { wantsToolList = TOOLS_LIST_RE.test(reqHead) })
    req.pipe(upstream)
  }

  // Classify the tools a connector exposes, from a tools/list reply passing through.
  //
  // `write` defaults TRUE when the hint is absent. That is not pessimism for its own
  // sake: the MCP spec explicitly says a client must not trust `annotations` from an
  // untrusted server, and the alternative default would let a `reviewer` role gain a
  // mutating tool merely because the server declined to describe it. Operator data,
  // seeded here (see ConnectorTool).
  private learnTools(connectorId: string, body: string): void {
    const raw = toolsFromBody(body)
    if (!raw) return
    try {
      const list: ConnectorTool[] = raw
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .filter((t) => typeof t.name === 'string')
        .map((t) => {
          const ann = (t.annotations ?? {}) as Record<string, unknown>
          return {
            name: t.name as string,
            description: typeof t.description === 'string' ? t.description : undefined,
            write: ann.readOnlyHint !== true,
          }
        })
      if (list.length) setTools(connectorId, list)
    } catch { /* not JSON-RPC we understand; classification stays as it was */ }
  }

  // A refusal the ENGINE can render. JSON-RPC error rather than a bare status so the
  // CLI surfaces the reason in the tool result instead of "server unavailable".
  private deny(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }))
  }
}

// The `result.tools` array out of a captured reply, or null. Handles BOTH shapes a
// streamable-HTTP MCP server may answer a tools/list with: a plain JSON body, and an SSE
// stream whose payloads ride `data:` lines. Each candidate is parsed independently, so a
// prefix truncated at MAX_CLASSIFY_BYTES simply yields nothing rather than throwing.
function toolsFromBody(body: string): unknown[] | null {
  const candidates = [body]
  if (body.includes('data:')) {
    for (const line of body.split('\n')) {
      const t = line.trim()
      if (t.startsWith('data:')) candidates.push(t.slice(5).trim())
    }
  }
  for (const c of candidates) {
    if (!c) continue
    try {
      const msg = JSON.parse(c) as { result?: { tools?: unknown } }
      if (Array.isArray(msg.result?.tools)) return msg.result.tools
    } catch { /* try the next candidate */ }
  }
  return null
}
