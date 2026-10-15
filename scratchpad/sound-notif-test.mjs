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
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9362', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1300,900',
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
  if (r.result?.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}
async function waitFor(expr, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) } throw new Error(`timeout: ${expr}`) }

import { check, results } from './assert.mjs'
const chimes = () => evaluate(`window.__chimes|0`)
const notes = () => evaluate(`window.__notes.length`)

const SHIM = `
  window.__hidden = false;
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__hidden});
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__hidden?'hidden':'visible'});
  // ★ COUNT CHIMES, NOT OSCILLATORS. playChime() is a deliberate TWO-NOTE ding-dong
  // (A5 then D6), so it constructs TWO oscillators per chime. An earlier version of this
  // shim incremented a counter called __chimes inside the oscillator constructor, which
  // therefore reported 2 per completion and made every count here read double. That is why
  // the positive assertions below were written as >= 1: the exact number was not trustworthy,
  // so nothing could be asserted exactly -- and a genuine DOUBLE SIGNAL (two subscriptions to
  // the same state change, say) would have been invisible behind the same >= 1.
  // MEASURED 2026-10-05 in the browser: one completion produced 2 oscillators and exactly
  // 1 notification, so signal() fires once and the doubling was purely this counter.
  //
  // Grouping by microtask rather than dividing by two keeps this independent of how many
  // notes the chime has: both oscillators of one playChime() are constructed synchronously,
  // so they fall in a single burst. Change the chime to three notes and this still counts 1.
  window.__chimes = 0; window.__oscs = 0; window.__inBurst = false;
  class FakeOsc { constructor(){ this.frequency={value:0}; this.type='sine' } connect(){} start(){} stop(){} }
  class FakeGain { constructor(){ this.gain={setValueAtTime(){},exponentialRampToValueAtTime(){},linearRampToValueAtTime(){}} } connect(){} }
  class FakeAC { constructor(){ this.state='running'; this.currentTime=0; this.destination={} } resume(){return Promise.resolve()} createOscillator(){ window.__oscs++;
      if(!window.__inBurst){ window.__inBurst=true; window.__chimes++; Promise.resolve().then(()=>{window.__inBurst=false}) }
      return new FakeOsc() } createGain(){return new FakeGain()} }
  window.AudioContext = FakeAC;
  window.__notes = [];
  class FakeNote { constructor(t,o){ this.title=t; this.opts=o||{}; window.__notes.push({title:t,tag:(o||{}).tag}) } close(){} }
  FakeNote.permission='granted'; FakeNote.requestPermission=()=>Promise.resolve('granted');
  window.Notification = FakeNote;
  // ★ THE PAGE'S SESSION WORLD IS THIS TEST'S ALONE, ONCE __isolate IS SET.
  // Everything below feeds SYNTHETIC sessions (s1/s2) that the server has never heard of. The
  // shared :4321 server is live and broadcasts to every socket, so any real session:list frame
  // -- a leftover session from an earlier harness exiting, another harness creating one --
  // replaces the synthetic list wholesale. s1 is then absent from sessions, the reducer moves
  // the selection to the real sessions[0] (that invariant is CORRECT: activeId is non-null
  // only while its row exists), s1 stops being "actively watched", and the finish below
  // chimes. The file then reports a false app bug: "chimes at a session you are watching".
  // MEASURED 2026-10-05: with session churn on :4321, 8/8 runs failed exactly that way,
  // chimes=4, matching the 1-in-7 flake seen in the full suite.
  //
  // Registered in the constructor, so it precedes client.ts's sock.onmessage assignment (made
  // after construction) and stopImmediatePropagation reaches it. The test's own injection
  // calls __appws.onmessage(...) DIRECTLY, bypassing event dispatch, so it is unaffected.
  // NOTE: no backticks anywhere in this comment -- it lives inside the SHIM template literal.
  window.__isolate = false;
  const RealWS=window.WebSocket;
  class CapWS extends RealWS{constructor(...a){super(...a);if(String(a[0]).includes('/ws')){window.__appws=this;
    this.addEventListener('message',(ev)=>{ if(!window.__isolate) return; let t='';
      try{ t=JSON.parse(ev.data).type }catch{}
      if(t==='session:list'||t==='session:state'||t==='session:exit') ev.stopImmediatePropagation();
    }, true);
  }}} window.WebSocket=CapWS;
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

// ★ ISOLATE BEFORE THE FIRST FEED, NOT AFTER IT — the ordering is the whole fix.
// Measured: switching it on after the synthetic list still failed 7/8, because a real list
// landing in the gap between the feed and the switch clobbers the synthetic sessions and is
// not dropped. One instrumented run saw 4 real `session:list` frames, of which the 2 inside
// that window got through. Isolating first closes the window entirely: 10/10 under the same
// churn that failed 8/8.
await evaluate(`window.__isolate = true`)

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
await evaluate(`window.__chimes=0; window.__oscs=0`)  // ignore any confirm chime

// Background session finishes, tab FOCUSED (not hidden), bell on, sound on.
await finish('s2')
check('background finish chimes (tab focused, no bell needed for sound)', await poll(chimes, 1), `chimes=${await chimes()}`)
// ★ EXACTLY ONE, NOT "at least one". This is the assertion that can see a double signal --
// two subscriptions to api.on.stateChange, or listeners surviving a reconnect -- which the
// previous >= 1 could not. Verified to have teeth: with the shim made to count each chime
// twice (simulating exactly that defect) this case goes RED, while >= 1 stays green.
check('…exactly once, not twice (a double subscription would show here)',
  (await chimes()) === 1, `chimes=${await chimes()}`)
check('background finish notifies even with tab FOCUSED', await poll(notes, 1), `notes=${await notes()}`)
check('…and notifies exactly once', (await notes()) === 1, `notes=${await notes()}`)
// Pins the chime's SHAPE, so the counter above cannot quietly drift back to counting
// oscillators: one chime is two notes, and a change to that should be a deliberate edit here.
check('one chime is a two-note burst (2 oscillators)', (await evaluate(`window.__oscs|0`)) === 2,
  `oscillators=${await evaluate(`window.__oscs|0`)}`)

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

cdpDone = true   // deliberate teardown from here — the CDP close below is expected
reapChrome()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
