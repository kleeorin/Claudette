// REFRESH-SURVIVAL NET (phone slice 2A) — the net under App.tsx's reload path.
//
//   CHROME_BIN=… node scratchpad/refresh-survival-check.mjs
//
// Isolated everything: own server (4496), own vite (5296), own Chrome (CDP 9354), own
// CLAUDETTE_DATA_DIR, own token, stand-in `claude` and stand-in pane SHELL on PATH. It
// never touches the operator's :4319 server, and it NEVER serves web/dist — that bundle
// is stale and unrebuildable here, so a green against it would be a green about an old
// build in both directions. vite compiles the working tree.
//
// ── ★ THE SENTENCE THAT MUST SURVIVE ANY EDIT OF THIS FILE ★ ─────────────────
// THE PANES MUST BE OLDER THAN SWEEP_GRACE_MS OR EVERY RELOAD ASSERTION IS VACUOUS.
// server/src/pane/paneManager.ts sets SWEEP_GRACE_MS = 30_000 and skips any pane younger
// than that, whoever prunes. So the obvious harness — spawn, reload, assert survival —
// PASSES WITH EVERY INVARIANT BELOW BROKEN. That is not speculation: App.tsx:461 records
// that this same grace already masked one of these bugs in production. Hence the single
// aged fixture: spawn once, wait past the grace ONCE (~31s), then run every reload
// assertion against it. If you "optimise" that sleep away you do not speed the net up,
// you silently delete it.
//
// ── two more load-bearing setup constraints ──────────────────────────────────
// ONE TAB, sessionStorage PRESERVED. The claim id lives in sessionStorage (stable per
// tab, unique across tabs) and paneManager.prune kills a pane only when NO client claims
// it. A second tab — or a cleared sessionStorage — leaves the old claim behind under the
// old id, PROTECTING every pane forever, and all of this goes green regardless. So:
// CDP Page.reload on the same target, and the clientId is pinned explicitly below.
//
// ── what this net covers, and what it provably does not ──────────────────────
// Hazard vocabulary is canonical in web/src/store/sessionReducer.ts:12-56.
//
//   H3  App.tsx ~452-456 — `keep` built from termsRef, NOT inside the setTermsBySession
//       updater (a deferred updater posted an empty keep-set and the server killed every
//       terminal). COVERED, post-grace.
//   H4  App.tsx ~457-461 — two flags (reconcileStarted / reconciled), not one.
//       NOT COVERED BY A STATE-SHAPED FIXTURE; CLOSED BY A CALL-ORDER ASSERTION.
//       The break was applied and this net ran 15/15 GREEN, and an earlier draft of this
//       entry concluded from that that H4 was structurally undetectable and told the next
//       reader NOT to write an assertion. That conclusion was wrong, and the sentence it
//       was missing is this one: the reconcile performs its OWN `void api.pane.prune(keep)`
//       at App.tsx:478, unconditionally, gated by neither flag. So the correct keep-set is
//       re-established one round-trip later no matter what the claim effect did — which
//       makes the one-flag version's extra early prune REDUNDANT, not merely
//       over-protective. Both versions therefore converge on the same STATE, and any
//       fixture that inspects state at the end must be green on both. That is a property of
//       the fixture's shape, not of H4.
//       What differs is the ORDER. Two-flag posts pane.list and prunes only inside its
//       `.then`; one-flag fires the claim effect on mount (`reconciled` is already true) and
//       posts a prune BEFORE the list returns, against the unvalidated restored set. That is
//       observable, so it is now asserted — see 'H4: no pane.prune is posted before the
//       reconcile list has returned' in block [2], fed by the fetch-order recorder installed
//       before the first navigate. Green today, red on exactly the break above.
//       Why it still matters even though it converges: App.tsx:461's "harmless only by
//       accident of the server's spawn grace" is the whole point — the early prune is
//       survivable only because prune spares ptys inside their grace window. Shrink or
//       remove that grace and the redundant early prune becomes a killer. The assertion
//       pins the order rather than the accident.
//       The dead/live fixture is KEPT: the dead-entry drop is real restore behaviour, it
//       is asserted below on its own terms, and the H5 break reddens it.
//   H5  App.tsx:413-414 — the `if (sessions.length === 0) return` guard on the
//       session-gone cleanup (the list loads async; unguarded, the effect runs with an
//       empty id set and drops every session's terminals). COVERED.
//   H6  App.tsx ~492-524 — the restore effect marks each reopened notebook `seenNb` so
//       the newly-opened effect does not ALSO attach it to whatever session happens to
//       be active. COVERED, and the only one here that is cleanly attributable.
//   H1  App.tsx ~301-317 — `publishedRef`, the activePane dedupe cache written in one
//       effect and cleaned in another. LABELLED HOLE. Reload survival does not exercise
//       it and no proxy for it would be honest.
//   H2  App.tsx ~441-443 — the prune effect keyed on `sessionIdKey` rather than
//       `sessions`. LABELLED HOLE, and genuinely unobservable: the updaters return `prev`
//       and the prunes are idempotent, so a violation produces identical observable
//       state. It is a wasted-work guard, not a correctness one — a review-time
//       invariant, protected by the dependency array and the eslint-disable beside it.
//
// H3 and H5 both end in "a terminal that should have survived did not", so a red in
// block [2] alone does not say which broke. Block [1] DOES separate them, and that is
// measured, not argued:
//   H3 broken → block [1] fully GREEN, block [2] red. The empty keep-set only kills once
//                the panes are past the grace, so the damage is invisible until the aged
//                reload. This is the case the 31s exists for.
//   H5 broken → block [1] ALREADY red (0 terminal tabs on the first load). Wiping the
//                per-session state is grace-independent; it does not wait for a sweep.
// So: red in [1] and [2] ⇒ look at H5 first. Green [1], red [2] ⇒ look at H3 first.
//
// ★ THAT RULE DISCRIMINATES ONE BREAK AT A TIME, AND ONLY ONE ★
// Both falsifiability runs broke exactly one hypothesis, so the rule is only ever measured
// against a single regression. If H3 and H5 are broken TOGETHER the run presents as pure
// H5 — block [1] is already red, which is H5's own signature — and H3 is MASKED
// completely: nothing distinguishes "H5 broke" from "H5 broke and so did H3", because the
// state H3's break would have destroyed was already destroyed one step earlier. So a red
// [1] rules H3 neither in nor out. After fixing an H5 red, RE-RUN before concluding: the
// second run is what separates them. Written here because a triage rule gets read as a
// diagnosis — "it's H5" — and this one is only ever a first suspect.
//
// H6 fails on its own axis entirely (a notebook tab in the wrong session) and points at
// one line. H4 does not fail on the STATE axis — see the H4 entry above, which now covers it
// by call order instead.
//
// ── this net is NOT fails-first ──────────────────────────────────────────────
// Unlike layout-check.mjs, every assertion here describes behaviour that is CORRECT
// TODAY, so a green run proves nothing on its own. Every check is tagged [today], and
// falsifiability was established the only way that counts — by BREAKING the code and
// watching the net go red. Every line below is a run that happened, not a prediction:
//
//   FALSIFIABILITY LOG (baseline: 17 passed / 0 failed)
//   The three H3/H5/H6 runs below were measured when the baseline was 15, before the
//   replay-count and H4 order assertions were added. Their TOTALS are therefore two lower
//   than a rerun would show; the failure COUNTS and the attribution are unaffected, and the
//   numbers are left as measured rather than rewritten to match a run that did not happen.
//   BREAK H3  `keep.push` loop moved inside the setTermsBySession updater
//             → 8 passed / 7 FAILED. Block [1] green, every survival check in [2] red,
//               tab strip 0 tabs, both layouts emptied. Detected.
//   BREAK H5  `if (sessions.length === 0) return` guard deleted
//             → 5 passed / 10 FAILED, red from block [1] onward. Detected.
//   BREAK H6  `seenNb.current.add(id)` removed from the notebook restore effect
//             → 14 passed / 1 FAILED — exactly the H6 check, reporting Alpha's tab list as
//               [demo.py, beta.ipynb]. One red, one cause, one line. Detected.
//   BREAK H4  reconcileStarted/reconciled collapsed into one ref set at the top
//             → 15 passed / 0 failed. NOT DETECTED **BY THE STATE-SHAPED FIXTURE** — that was
//               a real measured run, and the reason is the fixture's shape, not H4: the
//               reconcile's own prune is unconditional, so both versions converge on the same
//               end state and ANY end-state assertion must be green on both.
//               The CALL-ORDER assertion added for it IS now measured, on the same break:
//               → 16 passed / 1 FAILED, and the single red is the H4 order check itself:
//                 list:start → prune:start → prune:start → list:done → prune:done → …
//                 Two prunes posted BEFORE the list returned, which is the predicted
//                 signature exactly. Baseline with the flags restored: 17/0, order
//                 list:start → list:done → prune:start → prune:done. Cleanly attributable —
//                 no other check moved in either direction. DETECTED, by order not by state.
//
// The net also earned its keep on its first green-seeking run: the scrollback-replay
// check below was red against correct-looking code, and the cause was a real defect in
// TerminalView.tsx (the attach-mode pane id was never re-armed after a remount, so the
// replay bailed, live output was dropped and typing no-opped). Fixed there, with the
// diagnosis in a comment. scratchpad/xterm-replay-probe.mjs is the probe that isolated it.
//
import { spawn } from 'child_process'
import { mkdtemp, writeFile, mkdir, chmod } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4496
const WEB_PORT = 5296
const CDP_PORT = 9354
const APP = `http://127.0.0.1:${WEB_PORT}`
const API = `http://127.0.0.1:${PORT}`
const TOKEN = 'refresh-survival-token'
const CLIENT_ID = 'refresh-survival-tab'     // pinned: one tab, one claim, across reloads
const GRACE_MS = 30_000                      // MUST track paneManager.ts SWEEP_GRACE_MS — CHECKED BELOW

