// Screenshot the redesigned shell against the throwaway server on :4321.
// Creates a session in a demo dir, then exercises: Files dock, Milkdown (.md) tab,
// CodeMirror (.ts, color-coded) tab, Git dock, Terminal bottom dock.
//   node scratchpad/redesign-shot.mjs
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const OUT = '/tmp/claudette-shots'
const CWD = '/tmp/claudette-fs-test'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await new Promise((r) => spawn('mkdir', ['-p', OUT]).on('exit', r))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-rd-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9349', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1500,940',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9349/json')).json()
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
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result?.result?.value }
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); const { writeFile } = await import('fs/promises'); await writeFile(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log(`📸 ${name}`) }
async function waitFor(expr, ms = 12000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) } throw new Error(`timeout: ${expr}`) }
const clickText = (label) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!b)return false;b.click();return true})()`)
const clickTitle = (title) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title===${JSON.stringify(title)});if(!b)return false;b.click();return true})()`)
const clickFile = (name) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent&&x.textContent.includes(${JSON.stringify(name)}));if(!b)return false;b.click();return true})()`)

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await wait(700)

// Session in the demo dir.
if (!(await clickTitle('New session'))) console.log('❌ New session btn')
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Create session'))`)
await evaluate(`(()=>{const inp=[...document.querySelectorAll('input')].find(i=>i.className.includes('font-mono'));const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(inp,${JSON.stringify(CWD)});inp.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
await clickText('Create session')
await wait(3500)
await shot('r1-chat-full')

// Files dock.
if (!(await clickTitle('Files browser'))) console.log('❌ Files toggle')
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent&&b.textContent.includes('README.md')))`, 8000).catch(()=>console.log('⚠️ file list'))
await wait(800)
await shot('r2-files-dock')

// Open README.md → Milkdown editor tab (companion split with Claude).
await clickFile('README.md')
await waitFor(`!!document.querySelector('.milkdown-host .ProseMirror')`, 8000).catch(()=>console.log('⚠️ milkdown'))
await wait(1200)
await shot('r3-milkdown-md')

// Open sample.ts → CodeMirror color-coded tab.
await clickFile('sample.ts')
await waitFor(`!!document.querySelector('.cm-editor')`, 8000).catch(()=>console.log('⚠️ codemirror'))
await wait(1000)
await shot('r4-code-ts')

// Git dock.
if (!(await clickTitle('Git panel'))) console.log('❌ Git toggle')
await wait(1200)
await shot('r5-git-dock')

// Terminal bottom dock.
if (!(await clickTitle('Terminal'))) console.log('❌ Terminal toggle')
await wait(1500)
await shot('r6-terminal-bottom')

cdp.close(); chrome.kill('SIGKILL')
console.log(`done → ${OUT}`)
process.exit(0)
