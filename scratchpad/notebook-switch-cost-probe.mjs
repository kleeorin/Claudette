// notebook-switch-cost-probe — HOW MUCH does a session switch cost when a notebook is open,
// and does that cost scale with the number of CODE cells?
//
// This is a MEASUREMENT, not a test and not a fix. It asserts nothing about whether the
// number is acceptable; it exists so that a decision between three candidate fixes is made
// against a number instead of a reading. Exit code is 0 whenever the measurement itself
// succeeded — a slow app is a result, not a failure. It exits non-zero only when it could
// not measure (no Chrome, no server, a fixture that never rendered), because "I could not
// verify" must never be spelled the same way as "I verified".
//
// Run:  node scratchpad/notebook-switch-cost-probe.mjs
//
// ── THE HYPOTHESIS UNDER TEST ─────────────────────────────────────────────────────────
// App.tsx builds `contentNode` for the ACTIVE tab only, so a session switch UNMOUNTS the
// whole NotebookView and mounts a new one — unlike the terminals a few hundred lines below,
// which deliberately keep every session's TerminalView mounted and toggle `hidden`.
// NotebookView renders every cell with no virtualization, and notebook/Cell.tsx constructs
// a `new EditorView` per CODE cell (markdown cells skip it while rendered).
// PREDICTION: cost linear in code-cell count, roughly symmetric away/back.
// A FLAT result refutes it, and a refutation is the more valuable outcome here — it would
// mean all three candidate fixes are aimed at the wrong thing. (Measured: linear, yes;
// symmetric, no. See the results block below.)
//
// ── WHAT IT MEASURED, 2026-08-29 (3 runs, headless Chrome 152, 6 round trips per fixture) ─
// The hypothesis is CONFIRMED in its main claim and REFUTED in one part of it.
//
//   fixture              switch away        switch back        editors built returning
//   no notebook tab          2-3 ms             2 ms                     0
//   1 code cell              3 ms               4-5 ms                   1
//   10 code cells            4 ms               17-18 ms                10
//   50 code cells            5 ms               129-135 ms              50
//   10 markdown cells        2 ms               4-5 ms                   0
//   50 markdown cells        2-3 ms             10-16 ms                 0
//
// 1. LINEAR IN CODE-CELL COUNT. Net of the 2 ms bare switch, the cost is 1.5-2.7 ms per code
//    cell across 1, 10 and 50 cells — a 1.7-1.8× spread in per-cell cost over a 50× range in
//    cell count. Flat would have shown per-cell cost falling ~50×. It does not.
// 2. IT IS EditorView CONSTRUCTION, not React re-rendering. 50 markdown cells cost 10-16 ms
//    and build ZERO editors; 50 code cells cost 129-135 ms and build 50. Same cell count,
//    same source text, ~10× the cost, and the only difference is that markdown cells skip
//    the editor while rendered.
// 3. ★ IT IS NOT SYMMETRIC, and this part of the hypothesis is REFUTED. Switching AWAY is
//    flat at 2-5 ms regardless of cell count — tearing 50 editors down is nearly free.
//    ALL of the cost is on the way BACK, in construction. This matters for the fix: it is
//    one-directional, so it is felt only when returning to the session with the notebook.
// 4. The whole cost is main-thread BLOCK, not waiting. The longest gap between polls equals
//    the total elapsed time in every fixture, so 133 ms at 50 cells is 133 ms of frozen UI,
//    not 133 ms of a pending fetch.
//
// Absolute numbers are an upper bound (headless, --disable-gpu). The shape is not.
// ── WHAT IS MEASURED, PRECISELY ───────────────────────────────────────────────────────
// Per switch, three numbers:
//   ms       click on the session row → the DOM has reached the expected state. This is the
//            interval the operator experiences as "switching is slow".
//   maxGap   the longest gap between consecutive polls during that interval. The poll is a
//            setTimeout(0) loop, so a gap of 300ms means the main thread was BLOCKED for
//            300ms — this is the jank, as distinct from the total.
//   built    how many `.cm-editor` nodes were ADDED to the document during the switch, and
//            `torn` how many were REMOVED, counted by a MutationObserver.
//
// ★ WHY A MutationObserver RATHER THAN A COUNTER PATCHED INTO Cell.tsx. The obvious way to
// count EditorView constructions is to patch a counter into a copy of Cell.tsx — but this
// probe drives the BUILT bundle in `web/dist`, so a source patch would need a rebuild, and
// rebuilding is both someone else's file and would bake in another session's half-finished
// refactor. Counting `.cm-editor` nodes appearing in the DOM measures the shipped artifact
// with nothing patched at all: CodeMirror creates exactly one such node per EditorView, so
// the count is the construction count. It is strictly better evidence than the patch would
// have been, not a compromise — and it is the difference between "N present" and "N torn
// down and N rebuilt", which is the whole question.
//
// ── WHAT THIS RUN IS AND IS NOT EVIDENCE ABOUT ────────────────────────────────────────
// • It drives `web/dist`, the BUILT bundle. At the time of writing dist was built before
//   HEAD, but the only commit to `web/src` in between touched FileEditorView's review path
//   and NOTHING on the notebook render path (App.tsx's contentNode, NotebookView,
//   notebook/Cell.tsx) — checked with `git log --since=<dist mtime> -- <those paths>`, which
//   returned empty. So the stale bundle is measurement-equivalent FOR THIS QUESTION. That is
//   a narrower claim than "dist is fresh" and it is the one that is true. RE-CHECK IT before
//   trusting a later run; uncommitted `web/src` edits are in NO build.
// • Headless Chrome with --disable-gpu is SLOWER than the operator's real browser. Absolute
//   numbers are an upper bound on a desktop and are not a user-facing latency figure. The
//   SHAPE across cell counts is what this probe is for, and the shape is not affected.
// • The sessions and the notebook are SYNTHETIC — injected as server frames through the
//   page's own WebSocket, the mechanism notebook-session-test.mjs uses. No kernel, no
//   jupyter, no .ipynb on disk. That is deliberate: it makes cell count a free variable, and
//   the mount cost this probe measures does not depend on where the doc came from.
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4501
const DEVTOOLS = 9364
const APP = `http://127.0.0.1:${PORT}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const die = (msg, extra = '') => { console.error(`\n[could not measure] ${msg}${extra ? '\n' + extra : ''}`); process.exit(2) }

// --- our own server, and PROVEN to be ours -------------------------------------------
// Isolated data dir: without one the server relaunches every persisted session from the
// operator's real ~/.config/claudette, spawning a `claude` per entry before it ever listens.
// And a 200 on a fixed port proves nothing about WHOSE server answered — wait for our own
// child's ready line instead. Both lessons are notebook-ui-e2e.mjs's, paid for there.
const dataDir = await mkdtemp(join(tmpdir(), 'nbswitch-data-'))
const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: (() => {
    const e = { ...process.env, CLAUDETTE_NO_AUTH: '1', CLAUDETTE_DATA_DIR: dataDir,
                PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production' }
    delete e.CLAUDETTE_TOKEN   // resolveAuth checks the token FIRST, so NO_AUTH is inert while it is set
    return e
  })(),
  cwd: process.cwd(), stdio: 'pipe', detached: true,
})
let ownLog = '', exited = null
server.stdout.on('data', (d) => { ownLog += d })
server.stderr.on('data', (d) => { ownLog += d })
server.on('exit', (c) => { exited = c })

// ★ CHROME_BIN, AND WHY A CONFINED SESSION MUST SET IT. `/usr/bin/google-chrome` on this
// machine is a symlink chain ending at `/opt/google/chrome/google-chrome`, and `/opt` is
// outside a sandboxed session's mounts — so from inside a box the symlink resolves to
// nothing and `spawn` fails with ENOENT on a path that plainly exists. That reads exactly
// like "Chrome is not installed", which is false and would send the next person hunting.
// It is a MOUNT gap, not a missing package. Two ways out: have the operator mount `/opt`,
// or fetch a private browser, which needs no permission at all and is what this was
// measured with:
//   mkdir -p /tmp/qa-chrome && (cd /tmp/qa-chrome && npx @puppeteer/browsers install chrome@stable)
//   CHROME_BIN=/tmp/qa-chrome/chrome/linux-*/chrome-linux64/chrome node scratchpad/notebook-switch-cost-probe.mjs
// `/tmp` is per-sandbox private, so every session needs its own copy.
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-nbswitch-'))
const chromeBin = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
const chrome = spawn(chromeBin, [
  '--headless=new', `--remote-debugging-port=${DEVTOOLS}`, `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
  // Timer throttling would make the poll loop below report gaps that are Chrome's
  // background policy rather than the app's work — measuring the harness, not the subject.
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  'about:blank',
], { stdio: 'pipe', detached: true })
// A failed spawn arrives as an 'error' EVENT, not a throw: without this handler it lands on
// the unhandledRejection hook below as a raw stack, which buries the one line that matters.
chrome.on('error', (e) => die(
  `could not start Chrome at ${chromeBin} (${e.code ?? e.message})`,
  e.code === 'ENOENT'
    ? '  The path may exist but resolve outside this sandbox — see the CHROME_BIN note in the header.'
    : ''))

