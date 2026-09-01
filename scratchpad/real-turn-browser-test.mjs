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
import { answerTrustGate, waitForComposer } from './trust-gate.mjs'

const APP = 'http://127.0.0.1:4321'
const CWD = '/tmp'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-realt-'))
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9358', `--user-data-dir=${chromeDir}`,
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
async function waitFor(expr, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) } throw new Error(`timeout: ${expr}`) }
const clickTitle = (t) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title===${JSON.stringify(t)});if(!b)return false;b.click();return true})()`)
const clickText = (t) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(t)});if(!b)return false;b.click();return true})()`)
const hasStop = () => evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Stop')`)
const footerState = () => evaluate(`(()=>{const s=[...document.querySelectorAll('span')].find(s=>['idle','running','waiting','exited'].includes(s.textContent.trim().toLowerCase()));return s?s.textContent.trim().toLowerCase():null})()`)

import { check, results } from './assert.mjs'

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
// Same workspace-trust gate as doubling-agents-test: an untrusted cwd renders "Trust this
// folder?" instead of creating the session, and this file predated it. Without answering,
// the next line's value-setter ran against a null textarea and threw `Illegal invocation`.
await answerTrustGate(evaluate)
await waitForComposer(evaluate)
await wait(4000)  // let the engine spawn + init

// Send a real multi-step prompt.
// PROMPT LENGTH IS LOAD-BEARING, not incidental. The assertion below needs to observe the
// indicator STILL UP after the init has fired, and it uses >2.5s as the proxy for "init has
// certainly landed". This prompt used to be a bare `echo hello` + one sentence, and the
// whole turn finished in ~2.7s: samples read stop=true at 2.4s and stop=false at 3.0s, so
// the 2500ms threshold fell in the gap and the check failed with the indicator having been
// up the entire turn. That was the harness racing the model, not a regression. Ask for
// enough work that the turn comfortably outlives the threshold.
await evaluate(`(()=>{const ta=document.querySelector('textarea');const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(ta,'Run the bash command echo hello, then the bash command uname -a, then write two short paragraphs explaining what each printed and why they differ.');ta.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
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
  await wait(200)
}

console.log('samples:\n  ' + samples.join('\n  '))
// Locate the transition explicitly. A failure of the next check is either "the indicator
// vanished early" (the real bug) or "the turn was shorter than the threshold" (the harness
// racing the model, which is what happened on 2026-08-24); printing the last moment Stop was
// seen tells the two apart without re-running.
{
  const upSamples = samples.filter((l) => l.includes('stop=true'))
  const lastUp = upSamples.length ? upSamples[upSamples.length - 1].trim().split(' ')[0] : 'never'
  console.log(`  → Stop last seen at ${lastUp} (threshold for the init check is 2.5s)`)
}
check('Stop/interrupt was visible during the turn', sawStop)
check('indicator SURVIVED init (Stop still up >2.5s in)', sawRunningAfterInit)
// ★ THIS ASSERTION WAS VACUOUS AND ALWAYS GREEN. It searched document.body for 'hello' —
// and the PROMPT this harness types is "Run the bash command echo hello, then …", so the
// word was on screen from the instant the user's own bubble rendered. It could not fail:
// not when the assistant said nothing, not when the turn died on an auth-failure frame,
// not with the whole transcript feature removed. A check that passes for a reason
// unrelated to its name reports nothing.
// It now asks the DOM for an ASSISTANT item specifically, via the `data-kind` marker on
// the transcript row (harness-only, same contract as App.tsx's `data-phone`).
const answered = await evaluate(`(() => {
  const a = [...document.querySelectorAll('[data-kind="text"]')]
  return a.some((el) => (el.innerText || '').trim().length > 0)
})()`)
check('turn actually completed (the ASSISTANT produced text)', answered)
const endState = await footerState()
check('after the turn, footer returns to idle', endState === 'idle', `state=${endState}`)
const stopGone = await hasStop()
check('after the turn, Stop is gone', stopGone === false)

// ── A CREDENTIAL IS A PREREQUISITE, NOT A PRODUCT BEHAVIOUR ──────────────────────────
// If the CLI is not logged in the turn dies instantly on an auth-failure frame: the whole
// "turn" completes in ~200ms, the session goes idle well before the 2.5s threshold, and
// `indicator SURVIVED init` fails for a reason that has nothing to do with the indicator.
// Reporting that as a test result names the wrong thing — and the suite's own rule is that
// a prerequisite problem must never be reported as a failure. So: exit 77, the runner's
// runtime-skip code, which lands in the SKIP column with the reason attached.
// Detected from the page rather than from the CLI, because that is what this harness can
// see; an auth failure surfaces as an error bubble, and chat.tsx documents that the frame
// itself arrives labelled subtype:'success', so the label cannot be trusted for this.
const authFailed = await evaluate(`(() => {
  const t = (document.body.innerText || '').toLowerCase()
  return t.includes('authentication_failed') || t.includes('not logged in') || t.includes('please run /login')
})()`)
cdpDone = true   // deliberate teardown from here — the CDP close below is expected
reapChrome()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
if (authFailed) {
  console.error('\n[skip] the CLI is not logged in, so this run is not a verdict on the working indicator.')
  console.error('   The turn dies on the auth-failure frame in ~200ms, so the session is idle before the')
  console.error('   2.5s threshold and the init check fails for an unrelated reason. Fix the credential,')
  console.error('   then re-run — re-running until it goes green proves nothing.')
  console.error(`   (assertions this run, for information only: ${passed}/${results.length})`)
  process.exit(77)
}
process.exit(passed === results.length ? 0 : 1)
