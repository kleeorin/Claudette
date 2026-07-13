// Screenshot the three main views (chat / notebook / terminal) of the RUNNING
// Claudette server on :4319 via headless Chrome CDP. Auth via the persisted token.
//   node scratchpad/ui-screenshots.mjs
import { spawn } from 'child_process'
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4319'
const OUT = '/tmp/claudette-shots'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const token = (await readFile('.claudette-token', 'utf8')).trim()

await spawnSync('mkdir', ['-p', OUT])
function spawnSync(cmd, args) { return new Promise((r) => spawn(cmd, args).on('exit', r)) }

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-shots-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9345', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9345/json')).json()
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
  await wait(150)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  console.log(`📸 ${name}`)
}
async function waitFor(expr, ms = 10000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await evaluate(expr)) return true
    await wait(200)
  }
  throw new Error(`timeout waiting for: ${expr}`)
}
const clickButton = (label) => evaluate(
  `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

// auth (sets the httpOnly cookie), then the app
await send('Page.navigate', { url: `${APP}/api/auth?token=${token}` })
await wait(800)
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Chat'))`)
await wait(1200) // let sessions/WS settle
await shot('1-chat')

// notebook: open the default path via the dialog
await clickButton('+ notebook')
await waitFor(`!!document.querySelector('.modal-input')`)
const opened = await clickButton('Open')
if (!opened) console.log('❌ Open button not found')
await waitFor(`!!document.querySelector('.cm-editor')`, 15000).catch(() => console.log('⚠️ no CodeMirror editor appeared'))
await wait(1000)
await shot('2-notebook')

// terminal
await clickButton('Terminal')
await waitFor(`!!document.querySelector('.xterm')`, 10000).catch(() => console.log('⚠️ no xterm appeared'))
await wait(1500) // shell prompt
await evaluate(`(() => { const t = document.querySelector('.xterm textarea'); if (t) t.focus(); return true })()`)
await shot('3-terminal')

cdp.close()
chrome.kill('SIGKILL')
console.log(`done → ${OUT}`)
process.exit(0)