// Reap by process GROUP on EVERY exit path. `npx` forks the real node, so killing the
// wrapper by pid strands the port; and reaping only on the happy path is how this directory
// came to leave a detached server holding a fixed port for hours, which then reports as
// "server exited before listening" on the next run. See scratchpad/port-and-reap-lint.mts.
const reapChrome = () => { try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} } }
const reapServer = () => { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
process.on('exit', () => { reapChrome(); reapServer() })
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapChrome(); reapServer(); if (e) console.error(e); process.exit(2) })
}

let owned = false
for (let i = 0; i < 100; i++) {
  if (/Claudette server ready/.test(ownLog)) { owned = true; break }
  if (exited !== null) break
  await wait(250)
}
if (!owned) die(`our server never reported ready (exit=${exited})`, ownLog.slice(-1500) || '(no output)')

// --- CDP -----------------------------------------------------------------------------
let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null
  } catch {}
  if (!wsUrl) await wait(250)
}
if (!wsUrl) die('no CDP target — is Chrome installed? (CHROME_BIN overrides the path)')

const cdp = new WebSocket(wsUrl)
await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej) })
let cdpId = 0
const pending = new Map()
let cdpDone = false
// Every pending send() is resolved only by the socket, so a dead Chrome hangs this process
// forever holding its ports. Abort loudly instead of sleeping in ep_poll.
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died'); process.exit(2) })
cdp.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => { const id = ++cdpId; return new Promise((res) => { pending.set(id, res); cdp.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error('page eval threw: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400))
  return r.result?.result?.value
}
async function waitFor(expr, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(150) }
  throw new Error(`timeout waiting for: ${expr}`)
}

// Capture the app's own socket so server frames can be injected into it. Installed before
// any navigation so it is in place for the page's very first WebSocket construction.
const SHIM = `
  const RealWS = window.WebSocket;
  class CapWS extends RealWS { constructor(...a) { super(...a); if (String(a[0]).includes('/ws')) window.__appws = this } }
  window.WebSocket = CapWS;
`
await send('Page.enable')
await send('Runtime.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })

// --- the in-page instrument ----------------------------------------------------------
// `.cm-editor` is created exactly once per `new EditorView`, so counting the nodes added and
// removed across a switch IS the construction/destruction count.
const INSTRUMENT = `
// ★ COUNTS DISTINCT ELEMENTS, NOT MUTATION RECORDS, AND THE DIFFERENCE IS NOT PEDANTRY.
// The first version of this counter tallied every '.cm-editor' seen in an addedNodes list,
// and reported exactly 2× the cell count on every switch back — which looked like a real
// and important finding: "the app builds two editors per cell". It is not. ONE editor is
// observed TWICE: once when EditorView inserts its own '.cm-editor' into the cell's host
// div, and again when React attaches an ancestor of that host to the document, at which
// point the observer sees the whole subtree arrive. Two records, one element.
// The tell was arithmetic, and it is worth remembering because it is the only reason this
// was caught: the run reported 100 built and 0 torn, yet the readiness predicate had just
// confirmed exactly 50 '.cm-editor' nodes in the document. 100 added minus 0 removed cannot
// leave 50. A number that cannot be true of the DOM it claims to describe is a bug in the
// instrument, and a plausible one would have been reported as a finding.
window.__probe = {
  built: null, torn: null, obs: null,
  reset() { this.built = new Set(); this.torn = new Set() },
  collect(nodes, into) {
    for (const nd of nodes) {
      if (nd.nodeType !== 1) continue
      if (nd.matches && nd.matches('.cm-editor')) into.add(nd)
      if (nd.querySelectorAll) for (const e of nd.querySelectorAll('.cm-editor')) into.add(e)
    }
  },
  install() {
    if (this.obs) return true
    this.reset()
    this.obs = new MutationObserver((muts) => {
      for (const m of muts) { this.collect(m.addedNodes, this.built); this.collect(m.removedNodes, this.torn) }
    })
    this.obs.observe(document.body, { childList: true, subtree: true })
    return true
  },
}
window.__cm = () => document.querySelectorAll('.cm-editor').length
window.__cells = () => document.querySelectorAll('[data-cell-id]').length
// The active session row carries \`bg-ctp-surface0\` as a class TOKEN. Matched with
// classList.contains, never a substring test on className: the INACTIVE rows carry
// \`hover:bg-ctp-surface0/50\`, which contains that string, so a substring match would call
// every row active and the readiness predicate would be satisfied before the switch began.
window.__activeIs = (name) => {
  const row = [...document.querySelectorAll('div')].find((d) =>
    d.classList.contains('cursor-pointer') && d.textContent && d.textContent.includes(name))
  return !!row && row.classList.contains('bg-ctp-surface0')
}
window.__clickSession = (name) => {
  const row = [...document.querySelectorAll('div')].find((d) =>
    d.classList.contains('cursor-pointer') && d.textContent && d.textContent.includes(name))
  if (!row) return false
  row.click()
  return true
}
// Click, then poll until the DOM has reached the expected state. The poll is setTimeout(0)
// rather than requestAnimationFrame ON PURPOSE: rAF is throttled for a headless page that is
// never composited, which would have measured Chrome's frame policy instead of the app's
// work. The gap between consecutive polls is therefore a direct read of main-thread blocking.
window.__switch = async (name, readySrc) => {
  const ready = new Function('return (' + readySrc + ')')()
  window.__probe.reset()
  const t0 = performance.now()
  if (!window.__clickSession(name)) {
    const rows = [...document.querySelectorAll('div')].filter((d) => d.classList.contains('cursor-pointer'))
    return { error: 'no session row named ' + name + ' (rows present: ' +
      JSON.stringify(rows.map((r) => (r.textContent || '').slice(0, 24))) + ')' }
  }
  let last = t0, maxGap = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 0))
    const now = performance.now()
    if (now - last > maxGap) maxGap = now - last
    last = now
    if (ready()) return { ms: now - t0, maxGap, built: window.__probe.built.size, torn: window.__probe.torn.size }
    if (now - t0 > 30000) return { error: 'switch to ' + name + ' never reached the expected DOM state' }
  }
}
`

// --- fixtures -------------------------------------------------------------------------
const SESSIONS = [
  { id: 'sA', name: 'alpha-session', cwd: '/tmp', rootDir: '/tmp', state: 'idle' },
  { id: 'sB', name: 'beta-session', cwd: '/tmp', rootDir: '/tmp', state: 'idle' },
]
const mkDoc = (kind, n) => ({
  notebookId: 'nb1', path: '/tmp/probe.ipynb', version: 1, dirty: false, conflict: false,
  canUndo: false, canRedo: false, metadata: {}, kernelName: null,
  cells: Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    cellType: kind === 'md' ? 'markdown' : 'code',
    // Same source either way, so the two arms differ ONLY in cell type. A markdown arm
    // with shorter text would confound "markdown skips the editor" with "less to parse".
    source: `x${i} = ${i}\ny${i} = x${i} * 2\nprint(x${i} + y${i})`,
    outputs: [], executionCount: null, metadata: {},
  })),
})

