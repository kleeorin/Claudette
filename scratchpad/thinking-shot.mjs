// Visual check of the live activity signals: the composer thinking ticker + the
// sidebar session state. Injects a fake session and a streaming thinking block
// over the app's real WebSocket (captured via a subclass shim), then screenshots.
//   node scratchpad/thinking-shot.mjs
import { spawn } from 'child_process'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const OUT = '/tmp/claudette-shots'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await new Promise((r) => spawn('mkdir', ['-p', OUT]).on('exit', r))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-think-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9352', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9352/json')).json()
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
async function waitFor(expr, ms = 12000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) } throw new Error(`timeout: ${expr}`) }
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log(`📸 ${name}`) }

const SHIM = `
  const RealWS = window.WebSocket;
  class CapWS extends RealWS { constructor(...a){ super(...a); if(String(a[0]).includes('/ws')) window.__appws=this; } }
  window.WebSocket = CapWS;
`
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await waitFor(`!!window.__appws`)
await wait(600)  // let the server's initial (empty) session:list land first

const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)

// Inject a session, then drive it into a running + actively-thinking state.
await feed({ type: 'session:list', sessions: [
  { id: 's1', name: 'refactor-notebook', cwd: '/home/kleeorin/Work/Projects/Claudette', rootDir: '/home/kleeorin/Work/Projects/Claudette', state: 'idle' },
  { id: 's2', name: 'docs-pass', cwd: '/home/kleeorin/Work/Projects/Claudette', rootDir: '/home/kleeorin/Work/Projects/Claudette', state: 'idle' },
] })
await wait(300)
await feed({ type: 'session:state', id: 's1', state: 'running' })
await feed({ type: 'session:state', id: 's2', state: 'waiting' })
await feed({ type: 'session:event', id: 's1', event: { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } } })
const thought = "The undo stack banks a snapshot before each op, so I need to make sure clearAllOutputs is captured too — otherwise redo after a clear would desync the version counter. Let me trace applyOp and confirm the snapshot happens on the success path before the version bump."
for (const chunk of thought.match(/.{1,24}/g)) { await feed({ type: 'session:event', id: 's1', event: { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: chunk } } } }); await wait(40) }
await wait(400)
const ticker = await evaluate(`(()=>{const el=[...document.querySelectorAll('span')].find(s=>s.className.includes('italic')&&s.textContent.includes('undo stack'));return el?el.textContent.slice(0,60):null})()`)
console.log('composer ticker:', JSON.stringify(ticker))
const label = await evaluate(`(()=>{const el=[...document.querySelectorAll('span')].find(s=>s.textContent==='working');return !!el})()`)
console.log('sidebar "working" label present:', label)
await shot('think-1-composer-and-sidebar')

// Now stop thinking (block ends) → the ticker should fall back to "Working…".
await feed({ type: 'session:event', id: 's1', event: { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } } })
await wait(400)
await shot('think-2-working-fallback')

chrome.kill('SIGKILL')
console.log(ticker && label ? '\n✅ both signals rendered' : '\n❌ a signal is missing')
process.exit(ticker && label ? 0 : 1)
