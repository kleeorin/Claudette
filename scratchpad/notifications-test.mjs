// E2E for background-session desktop notifications (web/src/lib/notifications.ts).
// Drives the REAL built app in headless Chrome against the throwaway server on
// :4321. We inject two shims before app load: a Notification stub that records
// every construction, and a WebSocket subclass that hands us the app's live socket
// so we can feed it real server frames. Then we assert the notification gating:
//   - turn-complete (running→idle) fires while the tab is hidden
//   - permission prompt fires
//   - NOTHING fires while the tab is visible, or before the user opts in
//   node scratchpad/notifications-test.mjs
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-notif-'))
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9351', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
  'about:blank',
], { stdio: 'pipe', detached: true })

// Reap the browser on EVERY exit path, not just the happy one. These tests used to kill
// Chrome only at the end, so any throw — a timeout on a dead selector, an assertion that
// blew up — orphaned the whole headless process tree. One session left 14 of them behind,
// which quietly eats a machine until someone reboots. Pattern copied from find-diff-check.
// Reap by process GROUP, not by pid — the same discipline this file uses for its server,
// where it IS load-bearing (`npx` forks the real node, so killing the wrapper by pid can
// strand the port). For Chrome it is defence in depth only: measured, the bare kill did
// not orphan it. See rule 3 in scratchpad/port-and-reap-lint.mts.
const reapChrome = () => { try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} } }
process.on('exit', reapChrome)
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapChrome(); if (e) console.error(e); process.exit(1) })
}


async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9351/json')).json()
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
const pending = new Map()
// A CDP reply is awaited on a promise that ONLY the socket can resolve, so if Chrome dies
// mid-run — crash, OOM, an external pkill — every pending send() hangs forever and the
// harness sleeps in ep_poll holding its ports until someone hunts it down. Abort loudly
// instead. No reap() here on purpose: process.exit() runs the process.on('exit') handlers,
// which already cover every child. `cdpDone` keeps this off the DELIBERATE teardown below,
// where the very same close event is expected and must not be read as a failure.
let cdpDone = false
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died; aborting rather than hanging'); process.exit(1) })
cdp.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
function send(method, params = {}) { const id = ++cdpId; return new Promise((res) => { pending.set(id, res); cdp.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error('page eval threw: ' + JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}
async function waitFor(expr, ms = 12000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) } throw new Error(`timeout: ${expr}`) }

// Shims installed BEFORE any app script runs.
const SHIM = `
  window.__hidden = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__hidden ? 'hidden' : 'visible' });
  window.__notes = [];
  class FakeNote {
    constructor(title, opts) { this.title = title; this.opts = opts || {}; window.__notes.push({ title, body: this.opts.body, tag: this.opts.tag }); }
    close() {} addEventListener() {}
  }
  FakeNote.permission = 'granted';
  FakeNote.requestPermission = () => Promise.resolve('granted');
  window.Notification = FakeNote;
  const RealWS = window.WebSocket;
  class CapWS extends RealWS { constructor(...a) { super(...a); if (String(a[0]).includes('/ws')) window.__appws = this; } }
  window.WebSocket = CapWS;
`
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
// A REAL SESSION IS REQUIRED, and it was not obvious. The app suppresses a notification
// only for a session you are actually looking at — notifications.ts:63 is
// `watching(id) = id === activeRef.current && !document.hidden`, i.e. BOTH conditions. This
// fixture used to invent a session id ('s1') and inject frames for it, so activeRef.current
// was null, `watching` was false for every frame, and the two visibility-gating assertions
// below could not pass no matter how the app behaved. They never ran to prove it: the bell
// selector above had rotted, so the file cascaded and stopped at 2/8 before reaching them.
// Create a session for real and drive the frames with ITS id, so the gating check is a
// statement about the app rather than about the fixture.
const created = await (await fetch(`${APP}/api/session/create`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'notif', cwd: '/tmp', rootDir: '/tmp', sandbox: { enabled: false, mounts: [] } }),
})).json()
const SID = created?.session?.id ?? created?.id
if (!SID) { console.error('could not create a session:', JSON.stringify(created)); process.exit(1) }

await send('Page.navigate', { url: `${APP}/` })