const feed = (frame) => evaluate(`(() => { window.__appws.onmessage({ data: ${JSON.stringify(JSON.stringify(frame))} }); return true })()`)

async function setupFixture(kind, n) {
  // A fresh document per fixture: notebook docs and open tabs are global app state, and a
  // fixture that inherits the previous one's editors measures the wrong teardown.
  await send('Page.navigate', { url: `${APP}/` })
  await waitFor(`!!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Chat'))`)
  await waitFor(`!!window.__appws`)
  await evaluate(INSTRUMENT)
  await evaluate(`window.__probe.install()`)
  await feed({ type: 'session:list', sessions: SESSIONS })
  await waitFor(`window.__activeIs('alpha-session')`)
  if (kind === 'none') return { cm: 0, cells: 0 }
  await feed({ type: 'notebook:update', doc: mkDoc(kind, n) })
  await feed({ type: 'session:focusPane', id: 'sA', notebookId: 'nb1', path: '/tmp/probe.ipynb' })
  const wantCm = kind === 'code' ? n : 0
  await waitFor(`window.__cells() === ${n} && window.__cm() === ${wantCm}`)
  return { cm: wantCm, cells: n }
}

// Readiness predicates, as source strings evaluated in the page.
const readyOnB = `() => window.__activeIs('beta-session') && window.__cm() === 0 && window.__cells() === 0`
const readyOnA = (cells, cm) => `() => window.__activeIs('alpha-session') && window.__cells() === ${cells} && window.__cm() === ${cm}`

