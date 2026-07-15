// Verify a notebook a Claude tool opens lands in the CALLING session, never in the
// session the user is currently viewing. Two sessions: Y (active/viewed) and X
// (Claude working in background). We simulate Claude in X opening a notebook by
// injecting the server frames it produces: notebook:update (doc appears globally)
// + session:focusPane(X). The notebook must appear in X's tabs, NOT Y's.
//   node scratchpad/notebook-session-test.mjs
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-nb2-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9363', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9363/json')).json()
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
// The main tab strip shows tabs for the ACTIVE session. Is there a notebook tab?
const notebookTabShown = () => evaluate(`!!([...document.querySelectorAll('button')].find(b=>b.textContent&&b.textContent.includes('demo.ipynb')))`)
const clickSession = (name) => evaluate(`(()=>{const d=[...document.querySelectorAll('div')].find(x=>x.className.includes('cursor-pointer')&&x.textContent&&x.textContent.includes(${JSON.stringify(name)}));if(!d)return false;d.click();return true})()`)

const SHIM = `
  const RealWS=window.WebSocket; class CapWS extends RealWS{constructor(...a){super(...a);if(String(a[0]).includes('/ws'))window.__appws=this}} window.WebSocket=CapWS;
`
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await waitFor(`!!window.__appws`)
await wait(600)

const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)
// Y is first → active/viewed; X is the background session Claude works in.
await feed({ type: 'session:list', sessions: [
  { id: 'sY', name: 'viewing-this', cwd: '/tmp', rootDir: '/tmp', state: 'idle' },
  { id: 'sX', name: 'claude-here', cwd: '/tmp', rootDir: '/tmp', state: 'running' },
] })
await wait(400)
check('start: no notebook tab in the viewed session', (await notebookTabShown()) === false)

// Claude in X opens a notebook: the doc is pushed globally (notebook:update)…
const doc = { notebookId: 'nb1', path: '/tmp/demo.ipynb', cells: [], version: 1, dirty: false, conflict: false, canUndo: false, canRedo: false, kernelName: null }
await feed({ type: 'notebook:update', doc })
await wait(400)
check('notebook:update alone does NOT leak into the viewed session (the bug)', (await notebookTabShown()) === false, `tabShown=${await notebookTabShown()}`)

// …followed by the per-session focus for the CALLING session X.
await feed({ type: 'session:focusPane', id: 'sX', notebookId: 'nb1', path: '/tmp/demo.ipynb' })
await wait(400)
check('after focusPane(X): STILL not in the viewed session Y', (await notebookTabShown()) === false, `tabShown=${await notebookTabShown()}`)

// Switch to X — the notebook is there.
await clickSession('claude-here')
await wait(500)
check('the notebook IS in the calling session X', (await notebookTabShown()) === true, `tabShown=${await notebookTabShown()}`)

// Back to Y — still clean.
await clickSession('viewing-this')
await wait(500)
check('back in Y: still no notebook tab', (await notebookTabShown()) === false, `tabShown=${await notebookTabShown()}`)

chrome.kill('SIGKILL')
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
