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
    res.on('end', () => { clearTimeout(timer); resolve(`completed ${res.statusCode} (${b.length}B)`) })
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
attack('A: upstream never answers — is the session\'s request BOUNDED (does it complete at all)?',
  !r3.startsWith('HUNG'), `${r3} after ${took}s`)
// Not a finding — a measured fact with no owner, printed where it cannot be missed. Same
// pattern as scratchpad/shell-fixed-cost-probe.mjs. The number is the point: the decision in
// front of the operator is "is 120s right for a tools/list handshake", not "is this test ok".
if (!r3.startsWith('HUNG')) {
  console.log(`\n⚠  [open] MEASURED, unowned: a silent upstream ties up this call for ${took}s`)
  console.log('   before the 504 (connectorProxy.ts:48, UPSTREAM_TIMEOUT_MS = 120_000). That is the')
  console.log('   full handshake budget for a tools/list — the tool call is dead for two minutes and')
  console.log('   the session cannot tell. Bounded is not the same as reasonable. This file asserts')
  console.log('   only the bound; the VALUE is a product decision and deliberately not asserted here.')
}
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

