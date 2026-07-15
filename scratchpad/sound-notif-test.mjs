// Verify the new background-session signals:
//  • sound (chime) fires on a background session finishing, WITHOUT the tab hidden
//    and WITHOUT the bell — and NOT when you're actively watching that session;
//  • desktop notification now fires even with the tab FOCUSED (bell enabled);
//  • muting the sound stops the chime but keeps the notification.
// Stubs AudioContext (counts chimes) + Notification (counts + permission granted),
// and pins document.hidden=false so "focused" is deterministic in headless.
//   node scratchpad/sound-notif-test.mjs
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-snd-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9362', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1300,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9362/json')).json()
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
const chimes = () => evaluate(`window.__chimes|0`)
const notes = () => evaluate(`window.__notes.length`)

const SHIM = `
  window.__hidden = false;
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__hidden});
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__hidden?'hidden':'visible'});
  window.__chimes = 0;
  class FakeOsc { constructor(){ window.__chimes++; this.frequency={value:0}; this.type='sine' } connect(){} start(){} stop(){} }
  class FakeGain { constructor(){ this.gain={setValueAtTime(){},exponentialRampToValueAtTime(){},linearRampToValueAtTime(){}} } connect(){} }
  class FakeAC { constructor(){ this.state='running'; this.currentTime=0; this.destination={} } resume(){return Promise.resolve()} createOscillator(){return new FakeOsc()} createGain(){return new FakeGain()} }
  window.AudioContext = FakeAC;
  window.__notes = [];
  class FakeNote { constructor(t,o){ this.title=t; this.opts=o||{}; window.__notes.push({title:t,tag:(o||{}).tag}) } close(){} }
  FakeNote.permission='granted'; FakeNote.requestPermission=()=>Promise.resolve('granted');
  window.Notification = FakeNote;
  const RealWS=window.WebSocket; class CapWS extends RealWS{constructor(...a){super(...a);if(String(a[0]).includes('/ws'))window.__appws=this}} window.WebSocket=CapWS;
`
await send('Page.enable')
await send('Runtime.enable')
cdp.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.method === 'Runtime.exceptionThrown') console.log('  ⚠ PAGE EXCEPTION:', m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text)
})
await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await waitFor(`!!window.__appws`)
await wait(600)

const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)
await feed({ type: 'session:list', sessions: [
  { id: 's1', name: 'foreground', cwd: '/tmp', rootDir: '/tmp', state: 'idle' },
  { id: 's2', name: 'background', cwd: '/tmp', rootDir: '/tmp', state: 'idle' },
] })
await wait(400)

// Finish a session: inject running, settle, inject idle, settle.
const finish = async (sid) => {
  await feed({ type: 'session:state', id: sid, state: 'running' })
  await wait(250)
  await feed({ type: 'session:state', id: sid, state: 'idle' })
  await wait(400)
}
const poll = async (fn, want, ms = 2000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await fn()) >= want) return true; await wait(100) } return false }

// Reset counters (the AC probe touched __chimes; already reset above).
await evaluate(`window.__chimes=0`)

// Enable the bell (desktop notifications). Sound is on by default.
const bellClicked = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').toLowerCase().includes('desktop notification'));if(!b)return false;b.click();return true})()`)
check('bell toggle found + clicked', bellClicked === true)
await wait(200)
await evaluate(`window.__chimes=0`)  // ignore any confirm chime

// Background session finishes, tab FOCUSED (not hidden), bell on, sound on.
await finish('s2')
check('background finish chimes (tab focused, no bell needed for sound)', await poll(chimes, 1), `chimes=${await chimes()}`)
check('background finish notifies even with tab FOCUSED', await poll(notes, 1), `notes=${await notes()}`)

// Active session (s1) finishing while you watch it (active + focused): silent.
const cBefore = await chimes(), nBefore = await notes()
await finish('s1')
check('actively-watched session finishing is silent (no chime)', (await chimes()) === cBefore, `chimes=${await chimes()}`)
check('actively-watched session finishing does not notify', (await notes()) === nBefore)

// Mute sound; background finish should still notify but not chime.
await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')||'').includes('Mute completion sound'));if(b){b.click();return true}return false})()`)
await wait(150)
const cMute = await chimes(), nMute = await notes()
await finish('s2')
check('muted: background finish does NOT chime', (await chimes()) === cMute, `chimes=${await chimes()}`)
check('muted: desktop notification still fires', await poll(notes, nMute + 1), `notes=${await notes()}`)

chrome.kill('SIGKILL')
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
