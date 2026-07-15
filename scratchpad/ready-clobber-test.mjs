// Regression for the "idle mid-turn" bug: the engine's system/init (→ session:ready)
// used to clobber the running state to idle, hiding the working indicator + interrupt
// for the whole turn. Replays the REAL captured order (running → ready(init) → …
// → idle) via injected frames and asserts the indicator survives the ready.
//   node scratchpad/ready-clobber-test.mjs
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-ready-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9357', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1300,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9357/json')).json()
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
  if (r.result?.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}
async function waitFor(expr, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) } throw new Error(`timeout: ${expr}`) }

const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`) }
const hasStop = () => evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Stop')`)

const SHIM = `
  const RealWS = window.WebSocket;
  class CapWS extends RealWS { constructor(...a){ super(...a); if(String(a[0]).includes('/ws')) window.__appws=this; } }
  window.WebSocket = CapWS;
`
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await waitFor(`!!window.__appws`)
await wait(600)

const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)
await feed({ type: 'session:list', sessions: [{ id: 's1', name: 'demo', cwd: '/tmp', rootDir: '/tmp', state: 'idle' }] })
await wait(400)

// Send a turn → optimistic running → Stop shows.
await evaluate(`(()=>{const ta=document.querySelector('textarea');const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(ta,'hi');ta.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
await wait(100)
await evaluate(`(()=>{const ta=document.querySelector('textarea');ta.focus();ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`)
await wait(150)
check('Stop shows after send', (await hasStop()) === true)

// The engine's real running broadcast (dedup) + the init that used to clobber it.
await feed({ type: 'session:state', id: 's1', state: 'running' })
await feed({ type: 'session:ready', id: 's1', claudeSessionId: 'abc-123' })
await wait(250)
check('Stop SURVIVES the ready/init (the bug)', (await hasStop()) === true)
const stillRunning = await evaluate(`[...document.querySelectorAll('span')].some(s=>s.textContent.trim().toLowerCase()==='running')`)
check('footer still shows running after ready', stillRunning === true)

// Stream some content, then the terminal result → idle clears it.
await feed({ type: 'session:state', id: 's1', state: 'idle' })
await wait(250)
check('idle (turn end) clears the indicator', (await hasStop()) === false)

// And ready on an idle session still settles to idle (no regression).
await feed({ type: 'session:ready', id: 's1', claudeSessionId: 'abc-123' })
await wait(150)
check('ready on an idle session leaves it idle', (await hasStop()) === false)

chrome.kill('SIGKILL')
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