// …and "MUST track" is now a CHECK rather than a comment. This is the file's own load-bearing
// invariant — every reload assertion below is vacuous unless the panes are older than the
// server's sweep grace — and until now the only thing holding the two numbers together was the
// sentence on the line above.
//
// The ASYMMETRY is what makes it worth failing hard over. Lower the server constant and this
// harness merely oversleeps: slower, still valid. RAISE it and the harness under-ages its
// fixture, the sweep never runs during the test, and every reload check goes green while
// proving nothing — which is precisely the "an alarm that cries wolf trains you to ignore it"
// failure this directory keeps relearning, reintroduced one level up, in the file written to
// prevent it. A vacuous green is worse than a red.
{
  const src = readFileSync(new URL('../server/src/pane/paneManager.ts', import.meta.url), 'utf8')
  // The underscore form is what the server actually uses (`30_000`), so the character class
  // must include it and the value must be de-underscored before comparison. Verified against
  // both spellings rather than assumed.
  const m = src.match(/SWEEP_GRACE_MS\s*=\s*([0-9_]+)/)
  if (!m) {
    console.error('FATAL: could not find SWEEP_GRACE_MS in server/src/pane/paneManager.ts.')
    console.error('It was probably renamed or moved. Find the sweep grace constant, then update')
    console.error('BOTH this regex and GRACE_MS above so they agree again.')
    process.exit(1)
  }
  const serverGrace = Number(m[1].replace(/_/g, ''))
  if (serverGrace !== GRACE_MS) {
    console.error(`FATAL: sweep-grace mismatch — this harness has GRACE_MS=${GRACE_MS}, but`)
    console.error(`server/src/pane/paneManager.ts has SWEEP_GRACE_MS=${serverGrace}.`)
    console.error('UPDATE BOTH so they agree. Do not just make this file sleep longer: the two')
    console.error('numbers are one fact. If the server grace GREW, every reload assertion in this')
    console.error('file has been running vacuously since the change.')
    process.exit(1)
  }
}
const VIEW = { width: 1440, height: 900 }

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0, passed = 0
const ok = (tag, name, cond, extra = '') => {
  cond ? passed++ : failed++
  console.log(`  ${cond ? '✅' : '❌'} [${tag}] ${name}${extra ? ` — ${extra}` : ''}`)
}

