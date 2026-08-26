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
// Token now lives under ~/.config/claudette/ (out of the mounted project dir); fall
// back to the CLAUDETTE_TOKEN env for one-off overrides.
const tokenPath = `${process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`}/claudette/token`
const token = (process.env.CLAUDETTE_TOKEN || (await readFile(tokenPath, 'utf8'))).trim()

await spawnSync('mkdir', ['-p', OUT])
function spawnSync(cmd, args) { return new Promise((r) => spawn(cmd, args).on('exit', r)) }

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-shots-'))
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9345', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,900',
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
// A CDP reply is awaited on a promise that ONLY the socket can resolve, so if Chrome dies
// mid-run — crash, OOM, an external pkill — every pending send() hangs forever and the
// harness sleeps in ep_poll holding its ports until someone hunts it down. Abort loudly
// instead. No reap() here on purpose: process.exit() runs the process.on('exit') handlers,
// which already cover every child. `cdpDone` keeps this off the DELIBERATE teardown below,
// where the very same close event is expected and must not be read as a failure.
let cdpDone = false
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died; aborting rather than hanging'); process.exit(1) })
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

cdpDone = true   // deliberate teardown from here — the CDP close below is expected
cdp.close()
reapChrome()
console.log(`done → ${OUT}`)
process.exit(0)
