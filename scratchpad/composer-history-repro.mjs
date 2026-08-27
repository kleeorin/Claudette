// Repro for the composer bug: "I'm writing, press Up, my text is gone and Down
// doesn't bring it back." Unlike history-resume-test.mjs (which dispatches synthetic
// KeyboardEvents that never move the caret), this drives REAL key events through CDP
// Input, so the browser's own caret defaults apply — which is where the bug lives.
//
// Runs its own server + vite on private ports with an isolated CLAUDETTE_DATA_DIR, so
// it never touches the real session list. The session is injected client-side over the
// app's WebSocket (so no real Claude turn ever runs; sends are optimistic echoes).
//   node scratchpad/composer-history-repro.mjs
import { spawn, execFileSync } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

// Renumbered off 4491/5291: find-diff-check.mjs binds BOTH of those, with a different
// throwaway token, so a leaked instance of either made the other report 401s across every
// check. Note it was both ports, not just the API one — moving only PORT would have left
// the web-server collision in place.
const PORT = 4494
const WEB_PORT = 5294
const APP = `http://127.0.0.1:${WEB_PORT}`
const TOKEN = 'hist-token'
const CHROME = process.env.CHROME_BIN ?? '/tmp/browsers/chrome/linux-152.0.7977.54/chrome-linux64/chrome'
const CDP_PORT = 9357
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const DATA = await mkdtemp(join(tmpdir(), 'hist-data-'))
// A cwd with no past conversations: ChatView seeds recall from a resumed transcript,
// and a shared dir like /tmp has real ones — they'd show up as extra history levels.
const PROJ = await mkdtemp(join(tmpdir(), 'hist-proj-'))
const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), CLAUDETTE_TOKEN: TOKEN, CLAUDETTE_DATA_DIR: DATA },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let log = ''
server.stdout.on('data', (d) => (log += d))
server.stderr.on('data', (d) => (log += d))
const web = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
  cwd: 'web', env: { ...process.env, PORT: String(PORT), WEB_PORT: String(WEB_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let weblog = ''
web.stdout.on('data', (d) => (weblog += d))
web.stderr.on('data', (d) => (weblog += d))
const reap = () => {
  for (const p of [server, web]) { try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} } }
  try { chrome?.kill('SIGKILL') } catch {}
}
process.on('exit', reap)
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reap(); if (e) console.error(e); process.exit(1) })
}
for (let i = 0; i < 60 && !log.includes('Server listening'); i++) await wait(500)
if (!log.includes('Server listening')) { console.error(log.slice(-2000)); throw new Error('server did not start') }
for (let i = 0; i < 60 && !weblog.includes('ready in'); i++) await wait(500)
if (!weblog.includes('ready in')) { console.error(weblog.slice(-2000)); throw new Error('vite did not start') }
console.log('server + vite up')

// A chrome left behind by an earlier run would still answer on this port — we'd attach
// to ITS page (and ITS localStorage) and test stale state. Take the port for ourselves.
try { execFileSync('pkill', ['-f', `remote-debugging-port=${CDP_PORT}`]) } catch { /* none running */ }
await wait(500)
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-hist-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
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
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
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
cdp.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
function send(method, params = {}) { const id = ++cdpId; return new Promise((res) => { pending.set(id, res); cdp.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}
async function waitFor(expr, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) } throw new Error(`timeout: ${expr}`) }

const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`) }

const SHIM = `
  // A previous run's drafts/history would otherwise seed this one (same origin).
  try { localStorage.clear() } catch {}
  const RealWS = window.WebSocket;
  class CapWS extends RealWS { constructor(...a){ super(...a); if(String(a[0]).includes('/ws')) window.__appws=this; } }
  window.WebSocket = CapWS;