const DATA = await mkdtemp(join(tmpdir(), 'rsurv-data-'))
const PROJ = await mkdtemp(join(tmpdir(), 'rsurv-proj-'))
const BIN = await mkdtemp(join(tmpdir(), 'rsurv-bin-'))

// Each pane gets its OWN cwd so the shell shim can stamp a pane-identifying marker into
// the pty's scrollback at spawn. That marker is how the reattach assertion proves the
// browser replayed THIS pane's pre-reload output rather than merely rendering a terminal.
const DIR_A1 = join(PROJ, 'p-a1'), DIR_A2 = join(PROJ, 'p-a2'), DIR_B1 = join(PROJ, 'p-b1')
for (const d of [DIR_A1, DIR_A2, DIR_B1]) await mkdir(d, { recursive: true })

const PY = join(PROJ, 'demo.py')
await writeFile(PY, 'x = 1\nprint(x)\n')
const NB = join(PROJ, 'beta.ipynb')
await writeFile(NB, JSON.stringify({
  cells: [{ cell_type: 'code', source: ['print("beta notebook")\n'], metadata: {}, outputs: [], execution_count: null }],
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } },
  nbformat: 4, nbformat_minor: 5,
}, null, 1))

// The pane shell: paneManager spawns `process.env.SHELL`, and we own the server's env.
// A real interactive bash may or may not emit a prompt under a headless pty; this emits a
// deterministic marker and then parks, so the scrollback assertion has something exact to
// look for and the pty stays alive for the whole run.
const SHELL_SHIM = join(BIN, 'pane-shell')
await writeFile(SHELL_SHIM, `#!/bin/sh
printf 'PANE-MARKER %s\\r\\n' "\$(basename "\$PWD")"
while : ; do sleep 3600 ; done
`)
await chmod(SHELL_SHIM, 0o755)

