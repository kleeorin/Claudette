// RED TEAM round 2, part C — proxy liveness and the deny-rule injection backstop against a
// hand-edited or imported catalog.
//   npx tsx scratchpad/rt2-connectors-c.mts
//
// ★ SLOW ON PURPOSE: ~130s, nearly all of it case A3 waiting out the proxy's real 120s
//   upstream timeout. There is no shortcut — UPSTREAM_TIMEOUT_MS is a module constant, and
//   "the request is bounded" can only be asserted by watching it actually complete.
//
// ── A3 WAS A FALSE RED FOR TWO BASELINES. RECALIBRATED 2026-08-26 ────────────────────
// It used to ask "does the session's request ever finish?", wait 3000ms, and report
// `HUNG (no response after 3000ms)`. Both halves were wrong: 3 seconds cannot answer "ever",
// and the answer was false. connectorProxy.ts:194 does `upstream.setTimeout(
// UPSTREAM_TIMEOUT_MS)` and answers 504 — MEASURED at `completed 504 (106B) after 120s`.
// The proxy's own comment at :192 says the unbounded hang was fixed BEFORE this probe was
// written ("used to hang the session's tool call indefinitely — there was no timeout
// anywhere in this proxy"), so the probe was asserting against a defect that no longer
// existed. The baselines of 74/4/6 and 75/4/6 both counted this red: a diff against them
// should read the drop to 3 reds as A FALSE RED RETRACTED, NOT A DEFECT CLOSED.
//
// ── ★ A3's NAME WAS CORRECTED AGAIN ON 2026-08-27, AND THIS IS THE SECOND CORRECTION ──
// It briefly asserted "is the session's request BOUNDED (does it complete at all)?" — which
// generalised a measurement of ONE case into a claim about all of them. Measured: a DRIPPING
// upstream (one chunked keepalive every 5s) was still open after 150s, because
// upstream.setTimeout() is Node's socket IDLE timeout and any byte resets it. So:
//   · silent upstream   → bounded at 120s, 504.   (asserted here)
//   · dripping upstream → NOT BOUNDED AT ALL.     (an [open] below; no fix exists yet)
// The history of this one assertion is the whole lesson of this file. It has now claimed, in
// order: "hangs with no timeout" (false — a defect fixed before the probe was written),
// "the request is bounded" (false in general — true only for the case measured), and now the
// narrow thing that is actually true. Each wrong version was CONFIDENT AND SPECIFIC, which is
// exactly why they survived. Name the case you measured, in the assertion itself.
//
// ★ THE TRAP, AND WHY THE `[open]` LINE BELOW MUST NOT BE "SIMPLIFIED" AWAY.
// The obvious repair — widen the wait to 130s — turns this file green and leaves the REAL
// concern with no representation anywhere: 120 seconds is an absurd bound for a `tools/list`
// handshake, and a session's tool call sits dead for two minutes before the 504. Silencing a
// true issue by making a false one go away is the exact failure mode. So A3 now asserts only
// what is unambiguously true (the request is BOUNDED — it completes rather than hanging) and
// prints the measured bound as an explicit `[open]`. No threshold is invented here: what
// counts as an acceptable handshake timeout is a product decision, not a test's to make.
//
// ── FAILS-FIRST for A3, measured 2026-08-26 — the justification for the assertion ────
// The recalibrated A3 asserts that the request COMPLETES. That is only worth having if it
// can fail, so it was measured against the fix removed rather than reasoned about: a copy of
// connectorProxy.ts with the `upstream.setTimeout(UPSTREAM_TIMEOUT_MS, …)` block deleted
// (a copy, because server/src is read-only from a pinned session — the same discipline used
// for scratchpad/buffers-guard.mts). Result:
//   `🚨 SUCCEEDED — … BOUNDED … — HUNG (no response after 130000ms) after 130s`, exit 1.
// And the `[open]` line correctly SUPPRESSED itself, since it only prints on a completed
// request — so the mutation cannot leave a stale measurement on screen claiming 120s.
// As shipped: 0 findings, `completed 504 (106B) after 120s`.
//
// ★ AND A LESSON ABOUT READING PROBES, WHICH IS WHY THIS SURVIVED TWO BASELINES:
// its wording ("HUNG", "no timeout") was quoted upward as a finding about the app, twice,
// because it was specific and confident. A HARNESS'S OWN CLAIM ABOUT WHAT IT FOUND IS NOT
// EVIDENCE ABOUT THE CODE; ONLY THE CODE IS. Read the subject, not the output.
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { AddressInfo } from 'net'

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rt2c-'))
process.env.CLAUDETTE_DATA_DIR = DATA