const ROUNDS = 7        // the first is discarded as warm-up; 6 measured round trips remain
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  return { min: s[0], med, max: s[s.length - 1] }
}
const f = (x) => x.toFixed(0).padStart(5)
const row = (label, st) => `${label.padEnd(26)} ${f(st.med)} ms   [${f(st.min)} … ${f(st.max)}]`

async function measure(label, kind, n) {
  const want = await setupFixture(kind, n)
  // ONE RUN IN THREE ABORTED HERE with "no session row named alpha-session", mid-loop, on a
  // fixture that had already switched successfully several times. The sessions are synthetic
  // — injected frames — so anything that makes the app re-read its real session list (an
  // empty one, from our own throwaway server) wipes them and the rows vanish. Rather than
  // let a measurement die of its own fixture, re-inject and retry once; if the retry also
  // fails, that is a different problem and it still aborts. Retries are COUNTED and printed,
  // because a fixture that needed re-seeding half the time would make the numbers suspect
  // and silently swallowing that is how a measurement starts lying.
  let reseeds = 0
  const doSwitch = async (target, readySrc) => {
    let r = await evaluate(`window.__switch(${JSON.stringify(target)}, ${JSON.stringify(readySrc)})`)
    if (r?.error && r.error.includes('no session row')) {
      reseeds++
      await feed({ type: 'session:list', sessions: SESSIONS })
      await wait(300)
      r = await evaluate(`window.__switch(${JSON.stringify(target)}, ${JSON.stringify(readySrc)})`)
    }
    return r
  }
  const away = [], back = [], awayGap = [], backGap = [] 
  const builtAway = [], tornAway = [], builtBack = [], tornBack = []
  for (let r = 0; r < ROUNDS; r++) {
    const a = await doSwitch('beta-session', readyOnB)
    if (a?.error) die(`fixture ${label}: ${a.error}`)
    const b = await doSwitch('alpha-session', readyOnA(want.cells, want.cm))
    if (b?.error) die(`fixture ${label}: ${b.error}`)
    if (r === 0) continue                       // warm-up: first mount pays for lazy chunks
    away.push(a.ms); awayGap.push(a.maxGap); tornAway.push(a.torn); builtAway.push(a.built)
    back.push(b.ms); backGap.push(b.maxGap); builtBack.push(b.built); tornBack.push(b.torn)
  }
  return {
    label, n, kind, reseeds,
    away: stats(away), back: stats(back),
    awayGap: stats(awayGap), backGap: stats(backGap),
    tornAway: stats(tornAway), builtAway: stats(builtAway),
    tornBack: stats(tornBack), builtBack: stats(builtBack),
  }
}