// Stand-in `claude`: the sessions here are never messaged, they only need to exist and
// stay resolvable. No model, no flake.
await writeFile(join(BIN, 'claude'), `#!/usr/bin/env node
// Exit when the server that spawned us goes away. Parking on a timer alone left one of
// these reparented to init after every run — a harmless-looking orphan that still shows up
// in anyone's ps while they are diagnosing a real one.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.resume()
setTimeout(() => process.exit(0), 300000)
`)
await chmod(join(BIN, 'claude'), 0o755)

// ---- server ---------------------------------------------------------------------
const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: {
    ...process.env,
    PATH: `${BIN}:${process.env.PATH}`,
    SHELL: SHELL_SHIM,
    PORT: String(PORT), CLAUDETTE_TOKEN: TOKEN, CLAUDETTE_DATA_DIR: DATA,
    CLAUDETTE_ALLOW_UNSANDBOXED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let log = ''
server.stdout.on('data', (d) => (log += d))
server.stderr.on('data', (d) => (log += d))

const web = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
  cwd: 'web', env: { ...process.env, PORT: String(PORT), WEB_PORT: String(WEB_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let weblog = ''
web.stdout.on('data', (d) => (weblog += d))
web.stderr.on('data', (d) => (weblog += d))

// Reap EVERY child on EVERY exit path. Both e2e harnesses in this directory reaped only
// on the happy path, so every failing run minted an orphan (port-and-reap-lint.mts).
let chrome = null
// Kill the process GROUP, never the bare pid — which is why all three are spawned
// detached, since `-pid` needs a group to exist. Load-bearing for the wrapper children:
// `npx` forks the real node/vite, so a kill aimed at the wrapper can strand the port.
// For Chrome it is defence in depth ONLY. I first reported it here as a demonstrated
// 8-process orphan leak; that was one `ps` snapshot ~2s after exit, catching Chrome
// mid-teardown. Controlled sampling at t+1/2/4/8/15/30s found 0 survivors with the bare
// kill too. Keeping the group form for uniformity, not because a leak was shown.
const reapAll = () => {
  for (const p of [server, web, chrome]) {
    if (!p) continue
    try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} }
  }
}
process.on('exit', reapAll)
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapAll(); if (e) console.error(e); process.exit(1) })
}

for (let i = 0; i < 90 && !log.includes('Server listening'); i++) await wait(500)
if (!log.includes('Server listening')) { console.error(log.slice(-2000)); throw new Error('server did not start') }
for (let i = 0; i < 90 && !weblog.includes('ready in'); i++) await wait(500)
if (!weblog.includes('ready in')) { console.error(weblog.slice(-2000)); throw new Error('vite did not start') }
console.log('server + vite up')

