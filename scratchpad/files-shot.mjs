// Screenshot the Git panel against the THROWAWAY server on :4321. Creates a
// session rooted in a real git repo (ClaudeMaster), opens the Git tab, and shoots
// the Changes view + a selected file's diff.
//   node scratchpad/git-shot.mjs
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const OUT = '/tmp/claudette-shots'
const REPO = '/home/kleeorin/Work/Projects/ClaudeMaster'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await new Promise((r) => spawn('mkdir', ['-p', OUT]).on('exit', r))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-files-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9348', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9348/json')).json()
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
cdp.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
function send(method, params = {}) {
  const id = ++cdpId
  return new Promise((res) => { pending.set(id, res); cdp.send(JSON.stringify({ id, method, params })) })
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFile } = await import('fs/promises')
  await writeFile(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64'))
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
const setInput = (placeholder, value) => evaluate(`(() => {
  const inp = [...document.querySelectorAll('input')].find(i => i.placeholder === ${JSON.stringify(placeholder)});
  if (!inp) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(inp, ${JSON.stringify(value)});
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`)

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Chat'))`)
await wait(800)

// Create a session rooted in the git repo.
if (!(await clickTitle('New session'))) console.log('❌ New session (+) not found')
await waitFor(`!!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create session'))`)
// The cwd field is prefilled with DEFAULT_CWD; overwrite it with the repo path.
await evaluate(`(() => {
  const inp = [...document.querySelectorAll('input')].find(i => i.className.includes('font-mono'));
  if (!inp) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(inp, ${JSON.stringify(REPO)});
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`)
await clickText('Create session')
await wait(3500)

// Open the Files tab.
if (!(await clickTitle('File browser'))) console.log('❌ Files tab not found')
await waitFor(`!!([...document.querySelectorAll('span')].find(el => el.textContent === 'Files'))`, 8000).catch(() => console.log('⚠️ Files header missing'))
await wait(1200)
await shot('7-files-list')

// Click a text file (package.json) to preview it.
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent && x.textContent.includes('package.json'));
  if (b) { b.click(); return true } return false;
})()`)
await wait(1200)
await shot('8-files-preview')

cdp.close()
chrome.kill('SIGKILL')
console.log(`done → ${OUT}`)
process.exit(0)
