// End-to-end proof against a REAL Claude turn: create a session in the UI, send a
// prompt that triggers a tool + multi-step work, and sample the Stop/working
// indicator over the whole turn. Before the fix it vanished ~instantly (init
// clobbered running); now it must stay up until the turn actually ends.
//   node scratchpad/real-turn-browser-test.mjs
//
// ★★ READ THIS BEFORE EDITING ANY ASSERTION IN THIS FILE ★★
// THIS FILE HAS PRODUCED THREE VACUOUS ASSERTIONS, AND ONE OF THEM WAS CREATED BY REPAIRING
// ANOTHER. That is the fact worth carrying, because it is a statement about the repair
// process and not about any one check:
//
//   1. "turn actually completed" searched document.body for the word 'hello' — which THIS
//      FILE'S OWN PROMPT contains ("Run the bash command echo hello, …"). True from the
//      instant the user's bubble rendered. It could not fail: not with the assistant silent,
//      not with the turn dead on an auth frame, not with the transcript feature deleted.
//   2. It was repaired to ask for an ASSISTANT item via [data-kind="text"] — an honest
//      selector — but still with .some(): "is there assistant text on screen?". ALSO ALWAYS
//      TRUE, because the session replays its own previous runs (see the BASELINE block).
//      ★ A VACUOUS ASSERTION WAS REPAIRED INTO ANOTHER VACUOUS ASSERTION, AND STAYED GREEN
//      ACROSS BOTH. The repair was made with no test that could tell repaired from broken —
//      which is exactly the gap the pre-send baseline now closes.
//   3. "indicator SURVIVED init" degenerated for the same reason: with assistant text on
//      screen from sample 0, firstAssistant was 0, `lastStop >= firstAssistant` reduced to
//      `lastStop >= 0`, and that is identical to the sawStop assertion above it. Two lines,
//      one predicate, and a clobbered turn would have passed.
//
// The common cause is not carelessness — each fix was locally reasonable. It is that a
// check here is easy to write green and hard to prove RED, because proving red costs a live
// API turn on the operator's account. So: before you change an assertion in this file, say
// what state would make it fail, and confirm that state is REACHABLE by this harness. If the
// answer needs a live turn, the logic belongs in a pure module with offline fixtures instead
// — turn-indicator.mjs exists for exactly that reason, and its tests 8 and 9 pin the input
// shape this file actually produces rather than the tidy one it is tempting to assume.
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'
import { answerTrustGate, waitForComposer } from './trust-gate.mjs'
import { indicatorSurvivedInit, preSendSettled } from './turn-indicator.mjs'

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
// PROMPT LENGTH IS NO LONGER LOAD-BEARING — and the history is kept because it is the reason
// the verdict was rewritten. It used to matter: the check was "Stop still up at some sample
// >2500ms", so a fast turn failed it. A bare `echo hello` finished in ~2.7s, samples read
// stop=true at 2.4s and stop=false at 3.0s, the threshold fell in the gap, and the check went
// red with the indicator up the whole turn — the harness racing the model, not a regression.
// The response then was to lengthen the prompt so the turn outlived the threshold, which
// bought margin against the model's speed instead of removing the dependency on it.
// The verdict is now turn-relative (see turn-indicator.mjs), so a fast turn is fine. A
// multi-step prompt is still WORTH keeping — more samples, and it exercises a tool call — but
// nothing now breaks if the model answers quickly. Do not re-tune this prompt to fix a red.
await evaluate(`(()=>{const ta=document.querySelector('textarea');const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(ta,'Run the bash command echo hello, then the bash command uname -a, then write two short paragraphs explaining what each printed and why they differ.');ta.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
await wait(150)

// ★ BASELINE THE ASSISTANT-OUTPUT COUNT BEFORE SENDING. THIS IS LOAD-BEARING; DO NOT DROP IT
// BACK TO A BOOLEAN. Measured 2026-09-02 by a pre-prompt probe that sent nothing: at this
// exact point — session freshly "created", no prompt yet — the transcript ALREADY contains
//   kinds = user,text,tool_use,tool_use,tool_result,tool_result,text,
//           user,tool_use,tool_use,tool_result,tool_result,text
// i.e. two complete prior turns, with three non-empty [data-kind="text"] items reading
// "I'll run both commands." and two paragraphs about what `echo hello` printed. Those are
// THIS HARNESS'S OWN ANSWERS FROM PREVIOUS RUNS: the session is created in a fixed CWD
// (/tmp), the CLI keeps history per directory, and Claudette replays it (`fromReplay` in
// chat.tsx emits kind:'text' items). The server's data dir was a throwaway and it made no
// difference — the history is the CLI's, not Claudette's.
//
// So `some(el => el.innerText.trim())` — "is there assistant text on screen?" — is TRUE
// before the turn starts, on every run after the first. That is what made the live run
// report firstAssistant=0 with Stop up the whole turn, and on that shape the verdict
// degenerates: lastStop >= 0 is true whenever Stop was seen at all, so a CLOBBERED turn
// (Stop dying at sample 1) returns ok:true and the regression goes unreported. Verified
// directly against turn-indicator.mjs with the live-observed sample shape.
//
// The fix is to count, and to require an INCREASE. Both compared events stay events of the
// turn — which was the whole point of the turn-relative rewrite — but the signal now means
// "output arrived DURING THIS TURN" instead of "output is on screen", and those differ by
// exactly the replayed history above.
// ★★ AND A COUNT ALONE IS STILL A PREDICATE OVER AN UNBOUNDED SURFACE — corrected 2026-09-04.
// Counting what was on screen fixed the channel this comment describes, and left one open a
// layer down: replay is ASYNCHRONOUS, so an item landing after the reference is taken raises
// the total and reads as this turn's output. Same vacuity, same shape, smaller window.
// So the reference is now a BOUNDARY rather than a number — every pre-existing node is MARKED,
// and afterwards only UNMARKED nodes count. A set difference cannot be confused by totals that
// happen to coincide, and it says WHICH nodes are new instead of inferring it from a scalar.
//
// ⚠ BUT MARKING DOES NOT, BY ITSELF, CLOSE THE RACE — and believing it does is how this file
// would acquire its fourth vacuous assertion. A replayed item arriving AFTER the marking is
// unmarked, so it counts, exactly as it would have raised a count. Marking makes the reference
// PRECISE; it does not make it EARLIER. The only thing that closes the race is establishing
// that replay had finished before the reference was taken, which is what the settle probe
// below does — two counts straddling a REAL wait (see preSendSettled in turn-indicator.mjs,
// which refuses on a single probe, because two reads of the same instant are always equal).
const countText = `[...document.querySelectorAll('[data-kind="text"]')].filter(el => (el.innerText||'').trim().length > 0).length`
const settleA = await evaluate(countText)
await wait(600)
const settleB = await evaluate(countText)
const settle = preSendSettled([settleA, settleB])
console.log(`  pre-send settle probe: ${settleA} → ${settleB} across 600ms — ${settle.reason}`)
if (!settle.settled) {
  // Loud, and NOT a failure of the app: the harness could not establish a trustworthy
  // reference, so nothing downstream of it is a verdict. Same convention as the credential
  // check below — a prerequisite problem must never be reported as a defect in the subject.
  console.error('\n[skip] the transcript was still growing when the reference was taken, so')
  console.error('   "output produced by THIS turn" cannot be distinguished from late replay.')
  console.error(`   counts ${settleA} then ${settleB}; re-run rather than trusting this.`)
  cdpDone = true
  reapChrome()
  process.exit(77)
}

// Mark every pre-existing item. `data-pre-send` is a HARNESS-ONLY attribute set imperatively,
// never by React — the same contract as data-kind, in the other direction.
// Caveat worth knowing rather than discovering: if React ever RECREATES these nodes (a key
// change, a remount) the marks go with them and pre-existing items would read as new. That
// would be a false POSITIVE for output, so the total is logged beside the unmarked count on
// every sample line — a divergence between them is visible in the artefact rather than silent.
const BASELINE = await evaluate(`(() => {
  const els = [...document.querySelectorAll('[data-kind="text"]')].filter(el => (el.innerText||'').trim().length > 0)
  for (const el of els) el.setAttribute('data-pre-send', '1')
  return els.length
})()`)
console.log(`  marked ${BASELINE} pre-existing assistant text item(s) as data-pre-send` +
            (BASELINE > 0 ? ' — replayed history from earlier runs; the pre-prompt probe explains it' : ''))

await evaluate(`(()=>{const ta=document.querySelector('textarea');ta.focus();ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`)

// Sample the indicator across the turn.
// ONE round trip per sample, not three. This loop used to call hasStop(), footerState() and a
// done-check separately, so a "200ms" period was really 600ms+ of CDP latency — and the
// assertion below depends on catching a sample inside a window, so the sampling gap is part of
// the measurement, not overhead around it. Reading all four facts in a single evaluate makes
// the period roughly what it says.
const SAMPLE = `(() => {
  const stop = [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Stop')
  const st = [...document.querySelectorAll('span')].find(s => ['idle','running','waiting','exited'].includes(s.textContent.trim().toLowerCase()))
  // SET DIFFERENCE, not a count comparison: only nodes that were NOT marked before the send
  // are this turn's output. See the marking block above for why a count was not enough.
  // (No backticks in this comment on purpose: it lives inside a template literal, and a
  // backtick here silently terminates the string. Documented trap; I hit it once already.)
  const all = [...document.querySelectorAll('[data-kind="text"]')].filter(el => (el.innerText || '').trim().length > 0)
  const fresh = all.filter(el => !el.hasAttribute('data-pre-send')).length
  return { stop, state: st ? st.textContent.trim().toLowerCase() : null, assistant: fresh > 0, fresh, textCount: all.length }
})()`
const samples = []
let sawStop = false
const start = Date.now()
while (Date.now() - start < 45000) {
  const m = await evaluate(SAMPLE)
  const t = (Date.now() - start) / 1000
  // Both numbers on every line on purpose: `fresh` is what the verdict uses, `total` is the
  // cross-check. total - fresh should stay equal to the marked baseline for the whole run; if
  // it drifts, React recreated marked nodes and the verdict is reading a false positive. That
  // is visible here rather than silent.
  samples.push({ stop: m.stop, assistant: m.assistant, line: `${t.toFixed(1)}s stop=${m.stop} state=${m.state} assistant=${m.assistant} (fresh ${m.fresh}, total ${m.textCount}, marked ${BASELINE})` })
  if (m.stop) sawStop = true
  // Turn done once the ASSISTANT has produced text and Stop is gone. The old form asked
  // whether the page contained the word "hello" — which the harness's own prompt contains, so
  // that half was true from the moment the user's bubble rendered and contributed nothing.
  if (m.assistant && !m.stop && Date.now() - start > 6000) break
  await wait(200)
}

console.log('samples:\n  ' + samples.map((s) => s.line).join('\n  '))

// ── THE INIT-CLOBBER VERDICT ─────────────────────────────────────────────────────────────
// Decided by scratchpad/turn-indicator.mjs, which is pure and unit-tested (turn-indicator-
// test.mjs, 7 assertions, no browser). This used to be `stop === true at some sample >2500ms`
// — sound, but not specific: 2500 is a wall-clock PROXY for "init has fired", and it fails
// identically when the turn simply finishes early. That is the 2026-08-24 false red recorded
// in this file's history, and lengthening the prompt only bought margin against the model's
// speed rather than removing the dependency on it.
// The replacement compares two events OF THE TURN — the last sample showing Stop against the
// first showing assistant output — so the model's speed drops out.
const verdict = indicatorSurvivedInit(samples)
console.log(`  → lastStop=${verdict.lastStop} firstAssistant=${verdict.firstAssistant} reason=${verdict.reason}`)

// TWO ASSERTIONS, AND WHAT SEPARATES THEM — stated because for a while they were one fact.
// While `assistant` was true from sample 0, `lastStop >= firstAssistant` reduced to
// `lastStop >= 0`, which is exactly `sawStop`: the survived-init check could not fail unless
// this one did, so the suite carried two lines and one predicate. With the baseline in place
// they are genuinely different questions — this one asks whether the indicator appeared AT
// ALL (a dead composer, a send that never dispatched), and the one below asks whether it was
// STILL UP once this turn's own output began. Keep the distinction or delete one of them.
check('Stop/interrupt was visible during the turn', sawStop)
// INCONCLUSIVE IS NOT FAILING. If the sampler never saw Stop, or the turn never produced
// assistant output (an auth failure, a dead engine), the comparison has nothing to compare
// and a red here would name a defect that was never observed. Skip loudly instead — the
// convention this file's credential check already uses.
if (verdict.reason === 'no-stop-sample' || verdict.reason === 'no-assistant-sample') {
  console.log(`⏭️  INCONCLUSIVE: ${verdict.reason} — the indicator verdict did not run.`)
  console.log('   This is not a pass and not a failure: the run did not produce the evidence.')
} else {
  check('indicator SURVIVED init (Stop still up when output began)', verdict.ok,
    { pass: `Stop last seen at sample ${verdict.lastStop}, output first at ${verdict.firstAssistant}`,
      fail: `Stop last seen at sample ${verdict.lastStop} but output did not start until ${verdict.firstAssistant} — the indicator died before the turn produced anything` })
}
// ★ THIS ASSERTION WAS VACUOUS AND ALWAYS GREEN. It searched document.body for 'hello' —
// and the PROMPT this harness types is "Run the bash command echo hello, then …", so the
// word was on screen from the instant the user's own bubble rendered. It could not fail:
// not when the assistant said nothing, not when the turn died on an auth-failure frame,
// not with the whole transcript feature removed. A check that passes for a reason
// unrelated to its name reports nothing.
// It now asks the DOM for an ASSISTANT item specifically, via the `data-kind` marker on
// the transcript row (harness-only, same contract as App.tsx's `data-phone`).
//
// ⚠ AND THAT FIX WAS NOT ENOUGH — corrected 2026-09-02. Swapping the 'hello' text search for
// `[data-kind="text"]` made the selector honest and left the assertion vacuous, because it
// still asked `.some(...)`: "is there assistant text on screen?", which the replayed history
// answers YES to before the prompt is even sent (see the BASELINE block above — measured at
// three non-empty items, this harness's own answers from previous runs). A vacuous check was
// replaced with a differently vacuous one, and it stayed green through both.
// It now requires MORE assistant text than there was before this turn started. Same baseline
// as the sampler, deliberately: two questions about the same turn should not be able to
// disagree about what counts as output.
const answeredCount = await evaluate(`[...document.querySelectorAll('[data-kind="text"]')].filter(el => (el.innerText||'').trim().length > 0 && !el.hasAttribute('data-pre-send')).length`)
check('turn actually completed (the ASSISTANT produced text THIS turn)', answeredCount > 0,
  { pass: `${answeredCount} UNMARKED assistant text item(s) — produced by this turn, not replayed`,
    fail: `0 unmarked assistant text item(s) — every item on screen predates the send, so this turn added nothing` })
const endState = await footerState()
check('after the turn, footer returns to idle', endState === 'idle', `state=${endState}`)
const stopGone = await hasStop()
check('after the turn, Stop is gone', stopGone === false)

// ── A CREDENTIAL IS A PREREQUISITE, NOT A PRODUCT BEHAVIOUR ──────────────────────────
// If the CLI is not logged in the turn dies instantly on an auth-failure frame: the whole
// "turn" completes in ~200ms and never produces assistant output, so the indicator verdict
// has nothing to compare and reports `no-assistant-sample` — inconclusive, and already
// handled above as a skip rather than a red. This block is the louder, whole-run version:
// none of the other assertions are a verdict on anything either when the engine never ran.
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
  console.error('   The turn dies on the auth-failure frame in ~200ms and never produces assistant output,')
  console.error('   so nothing here is a verdict on the indicator. Fix the credential, then re-run —')
  console.error('   re-running until it goes green proves nothing.')
  console.error(`   (assertions this run, for information only: ${passed}/${results.length})`)
  process.exit(77)
}
process.exit(passed === results.length ? 0 : 1)
