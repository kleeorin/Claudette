// The connector proxy's CONCURRENCY CAP — the resource bound, as distinct from the
// time bound.
//
// ★ WHY THIS FILE EXISTS. The total-duration guard in connectorProxy bounds ONE connection's
// lifetime. It is not a resource bound, and the proxy's own comment says so: with unbounded
// concurrency an adversary simply opens more connections, and the time guard then lands on
// legitimate long streams instead of on the attacker — the wrong way round. For a SANDBOXED
// session this is the only bound that exists at all, because MCP_* env is stripped from the
// box, so the proxy is the single path out.
//
// This file converts the two `[open]` notes in rt2-connectors-c.mts from printed measurements
// into assertions. An `[open]` is an honest placeholder; it is also invisible to a suite that
// only reads exit codes, which is exactly how a known gap stays open for months.
//
// ★★ KNOWN TO FLIP, MEASURED BOTH WAYS. Written before the cap existed (as a patch, because
// `server/src` was read-only to its author): 7 passed / 4 failed on the unpatched tree, 11/0
// with the patch. The patch was applied to server/src/connectors/connectorProxy.ts on
// 2026-10-06, the EXPECTED_RED entry came off, and the patch file was deleted. Case 7 (the
// global 64 cap) was added afterwards; 15/15 now. Case 6 passed even before the cap, which is
// what showed the red was the missing feature and not a broken harness.
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'
import { check, passed as pass, failed as fail } from './assert.mjs'

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'capcap-'))
process.env.CLAUDETTE_DATA_DIR = DATA
const store = await import('../server/src/connectors/connectorStore')
const { ConnectorProxy } = await import('../server/src/connectors/connectorProxy')

// The cap the implementation ships with. Read from the plan rather than probed, so a change
// to the constant without a change here is a visible disagreement rather than a silent pass.
const N = 6

// ── Fixture upstream ──────────────────────────────────────────────────────────────────────
// 'hold'  : accept and keep the connection open until the test releases it. This is what
//           occupies a slot; without it there is nothing to saturate.
// 'ok'    : answer at once.
// 'silent': accept and never answer (slowloris upstream), for case 6.
const held: http.ServerResponse[] = []
const upstream = http.createServer((req, res) => {
  const mode = req.headers['x-mode']
  if (mode === 'ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":1,"result":{}}'); return }
  if (mode === 'hold') { held.push(res); return }
  // 'silent': never answer.
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
const uport = (upstream.address() as AddressInfo).port

const granted = new Set(['good'])
const proxy = new ConnectorProxy((_sid: string, cid: string) => granted.has(cid))
await proxy.start()
store.saveConnector({ id: 'good', name: 'Good', transport: 'http', url: `http://127.0.0.1:${uport}/mcp` })
store.saveConnector({ id: 'nogrant', name: 'NoGrant', transport: 'http', url: `http://127.0.0.1:${uport}/mcp` })

type Reply = { status: number; body: string; ms: number }
const call = (url: string, mode: string, body = '{"jsonrpc":"2.0","id":1,"method":"ping"}', timeoutMs = 30_000): Promise<Reply> =>
  new Promise((resolve) => {
    const t0 = Date.now()
    const timer = setTimeout(() => { resolve({ status: 0, body: 'HUNG', ms: Date.now() - t0 }); req.destroy() }, timeoutMs)
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mode': mode } }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode ?? 0, body: b, ms: Date.now() - t0 }) })
    })
    req.on('error', () => { clearTimeout(timer); resolve({ status: 0, body: 'ERR', ms: Date.now() - t0 }) })
    req.end(body)
  })

// Fire-and-forget occupant: starts a request and leaves it in flight.
const occupy = (url: string): Promise<Reply> => call(url, 'hold')
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
const isJsonRpcError = (b: string): boolean => {
  try { const o = JSON.parse(b); return o?.jsonrpc === '2.0' && o?.error?.code === -32000 && o?.id === null } catch { return false }
}

