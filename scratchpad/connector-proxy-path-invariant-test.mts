// THE INVARIANT THE CONNECTOR CREDENTIAL DESIGN RESTS ON:
//   the proxy dials the path from the CONNECTOR DEFINITION, and discards the client's.
//
// WHY THIS TEST EXISTS. Once an OAuth bearer is attached in the proxy, it holds a live
// credential for the operator's Google account. A granted session controls the request BODY,
// so it can call any tool the connector exposes — that is the grant, and it is bounded by the
// connector's own MCP endpoint. What it must never control is the ENDPOINT. If the client's
// path were forwarded, a session granted the calendar connector could dial any path on
// calendarmcp.googleapis.com WITH THE OPERATOR'S TOKEN ATTACHED, and the proxy would be a
// general credential-lending API gateway aimed wherever the box points it.
//
// The change that breaks this looks like a courtesy: "forward the sub-path so connectors can
// expose sub-resources", "pass the query string through so tools can paginate". This test is
// here so that change fails loudly instead of silently widening reach.
//
// It drives the REAL ConnectorProxy against a REAL local upstream that records what it was
// asked for. No mocking of the thing under test: the assertion is about the bytes the upstream
// actually received.

import http from 'http'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { check, failed as fail } from './assert.mjs'

// What the upstream saw. The point of the whole test.
const seen: { url: string; auth: string | null }[] = []
const upstream = http.createServer((req, res) => {
  seen.push({ url: req.url || '', auth: (req.headers.authorization as string) ?? null })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
const upstreamPort = (upstream.address() as AddressInfo).port

// The connector's configured URL: a FIXED path with a query, so the test can tell "the
// connector's path was used" from "the client's path was used" and from "they were merged".
const CONNECTOR_PATH = '/mcp/v1'
const CONNECTOR_QUERY = '?fixed=1'
const connectorUrl = `http://127.0.0.1:${upstreamPort}${CONNECTOR_PATH}${CONNECTOR_QUERY}`

// The catalog is supplied through the REAL store, via a throwaway CLAUDETTE_DATA_DIR holding a
// real connectors.json. An earlier draft tried to monkeypatch getConnector and could not — ESM
// exports are read-only bindings — but the honest version is better anyway: the proxy resolves
// the definition through exactly the code path it uses in production.
const dataDir = mkdtempSync(path.join(tmpdir(), 'claudette-proxypath-'))
process.env.CLAUDETTE_DATA_DIR = dataDir
writeFileSync(path.join(dataDir, 'connectors.json'), JSON.stringify({
  connectors: [{ id: 'testcon', name: 'Test', transport: 'http', url: connectorUrl }],
  oauthClients: [], accountConnectors: [], strict: false, builtinOverrides: {},
}))

const { ConnectorProxy } = await import('../server/src/connectors/connectorProxy.js')

const proxy = new ConnectorProxy(() => true)   // everything granted; this test is about paths
const port = await proxy.start()
const url = proxy.urlFor('session-1', 'testcon')
const token = url.split('/c/')[1]

const post = (p: string): Promise<number> => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
    headers: { 'content-type': 'application/json' } }, (res) => {
    res.resume()
    res.on('end', () => resolve(res.statusCode || 0))
  })
  req.on('error', () => resolve(0))
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }))
})

try {
  // --- the plain case: the connector's path is what the upstream sees --------------------
  seen.length = 0
  await post(`/c/${token}`)
  check('a plain call reaches the CONNECTOR\'s configured path',
    seen.length === 1 && seen[0].url === `${CONNECTOR_PATH}${CONNECTOR_QUERY}`,
    `upstream saw ${JSON.stringify(seen.map((s) => s.url))}, expected ${CONNECTOR_PATH}${CONNECTOR_QUERY}`)

  // --- THE ATTACK: a session appends its own path after the route token ------------------
  // This is the shape that matters. If any of these arrive upstream, a granted session is
  // choosing the endpoint the operator's credential is presented to.
  // MUTATION THAT TURNS THESE RED: in onRequest, dial with the client's path — e.g.
  //   path: (req.url || '').replace(/^\/c\/[^/?]+/, '') || target.pathname + target.search
  const attacks: [string, string][] = [
    [`/c/${token}/../../admin`, 'a traversal segment'],
    [`/c/${token}/v1/users/me/messages`, 'an appended API sub-path'],
    [`/c/${token}?alt=media&file=secrets`, 'an attacker-chosen query string'],
    [`/c/${token}/mcp/v1/../../../oauth2/v4/token`, 'a path that climbs to another API'],
  ]
  for (const [attackPath, label] of attacks) {
    seen.length = 0
    await post(attackPath)
    const got = seen[0]?.url
    check(`${label} does NOT reach the upstream — the client cannot steer the endpoint`,
      seen.length === 1 && got === `${CONNECTOR_PATH}${CONNECTOR_QUERY}`,
      `upstream saw ${JSON.stringify(got)} for client path ${JSON.stringify(attackPath)}; `
        + `it must always be ${CONNECTOR_PATH}${CONNECTOR_QUERY}, or a granted session picks the destination`)
  }

  // --- and the client's own Authorization is never forwarded -----------------------------
  // Not the same property, but it fails in the same direction: the identity presented upstream
  // must be the operator's, never one the session chose. Asserted positively (auth is null)
  // rather than as a negated substring against any particular header text.
  seen.length = 0
  await new Promise<void>((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/c/${token}`, method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer session-chosen-identity' } },
    (res) => { res.resume(); res.on('end', () => resolve()) })
    req.on('error', () => resolve())
    req.end('{}')
  })
  check('a client-supplied Authorization header is stripped, not forwarded',
    seen.length === 1 && seen[0].auth === null,
    seen[0]?.auth === null ? 'upstream saw no Authorization' : 'upstream saw a session-chosen identity')

  // --- an unknown token is refused locally, without dialling anything --------------------
  // Pins the other half of the routing contract: the token is the ONLY thing taken from the
  // client's URL, and a bad one stops here rather than reaching a provider.
  seen.length = 0
  const code = await post('/c/00000000-0000-0000-0000-000000000000')
  check('an unknown route token is refused locally and dials nothing',
    code === 404 && seen.length === 0, `status ${code}, upstream calls ${seen.length}`)
} finally {
  proxy.stop()
  upstream.close()
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.CLAUDETTE_DATA_DIR
}

process.exit(fail === 0 ? 0 : 1)
