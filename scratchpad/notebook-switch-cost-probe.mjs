// notebook-switch-cost-probe — HOW MUCH does a session switch cost when a notebook is open,
// and does that cost scale with the number of CODE cells?
//
// It began as a pure MEASUREMENT — it existed so a choice between three candidate fixes was
// made against a number instead of a reading — and the timings still are: a slow machine is
// a result, not a failure, so nothing here asserts on a millisecond count. Since the fix it
// measured landed (1bd56af) it also carries ONE structural assertion, at the bottom: a
// session switch must build and destroy zero cell editors. That is the invariant the fix
// established and it does not vary with hardware.
//
//   exit 0   measured, and the invariant holds
//   exit 1   a session switch rebuilt cell editors — the regression is back, or the
//            artifact under test predates the fix
//   exit 2   could not measure (no server, a fixture that never rendered)
//   exit 77  runtime skip: no browser. "I could not verify" must never be spelled the
//            same way as "I verified", in either direction.
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
// • It drives `web/dist`, the BUILT bundle, unless PROBE_MODE=dev.
//   ★ THAT CLAIM WENT STALE AND THE WAY IT WENT STALE IS THE WARNING. When the original
//   numbers were taken, dist predated HEAD but the only commit in between touched
//   FileEditorView, so the bundle was measurement-equivalent FOR THAT QUESTION — a narrower
//   claim than "dist is fresh", deliberately, and it was true. It stopped being true the
//   moment 1bd56af landed, because that commit changes the very code path this measures and
//   dist has not been rebuilt since. A run against dist today therefore measures the
//   PRE-FIX app and correctly exits 1. So: re-derive the claim, never inherit it. Run
//   `git log --since="$(date -r web/dist/index.html)" -- web/src/App.tsx
//   web/src/components/NotebookView.tsx web/src/components/notebook/` before quoting a
//   number, and remember uncommitted `web/src` edits are in NO build at all.
// • Headless Chrome with --disable-gpu is SLOWER than the operator's real browser. Absolute
//   numbers are an upper bound on a desktop and are not a user-facing latency figure. The
//   SHAPE across cell counts is what this probe is for, and the shape is not affected.
// • The sessions and the notebook are SYNTHETIC — injected as server frames through the
//   page's own WebSocket, the mechanism notebook-session-test.mjs uses. No kernel, no
//   jupyter, no .ipynb on disk. That is deliberate: it makes cell count a free variable, and
//   the mount cost this probe measures does not depend on where the doc came from.
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { readdirSync, realpathSync, accessSync, constants } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4501          // the backend
const WEB_PORT = 5501      // the vite dev server, PROBE_MODE=dev only
const DEVTOOLS = 9364
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const die = (msg, extra = '') => { console.error(`\n[could not measure] ${msg}${extra ? '\n' + extra : ''}`); process.exit(2) }
// A MISSING DEPENDENCY IS NOT A FAILURE, and must not be spelled like one. 77 is
// run-suite.sh's runtime-skip code: "I ran and could not verify". Exiting 2 for a machine
// with no browser would report a regression that was never measured.
const skip = (msg, extra = '') => { console.log(`\n[skip] ${msg}${extra ? '\n' + extra : ''}`); process.exit(77) }

// ── WHICH ARTIFACT AM I MEASURING? ────────────────────────────────────────────────────
// dist (default) — the built bundle in web/dist, which is what users actually run. Use this
//   for any number you intend to quote.
// dev            — a vite dev server over the WORKING TREE. Slower and unminified, so its
//   absolute timings are NOT comparable with dist's; what it is for is verifying a change
//   that is committed but not yet built. This probe's own fix-verification was done this
//   way, because web/dist lagged the fix by a rebuild that belonged to another session.
//   Compare dev against dev and dist against dist, never across.
const MODE = process.env.PROBE_MODE ?? 'dist'
if (MODE !== 'dist' && MODE !== 'dev') die(`PROBE_MODE must be 'dist' or 'dev', got ${JSON.stringify(MODE)}`)
const APP = MODE === 'dev' ? `http://127.0.0.1:${WEB_PORT}` : `http://127.0.0.1:${PORT}`

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

let vite = null   // only PROBE_MODE=dev assigns it; the exit reaper closes over it either way