try {
  const s1 = proxy.urlFor('s1', 'good')

  // ── 1. N+1 IS REJECTED, AND SAYS SO IN A PARSEABLE BODY ────────────────────────────────
  // Asserting the BODY as well as the status, not timing: a timing-only assertion ("it came
  // back fast") passes just as well for a connection refused by the kernel, which is a
  // different failure wearing the same stopwatch.
  const occupants = Array.from({ length: N }, () => occupy(s1))
  await settle(600)
  const overflow = await call(s1, 'hold', '{"jsonrpc":"2.0","id":1,"method":"ping"}', 5_000)
  check('1. request N+1 is rejected with 503', overflow.status === 503, `status=${overflow.status} ms=${overflow.ms}`)
  check('1b. …and the body is a parseable JSON-RPC error (code -32000, id null)',
    isJsonRpcError(overflow.body), overflow.body.slice(0, 120))

  // ── 4. AN UNGRANTED CONNECTOR STILL GETS 403 WHILE SATURATED ───────────────────────────
  // Admission sits AFTER the grant check, so saturation must not change what an ungranted
  // caller learns. If the cap were admitted first, this would turn into a 503 and quietly
  // tell an ungranted caller about the proxy's load.
  const ung = await call(proxy.urlFor('s1', 'nogrant'), 'ok', undefined, 5_000)
  check('4. ungranted connector still gets 403 while the session is saturated',
    ung.status === 403, `status=${ung.status}`)

  // ── 3. THE CAP IS PER (session, connector), NOT PER CONNECTOR ──────────────────────────
  // Session A saturated must not starve session B of a connector B was granted. A
  // connector-only key would make one session a denial-of-service against every other.
  const s2 = proxy.urlFor('s2', 'good')
  const other = await call(s2, 'ok', undefined, 5_000)
  check('3. a DIFFERENT session is still served while the first is saturated',
    other.status === 200, `status=${other.status}`)

  // ── 2. SLOTS COME BACK ─────────────────────────────────────────────────────────────────
  // The case that catches a double- or triple-decrement: with a naive release the counter
  // drifts negative and the cap silently stops rejecting, so a cap that never recovers and a
  // cap that never fires both need pinning, and only this one sees the first.
  // ★ 2a FIRST: finishing ONE request frees EXACTLY ONE slot. This is the case that sees an
  // over-release, and it is sharper than draining everything at once — which cannot tell
  // "released once" from "released three times", because after a full drain the count is
  // zero either way. With a duplicate decrement while several requests share a key, the
  // second slot opens too and the follow-up below is admitted when it should be refused.
  // ⚠ PROBE WITH 'ok', NEVER 'hold'. An awaited 'hold' probe times out, and `call` destroys
  // the request on timeout — which hands the slot straight back and makes the very next probe
  // see free capacity. The first draft of these two cases did exactly that and reported
  // status=0 twice, a self-inflicted result that says nothing about the cap.
  held.splice(0, 1).forEach((r) => { try { r.end('{"jsonrpc":"2.0","id":1,"result":{}}') } catch { /* gone */ } })
  await settle(600)
  const oneFreed = await call(s1, 'ok', undefined, 5_000)
  check('2a. finishing one request frees exactly one slot (it is admitted)',
    oneFreed.status === 200, `status=${oneFreed.status}`)
  // Re-occupy the freed slot with a request that STAYS in flight, so the next probe meets a
  // genuinely full budget rather than the gap the probe above just vacated.
  occupants.push(occupy(s1))
  await settle(600)
  const stillFull = await call(s1, 'ok', undefined, 5_000)
  check('2b. …and ONLY one — the next is still refused (catches a double decrement)',
    stillFull.status === 503, `status=${stillFull.status}`)

  held.splice(0).forEach((r) => { try { r.end('{"jsonrpc":"2.0","id":1,"result":{}}') } catch { /* gone */ } })
  await Promise.all(occupants)
  await settle(600)
  const afterDrain = await call(s1, 'ok', undefined, 5_000)
  check('2. a slot is returned when a request finishes (N+1 now succeeds)',
    afterDrain.status === 200, `status=${afterDrain.status}`)

  // ── 5. release(sessionId) RECLAIMS THE SESSION'S SLOTS ─────────────────────────────────
  // A session destroyed mid-flight must not leave its budget consumed forever. Without this
  // the cap degrades into a permanent lockout for a session id that no longer exists.
  const occupants2 = Array.from({ length: N }, () => occupy(s1))
  await settle(600)
  const blocked = await call(s1, 'hold', undefined, 5_000)
  check('5a. (precondition) the session is saturated again', blocked.status === 503, `status=${blocked.status}`)
  proxy.release('s1')
  const s1fresh = proxy.urlFor('s1', 'good')   // release() drops the token too, so re-mint
  const afterRelease = await call(s1fresh, 'ok', undefined, 5_000)
  check('5. release(sessionId) reclaims that session\'s slots',
    afterRelease.status === 200, `status=${afterRelease.status}`)
  held.splice(0).forEach((r) => { try { r.destroy() } catch { /* gone */ } })
  await Promise.all(occupants2)

  // ── 7. ★ THE GLOBAL BACKSTOP ───────────────────────────────────────────────────────────
  // Found by a mutation run on the real tree: deleting the global admission check left the
  // suite at 11/0, i.e. the 64-cap was never exercised at all. Cases 1-5 all saturate ONE
  // (session, connector) pair, so they can only ever trip the PER-PAIR limit — many sessions
  // each comfortably under their own budget can still sum past the process-wide one, and
  // nothing was watching that.
  //
  // ★★ ASSERTED ON THE GLOBAL WORDING, NOT MERELY ON 503. Both caps answer 503, so a test
  // that only checked the status would pass just as well if the PER-PAIR limit had fired —
  // which is exactly what would happen if the fill were mis-sized. The distinct message is
  // what makes this a test of the global cap rather than a test that something refused.
  const GLOBAL = 64
  // 11 distinct pairs: ten at the per-pair maximum plus one at four = 64 exactly. Every pair
  // stays at or under its own limit, so any rejection here can only come from the global one.
  const globalHeld: Promise<Reply>[] = []
  for (let i = 0; i < 10; i++) {
    const u = proxy.urlFor(`g${i}`, 'good')
    for (let k = 0; k < N; k++) globalHeld.push(occupy(u))
  }
  const partial = proxy.urlFor('g10', 'good')
  for (let k = 0; k < GLOBAL - 10 * N; k++) globalHeld.push(occupy(partial))
  await settle(1200)

  const overGlobal = await call(proxy.urlFor('g11', 'good'), 'ok', undefined, 5_000)
  check('7. the 65th in-flight request is refused even though its own pair is empty',
    overGlobal.status === 503, `status=${overGlobal.status}`)
  check('7b. …and the body is a parseable JSON-RPC error',
    isJsonRpcError(overGlobal.body), overGlobal.body.slice(0, 120))
  check('7c. ★ …naming the GLOBAL limit, not the per-session one',
    /global in-flight limit/.test(overGlobal.body), overGlobal.body.slice(0, 160))

  // Release a few and the proxy serves again — the global counter comes back down, so the
  // backstop is a cap rather than a one-way latch.
  held.splice(0, N).forEach((r) => { try { r.end('{"jsonrpc":"2.0","id":1,"result":{}}') } catch { /* gone */ } })
  await settle(1200)
  const afterGlobalDrain = await call(proxy.urlFor('g12', 'good'), 'ok', undefined, 5_000)
  check('7d. …and once some finish, a fresh pair is served again',
    afterGlobalDrain.status === 200, `status=${afterGlobalDrain.status}`)

  held.splice(0).forEach((r) => { try { r.destroy() } catch { /* gone */ } })
  await Promise.all(globalHeld)
  await settle(600)

  // ── 6. THE SILENT UPSTREAM IS BOUNDED (the other [open]) ───────────────────────────────
  // Not a cap case — the existing total-duration guard — but it is the second printed
  // measurement being turned into an assertion. It also keeps this file honest while the cap
  // is unbuilt: it should pass NOW, so an all-red run means the harness is broken rather than
  // the feature missing. `tools/list` puts the request in the fast set (15s), so a 504 inside
  // 20s is the bound doing its job rather than the 120s ceiling.
  const silent = await call(proxy.urlFor('s3', 'good'), 'silent', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', 40_000)
  check('6. a silent upstream is answered 504 rather than hanging', silent.status === 504, `status=${silent.status} ms=${silent.ms}`)
  check('6b. …and inside the fast budget, not the 120s ceiling', silent.ms < 20_000, `ms=${silent.ms}`)
} finally {
  held.splice(0).forEach((r) => { try { r.destroy() } catch { /* gone */ } })
  await proxy.stop?.()
  upstream.close()
  fs.rmSync(DATA, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
