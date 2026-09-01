// LAYOUT REGRESSION HARNESS — the desktop shell has no automated coverage, and the
// phone-native layout adds a SECOND mode to a ~1700-line App.tsx. This is the net that
// makes either mode verifiable.
//
//   CHROME_BIN=… node scratchpad/layout-check.mjs
//   (run-suite.sh finds the bundled .chrome-headless/ Chrome and exports CHROME_BIN)
//
// Built on find-ui-check.mjs's harness — isolated PORT + WEB_PORT, its own vite, an
// isolated CLAUDETTE_DATA_DIR, a throwaway CLAUDETTE_TOKEN, and a stand-in `claude` on
// PATH. It NEVER touches the operator's :4319 server. It replaces layout-shots.mjs, which
// could not fail (unconditional process.exit(0)) and whose selectors predate the redesign.
//
// IT ASSERTS STRUCTURE, NEVER PIXELS. Screenshot-diffing a ~2 MB CodeMirror + xterm +
// Milkdown shell is flaky and gets disabled within a month; element presence and computed
// visibility do not drift with a font or a theme tweak.
//
// EXPECT RED UNTIL THE PHONE LAYOUT LANDS. Like scratchpad/sandbox-regression-fixes-test,
// this asserts the TARGET behaviour, so today it reports what is missing. Each check says
// which side of that line it is on:
//   [today]   must pass now — a regression if it goes red
//   [phone]   passes once the phone layout lands
//   [fix]     passes once the permission card moves OUT of the scroll container
import { spawn } from 'child_process'
import { mkdtemp, writeFile, mkdir, rm, chmod } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4493
const WEB_PORT = 5293
const APP = `http://127.0.0.1:${WEB_PORT}`
const API = `http://127.0.0.1:${PORT}`
const TOKEN = 'layout-check-token'
const GO = '/tmp/claudette-layout-go'      // touch → the shim raises the Bash permission
// SECOND marker, for the machine-side path. Separate from GO on purpose: the two requests must
// be raisable INDEPENDENTLY, because the Bash one must NOT be on screen while [6] measures.
const GO_EDIT = '/tmp/claudette-layout-go-edit'
const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }  // iPhone 14-ish; below Tailwind's md (768)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
import { withMarks, passed, failed } from './assert.mjs'
const ok = withMarks({ indent: '  ' })
await rm(GO, { force: true })
await rm(GO_EDIT, { force: true })

const DATA = await mkdtemp(join(tmpdir(), 'layout-data-'))
const PROJ = await mkdtemp(join(tmpdir(), 'layout-proj-'))
const BIN = await mkdtemp(join(tmpdir(), 'layout-bin-'))
await writeFile(join(PROJ, 'demo.py'), 'x = 1\nprint(x)\n')