// ★ RESOLVING A BROWSER, AND WHY THE OBVIOUS PATH IS A TRAP.
// `/usr/bin/google-chrome` on this machine is a symlink chain ending in
// `/opt/google/chrome/google-chrome`, and `/opt` is outside a sandboxed session's mounts —
// so from inside a box the link resolves to nothing and `spawn` fails with ENOENT on a path
// that plainly exists and that `ls` will happily show you. That reads as "Chrome is not
// installed", which is false, and it costs the next person an hour. It is a MOUNT gap.
// The repo now bundles a Chrome for Testing under `.chrome-headless/` (gitignored, so it is
// per-checkout) precisely because that is the only browser a confined session can reach.
// This resolution order is deliberately the SAME LIST run-suite.sh probes, so a standalone
// run and a suite run pick the same binary — a harness that quietly disagrees with the
// runner about which browser it used is a harness whose numbers cannot be compared.
// Failing to find one is a SKIP (77), never a failure: no browser means unmeasured, and
// unmeasured must not be spelled like a regression.
const CHROME_CANDIDATES = [
  ...(() => {
    try {
      return readdirSync('.chrome-headless/chrome')
        .map((d) => join('.chrome-headless/chrome', d, 'chrome-linux64/chrome'))
    } catch { return [] }
  })(),
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
]
const resolveChrome = () => {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN
  for (const c of CHROME_CANDIDATES) {
    // realpath FIRST: the dangling-symlink case above is exactly what a bare existsSync misses.
    try { const real = realpathSync(c); accessSync(real, constants.X_OK); return real } catch {}
  }
  return null
}
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-nbswitch-'))
const chromeBin = resolveChrome()
if (!chromeBin) skip('no browser: no usable Chrome found', [
  '  Looked at: ' + CHROME_CANDIDATES.join(', '),
  '  A path listed there can EXIST and still be unusable from a sandboxed session, because',
  '  the system Chrome is a symlink into /opt, which is outside our mounts. Fetch one:',
  '    npx @puppeteer/browsers install chrome@stable --path "$PWD/.chrome-headless"',
  '  or point CHROME_BIN at an existing copy.',
].join('\n'))
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
chrome.on('error', (e) => skip(
  `no browser: could not start Chrome at ${chromeBin} (${e.code ?? e.message})`,
  e.code === 'ENOENT'
    ? [
        '  The path may exist and still fail: /usr/bin/google-chrome is a symlink into /opt,',
        '  which is outside a sandboxed session\'s mounts, so it resolves to nothing from in',
        '  there. That is a MOUNT gap, not a missing package. Fetch a private browser:',
        '    mkdir -p /tmp/qa-chrome && (cd /tmp/qa-chrome && npx @puppeteer/browsers install chrome@stable)',
        '    CHROME_BIN=/tmp/qa-chrome/chrome/linux-*/chrome-linux64/chrome node scratchpad/notebook-switch-cost-probe.mjs',
        '  /tmp is per-sandbox private, so every session needs its own copy.',
      ].join('\n')
    : ''))

// Reap by process GROUP on EVERY exit path. `npx` forks the real node, so killing the
// wrapper by pid strands the port; and reaping only on the happy path is how this directory
// came to leave a detached server holding a fixed port for hours, which then reports as
// "server exited before listening" on the next run. See scratchpad/port-and-reap-lint.mts.
const reapChrome = () => { try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} } }
const reapServer = () => { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
// ★ AN EXIT HANDLER THAT THROWS REPLACES THE EXIT CODE IT WAS SUPPOSED TO PRESERVE.
// A refactor briefly left `vite` undeclared while this closure still referenced it. The run
// printed its three red assertions and reached `process.exit(1)` correctly — and then this
// handler threw on the way out, turning a clean, correct "regression detected" into an
// uncaught ReferenceError and exit 7. The verdict was right there in the output and the
// exit code disagreed with it. Reapers run on the failure path by definition, so anything
// they touch must be defined even in the modes that never create it.
const reapVite = () => { if (!vite) return; try { process.kill(-vite.pid, 'SIGKILL') } catch { try { vite.kill('SIGKILL') } catch {} } }
process.on('exit', () => { reapChrome(); reapServer(); reapVite() })
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapChrome(); reapServer(); reapVite(); if (e) console.error(e); process.exit(2) })
}

let owned = false
for (let i = 0; i < 100; i++) {
  if (/Claudette server ready/.test(ownLog)) { owned = true; break }
  if (exited !== null) break
  await wait(250)
}
if (!owned) die(`our server never reported ready (exit=${exited})`, ownLog.slice(-1500) || '(no output)')

// In dev mode the browser talks to vite, which proxies /api and /ws back to the server
// spawned above (web/vite.config.ts). Spawned AFTER the backend is confirmed ready so the
// proxy never races an absent upstream.
if (MODE === 'dev') {
  vite = spawn('npx', ['vite'], {
    cwd: join(process.cwd(), 'web'),
    env: { ...process.env, HOST: '127.0.0.1', WEB_PORT: String(WEB_PORT), PORT: String(PORT) },
    stdio: 'pipe', detached: true,
  })
  let viteLog = '', viteExited = null
  vite.stdout.on('data', (d) => { viteLog += d })
  vite.stderr.on('data', (d) => { viteLog += d })
  vite.on('exit', (c) => { viteExited = c })
  vite.on('error', (e) => die(`could not start vite (${e.code ?? e.message})`))
  let up = false
  for (let i = 0; i < 120; i++) {
    if (/ready in|Local:/.test(viteLog)) { up = true; break }
    if (viteExited !== null) break
    await wait(250)
  }
  if (!up) die(`the vite dev server never came up (exit=${viteExited})`, viteLog.slice(-1500) || '(no output)')
}