console.log(`\nnotebook switch cost — ${ROUNDS - 1} measured round trips per fixture, headless Chrome`)
console.log('(medians, with [min … max] across the round trips)\n')

const results = []
for (const [label, kind, n] of [
  ['no notebook tab', 'none', 0],
  ['code cells: 1', 'code', 1],
  ['code cells: 10', 'code', 10],
  ['code cells: 50', 'code', 50],
  ['markdown cells: 10', 'md', 10],
  ['markdown cells: 50', 'md', 50],
]) {
  const r = await measure(label, kind, n)
  results.push(r)
  console.log(`── ${label} ${'─'.repeat(Math.max(0, 52 - label.length))}`)
  console.log('  ' + row('A→B  (switch away)', r.away) + `   longest block ${f(r.awayGap.med)} ms`)
  console.log('  ' + row('B→A  (switch back)', r.back) + `   longest block ${f(r.backGap.med)} ms`)
  console.log(`  editors  A→B: ${r.builtAway.med} built / ${r.tornAway.med} torn` +
              `    B→A: ${r.builtBack.med} built / ${r.tornBack.med} torn` +
              (r.kind === 'code' && r.builtBack.med > r.n ? `   ← ${(r.builtBack.med / r.n).toFixed(0)}× the cell count` : ''))
  if (r.reseeds) console.log(`  ⚠ the session list was re-injected ${r.reseeds}× during this fixture (see the note in measure())`)
}

