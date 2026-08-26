// Screenshot the new split-layout + compact chat against a THROWAWAY server on
// :4321 (loopback, no token → open). Creates a session (for the companion chat),
// opens a fresh notebook via the new FileBrowser, and captures side / stack / hidden
// layouts. Cleans up the test notebook at the end.
//   node scratchpad/layout-shots.mjs
import { spawn } from 'child_process'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const OUT = '/tmp/claudette-shots'
const NB = '/home/kleeorin/Work/Projects/Claudette/claudette-layout-test.ipynb'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await new Promise((r) => spawn('mkdir', ['-p', OUT]).on('exit', r))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-shots-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9346', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9346/json')).json()
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
cdp.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
function send(method, params = {}) {
  const id = ++cdpId
  cdp.send(JSON.stringify({ id, method, params }))
  return new Promise((res) => pending.set(id, res))
}
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}
async function shot(name) {
  await wait(200)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  console.log(`📸 ${name}`)
}
async function waitFor(expr, ms = 12000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) }
  throw new Error(`timeout waiting for: ${expr}`)
}
const clickText = (label) => evaluate(
  `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)
const clickTitle = (title) => evaluate(
  `(() => { const b = [...document.querySelectorAll('button')].find(x => x.title === ${JSON.stringify(title)}); if (!b) return false; b.click(); return true })()`)

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Chat'))`)
await wait(1000)

// 1. Create a session (needed so the companion chat has something to show).
if (!(await clickTitle('New session'))) console.log('❌ New session (+) not found')
await waitFor(`!!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create session'))`)
await clickText('Create session')
await wait(3500) // let claude spawn + session register
await shot('1-chat')

// 2. Open a fresh notebook via the FileBrowser ("Create here").
if (!(await clickText('+ notebook'))) console.log('❌ + notebook not found')
await waitFor(`!!([...document.querySelectorAll('input')].find(i => i.placeholder === 'new-notebook.ipynb'))`)
await evaluate(`(() => {
  const inp = [...document.querySelectorAll('input')].find(i => i.placeholder === 'new-notebook.ipynb');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(inp, 'claudette-layout-test');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`)
await clickText('Create here')
await waitFor(`!!document.querySelector('.cm-editor')`, 15000).catch(() => console.log('⚠️ no CodeMirror'))
await wait(1200)
await shot('2-notebook-side')   // default 'side' on a 1440px screen

// 3. Toggle to stacked-under.
if (!(await clickTitle('Claude under the notebook'))) console.log('❌ stack toggle not found')
await wait(700)
await shot('3-notebook-stack')

// 4. Hide Claude → full-width notebook.
await clickText('Hide Claude')
await wait(600)
await shot('4-notebook-full')

cdp.close()
chrome.kill('SIGKILL')
await rm(NB, { force: true })
console.log(`done → ${OUT}`)
process.exit(0)