const store = await import('../server/src/connectors/connectorStore')
const { ConnectorProxy } = await import('../server/src/connectors/connectorProxy')
const { connectorDenyRules } = await import('../server/src/connectors/connectorLaunch')

const findings: string[] = []
const attack = (n: string, blocked: boolean, d = ''): void => {
  if (blocked) console.log(`✅ blocked — ${n}${d ? ` — ${d}` : ''}`)
  else { findings.push(n); console.log(`🚨 SUCCEEDED — ${n}${d ? ` — ${d}` : ''}`) }
}
console.log(`(isolated data dir ${DATA})\n`)

// A. Liveness ------------------------------------------------------------------------
const modes = { abortJson: true, abortStream: true, silent: true }
const upstream = http.createServer((req, res) => {
  const mode = req.headers['x-mode']
  if (mode === 'abort-json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"jsonrpc":"2.0",')
    setTimeout(() => res.socket?.destroy(), 20)
    return
  }
  if (mode === 'abort-stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: hi\n\n')
    setTimeout(() => res.socket?.destroy(), 20)
    return
  }
  if (mode === 'drip') {
    // Headers out, then one chunk every 2s forever. This is the SSE-that-opens-and-dies
    // case, and it is the one an IDLE timeout can never catch however small you set it —
    // every drip resets it. It also exercises the POST-HEADER failure path by
    // construction, since the status is already sent by the time the guard fires.
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const t = setInterval(() => { try { res.write(': keepalive\n\n') } catch { clearInterval(t) } }, 2000)
    req.on('close', () => clearInterval(t))
    return
  }
  // 'silent': accept the request and never answer (slowloris upstream).
})
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
const uport = (upstream.address() as AddressInfo).port
const proxy = new ConnectorProxy(() => true)
await proxy.start()
store.saveConnector({ id: 'evil', name: 'Evil', transport: 'http', url: `http://127.0.0.1:${uport}/mcp` })
const url = proxy.urlFor('s1', 'evil')

const probe = (mode: string, ms: number): Promise<string> => new Promise((resolve) => {
  const timer = setTimeout(() => { resolve(`HUNG (no response after ${ms}ms)`); req.destroy() }, ms)
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mode': mode } }, (res) => {
    let b = ''
    res.on('data', (c) => (b += c))
    res.on('end', () => {
      clearTimeout(timer)
      // Surface WHETHER THE BODY CARRIES A JSON-RPC ERROR, not just its length. Once the
      // head is out the status can no longer say anything, so the body is the only channel
      // left — and "200, 209 bytes" is exactly as consistent with a truncated stream as
      // with a diagnosable failure. This is the difference the post-header fix makes.
      let rpc = ''
      try { const m = b.match(/\{"jsonrpc".*\}/); if (m && JSON.parse(m[0])?.error) rpc = ' +rpc-error' } catch { /* not our frame */ }
      resolve(`completed ${res.statusCode} (${b.length}B)${rpc}`)
    })
    res.on('error', (e) => { clearTimeout(timer); resolve(`res error ${(e as Error).message}`) })
  })
  req.on('error', (e) => { clearTimeout(timer); resolve(`req error ${(e as Error).message}`) })
  req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
})

for (const [mode, label] of [['abort-json', 'upstream aborts mid-JSON'], ['abort-stream', 'upstream aborts mid-stream']] as const) {
  const r = await probe(mode, 3000)
  attack(`A: ${label} — does the session's request ever finish?`, !r.startsWith('HUNG'), r)
}
// A3: the silent (slowloris) upstream. The CEILING is 130s — deliberately above the proxy's
// own 120s timeout, because the claim is "bounded", not "bounded by any particular value".
// A ceiling below the real timeout would report HUNG for a request that was going to
// complete, which is precisely the error this case is being repaired for.
const A3_CEILING_MS = 130_000
const t0 = Date.now()
const r3 = await probe('silent', A3_CEILING_MS)
const took = Math.round((Date.now() - t0) / 1000)
// ★ THE LOWER BOUND IS NOT DECORATION. `!startsWith('HUNG')` alone goes green for ANY prompt
// result — a fixture that fails to start, a refused port, an early throw — all of which return
// in ~0s and satisfy "bounded" while proving nothing about the timeout. `took` was printed but
// never asserted on, so the strongest evidence in this file was pinned by nothing.
// 5s, not ~120s: this must survive the timeout VALUE changing (a per-method budget is being
// designed), and the failure mode being excluded is an INSTANT return, not a slightly-wrong
// one. The measured value is carried by the [open] line below, which is where it belongs.
attack('A: upstream never answers AND SENDS NOTHING — is that case bounded?',
  !r3.startsWith('HUNG') && took >= 5,
  `${r3} after ${took}s` + (took < 5 && !r3.startsWith('HUNG')
    ? ' ← returned instantly: that is a broken fixture, not a bounded request' : ''))
