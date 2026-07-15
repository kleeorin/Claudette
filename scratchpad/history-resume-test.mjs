// E2E for (1) shell-like Up/Down message history in the composer, and (2) auto-
// resume of the latest conversation when a RESTORED session is first viewed.
// Injects fake sessions over the app's real WebSocket (captured via a subclass).
// Session s1 (no past convo) drives the history test via optimistic local echoes;
// session s2 (cwd has a fixture conversation) drives auto-resume on activation.
//   node scratchpad/history-resume-test.mjs
import { spawn } from 'child_process'
import { mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-hr-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9354', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9354/json')).json()
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
await wait(700)

const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)
// Two RESTORED sessions (not created via the UI, so not "fresh"): s1 for history,
// s2 (cwd has a fixture conversation) for auto-resume.
await feed({ type: 'session:list', sessions: [
  { id: 's1', name: 'hist-demo', cwd: '/tmp/claudette-hist-test', rootDir: '/tmp/claudette-hist-test', state: 'idle' },
  { id: 's2', name: 'resume-demo', cwd: '/tmp/claudette-resume-test', rootDir: '/tmp/claudette-resume-test', state: 'idle' },
] })
await wait(500)

// --- Feature 1: Up/Down history on s1 (active). Send three messages; the optimistic
// echoes populate the transcript (s1 is unknown server-side, so no real turn runs).
const typeSend = async (text) => {
  await evaluate(`(()=>{const ta=document.querySelector('textarea');const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(ta,${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await wait(120)
  await evaluate(`(()=>{const ta=document.querySelector('textarea');ta.focus();ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`)
  await wait(180)
}
await typeSend('first message')
await typeSend('second message')
await typeSend('third message')
const echoed = await evaluate(`['first message','second message','third message'].every(t=>document.body.innerText.includes(t))`)
check('sent messages appear as user bubbles', echoed === true)

const draftVal = () => evaluate(`document.querySelector('textarea').value`)
const pressKey = (key) => evaluate(`(()=>{const ta=document.querySelector('textarea');ta.focus();ta.dispatchEvent(new KeyboardEvent('${'keydown'}',{key:${JSON.stringify(key)},bubbles:true,cancelable:true}));return true})()`)

await pressKey('ArrowUp'); await wait(120)
check('Up recalls the last sent message', (await draftVal()) === 'third message', JSON.stringify(await draftVal()))
await pressKey('ArrowUp'); await wait(120)
check('Up again recalls the one before', (await draftVal()) === 'second message', JSON.stringify(await draftVal()))
await pressKey('ArrowUp'); await wait(120)
check('Up a third time reaches the oldest', (await draftVal()) === 'first message', JSON.stringify(await draftVal()))
await pressKey('ArrowUp'); await wait(120)
check('Up past the oldest stays put', (await draftVal()) === 'first message', JSON.stringify(await draftVal()))
await pressKey('ArrowDown'); await wait(120)
check('Down walks forward again', (await draftVal()) === 'second message', JSON.stringify(await draftVal()))
await pressKey('ArrowDown'); await pressKey('ArrowDown'); await wait(150)
check('Down past the newest restores empty draft', (await draftVal()) === '', JSON.stringify(await draftVal()))

// --- Feature 2: activate s2 → it auto-resumes its latest conversation (the fixture).
await evaluate(`(()=>{const b=[...document.querySelectorAll('div')].find(d=>d.textContent&&d.textContent.includes('resume-demo')&&d.className.includes('cursor-pointer'));if(b){b.click();return true}return false})()`)
await waitFor(`document.body.innerText.includes('Quicksort is a divide-and-conquer sort')`, 10000).then(() => {}).catch(() => {})
await wait(600)
const resumedAssistant = await evaluate(`document.body.innerText.includes('Quicksort is a divide-and-conquer sort')`)
check('auto-resume loaded the latest conversation (assistant text)', resumedAssistant === true)
const resumedUser = await evaluate(`document.body.innerText.includes('Explain quicksort briefly')`)
check('auto-resume shows past USER prompts too (replay fix)', resumedUser === true)

// Switching back to s1 keeps its (history) transcript, not s2's.
await evaluate(`(()=>{const b=[...document.querySelectorAll('div')].find(d=>d.textContent&&d.textContent.includes('hist-demo')&&d.className.includes('cursor-pointer'));if(b){b.click();return true}return false})()`)
await wait(500)
const s1Kept = await evaluate(`document.body.innerText.includes('third message') && !document.body.innerText.includes('Quicksort is a divide')`)
check('per-session transcripts stay separate after switching', s1Kept === true)

chrome.kill('SIGKILL')
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
