// Verify markdown-cell rendering + heading-level collapse in the notebook.
// Opens /tmp/claudette-nb-test/demo.ipynb (H1 → code → H2 → code → H1 → code),
// asserts markdown renders (real <h1>, not raw `#`), then collapses the first H1
// and asserts the 3 cells beneath it fold away (down to the next H1).
//   node scratchpad/md-collapse-shot.mjs
import { spawn } from 'child_process'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const OUT = '/tmp/claudette-shots'
const CWD = '/tmp/claudette-nb-test'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await new Promise((r) => spawn('mkdir', ['-p', OUT]).on('exit', r))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-md-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9353', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9353/json')).json()
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
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(`${OUT}/${name}.png`, Buffer.from(r.result.data, 'base64')); console.log(`📸 ${name}`) }
const clickTitle = (t) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title===${JSON.stringify(t)});if(!b)return false;b.click();return true})()`)
const clickText = (t) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(t)});if(!b)return false;b.click();return true})()`)

const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`) }

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await wait(500)

// Session rooted at the fixture dir.
await clickTitle('New session')
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Create session'))`)
await evaluate(`(()=>{const inp=[...document.querySelectorAll('input')].find(i=>i.className.includes('font-mono'));const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(inp,${JSON.stringify(CWD)});inp.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
await clickText('Create session')
await wait(2500)

// Open the notebook from the Files dock.
await clickTitle('Files browser')
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent&&b.textContent.includes('demo.ipynb')))`)
await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent&&x.textContent.includes('demo.ipynb'));b.click();return true})()`)
await waitFor(`!!document.querySelector('.cm-markdown h1')`)
await wait(700)

// 1. Markdown renders (real <h1>, not a CodeMirror editor showing `# Section One`).
const h1s = await evaluate(`[...document.querySelectorAll('.cm-markdown h1')].map(h=>h.textContent)`)
check('markdown cells render as HTML headings', Array.isArray(h1s) && h1s.some(t => /Section One/.test(t)) && h1s.some(t => /Section Two/.test(t)), JSON.stringify(h1s))
const rawShown = await evaluate(`document.body.innerText.includes('# Section One')`)
check('raw "# Section One" is NOT shown (rendered, not source)', rawShown === false)
const bullets = await evaluate(`document.querySelectorAll('.cm-markdown ul li').length`)
check('sub-section list renders as bullets', bullets >= 2, `li=${bullets}`)
await shot('md-1-rendered')

// 2. Collapse the first H1 → the 3 cells under it (code, H2, code) fold; H1 #2 stays.
const carets = await evaluate(`[...document.querySelectorAll('button[title="Collapse section"]')].length`)
check('heading cells expose a collapse caret', carets >= 2, `carets=${carets}`)
await evaluate(`(()=>{const b=document.querySelector('button[title="Collapse section"]');b.click();return true})()`)
await wait(500)
const badge = await evaluate(`document.body.innerText.match(/(\\d+) cells hidden/)?.[1] || null`)
check('collapsed heading shows a "N cells hidden" badge (3)', badge === '3', `badge=${badge}`)
const underOneHidden = await evaluate(`!document.body.innerText.includes('under section one')`)
check('a code cell under the H1 is folded away', underOneHidden === true)
const subGone = await evaluate(`![...document.querySelectorAll('.cm-markdown h2')].some(h=>/Subsection A/.test(h.textContent))`)
check('the nested H2 subsection is folded away', subGone === true)
const twoVisible = await evaluate(`[...document.querySelectorAll('.cm-markdown h1')].some(h=>/Section Two/.test(h.textContent))`)
check('the next H1 (Section Two) stays visible', twoVisible === true)
await shot('md-2-collapsed')

// 3. Expand again → everything returns.
await evaluate(`(()=>{const b=document.querySelector('button[title="Expand section"]');b.click();return true})()`)
await wait(500)
const restored = await evaluate(`document.body.innerText.includes('under section one')`)
check('expanding restores the folded cells', restored === true)
await shot('md-3-expanded')

chrome.kill('SIGKILL')
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