// The stand-in CLI: first a LONG assistant message (so the transcript actually scrolls —
// without it the scroll assertion is vacuous), then, on the GO marker, one permission
// request so a pending card is on screen deterministically. No model, no flake.
const LONG = Array.from({ length: 120 }, (_, i) => `line ${i + 1} of filler so the transcript overflows the viewport`).join('\\n')
await writeFile(join(BIN, 'claude'), `#!/usr/bin/env node
import { existsSync } from 'fs'
process.stdout.write(JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(LONG)} }] },
}) + '\\n')
const req = {
  type: 'control_request',
  request_id: 'req-layout-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    display_name: 'Bash',
    input: { command: 'echo layout-harness' },
    tool_use_id: 'tu-layout-1',
    permission_suggestions: [],
  },
}
// THE MACHINE-SIDE REQUEST. An Edit permission does something a Bash permission does not: the
// app's own proposed-edit effect opens a file-editor content tab WITHOUT the user asking, and
// \`autoOpenEdits\` defaults ON. That is the only path that makes \`active\` non-null with no user
// gesture, and it is the exact input that would expose a phone layout wired to \`active\`.
// Without it section [6] cannot fail, because a Bash permission leaves \`active\` null and the
// chat pane showing whatever the design does.
const editReq = {
  type: 'control_request',
  request_id: 'req-layout-2',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Edit',
    display_name: 'Edit',
    input: { file_path: ${JSON.stringify(join(PROJ, 'demo.py'))}, old_string: 'x = 1', new_string: 'x = 2' },
    tool_use_id: 'tu-layout-2',
    permission_suggestions: [],
  },
}
const tick = setInterval(() => {
  if (!existsSync(${JSON.stringify(GO)})) return
  clearInterval(tick)
  process.stdout.write(JSON.stringify(req) + '\\n')
}, 200)
const tickEdit = setInterval(() => {
  if (!existsSync(${JSON.stringify(GO_EDIT)})) return
  clearInterval(tickEdit)
  process.stdout.write(JSON.stringify(editReq) + '\\n')
}, 200)
// Exit when the server that spawned us goes away. Parking on a timer alone left one of
// these reparented to init after every run — a harmless-looking orphan that still shows up
// in anyone's ps while they are diagnosing a real one, which is exactly when a clean ps
// matters most.
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
    PORT: String(PORT), CLAUDETTE_TOKEN: TOKEN, CLAUDETTE_DATA_DIR: DATA,
    // The session runs UNSANDBOXED on purpose: inside a box, bwrap resolves the real
    // `claude` rather than the PATH shim, and the harness would drive a live model.
    CLAUDETTE_ALLOW_UNSANDBOXED: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let log = ''
server.stdout.on('data', (d) => (log += d))
server.stderr.on('data', (d) => (log += d))
const reap = () => { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
process.on('exit', reap)

const web = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
  cwd: 'web', env: { ...process.env, PORT: String(PORT), WEB_PORT: String(WEB_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let weblog = ''
web.stdout.on('data', (d) => (weblog += d))
web.stderr.on('data', (d) => (weblog += d))
const reapWeb = () => { try { process.kill(-web.pid, 'SIGKILL') } catch { try { web.kill('SIGKILL') } catch {} } }
process.on('exit', reapWeb)
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reap(); reapWeb(); if (e) console.error(e); process.exit(1) })
}
for (let i = 0; i < 90 && !log.includes('Server listening'); i++) await wait(500)
if (!log.includes('Server listening')) { console.error(log.slice(-2000)); throw new Error('server did not start') }
for (let i = 0; i < 90 && !weblog.includes('ready in'); i++) await wait(500)
if (!weblog.includes('ready in')) { console.error(weblog.slice(-2000)); throw new Error('vite did not start') }
console.log('server + vite up')

const apiPost = (p, body) => fetch(`${API}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` }, body: JSON.stringify(body),
}).then((r) => r.json())

// TWO sessions: the per-session tab model (`bySession`) is the shared state the second
// layout mode is most likely to break, and it takes two sessions to see it.
const s1 = await apiPost('/api/session/create', { name: 'Alpha', cwd: PROJ, rootDir: PROJ, sandbox: { enabled: false, mounts: [] } })
const s2 = await apiPost('/api/session/create', { name: 'Beta', cwd: PROJ, rootDir: PROJ, sandbox: { enabled: false, mounts: [] } })
console.log(`sessions: Alpha=${s1.id?.slice(0, 8)} Beta=${s2.id?.slice(0, 8)}`)

// ---- chrome / CDP ---------------------------------------------------------------
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
if (!existsSync(CHROME)) { console.error(`no Chrome at ${CHROME} (set CHROME_BIN)`); process.exit(1) }
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-layout-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9353', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  `--window-size=${DESKTOP.width},${DESKTOP.height}`, 'about:blank',
], { stdio: 'pipe', detached: true })
process.on('exit', () => { try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} } })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9353/json')).json()
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
// mid-run — crash, OOM, an external pkill — every pending send() hangs forever and the
// harness sleeps in ep_poll holding its ports until someone hunts it down. Abort loudly
// instead. No reap() here on purpose: process.exit() runs the process.on('exit') handlers,
// which already cover every child. `cdpDone` keeps this off the DELIBERATE teardown below,
// where the very same close event is expected and must not be read as a failure.
let cdpDone = false
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died; aborting rather than hanging'); process.exit(1) })
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
async function waitFor(expr, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) }
  return false
}
const setViewport = async (v) => {
  await send('Emulation.setDeviceMetricsOverride', {
    width: v.width, height: v.height, deviceScaleFactor: 1, mobile: v.width < 768,
  })
  await wait(600)   // let the resize listener + React commit settle
}

// ---- shared page helpers (injected once, used by every assertion) ---------------
// Visible = has layout area AND is not display:none/visibility:hidden. `offsetParent` is
// null for position:fixed, so it is checked explicitly rather than used as the test.
const HELPERS = `
window.__qa = {
  visible(el) {
    if (!el) return false
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return false
    const s = getComputedStyle(el)
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0
  },
  // Drag dividers: App.tsx gives every one title="Drag to resize".
  dividers() { return [...document.querySelectorAll('[title="Drag to resize"]')] },
  visibleDividers() { return this.dividers().filter((d) => this.visible(d)) },
  // The pending permission card — ChatView renders it with a yellow border.
  permCard() { return document.querySelector('[class*="border-ctp-yellow"]') },
  // The transcript's scrolling container: the tallest scrollable ancestor chain member.
  scroller() {
    // Prefer the EXPLICIT hook. The class scan below is a heuristic: it takes the largest
    // overflowing overflow-y-auto element, so the day any other bounded scroll region
    // appears (AskUserQuestionCard's question list now has one) it can silently retarget,
    // and the [fix] assertions would keep passing while measuring the wrong element.
    // Kept as a fallback so this harness still works against a build without the hook.
    // NB no backticks in this comment: HELPERS is a template literal, and one here closes
    // it early and turns the rest of the block into stray code.
    const hook = document.querySelector('[data-testid="transcript-scroller"]')
    if (hook) return hook
    const els = [...document.querySelectorAll('.overflow-y-auto')]
    return els.filter((e) => e.scrollHeight > e.clientHeight)
              .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? els[0] ?? null
  },
  inViewport(el) {
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
  },
  // Panes the phone mode must show one-at-a-time. The layout work is expected to add
  // these hooks; without them the phone assertions cannot be made at all.
  panes() { return [...document.querySelectorAll('[data-testid="pane"]')] },
  // inViewport is applied HERE and deliberately NOT inside visible(). Strengthening the global
  // visible() would break section [3]'s phone clickSession, which today finds a session row in
  // an OFF-SCREEN drawer and clicks it anyway; that vacuity is real but it belongs to slice 4
  // (drawer/tab-bar nav), and fixing it here would silently change what [3] tests. So the
  // strengthening is scoped to the one helper that needs it.
  // Why panes need it at all: a pane can be display:block with a real box and still be parked
  // outside the viewport, which is exactly what "one pane at a time" must rule out.
  visiblePanes() { return this.panes().filter((p) => this.visible(p) && this.inViewport(p)) },
}; true`

await send('Page.enable')
await setViewport(DESKTOP)
await send('Page.navigate', { url: `${APP}/api/auth?token=${TOKEN}` })
await wait(1200)
await send('Page.navigate', { url: `${APP}/` })
const booted = await waitFor(`!!document.querySelector('aside') || !!document.querySelector('textarea')`, 30000)
if (!booted) { console.error('app never rendered'); console.error(weblog.slice(-1500)); process.exit(1) }
await evaluate(HELPERS)
await wait(800)

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[1] desktop shell (1440×900)')
// ═══════════════════════════════════════════════════════════════════════════════
await setViewport(DESKTOP); await evaluate(HELPERS)
const dDividers = await evaluate(`window.__qa.visibleDividers().length`)
ok('desktop shows pointer-drag dividers', dDividers > 0, `${dDividers} visible`, 'today')
const dScrollerOk = await evaluate(`!!window.__qa.scroller()`)
// NAME THE HOOK SEPARATELY. `!!scroller()` passes under EITHER path — hook or class-scan
  // fallback — so removing or renaming data-testid="transcript-scroller" is invisible while
  // the [fix] assertions keep measuring, possibly the wrong element. Asserting the hook by
  // name makes its loss a legible red that says its own cause, while the fallback keeps the
  // rest of the harness running: degraded, but visibly so. Not hard-failed (brittle against
  // an older checkout for no gain) and not a warning (lost in output nobody reads when the
  // suite is green). An assertion whose truth-value can change without this file being
  // edited has to be NAMED.
  ok('the transcript exposes its test hook', await evaluate(`!!document.querySelector('[data-testid="transcript-scroller"]')`), '', 'today')
  // …and assert IDENTITY, not mere existence: scroller() returning SOMETHING is satisfied by
  // any overflowing element on the page.
  ok('scroller() resolves to that hook, not some other overflowing element', await evaluate(`(() => { const h = document.querySelector('[data-testid="transcript-scroller"]');
      return !!h && window.__qa.scroller() === h })()`), '', 'today')

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[2] phone shell (390×844) — WITH every pane actually open')
// ═══════════════════════════════════════════════════════════════════════════════
// *** BOTH ASSERTIONS HERE USED TO BE VACUOUS AND BOTH USED TO PASS. ***
// At rest this harness opens no content tab, no dock and no terminal, so THREE of the four
// panes do not exist and three of the four dividers are never rendered. "No divider is visible
// at phone width" then counted zero dividers having tested nothing, and the pane assertion had
// nothing to count either. Opening all three first is what gives both of them a subject — and
// it is why the three ungated dividers had to be found and gated in this same slice: making the
// pane count honest is what first made the divider count honest.
// Click a toolbar button by its visible text, reporting whether it was found AND enabled.
// Returns a boolean rather than throwing so the caller can assert it BY NAME — a bare
// `.find(...).click()` throws inside the page and resurfaces as whatever assertion runs next,
// named after the wrong subject.
const clickByText = async (label) => evaluate(`(() => {
  const want = ${JSON.stringify(label)}
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === want)
  if (!b || b.disabled) return false
  b.click(); return true
})()`)

await setViewport(DESKTOP); await evaluate(HELPERS)
// A session must be selected before the Terminal toggle does anything (it is per-session and
// renders DISABLED without one) — asserted rather than assumed, so a failure here names itself
// instead of resurfacing as "no terminal pane".
const onAlpha = await evaluate(`(() => {
  const el = [...document.querySelectorAll('button, [role="button"], li, div')]
    .filter((e) => e.textContent && e.textContent.trim() === 'Alpha')
    .find((e) => window.__qa.visible(e))
  if (!el) return false
  el.click(); return true
})()`)
ok('PRECONDITION: a session is selected (the Terminal toggle is inert without one)', onAlpha, '', 'today')
const termOpened = await clickByText('Terminal')
ok('PRECONDITION: the Terminal toolbar button opened a terminal', termOpened, '', 'today')
await waitFor(`!!document.querySelector('.xterm-rows')`, 30000)
const filesOpened = await clickByText('Files')
ok('PRECONDITION: the Files dock opened', filesOpened, '', 'today')
await wait(900)
// FileManager opens on DOUBLE click — a single click only selects the row.
const fileOpened = await evaluate(`(() => {
  const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'demo.py')
  if (!el) return false
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
  return true
})()`)
ok('PRECONDITION: demo.py opened as a content tab', fileOpened, '', 'today')
await wait(1500)

// (d) DESKTOP GUARD, and it is not optional: without it "hide everything, always" satisfies the
// phone assertion below and this harness would bless a blank app.
await evaluate(HELPERS)
const dPanes = await evaluate(`window.__qa.visiblePanes().length`)
const dPaneCount = await evaluate(`window.__qa.panes().length`)
ok('desktop 1440×900 with tab+dock+terminal open shows MULTIPLE panes', dPanes >= 3, `${dPanes} of ${dPaneCount} visible — a phone rule that leaked to desktop would show 1`, 'today')

await setViewport(PHONE); await evaluate(HELPERS)
const pDividers = await evaluate(`window.__qa.visibleDividers().length`)
const pDividerTotal = await evaluate(`window.__qa.dividers().length`)
ok('NO pointer-drag divider is visible at phone width', pDividers === 0, pDividers > 0 ? `${pDividers} of ${pDividerTotal} still visible — drag targets are unusable on touch`
                : `0 of ${pDividerTotal} rendered — non-vacuous only because all ${pDividerTotal} exist`, 'phone')

const paneCount = await evaluate(`window.__qa.panes().length`)
const visPanes = await evaluate(`window.__qa.visiblePanes().length`)
if (paneCount === 0) {
  ok('exactly one pane is visible at phone width', false, 'no [data-testid="pane"] elements — the phone layout must add this hook (see header)', 'phone')
} else {
  ok('exactly one pane is visible at phone width', visPanes === 1, `${visPanes} of ${paneCount} visible`, 'phone')
}

// SECOND divider measurement, in the TERMINAL pane — and it is not redundant.
// The measurement above CANNOT see the terminal-dock divider: that divider lives inside the
// Claude column, which is hidden while the content pane is showing, so its `md:` gate is not
// what keeps it off screen there. Verified by mutation: un-gating that one divider and
// re-running left this harness fully GREEN, while un-gating the right-dock divider (whose
// parent row IS visible) turned it red. A gate nothing measures is a gate that can be deleted
// by accident. Only in the terminal pane is that divider's parent visible.
// Two clicks because the toolbar button TOGGLES: the first closes the dock, the second reopens
// it and is what sets the phone pane to 'terminal'.
await setViewport(DESKTOP); await evaluate(HELPERS)
await clickByText('Terminal'); await wait(500)
await clickByText('Terminal'); await wait(900)
await setViewport(PHONE); await evaluate(HELPERS)
const tDividers = await evaluate(`window.__qa.visibleDividers().length`)
const tDividerTotal = await evaluate(`window.__qa.dividers().length`)
const tPanes = await evaluate(`window.__qa.visiblePanes().length`)
ok('NO divider is visible in the TERMINAL pane either', tDividers === 0, tDividers > 0 ? `${tDividers} of ${tDividerTotal} visible` : `0 of ${tDividerTotal} rendered — this is the state that covers the terminal-dock divider's gate`, 'phone')
ok('still exactly one pane in the terminal state', tPanes === 1, `${tPanes} visible`, 'phone')