`
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/?token=${TOKEN}` })
await waitFor(`!!document.querySelector('textarea') || !!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await waitFor(`!!window.__appws`)
await wait(700)

const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)
await feed({ type: 'session:list', sessions: [
  { id: 'h1', name: 'hist-demo', cwd: PROJ, rootDir: PROJ, state: 'idle' },
  { id: 'h2', name: 'other-demo', cwd: PROJ, rootDir: PROJ, state: 'idle' },
] })
await wait(800)
await waitFor(`!!document.querySelector('textarea')`)

// --- real input helpers -------------------------------------------------------
const focusTa = () => evaluate(`(()=>{const ta=document.querySelector('textarea');ta.focus();return true})()`)
const KEYS = { ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35 }
async function key(name, n = 1) {
  for (let i = 0; i < n; i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: KEYS[name], nativeVirtualKeyCode: KEYS[name] })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: KEYS[name], nativeVirtualKeyCode: KEYS[name] })
    await wait(150)
  }
}
async function type(text) { await focusTa(); await send('Input.insertText', { text }); await wait(180) }
async function enter() {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
  await wait(300)
  // EVERY SEND IN THIS HARNESS FAILS, BY CONSTRUCTION — and that is new information, not a
  // defect. The sessions here are PHANTOMS: they exist only because the shim fed a synthetic
  // `session:list` frame, so the real server behind this harness has never heard of `h1`.
  // `sendUserTurn` therefore returns false and the server broadcasts `session:sendFailed`
  // (sessionApi.ts). That was invisible until the dispatch fix made the frame arrive, and now
  // ChatView answers it by restoring the lost text into the composer — correctly.
  // So `enter()` no longer leaves an empty box, and the next `type()` INSERTS at the caret,
  // producing the "first messagesecond message" concatenation. Clearing here restores this
  // helper's original meaning: leave the composer as a SUCCESSFUL send would.
  // Scenarios B/C/D never saw this because `resetToDraft()` already cleared for them; A and E
  // are the two that type straight after a send.
  await clearBox()
}
const state = () => evaluate(`(()=>{const ta=document.querySelector('textarea');return {v:ta.value,s:ta.selectionStart,e:ta.selectionEnd}})()`)
// Walk back down to your own draft (level 0) and empty the box — where a scenario
// starts, rather than wherever the previous one left the history pointer.
const resetToDraft = async () => { await focusTa(); await key('ArrowDown', 8); await clearBox() }
const clearBox = async () => {
  await evaluate(`(()=>{const ta=document.querySelector('textarea');const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(ta,'');ta.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await wait(250)
}

// Seed two sent messages.
await focusTa()
await type('first message'); await enter()
await type('second message'); await enter()
console.log('after sends:', JSON.stringify(await state()))

// --- Scenario A: single-line draft, caret at end, Up …, then Down back ---------
await type('my precious draft')
console.log('A typed:  ', JSON.stringify(await state()))
await key('ArrowUp');   console.log('A up#1:   ', JSON.stringify(await state()))
await key('ArrowUp');   console.log('A up#2:   ', JSON.stringify(await state()))
await key('ArrowDown'); console.log('A down#1: ', JSON.stringify(await state()))
await key('ArrowDown'); console.log('A down#2: ', JSON.stringify(await state()))
check('A: Down restores the in-progress draft', (await state()).v === 'my precious draft', JSON.stringify((await state()).v))

// --- Scenario B: multi-line draft, walk Up out of it and back Down -------------
await resetToDraft()
await type('line one\nline two')
console.log('B typed:  ', JSON.stringify(await state()))
await key('ArrowUp', 4);   console.log('B up x4:  ', JSON.stringify(await state()))
await key('ArrowDown', 4); console.log('B down x4:', JSON.stringify(await state()))
check('B: Down restores the multi-line draft', (await state()).v === 'line one\nline two', JSON.stringify((await state()).v))

// --- Scenario C: draft → recall → edit the recalled message → browse further back.
// Both the edit AND the original draft have to survive the round trip.
await resetToDraft()
await type('draft C')
await key('ArrowUp', 2)                 // caret to start, then recall 'second message'
await type(' EDITED')
console.log('C edited: ', JSON.stringify(await state()))
await key('ArrowUp', 2);   console.log('C up x2:  ', JSON.stringify(await state()))
check('C: Up past the oldest stays put', (await state()).v === 'first message', JSON.stringify((await state()).v))
await key('ArrowDown');    console.log('C down#1: ', JSON.stringify(await state()))
check('C: Down brings the edited message back', (await state()).v === 'second message EDITED', JSON.stringify((await state()).v))
await key('ArrowDown');    console.log('C down#2: ', JSON.stringify(await state()))
check('C: Down again brings back the original draft', (await state()).v === 'draft C', JSON.stringify((await state()).v))

// --- Scenario D: recall, switch sessions, come back — the draft is still one Down
// away (ChatView remounts on a switch, so this used to strand the recalled message).
await resetToDraft()
await type('draft D')
await key('ArrowUp', 2)
console.log('D recalled:', JSON.stringify(await state()))
const clickSession = async (name) => {
  await evaluate(`(()=>{const b=[...document.querySelectorAll('div')].find(d=>d.textContent&&d.textContent.includes(${JSON.stringify(name)})&&d.className.includes('cursor-pointer'));if(b){b.click();return true}return false})()`)
  await wait(900)
}
await clickSession('other-demo')
await clickSession('hist-demo')
console.log('D back:   ', JSON.stringify(await state()))
await focusTa()
await key('ArrowDown')
console.log('D down#1: ', JSON.stringify(await state()))
check('D: draft survives a session switch mid-recall', (await state()).v === 'draft D', JSON.stringify((await state()).v))

// --- Scenario E: a multi-line recalled message — Up must move the caret between its
// lines first and only browse further back from the top line.
await resetToDraft()
await type('two\nline draft'); await enter()      // now the newest history entry
await wait(300)
await key('ArrowUp')                              // recall it (box is empty, caret at 0)
console.log('E recalled:', JSON.stringify(await state()))
check('E: recalled the multi-line message', (await state()).v === 'two\nline draft', JSON.stringify((await state()).v))
await key('ArrowUp')                              // caret to line 1, still the same text
console.log('E up#2:   ', JSON.stringify(await state()))
check('E: Up inside it moves the caret, not the history', (await state()).v === 'two\nline draft', JSON.stringify((await state()).v))
await key('ArrowUp')                              // from the top line → older message
console.log('E up#3:   ', JSON.stringify(await state()))
// (sending in E cleared the per-level edits, so this is the plain history text again)
check('E: Up from the top line browses back', (await state()).v === 'second message', JSON.stringify((await state()).v))

cdpDone = true   // deliberate teardown from here — the CDP close below is expected
reap()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
