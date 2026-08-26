// Verify the sidebar "needs attention" red light: a background session that finishes
// a turn (running→idle) while you're viewing a DIFFERENT session gets a red light,
// which clears when you switch to it. Also: the ACTIVE session finishing does NOT
// flag itself.
//   node scratchpad/attention-test.mjs
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-att-'))
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9359', `--user-data-dir=${chromeDir}`,
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
      const list = await (await fetch('http://127.0.0.1:9359/json')).json()
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

const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`) }
// Count the red attention dots (the "needs attention" light uses a red pulsing dot with that title).
const attentionCount = () => evaluate(`document.querySelectorAll('[title="Finished — needs your attention"]').length`)
const clickSession = (name) => evaluate(`(()=>{const d=[...document.querySelectorAll('div')].find(x=>x.className.includes('cursor-pointer')&&x.textContent&&x.textContent.includes(${JSON.stringify(name)}));if(!d)return false;d.click();return true})()`)

const SHIM = `
  const RealWS = window.WebSocket;
  class CapWS extends RealWS { constructor(...a){ super(...a); if(String(a[0]).includes('/ws')) window.__appws=this; } }
  window.WebSocket = CapWS;
`
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await waitFor(`!!window.__appws`)
await wait(600)

const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)
// s1 (active by default) + s2 (background).
await feed({ type: 'session:list', sessions: [
  { id: 's1', name: 'foreground', cwd: '/tmp', rootDir: '/tmp', state: 'idle' },
  { id: 's2', name: 'background', cwd: '/tmp', rootDir: '/tmp', state: 'idle' },
] })
await wait(400)
check('no attention lights initially', (await attentionCount()) === 0)

// s2 runs then finishes while s1 is active → s2 should get an attention light.
await feed({ type: 'session:state', id: 's2', state: 'running' })
await wait(120)
await feed({ type: 'session:state', id: 's2', state: 'idle' })
await wait(250)
check('background session that finished shows ONE attention light', (await attentionCount()) === 1, `count=${await attentionCount()}`)

// The ACTIVE session (s1) finishing a turn must NOT flag itself.
await feed({ type: 'session:state', id: 's1', state: 'running' })
await wait(120)
await feed({ type: 'session:state', id: 's1', state: 'idle' })
await wait(250)
check('active session finishing does NOT flag itself', (await attentionCount()) === 1, `count=${await attentionCount()}`)

// Switching to s2 clears its light.
await clickSession('background')
await wait(400)
check('viewing the flagged session clears its light', (await attentionCount()) === 0, `count=${await attentionCount()}`)

// A failed exit on a now-background session (s1) also flags it.
await feed({ type: 'session:exit', id: 's1', failed: true, error: 'boom' })
await wait(300)
check('a background session that ERRORED gets an attention light', (await attentionCount()) === 1, `count=${await attentionCount()}`)

cdpDone = true   // deliberate teardown from here — the CDP close below is expected
reapChrome()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
