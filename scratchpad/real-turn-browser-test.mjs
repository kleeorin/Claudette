// End-to-end proof against a REAL Claude turn: create a session in the UI, send a
// prompt that triggers a tool + multi-step work, and sample the Stop/working
// indicator over the whole turn. Before the fix it vanished ~instantly (init
// clobbered running); now it must stay up until the turn actually ends.
//   node scratchpad/real-turn-browser-test.mjs
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const CWD = '/tmp'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-realt-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9358', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1300,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9358/json')).json()
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
async function waitFor(expr, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) } throw new Error(`timeout: ${expr}`) }
const clickTitle = (t) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title===${JSON.stringify(t)});if(!b)return false;b.click();return true})()`)
const clickText = (t) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(t)});if(!b)return false;b.click();return true})()`)
const hasStop = () => evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Stop')`)
const footerState = () => evaluate(`(()=>{const s=[...document.querySelectorAll('span')].find(s=>['idle','running','waiting','exited'].includes(s.textContent.trim().toLowerCase()));return s?s.textContent.trim().toLowerCase():null})()`)

const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`) }

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await wait(500)

// Create a real session in /tmp.
await clickTitle('New session')
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Create session'))`)
await evaluate(`(()=>{const inp=[...document.querySelectorAll('input')].find(i=>i.className.includes('font-mono'));const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(inp,${JSON.stringify(CWD)});inp.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
await clickText('Create session')
await wait(4000)  // let the engine spawn + init

// Send a real multi-step prompt.
await evaluate(`(()=>{const ta=document.querySelector('textarea');const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(ta,'Run the bash command echo hello, then tell me in one short sentence what it printed.');ta.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
await wait(150)
await evaluate(`(()=>{const ta=document.querySelector('textarea');ta.focus();ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`)

// Sample the indicator across the turn.
const samples = []
let sawStop = false, sawRunningAfterInit = false
const start = Date.now()
while (Date.now() - start < 45000) {
  const stop = await hasStop()
  const st = await footerState()
  samples.push(`${((Date.now() - start) / 1000).toFixed(1)}s stop=${stop} state=${st}`)
  if (stop) sawStop = true
  // After ~2s the init has fired; if Stop is still up, running survived the clobber.
  if (stop && Date.now() - start > 2500) sawRunningAfterInit = true
  // Turn done once the assistant's answer is in and state is idle with no Stop.
  const done = await evaluate(`document.body.innerText.toLowerCase().includes('hello') && [...document.querySelectorAll('button')].every(b=>b.textContent.trim()!=='Stop')`)
  if (done && Date.now() - start > 6000) break
  await wait(600)
}

console.log('samples:\n  ' + samples.join('\n  '))
check('Stop/interrupt was visible during the turn', sawStop)
check('indicator SURVIVED init (Stop still up >2.5s in)', sawRunningAfterInit)
const answered = await evaluate(`document.body.innerText.toLowerCase().includes('hello')`)
check('turn actually completed (assistant answered)', answered)
const endState = await footerState()
check('after the turn, footer returns to idle', endState === 'idle', `state=${endState}`)
const stopGone = await hasStop()
check('after the turn, Stop is gone', stopGone === false)

chrome.kill('SIGKILL')
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