const hdr = { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` }
const apiPost = (p, body) => fetch(`${API}${p}`, { method: 'POST', headers: hdr, body: JSON.stringify(body) }).then((r) => r.json())
const apiGet = (p) => fetch(`${API}${p}`, { headers: hdr }).then((r) => r.json())

// ---- fixture --------------------------------------------------------------------
const mkSession = (name) => apiPost('/api/session/create', { name, cwd: PROJ, rootDir: PROJ, sandbox: { enabled: false, mounts: [] } })
const alpha = await mkSession('Alpha')
const beta = await mkSession('Beta')

// PRECONDITION, asserted rather than assumed. H6 needs the notebook to live under the
// session that is NOT active, and the store defaults the selection to sessions[0]
// (sessionReducer.ts:196). If the server ever stops listing in creation order, H6 would
// quietly start testing the opposite of what it claims — so this is a named check, not a
// comment.
const listed = await apiGet('/api/session/list')
const order = (listed.sessions ?? listed).map((s) => s.id)
ok('today', 'precondition: Alpha is sessions[0], so Alpha is the ACTIVE session and Beta owns the notebook',
  order[0] === alpha.id, `sessions[0]=${order[0]?.slice(0, 8)} alpha=${alpha.id.slice(0, 8)}`)

const mkPane = (cwd, sessionId) => apiPost('/api/pane/create', { cwd, cols: 80, rows: 24, sessionId })
const A1 = (await mkPane(DIR_A1, alpha.id)).id
const A2 = (await mkPane(DIR_A2, alpha.id)).id
const B1 = (await mkPane(DIR_B1, beta.id)).id
const bornAt = Date.now()
const DEAD = '00000000-dead-4000-8000-000000000000'   // never existed; the H4 fixture's dead half
console.log(`panes: A1=${A1.slice(0, 8)} A2=${A2.slice(0, 8)} B1=${B1.slice(0, 8)} dead=${DEAD.slice(0, 8)}`)

// ---- chrome / CDP ---------------------------------------------------------------
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
if (!existsSync(CHROME)) { console.error(`no Chrome at ${CHROME} (set CHROME_BIN)`); process.exit(1) }
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-rsurv-'))
chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--window-size=${VIEW.width},${VIEW.height}`, 'about:blank',
], { stdio: 'pipe', detached: true })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await wait(250)
  }
  throw new Error('no CDP target')
}
const cdp = new WebSocket(await cdpTarget())
await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej) })
let cdpId = 0
const pendingCdp = new Map()
// A CDP reply is awaited on a promise that ONLY the socket can resolve, so if Chrome dies
// mid-run — crash, OOM, or an external pkill — every pending send() hangs forever and the
// harness sleeps in ep_poll holding its ports. That is not hypothetical: it happened here,
// and the next run failed with "server did not start" pointing at an innocent edit. Turn a
// dead socket into a loud failure instead of a silent squatter.
cdp.on('close', () => { console.error('CDP socket closed — Chrome died; aborting rather than hanging'); reapAll(); process.exit(1) })
cdp.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.id && pendingCdp.has(m.id)) { pendingCdp.get(m.id)(m); pendingCdp.delete(m.id) }
})
const send = (method, params = {}) => {
  const id = ++cdpId
  cdp.send(JSON.stringify({ id, method, params }))
  return new Promise((res) => pendingCdp.set(id, res))
}
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
async function waitFor(expr, ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) }
  return false
}

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false })