// Return to the chat pane so [3]–[5] start from a known one. THREE things depend on this and
// it is not a tidy-up:
//   1. it leaves `active` null, so [7]'s machine-side open is the ONLY thing that sets it;
//   2. it puts the CHAT pane on screen, which is what keeps [4]'s transcript LAID OUT at phone.
//      2B hides rather than unmounts, so the scroller hook survives inside a display:none
//      subtree and scroller() still returns it — writes to a zero-box element no-op, and [4]
//      would degrade to a silent inconclusive. The precondition check inside [4] names that if
//      it ever happens;
//   3. it is the resting state [4] and [5] were written against.
// If you reorder these sections, re-read [4]'s scroller precondition before believing its
// result.
await setViewport(DESKTOP); await evaluate(HELPERS)
await clickByText('Chat')
await wait(600)

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[3] per-session tab state (bySession) survives a session switch')
// ═══════════════════════════════════════════════════════════════════════════════
// Sessions are listed in the sidebar; clicking one switches. The property under test is
// that each session keeps ITS OWN selected tab — the shared state most at risk from a
// second layout mode.
const clickSession = async (name) => evaluate(`(() => {
  const el = [...document.querySelectorAll('button, [role="button"], li, div')]
    .filter((e) => e.textContent && e.textContent.trim() === ${JSON.stringify(name)})
    .find((e) => window.__qa.visible(e))
  if (!el) return false
  el.click(); return true
})()`)

