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
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9351', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
  'about:blank',
], { stdio: 'pipe' })

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
await send('Page.navigate', { url: `${APP}/` })

// App mounted + the hub WebSocket captured.
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await waitFor(`!!window.__appws`)
await wait(300)

const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)
const noteCount = () => evaluate(`window.__notes.length`)
const notes = () => evaluate(`window.__notes.map(n=>n.title)`)
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`) }

// 1. Before opt-in: a full turn cycle must produce NOTHING.
await feed({ type: 'session:state', id: 's1', state: 'running' })
await feed({ type: 'session:state', id: 's1', state: 'idle' })
await wait(150)
check('silent before opt-in', (await noteCount()) === 0, `count=${await noteCount()}`)

// 2. Opt in via the bell (Notification.permission is already 'granted' in the shim).
const clicked = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').startsWith('Notify me'));if(!b)return false;b.click();return true})()`)
check('bell toggle found + clicked', clicked === true)
await wait(200)
const pressed = await evaluate(`!!([...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-pressed')==='true'))`)
check('bell shows enabled (aria-pressed)', pressed === true)

// 3. Turn-complete while hidden → one notification.
await feed({ type: 'session:state', id: 's1', state: 'running' })
await feed({ type: 'session:state', id: 's1', state: 'idle' })
await wait(150)
check('turn-complete fires while hidden', (await noteCount()) === 1, JSON.stringify(await notes()))

// 4. Permission prompt → another notification.
await feed({ type: 'session:permission', id: 's1', request: { requestId: 'r1', toolName: 'Bash', input: {} } })
await wait(150)
check('permission prompt fires', (await noteCount()) === 2, JSON.stringify(await notes()))

// 5. Tab visible → gating suppresses further notifications.
await evaluate(`(()=>{window.__hidden=false;document.dispatchEvent(new Event('visibilitychange'));return true})()`)
await feed({ type: 'session:state', id: 's1', state: 'running' })
await feed({ type: 'session:state', id: 's1', state: 'idle' })
await wait(150)
check('silent while tab is visible', (await noteCount()) === 2, `count=${await noteCount()}`)

// 6. Not-an-edge (idle→idle) must not fire even when hidden + enabled.
await evaluate(`(()=>{window.__hidden=true;return true})()`)
await feed({ type: 'session:state', id: 's1', state: 'idle' })
await wait(150)
check('no fire on non-edge idle→idle', (await noteCount()) === 2, `count=${await noteCount()}`)

// 7. Notification body/tag sanity on the last real fire.
const last = await evaluate(`window.__notes[1]`)
check('permission note tagged by session', last && last.tag === 's1', JSON.stringify(last))

chrome.kill('SIGKILL')
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