// H4 is an ORDERING property, not a state one, so record the order. Installed on every new
// document (so it survives the Page.reload) and reset with each, which is what makes the log
// read in block [2] contain only the post-reload load. Both calls go over HTTP —
// api/client.ts routes pane list/prune through get/post while input/resize go over the WS —
// so wrapping fetch sees all of it.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
window.__ord = []
window.__att = []
const __of = window.fetch
window.fetch = function (u, o) {
  const url = String((u && u.url) || u)
  const kind = url.includes('/api/pane/list') ? 'list' : url.includes('/api/pane/prune') ? 'prune'
    : url.includes('/api/pane/attach') ? 'attach' : null
  if (!kind) return __of.apply(this, arguments)
  // Attach also records what the RESPONSE carried, so "how many times did we replay" and
  // "how many markers did each replay bring" are separable without reading server logs.
  if (kind === 'attach') {
    const q = __of.apply(this, arguments)
    q.then((r) => r.clone().json()).then((j) => {
      window.__att.push(((j && j.data ? j.data : '').match(/PANE-MARKER p-a1/g) || []).length)
    }).catch(() => window.__att.push(-1))
    window.__ord.push('attach:start')
    return q
  }
  window.__ord.push(kind + ':start')
  const p = __of.apply(this, arguments)
  p.then(() => window.__ord.push(kind + ':done'), () => window.__ord.push(kind + ':fail'))
  return p
}
` })

// Auth first (same origin), so the seed below lands in the origin the app will read.
await send('Page.navigate', { url: `${APP}/api/auth?token=${TOKEN}` })
await wait(1200)

// ---- seed the persisted layout --------------------------------------------------
// Alpha: two LIVE panes plus one DEAD id (an id with no pty behind it) — the mix H4's
// fixture needs, and the only way to tell "reconciled" from "restored verbatim". Beta:
// one live pane, so terminal survival is also checked for a session that is NOT on
// screen. Beta also owns the only notebook tab; Alpha owns a plain file tab, so "Alpha
// gained a notebook" is a tab-count change and not a judgement call.
const LAYOUT = {
  v: 1,
  layout: 'side',
  sizes: { sideW: 420, stackH: 280, dockW: 320, termH: 240, sidebarW: 288 },
  seq: 10,
  terms: {
    [alpha.id]: { open: true, active: 't1', terms: [
      { key: 't1', paneId: A1, cwd: DIR_A1 },
      { key: 't2', paneId: A2, cwd: DIR_A2 },
      { key: 't3', paneId: DEAD, cwd: DIR_A1 },
    ] },
    [beta.id]: { open: true, active: 't4', terms: [{ key: 't4', paneId: B1, cwd: DIR_B1 }] },
  },
  content: {
    [alpha.id]: { active: `f:${PY}`, tabs: [{ kind: 'file', path: PY }] },
    [beta.id]: { active: `n:${NB}`, tabs: [{ kind: 'notebook', path: NB }] },
  },
}
await evaluate(`(() => {
  localStorage.setItem('claudette:layout:v1', ${JSON.stringify(JSON.stringify(LAYOUT))});
  sessionStorage.setItem('claudette.clientId', ${JSON.stringify(CLIENT_ID)});
  return true })()`)

// Page-side readers. Terminal tabs are the spans reading "Terminal N" in the dock's tab
// strip; the visible xterm is the one mounted for the active terminal of the active
// session (every other one renders inside a `hidden` container).
const HELPERS = `
window.__rs = {
  termTabs() {
    return [...document.querySelectorAll('span')].filter((s) => /^Terminal \\d+$/.test(s.textContent || '')).length
  },
  xtermText() {
    const rows = [...document.querySelectorAll('.xterm-rows')]
    return rows.map((r) => r.innerText || r.textContent || '').join('\\n')
  },
  layout() { try { return JSON.parse(localStorage.getItem('claudette:layout:v1')) } catch { return null } },
  tabsOf(sid) { const c = this.layout()?.content?.[sid]; return c ? c.tabs : null },
  termIdsOf(sid) {
    const t = this.layout()?.terms?.[sid]
    return t ? t.terms.map((x) => x.paneId) : null
  },
}; true`

const boot = async () => {
  const up = await waitFor(`!!document.querySelector('aside') || !!document.querySelector('textarea')`, 40000)
  if (!up) { console.error('app never rendered'); console.error(weblog.slice(-1500)); reapAll(); process.exit(1) }
  await evaluate(HELPERS)
  await wait(2500)   // reconcile round-trip + notebook reopen + the layout re-persist
}

await send('Page.navigate', { url: `${APP}/` })
await boot()

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[1] first load — restore from the seeded layout (PRE-GRACE)')
// These are NOT the load-bearing checks and must not be read as such. Every pane here is
// seconds old, so SWEEP_GRACE_MS protects it no matter what the client posts: nothing in
// this block can detect a pane-killing regression. What it CAN detect is grace-independent
// damage, and that is what makes it worth running: with H5 broken this block goes red
// immediately, while with H3 broken it stays fully green. That difference is the only
// thing here that tells those two hazards apart — see the header.
// ═══════════════════════════════════════════════════════════════════════════════
{
  const tabs = await evaluate(`window.__rs.termTabs()`)
  ok('today', 'restored dock shows Alpha 2 terminals (the dead entry dropped by reconcile)', tabs === 2, `${tabs} tabs`)
  const ids = await evaluate(`window.__rs.termIdsOf(${JSON.stringify(alpha.id)})`)
  ok('today', 'the dead pane id is gone from the re-persisted layout', Array.isArray(ids) && !ids.includes(DEAD), JSON.stringify(ids?.map((i) => i?.slice(0, 8))))
  const live = (await apiGet('/api/pane/list')).panes.map((p) => p.id)
  ok('today', 'pre-grace: all three live ptys still exist', [A1, A2, B1].every((i) => live.includes(i)), `${live.length} live`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// ★ AGE THE FIXTURE. DO NOT REMOVE. Read the header. ★
// ═══════════════════════════════════════════════════════════════════════════════
const age = Date.now() - bornAt
const sleepFor = GRACE_MS + 1500 - age
console.log(`\n… aging the panes past SWEEP_GRACE_MS (${Math.max(0, Math.ceil(sleepFor / 1000))}s) — without this every check below is vacuous`)
if (sleepFor > 0) await wait(sleepFor)
const liveBeforeReload = (await apiGet('/api/pane/list')).panes.map((p) => p.id)
ok('today', 'aged past the grace window and still alive (the standing claim held them)',
  [A1, A2, B1].every((i) => liveBeforeReload.includes(i)), `age=${Math.round((Date.now() - bornAt) / 1000)}s`)

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[2] RELOAD past the grace window — the load-bearing block')
// Same tab, same sessionStorage, same clientId. Page.reload, not a fresh navigate.
// ═══════════════════════════════════════════════════════════════════════════════
await send('Page.reload', { ignoreCache: true })
await boot()

{
  const live = (await apiGet('/api/pane/list')).panes.map((p) => p.id)
  // H3 / H5 family. A regression in either posts a keep-set that is empty or missing
  // entries, and past the grace the server kills what nobody claims. One red here does
  // NOT say which hazard broke — see the header.
  ok('today', 'H3/H5 family: Alpha terminal 1 survived the reload', live.includes(A1))
  ok('today', 'H3/H5 family: Alpha terminal 2 survived the reload', live.includes(A2))
  ok('today', 'H3/H5 family: the BACKGROUND session Beta kept its terminal too', live.includes(B1))
  ok('today', 'the dead id did not resurrect as a pty', !live.includes(DEAD))

  const tabs = await evaluate(`window.__rs.termTabs()`)
  ok('today', 'the tab strip shows both of Alpha terminals after the reload', tabs === 2, `${tabs} tabs`)

  const aIds = await evaluate(`window.__rs.termIdsOf(${JSON.stringify(alpha.id)})`)
  const bIds = await evaluate(`window.__rs.termIdsOf(${JSON.stringify(beta.id)})`)
  ok('today', 'Alpha layout still holds exactly its two live pane ids',
    Array.isArray(aIds) && aIds.length === 2 && aIds.includes(A1) && aIds.includes(A2), JSON.stringify(aIds?.map((i) => i?.slice(0, 8))))
  ok('today', 'Beta layout still holds its one live pane id',
    Array.isArray(bIds) && bIds.length === 1 && bIds[0] === B1, JSON.stringify(bIds?.map((i) => i?.slice(0, 8))))

  // Reattach: the pty's PRE-RELOAD output must be replayed into the fresh xterm. The
  // marker is stamped per-pane (each pane has its own cwd), so this also proves the
  // right pane was reattached — not merely that a terminal is on screen.
  const replayed = await waitFor(`(window.__rs.xtermText() || '').includes('PANE-MARKER p-a1')`, 15000)
  ok('today', 'the reattached xterm replayed THIS pane pre-reload scrollback', replayed,
    replayed ? '' : (await evaluate(`(window.__rs.xtermText() || '').slice(0, 200)`)))

  // …and EXACTLY ONCE. `includes()` above is blind to the failure it is most likely to
  // meet: the attach snapshot is the WHOLE buffer rather than a delta, so an effect that
  // runs twice on one instance replays it twice and `includes` stays green over a visibly
  // doubled screen. The shim prints this marker exactly once per pane, so the count is
  // exact. TerminalView's attach now clears first (see its ATTACH comment); this is the
  // assertion that says so.
  // The detail reports PER `.xterm-rows` ELEMENT, not just the total. xtermText() joins
  // every xterm in the document, so a total of 2 has two very different causes: one
  // terminal that replayed twice (the idempotence bug this asserts) or two mounted
  // terminals that both contain the marker (a harness artefact — nothing to do with
  // TerminalView). A bare total cannot tell them apart and would send the reader to the
  // wrong file.
  // FIRST attribute the doubling: is it the CLIENT replaying twice, or was the pty's own
  // server-side buffer already doubled? `/api/pane/attach` is two pure reads
  // (`{ data: panes.snapshot(id), alive: panes.has(id) }`), so asking it costs nothing and
  // settles in one number which file to open. The shim prints the marker once and then
  // sleeps forever, so anything above 1 here is a server-side buffer problem and
  // TerminalView is not involved at all.
  const snapMarkers = await apiPost('/api/pane/attach', { id: A1 })
    .then((r) => ((r.data || '').match(/PANE-MARKER p-a1/g) || []).length)
    .catch(() => -1)
  const attachLog = await evaluate(`(window.__att || []).slice()`)

  const markerSpread = await evaluate(
    `[...document.querySelectorAll('.xterm-rows')].map((r) => ((r.innerText || r.textContent || '').match(/PANE-MARKER p-a1/g) || []).length)`)
  const markerCount = Array.isArray(markerSpread) ? markerSpread.reduce((a, b) => a + b, 0) : -1
  ok('today', '…and replayed it ONCE, not twice (attach is idempotent)', markerCount === 1,
    `marker appears ${markerCount}× across ${Array.isArray(markerSpread) ? markerSpread.length : '?'} xterm element(s): [${markerSpread}]; the SERVER pty snapshot has it ${snapMarkers}× (>1 ⇒ not a client bug); attach replies carried [${attachLog}]`)

  // H4 — the ONE thing the state-shaped fixture cannot see (see the header entry). The
  // two-flag form posts pane.list and does not prune until it has returned; the one-flag
  // form fires the claim effect on mount and prunes AHEAD of the list. Both end in the same
  // keep-set, so only the order tells them apart.
  const ord = await evaluate(`(window.__ord || []).slice()`)
  const firstListDone = Array.isArray(ord) ? ord.indexOf('list:done') : -1
  const firstPrune = Array.isArray(ord) ? ord.indexOf('prune:start') : -1
  // Named for BOTH conjuncts on purpose. It asserts "a prune was posted AND only after the
  // list returned", so a run where no prune fires at all reds too — correctly, since that is
  // also a broken reconcile. Naming it "no prune before the list" would send the reader
  // hunting an early prune that never happened.
  ok('today', 'H4: a pane.prune is posted, and only after the reconcile list returned',
    firstListDone >= 0 && firstPrune > firstListDone,
    Array.isArray(ord) ? ord.join(' → ') : String(ord))

  // H6 — cleanly attributable, no grace dependency. Beta's notebook is reopened by path
  // during restore and marked seen; if that marking is lost, the newly-opened effect
  // attaches it to whatever session is ACTIVE, which is Alpha.
  const aTabs = await evaluate(`window.__rs.tabsOf(${JSON.stringify(alpha.id)})`)
  const bTabs = await evaluate(`window.__rs.tabsOf(${JSON.stringify(beta.id)})`)
  ok('today', 'H6: Beta got its notebook back', Array.isArray(bTabs) && bTabs.some((t) => t.kind === 'notebook' && t.path === NB), JSON.stringify(bTabs))
  ok('today', 'H6: Alpha did NOT gain Beta notebook', Array.isArray(aTabs) && !aTabs.some((t) => t.kind === 'notebook'), JSON.stringify(aTabs))
}

// Print the holes with the results, so a green run cannot be read as "all six hazards
// covered". A green here means H3, H4, H5 and H6 are covered and the other two are not.
console.log(`
labelled holes — NOT covered here, and deliberately not proxied:
  H1  publishedRef (App.tsx ~301-317): reload survival never exercises the activePane
      dedupe cache. No honest proxy exists in this harness.
  H2  sessionIdKey (App.tsx ~441-443): unobservable by construction — updaters return
      prev and prunes are idempotent, so a violation yields identical state. Review-time
      invariant, guarded by the dependency array and the eslint-disable beside it.

covered — every one DEMONSTRATED by breaking the code (see FALSIFIABILITY LOG in the header):
  DEMONSTRATED by breaking the code and measuring the red:
  H3  keep built outside the updater · H5  the empty-session-list guard · H6  seenNb
  H4  the two reconcile flags — by CALL ORDER, not by state. The state-shaped fixture is
      green on the break (both versions converge, because the reconcile's own prune at
      App.tsx:478 is unconditional), so the order assertion is what discriminates them:
      16/1 on the break, 17/0 restored. See the FALSIFIABILITY LOG.`)

console.log(`\n${passed} passed, ${failed} failed`)
reapAll()
process.exit(failed ? 1 : 0)