for (const [mode, vp] of [['desktop', DESKTOP], ['phone', PHONE]]) {
  await setViewport(vp); await evaluate(HELPERS)
  const gotAlpha = await clickSession('Alpha')
  await wait(500)
  const gotBeta = await clickSession('Beta')
  await wait(500)
  const backToAlpha = await clickSession('Alpha')
  await wait(500)
  const switched = gotAlpha && gotBeta && backToAlpha
  ok(`${mode}: both sessions are selectable`, switched, switched ? '' : `Alpha=${gotAlpha} Beta=${gotBeta} back=${backToAlpha}`, mode === 'desktop' ? 'today' : 'phone')
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[4] pending permission card — the scroll defect')
// ═══════════════════════════════════════════════════════════════════════════════
// PM's finding: the card renders INSIDE the scrolling transcript (ChatView.tsx:377), so it
// can be scrolled off-screen while the session sits blocked in `waiting`. Desktop masks it
// with a tall viewport + the auto-scroll effect keyed on [items, pending] (:241). On a
// phone with the keyboard up it is a live defect — and it is a correctness bug at EVERY
// width, not a phone-only one.
await setViewport(DESKTOP); await evaluate(HELPERS)
await clickSession('Alpha'); await wait(500)
await writeFile(GO, 'go')                      // release the permission request
const cardUp = await waitFor(`!!window.__qa.permCard()`, 25000)
ok('a pending permission card renders', cardUp, '', 'today')

if (cardUp) {
  await evaluate(HELPERS)
  // (a) STRUCTURAL — the real fix. The card must not be a descendant of the scroller.
  const insideScroller = await evaluate(`(() => {
    const c = window.__qa.permCard(), s = window.__qa.scroller()
    return !!(c && s && s.contains(c))
  })()`)
  ok('the permission card is NOT inside the scrolling transcript', !insideScroller, insideScroller ? 'it is a descendant of the scroll container — it can be scrolled away while the session blocks' : '', 'fix')

  // (b) BEHAVIOURAL — scroll the transcript up by one viewport and look again.
  const scrolled = await evaluate(`(() => {
    const s = window.__qa.scroller()
    if (!s) return -1
    const before = s.scrollTop
    s.scrollTop = Math.max(0, s.scrollTop - s.clientHeight)
    return before - s.scrollTop
  })()`)
  await wait(400)
  const stillThere = await evaluate(`window.__qa.inViewport(window.__qa.permCard())`)
  ok('after scrolling the transcript up one viewport, the card is still on screen', stillThere, scrolled <= 0 ? `(transcript did not scroll: delta=${scrolled} — assertion inconclusive)` : `scrolled ${scrolled}px away`, 'fix')

  // (c) Answerable at BOTH widths, in the RESTING state — the card is useless if its
  // buttons are off-screen. Scroll back to the bottom first: (b) above deliberately
  // scrolled the card away, and carrying that state in here would re-measure (b)'s defect
  // and report it as a second, different failure.
  const toBottom = `(() => { const s = window.__qa.scroller(); if (s) s.scrollTop = s.scrollHeight; return true })()`
  for (const [mode, vp] of [['desktop', DESKTOP], ['phone', PHONE]]) {
    await setViewport(vp); await evaluate(HELPERS)
    await evaluate(toBottom); await wait(400)
    // *** DID THAT WRITE ACTUALLY TAKE? ASSERT IT — DO NOT ASSUME. ***
    // Since 2B hides panes with `hidden` and never unmounts, the transcript div — and with it
    // the data-testid hook — survives inside a display:none subtree. scroller() returns that
    // hook UNCONDITIONALLY (the early return precedes the class-scan fallback), so in any state
    // where the chat pane is not the shown one it hands back a ZERO-BOX element and every write
    // to it silently no-ops: `toBottom` above does nothing, and the assertion below then
    // measures an unscrolled transcript while reporting on the card.
    // This harness only reaches that state if the pane ordering changes — see the note at the
    // end of [2] — so this check is GREEN today and exists to make the day it stops being green
    // say its own cause instead of degrading into a quiet "inconclusive".
    // NOT FIXED HERE: what scroller() should return for a hidden transcript (null? gate on
    // visible()?) is slice 3's subject, and changing it inside 2B would alter what [4] tests.
    const scrollerBoxH = await evaluate(`(() => {
      const s = window.__qa.scroller()
      return s ? Math.round(s.getBoundingClientRect().height) : -1
    })()`)
    ok(`${mode}: PRECONDITION: the transcript scroller is laid out, so scroll-to-bottom took effect`, scrollerBoxH > 0, scrollerBoxH === 0 ? 'scroller() returned a display:none element — writes to it no-op, so the result below is INCONCLUSIVE, not a pass'
        : scrollerBoxH < 0 ? 'no scroller at all' : `box ${scrollerBoxH}px`, 'today')
    const answerable = await evaluate(`(() => {
      const c = window.__qa.permCard()
      if (!c) return false
      const btn = [...c.querySelectorAll('button')].find((b) => window.__qa.visible(b))
      return !!btn && window.__qa.inViewport(btn)
    })()`)
    ok(`${mode}: the card has a reachable answer button (at rest)`, answerable, '', mode === 'desktop' ? 'today' : 'phone')
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[5] live crossing of the 768px boundary')
// ═══════════════════════════════════════════════════════════════════════════════
// Resizing across the breakpoint must not lose which session you were on.
await setViewport(DESKTOP); await evaluate(HELPERS)
await clickSession('Beta'); await wait(600)
const beforeCross = await evaluate(`document.body.innerText.includes('Beta')`)
await setViewport(PHONE); await evaluate(HELPERS)
await wait(600)
const afterCross = await evaluate(`document.body.innerText.includes('Beta')`)
await setViewport(DESKTOP); await evaluate(HELPERS)
await wait(600)
const backAgain = await evaluate(`document.body.innerText.includes('Beta')`)
ok('the selected session survives crossing 768px in both directions', beforeCross && afterCross && backAgain, `before=${beforeCross} phone=${afterCross} back=${backAgain}`, 'phone')

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[6] the 768px boundary is ONE number')
// ═══════════════════════════════════════════════════════════════════════════════
// MD_PX (web/src/lib/breakpoint.ts) and Tailwind's `md:` must agree AT the boundary, not
// approximately. usePhone negates the identical `(min-width: 768px)` query rather than
// spelling `max-width: 767.98px`, so agreement is by construction — this pins it so a future
// edit to either side cannot drift silently. Same shape as refresh-survival-check's GRACE_MS
// cross-source check: assert the two sources against each other, not each against a constant.
// 768 is the FIRST desktop pixel and 767 the LAST phone one, so this brackets the exact edge.
for (const [w, expectPhone] of [[768, false], [767, true]]) {
  await setViewport({ width: w, height: 900 }); await evaluate(HELPERS)
  const dataPhone = await evaluate(`document.querySelector('[data-phone]')?.getAttribute('data-phone') ?? '(absent)'`)
  const divs = await evaluate(`window.__qa.visibleDividers().length`)
  ok(`${w}px: JS side (data-phone) says ${expectPhone}`, dataPhone === String(expectPhone), `got ${dataPhone}`, 'today')
  ok(`${w}px: CSS side (md:-gated dividers) agrees`, expectPhone ? divs === 0 : divs > 0, `${divs} divider(s) visible`, 'today')
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[7] a MACHINE-opened tab must not steal the phone screen')
// ═══════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS EXISTS TO CATCH, and the reason section [4] cannot catch it: driving the
// phone pane off `active` is the smaller, more natural diff, and it is wrong. Three effects
// open a content tab with NO user gesture, and `autoOpenEdits` defaults ON. So when Claude
// proposes an edit, an `active`-driven phone layout shows the file editor — which covers the
// permission card approving THAT VERY EDIT, because slice 1 made the card a sibling of the
// transcript INSIDE the chat pane. The user would be reading the diff with no way to approve it.
//
// [4] raises a BASH permission, which leaves `active` null, so its phone assertion passes under
// the broken design too. The Edit request is what makes this falsifiable at all.
await setViewport(PHONE); await evaluate(HELPERS)
await wait(400)
const paneBefore = await evaluate(`window.__qa.visiblePanes().length`)
const tabsBefore = await evaluate(`document.body.innerText.includes('demo.py')`)
await writeFile(GO_EDIT, 'go')
// Wait for the machine-side open to actually land, so a green below cannot mean "nothing
// happened yet". The tab appearing in the strip IS the machine-side open.
const machineOpened = await waitFor(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'demo.py')`, 25000)
ok('PRECONDITION: the Edit request machine-opened a content tab', machineOpened, machineOpened ? '' : `tab never appeared (present before: ${tabsBefore}, panes before: ${paneBefore})`, 'today')

if (machineOpened) {
  await evaluate(HELPERS)
  await wait(500)
  // (i) the chat pane is STILL the one on screen. Identity via the transcript scroller, which
  //     lives inside the chat pane: if the content pane had taken over, the chat pane would be
  //     display:none and its scroller would have no box.
  const chatStillShown = await evaluate(`(() => {
    const sc = window.__qa.scroller()
    return !!sc && window.__qa.visible(sc) && window.__qa.visiblePanes().length === 1
  })()`)
  ok('a machine-opened tab does NOT displace the chat pane at phone', chatStillShown, chatStillShown ? '' : 'the content pane took the screen — the permission card approving this very edit is now hidden', 'fix')

  // (ii) the consequence that actually costs the user: the card must remain answerable.
  const cardReachable = await evaluate(`(() => {
    const c = window.__qa.permCard()
    if (!c) return false
    const btn = [...c.querySelectorAll('button')].find((b) => window.__qa.visible(b))
    return !!btn && window.__qa.inViewport(btn)
  })()`)
  ok('the edit permission card is still answerable at phone', cardReachable, '', 'fix')

  // (iii) MainTabs must highlight from the SHOWN pane, not from `active`. They legitimately
  //       disagree here — that is the whole point — so a strip highlighting `active` would
  //       show demo.py as current while the chat is what is on screen.
  const chatTabOn = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Chat')
    return !!b && b.className.includes('border-ctp-accent')
  })()`)
  ok('the tab strip highlights Chat, not the machine-opened tab', chatTabOn, '', 'fix')
}

// ---- done -----------------------------------------------------------------------
cdpDone = true   // deliberate teardown from here — the CDP close below is expected
cdp.close()
try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} }
reap(); reapWeb()
await rm(GO, { force: true }); await rm(GO_EDIT, { force: true })
for (const d of [DATA, PROJ, BIN, chromeDir]) await rm(d, { recursive: true, force: true }).catch(() => {})

console.log(`\n${passed} passed, ${failed} failed`)
console.log(failed === 0
  ? '✅ layout checks pass'
  : 'ℹ️  [phone]/[fix] failures are EXPECTED until the phone layout + permission-card move land.')
process.exit(failed === 0 ? 0 : 1)