// App mounted + the hub WebSocket captured.
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await waitFor(`!!window.__appws`)
// The composer only renders when a session is ACTIVE, so this doubles as the check that the
// app selected the session we just created. Without it the two gating assertions would go
// green-or-red for reasons having nothing to do with notifications.
// SELECT OUR SESSION EXPLICITLY. The shared :4321 server is reused by nine harnesses in a
// suite run, so by the time this one loads there are usually other sessions present and the
// app may have any of them active. Standalone there was exactly one and it was auto-selected,
// which is why this passed alone and dropped to 6/8 in-suite — an ordering dependency, not a
// notifications bug. Click ours by name; the gating contract is about the ACTIVE session, so
// the fixture has to know which one that is rather than hope.
await evaluate(`(()=>{const el=[...document.querySelectorAll('*')].find(n=>n.children.length===0&&n.textContent.trim()==='notif');if(!el)return false;(el.closest('button')||el).click();return true})()`)
await waitFor(`!!document.querySelector('textarea')`)
await wait(300)

const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)
const noteCount = () => evaluate(`window.__notes.length`)
const notes = () => evaluate(`window.__notes.map(n=>n.title)`)
import { check, results, failures as failed } from './assert.mjs'

// 1. Before opt-in: a full turn cycle must produce NOTHING.
await feed({ type: 'session:state', id: SID, state: 'running' })
await feed({ type: 'session:state', id: SID, state: 'idle' })
await wait(150)
check('silent before opt-in', (await noteCount()) === 0, `count=${await noteCount()}`)

// 2. Opt in via the bell (Notification.permission is already 'granted' in the shim).
// SELECTOR NOTE. This matched `aria-label` starting with "Notify me", a string the app has
// not used for some time — NotifyBell (App.tsx:988) now derives its label from permission +
// enabled state and has four variants. Match the one substring common to all four instead of
// one exact opening phrase, so a wording change does not silently unhook the whole file:
// "Desktop notifications on — click to turn off" / "Also send a desktop notification when a
// background session finishes or needs input" / the denied and unsupported variants.
// SoundToggle's labels start "Completion sound", so this stays unambiguous.
const BELL = `[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').toLowerCase().includes('desktop notification'))`
const clicked = await evaluate(`(()=>{const b=${BELL};if(!b)return false;b.click();return true})()`)
check('bell toggle found + clicked', clicked === true)
await wait(200)
// ...and this asked whether ANY button in the document had aria-pressed="true". SoundToggle
// is on by default and carries aria-pressed, so this check was GREEN while the click above
// was failing — it reported the sound toggle's state under the bell's name. Ask the bell.
const pressed = await evaluate(`(()=>{const b=${BELL};return !!b && b.getAttribute('aria-pressed')==='true'})()`)
check('bell shows enabled (aria-pressed)', pressed === true)

// 3. Turn-complete while hidden → one notification.
await feed({ type: 'session:state', id: SID, state: 'running' })
await feed({ type: 'session:state', id: SID, state: 'idle' })
await wait(150)
check('turn-complete fires while hidden', (await noteCount()) === 1, JSON.stringify(await notes()))

// 4. Permission prompt → another notification.
await feed({ type: 'session:permission', id: SID, request: { requestId: 'r1', toolName: 'Bash', input: {} } })
await wait(150)
check('permission prompt fires', (await noteCount()) === 2, JSON.stringify(await notes()))

// 5. Tab visible → gating suppresses further notifications.
await evaluate(`(()=>{window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'));return true})()`)
await feed({ type: 'session:state', id: SID, state: 'running' })
await feed({ type: 'session:state', id: SID, state: 'idle' })
await wait(150)
check('silent while tab is visible', (await noteCount()) === 2, `count=${await noteCount()}`)

// 6. Not-an-edge (idle→idle) must not fire even when hidden + enabled.
await evaluate(`(()=>{window.__hidden=true;return true})()`)
await feed({ type: 'session:state', id: SID, state: 'idle' })
await wait(150)
check('no fire on non-edge idle→idle', (await noteCount()) === 2, `count=${await noteCount()}`)

// 7. Notification body/tag sanity on the last real fire.
const last = await evaluate(`window.__notes[1]`)
check('permission note tagged by session', last && last.tag === SID, JSON.stringify(last))

cdpDone = true   // deliberate teardown from here — the CDP close below is expected
reapChrome()
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