// --- CDP -----------------------------------------------------------------------------
let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEVTOOLS}/json`)).json()
    wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null
  } catch {}
  if (!wsUrl) await wait(250)
}
if (!wsUrl) skip('no browser: Chrome started but never opened a CDP target')

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
// ★ VISIBLE counts, not PRESENT counts, and the distinction is the whole of this file's
// 2026-08-29 revision. Until the keep-mounted fix, a notebook belonging to a session you had
// switched away from was REMOVED from the document, so 'is it present' and 'is it on screen'
// were the same question and the probe asked the cheap one. They are no longer the same:
// every open notebook now stays mounted and App.tsx hides it with a 'hidden' wrapper.
// Presence was only ever a PROXY for visibility, so the readiness contract is unchanged in
// meaning — 'the notebook is no longer on screen' — and only its implementation moves.
// offsetParent is null for anything inside a display:none ancestor, which is exactly what
// Tailwind's 'hidden' sets, so this reads the same fact the user's eyes do.
// It also works against BOTH builds: pre-fix the nodes are absent (0 visible), post-fix they
// are present but hidden (0 visible). One predicate, both behaviours — so the difference
// between them shows up in the NUMBERS rather than in whether the probe can run at all.
const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null).length
window.__cm = () => vis('.cm-editor')
window.__cells = () => vis('[data-cell-id]')
window.__cmPresent = () => document.querySelectorAll('.cm-editor').length
window.__cellsPresent = () => document.querySelectorAll('[data-cell-id]').length
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

// ── THE ONE ASSERTION ─────────────────────────────────────────────────────────────────
// Everything above is a measurement and stays one: timings are machine-, browser- and
// build-dependent, so asserting on a millisecond count would produce a test that fails on a
// slow laptop and passes on a fast one, which is worse than no test.
//
// THIS is timing-independent and it is the invariant the fix actually established: a session
// switch must not construct or destroy a single cell editor. Before the fix it was N built
// and N torn per round trip at N code cells; after, it is 0/0 at every count, because every
// open notebook stays mounted and each cell latches its editor on first visibility.
// One structural fact, checked in both directions and in every fixture — which is what makes
// this file a regression test rather than a stopwatch.
//
// ★ VERIFIED IN BOTH DIRECTIONS, 2026-08-29, because an assertion never seen to fail is not
// evidence. Against the PRE-FIX bundle still in web/dist it reports 50 built / 50 torn at 50
// code cells and exits 1; against the post-fix working tree (PROBE_MODE=dev) it reports 0/0
// everywhere and exits 0. A guard proven only in the passing direction cannot tell you which
// of the two it is measuring.
console.log('\n── regression assertion ' + '─'.repeat(38))
let violations = 0
for (const r of results) {
  // max, not median: one rebuilt editor in one round trip out of six is still the bug.
  const worst = Math.max(r.builtAway.max, r.tornAway.max, r.builtBack.max, r.tornBack.max)
  const ok = worst === 0
  if (!ok) violations++
  console.log(`  ${ok ? '✅' : '❌'} ${r.label.padEnd(20)} a session switch builds or destroys no editor` +
              (ok ? '' : `  — worst round trip: ${r.builtBack.max} built / ${r.tornAway.max} torn`))
}

cdpDone = true
try { cdp.close() } catch {}
if (violations) {
  console.log(`\n${violations} fixture(s) rebuilt cell editors on a session switch — the keep-mounted`)
  console.log(`fix in 1bd56af is not in the artifact this run measured (${MODE}).`)
  console.log(`If that artifact is web/dist, check it has been rebuilt since the fix landed.\n`)
} else {
  console.log('\n[measured] the timings above are reported, not asserted — read the shape line.\n')
}
// ONE result-dependent exit, not two guarded bare literals. The two-literal form IS
// result-dependent in fact, but run-suite's gate reads the exit argument TEXTUALLY and
// cannot see that — it flagged this file as "cannot report failure", exactly as it flagged
// output-sanitizer-test for the same shape. Softening the gate to accept a bare exit(1)
// would gut it: an unreachable exit(1) beside a final exit(0) is the thing it exists to
// catch. So the file adopts the shape the gate can verify. Same behaviour either way.
process.exit(violations ? 1 : 0)