// A4: THE DRIP. Was an `[open]` citing a manual measurement from 2026-08-27 — static prose
// that would have gone on claiming "not bounded" after the guard landed, because nothing
// re-measured it. It is a live case now, which is the only form of that claim worth having.
const t4 = Date.now()
const r4 = await probe('drip', 60_000)
const took4 = Math.round((Date.now() - t4) / 1000)
// ALSO asserts the body carries a JSON-RPC error. The status was already sent as 200 by the
// upstream before the guard fired, so a client that only reads the status sees success; the
// error has to be IN THE BODY or the session gets a truncated stream indistinguishable from
// a network fault, which is what this path used to hand it.
attack('A: a DRIPPING upstream (a chunk every 2s) — is the TOTAL duration bounded, WITH a diagnosable error?',
  !r4.startsWith('HUNG') && took4 >= 5 && r4.includes('+rpc-error'),
  `${r4} after ${took4}s` + (r4.startsWith('HUNG')
    ? ' ← no idle timeout can bound this; only a total-duration guard can' : ''))

// Not a finding — a measured fact with no owner, printed where it cannot be missed. Same
// pattern as scratchpad/shell-fixed-cost-probe.mjs. The number is the point.
if (!r3.startsWith('HUNG')) {
  console.log(`\n⚠  [open] MEASURED, unowned: a SILENT upstream still ties up this call for ${took}s`)
  console.log('   before the 504. That is now the FAST-SET budget (connectorProxy.ts, FAST_TIMEOUT_MS')
  console.log('   = 15_000) rather than the 120s ceiling, so a handshake no longer costs two minutes —')
  console.log('   but bounded is still not the same as reasonable, and whether 15s is right for a')
  console.log('   tools/list is a product decision this file deliberately does not assert.')
}
// ★ THE BOUND THAT STILL DOES NOT EXIST. Recorded as its own [open] because the total-duration
// guard is easy to mistake for it, and that mistake would close the question wrongly.
console.log('')
console.log('⚠  [open] NOT BUILT, and NOT what the total-duration guard provides: a CONCURRENCY CAP.')
console.log('   The guard bounds ONE connection\'s lifetime. With unbounded concurrency an adversary')
console.log('   opens more of them, and the cap lands on legitimate long streams instead of on the')
console.log('   attack — the wrong way round. The instrument that bounds the RESOURCE is a cap on')
console.log('   N in-flight upstream requests per session and/or per connector: not evadable by')
console.log('   classification, does not kill long streams, and bounds fd cost directly. Nothing')
console.log('   in connectorProxy.ts limits how many upstream requests one session may have open.')
void modes

// B. Deny-rule injection backstop against catalog state that never went through
//    saveConnector (a hand-edited connectors.json, or an importer that skips validation).
fs.writeFileSync(path.join(DATA, 'connectors.json'), JSON.stringify({
  connectors: [{ id: 'a,Bash', name: 'x', transport: 'stdio', command: 'echo', tools: [{ name: 'y', write: true }] }],
  oauthClients: [],
  accountConnectors: [{ name: 'ev,Bash' }, { name: 'ok-one' }],
  strict: false,
}))
store.resetConnectorCache()
store.listConnectors()
const rules = connectorDenyRules({ granted: ['a,Bash'], accountAllow: [], readOnlyRole: true })
attack('B: a comma in a hand-edited catalog id/account name forges an extra --disallowedTools entry',
  !rules.some((r) => r.includes(',')), JSON.stringify(rules))


// Was an unconditional `process.exit(0)`: findings printed and the runner still said PASS.
// A plain `exit(findings.length ? 1 : 0)` would be wrong too — accepted residual risk would
// leave the suite permanently red, which hides whatever you break next (commit 2a57def).
// So: a BASELINE keyed on the attack id. Anything not listed is new and fails.
const ACCEPTED = new Set<string>([])
const idOf = (f: string) => f.split(':')[0].trim()
const unexpected = findings.filter((f) => !ACCEPTED.has(idOf(f)))
console.log(`\n${findings.length} finding(s) — ${findings.length - unexpected.length} accepted, ${unexpected.length} unexpected`)
for (const f of findings) console.log(`  ${ACCEPTED.has(idOf(f)) ? '·  (accepted)' : '🚨 UNEXPECTED'} ${f}`)
upstream.close(); proxy.stop()
process.exit(unexpected.length ? 1 : 0)

