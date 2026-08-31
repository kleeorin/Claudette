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
// THE CEILING. Every request gets this; recognition may only ever SHORTEN it.
// ★ THIS NUMBER MUST NEVER RISE, and no branch below may exceed it. The session writes the
// request body, so the session controls classification — that is safe only while
// classification can nothing but shorten the bound. Give `tools/call` 600s "because tool
// calls run long" and a session gains a longer socket pin by a classification it chooses,
// and the refinement becomes a regression. Monotonic, or not at all.
const UPSTREAM_TIMEOUT_MS = 120_000
// The fast set: handshake methods that have no legitimate reason to take two minutes.
// Adding a method here is always safe by the monotonicity argument above, so this set can
// grow without re-litigating the design.
const FAST_TIMEOUT_MS = 15_000
const FAST_METHOD_RE = /"method"\s*:\s*"(tools\/list|initialize|resources\/list|prompts\/list)"/
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
    // Hoisted because BOTH timeout callbacks live out here while the values they need are
    // computed inside handlers. `upstreamContentType` in particular is assigned where
    // `classifiable` is computed, inside the response handler — the design flags forgetting
    // that as the most likely thing to get wrong.
    let reqId: string | number | null = null
    let upstreamContentType = ''
    let budgetMs = UPSTREAM_TIMEOUT_MS
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
        upstreamContentType = contentType
        const capChunks: Buffer[] = []
        let capBytes = 0
        // pipe(), not a hand-rolled `up.on('data', c => res.write(c))`: that ignored
        // res.write's return value and never paused the source, so a fast upstream feeding
        // a slow consumer buffered the whole reply in res's internal write queue. The
        // MAX_CLASSIFY_BYTES cap bounds `captured`, never the pass-through — a 126 MB reply
        // still cost ~126 MB of RSS if the reader stalled. pipe applies backpressure and
        // ends `res` for us; the data listener alongside it still sees every chunk.
        up.pipe(res)
        up.on('data', (c: Buffer) => {
          // Same Buffer fix as the request tee. Here it is correctness / catalog hygiene
          // only — NOT security or availability — but it is what keeps a future widening of
          // TOOL_NAME_RE (today ASCII-only, and nothing says it must stay so) from turning
          // into a live bug: with the corruption gone, widening becomes a non-event.
          // And MAX_CLASSIFY_BYTES is a MEMORY bound, so a string-length test against it
          // was under-enforcing a guard rather than merely being imprecise.
          if (classifiable && wantsToolList && capBytes < MAX_CLASSIFY_BYTES) { capChunks.push(c); capBytes += c.length }
        })
        up.on('end', () => { if (capBytes) this.learnTools(def.id, Buffer.concat(capChunks).toString('utf8')) })
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
    // ── POST-HEADER FAILURE ──────────────────────────────────────────────────────────
    // Once the head is out the status cannot change, so `res.destroy()` handed the session a
    // truncated body with no status and no message — indistinguishable from a network fault,
    // and this is the LIKELIER real-world stall (an SSE stream that opens and then dies).
    // Put the error where the client will still read it: in the body.
    const failAfterHeaders = (msg: string): void => {
      if (upstreamContentType.includes('text/event-stream')) {
        // Leading blank line FIRST: the stall can land mid-frame, and a blank line
        // terminates whatever was in flight. If nothing was, parsers dispatch an empty
        // event and ignore it — safe either way, and it costs two bytes. JSON.stringify
        // never emits a literal newline, so the body cannot split the frame.
        res.end(`\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: reqId, error: { code: -32000, message: msg } })}\n\n`)
      } else {
        // A half-written JSON body cannot be repaired by appending to it. end() rather than
        // destroy(): a parse error beats a socket error, because it is diagnosable.
        res.end()
      }
    }
    const onIdleTimeout = (): void => {
      setHealth(def.id, 'error', `upstream stalled for ${budgetMs / 1000}s`)
      upstream.destroy()
      if (!res.headersSent) this.deny(res, 504, `connector "${def.id}" did not respond in time`)
      else failAfterHeaders(`connector "${def.id}" stalled for ${budgetMs / 1000}s`)
    }
    // ── TOTAL-DURATION GUARD, separate from the idle one and NOT a substitute for it ───
    // `upstream.setTimeout` is a SOCKET IDLE timeout: any byte resets it. So an upstream
    // that drips one chunk every few seconds is never idle and is never bounded, however
    // small the idle value — measured at STILL OPEN after 150s across 29 drips. Only a
    // wall-clock bound on the whole exchange catches that.
    // ⚠ THIS IS NOT A RESOURCE BOUND AND MUST NOT BE RECORDED AS ONE. It bounds ONE
    // connection's lifetime. With unbounded concurrency an adversary simply opens more, and
    // the cap lands on legitimate long streams instead of on them — the wrong way round.
    // The instrument that bounds the resource is a CONCURRENCY CAP (N in-flight upstream
    // requests per session and/or per connector), which does not exist. See the [open] in
    // scratchpad/rt2-connectors-c.mts.
    const onTotalTimeout = (): void => {
      setHealth(def.id, 'error', `upstream exceeded the ${budgetMs / 1000}s total budget`)
      upstream.destroy()
      if (!res.headersSent) this.deny(res, 504, `connector "${def.id}" exceeded its time budget`)
      else failAfterHeaders(`connector "${def.id}" exceeded its ${budgetMs / 1000}s time budget`)
    }
    // Armed with the CEILING here and re-armed shorter at req.on('end') once the body has
    // identified the method. Cleared on every terminal path, or a settled request keeps a
    // timer (and this closure) alive for up to two minutes.
    let totalTimer: NodeJS.Timeout = setTimeout(onTotalTimeout, UPSTREAM_TIMEOUT_MS)
    const clearTotal = (): void => clearTimeout(totalTimer)
    upstream.on('close', clearTotal)
    upstream.on('error', clearTotal)
    res.on('close', clearTotal)
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, onIdleTimeout)
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
    // Buffers, concatenated ONCE — not `reqHead += c`. `+=` stringifies each chunk on its
    // own, so a multi-byte codepoint split across a chunk boundary becomes two U+FFFD. That
    // is a PRECONDITION of jsonRpcId below, not tidiness: measured, the corrupted string
    // still PARSES (every structural JSON byte is ASCII and unsplittable, so corruption can
    // only land inside a string value where U+FFFD is legal) and therefore yields a WRONG
    // id rather than no id. Also note the cap was a STRING-length test against a byte-named
    // constant, which admits more bytes than intended for multi-byte content.
    const reqChunks: Buffer[] = []
    let reqBytes = 0
    req.on('data', (c: Buffer) => {
      if (reqBytes >= REQ_SNIFF_BYTES) return
      reqChunks.push(c); reqBytes += c.length
    })
    req.on('end', () => {
      const head = Buffer.concat(reqChunks).toString('utf8')
      wantsToolList = TOOLS_LIST_RE.test(head)
      reqId = jsonRpcId(head, reqBytes >= REQ_SNIFF_BYTES)
      // RE-ARM SHORTER, now that the body has told us what this call is. The timeouts were
      // armed with the ceiling when the request was created, because classification is only
      // available here — the body IS the classifier, and it arrives after the socket does.
      // setTimeout() replaces a pending timer, so this can only tighten the bound.
      if (FAST_METHOD_RE.test(head)) {
        budgetMs = FAST_TIMEOUT_MS
        upstream.setTimeout(FAST_TIMEOUT_MS, onIdleTimeout)
        clearTimeout(totalTimer)
        totalTimer = setTimeout(onTotalTimeout, FAST_TIMEOUT_MS)
      }
    })
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

// The JSON-RPC id out of a request-body prefix, or null when it cannot be known.
// ★ PARSE, DO NOT REGEX. `"id"` appears legitimately inside tool arguments, so a
// first-match regex returns the wrong one — and A WRONG ID IS WORSE THAN NO ID, because a
// client may settle a DIFFERENT pending call with it. Everything ambiguous returns null,
// which is exactly what deny() already emits and what no client can mis-route:
//   · truncated past REQ_SNIFF_BYTES → null (the prefix may not contain the real id)
//   · a batch (array) → null (no single id to answer)
//   · a notification (no id) → null
function jsonRpcId(body: string, truncated: boolean): string | number | null {
  if (truncated) return null
  try {
    const v: unknown = JSON.parse(body)
    if (Array.isArray(v) || v === null || typeof v !== 'object') return null
    const id = (v as { id?: unknown }).id
    return typeof id === 'string' || typeof id === 'number' ? id : null
  } catch { return null }
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