// --- the shape ------------------------------------------------------------------------
console.log('\n── shape ' + '─'.repeat(52))
const code = results.filter((r) => r.kind === 'code')
const none = results.find((r) => r.kind === 'none')
const md = results.filter((r) => r.kind === 'md')
const netBack = (r) => r.back.med - none.back.med
for (const r of code) {
  console.log(`  ${String(r.n).padStart(3)} code cells: back ${f(r.back.med)} ms, minus the ${f(none.back.med)} ms bare switch = ${f(netBack(r))} ms attributable to the notebook` +
              (r.n > 1 ? `  (${(netBack(r) / r.n).toFixed(1)} ms/cell)` : ''))
}
for (const r of md) {
  const peer = code.find((c) => c.n === r.n)
  console.log(`  ${String(r.n).padStart(3)} MARKDOWN cells: back ${f(r.back.med)} ms vs ${f(peer.back.med)} ms for the same count of code cells` +
              `  (markdown builds ${r.builtBack.med} editors, code builds ${peer.builtBack.med})`)
}
// PER-CELL cost, not a ratio against the 1-cell point. A ratio divides by a number only a
// few ms above the bare-switch floor, so timer noise there swings the headline figure
// (measured: 28.9× and 52.9× on two runs of the same build). Cost-per-cell is the same
// claim with a stable denominator: roughly CONSTANT per-cell means linear in total.
const perCell = code.map((r) => ({ n: r.n, per: netBack(r) / r.n }))
console.log('\n  net cost per code cell: ' + perCell.map((p) => `${p.n} cells → ${p.per.toFixed(1)} ms/cell`).join(' · '))
const pc = perCell.map((p) => p.per)
const spread = Math.max(...pc) / Math.max(0.01, Math.min(...pc))
console.log(`  A roughly CONSTANT ms/cell means the total is LINEAR in cell count; a total that`)
console.log(`  is flat would show ms/cell falling ~50× across this range. Spread here: ${spread.toFixed(1)}×.`)

cdpDone = true
try { cdp.close() } catch {}
console.log('\n[measured] this probe asserts nothing — read the shape line above.\n')
process.exit(0)
