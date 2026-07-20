// Browser-verify the two 07-18 chat fixes against REAL Claude turns:
//  1. No assistant-prose doubling (MSG_START/open-map fix in store/chat.tsx).
//     The turn asks for a unique marker word; a doubled transcript renders it twice.
//  2. The Agents tray renders a card for a subagent (CLI 2.1.207 names the tool
//     `Agent`, not `Task`; isSubagentTool now matches both).
// Needs the throwaway server on :4321 (isolated CLAUDETTE_DATA_DIR) + web/dist built.
// Since token-on-loopback (07-18) boot it with auth off, e.g.:
//   cd server && env -u CLAUDETTE_TOKEN CLAUDETTE_NO_AUTH=1 CLAUDETTE_DATA_DIR=$(mktemp -d) \
//     PORT=4321 HOST=127.0.0.1 npx tsx src/index.ts
// In a sandboxed session pass CHROME_BIN (host Chrome lives in /opt → invisible):
//   CHROME_BIN=$PWD/.chrome-headless/chrome/linux-*/chrome-linux64/chrome node scratchpad/doubling-agents-test.mjs
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const CWD = '/tmp'
const DEBUG_PORT = 9361
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-dblag-'))
const chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1300,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
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
const sendPrompt = async (text) => {
  await evaluate(`(()=>{const ta=document.querySelector('textarea');const s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(ta,${JSON.stringify(text)});ta.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await wait(150)
  await evaluate(`(()=>{const ta=document.querySelector('textarea');ta.focus();ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`)
}
// Turn is over when Stop is gone and the footer says idle.
async function waitTurnEnd(ms) {
  const t0 = Date.now()
  await wait(2000)   // let the optimistic running latch first
  while (Date.now() - t0 < ms) {
    const stop = await hasStop()
    if (!stop && Date.now() - t0 > 5000) return true
    await wait(700)
  }
  return false
}
const countInBody = (word) => evaluate(
  `(document.body.innerText.toLowerCase().match(/${word}/g)||[]).length`)

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
await wait(4000)  // engine spawn + init

// ---- Turn 1: doubling. The marker word never appears in the prompt (built by
// joining halves), so any occurrence in the DOM is assistant output. Doubled
// transcript => the marker (and the whole reply) renders twice.
await sendPrompt(
  'Run the bash command `echo hello`. Then reply with two short paragraphs about what it printed. ' +
  "In the second paragraph include, once, the single lowercase word formed by joining 'quix' and 'otic'.")
const t1done = await waitTurnEnd(90000)
check('turn 1 completed (Stop cleared, back to idle)', t1done)
await wait(1000)
const marker = await countInBody('quixotic')
check('marker word appears EXACTLY once (no doubled prose)', marker === 1, `count=${marker}`)
// Belt-and-braces: no identical long text line rendered twice anywhere.
const dupLine = await evaluate(`(()=>{
  const lines = document.body.innerText.split('\\n').map(s=>s.trim()).filter(s=>s.length>40)
  const seen = new Set()
  for (const l of lines) { if (seen.has(l)) return l; seen.add(l) }
  return null })()`)
check('no long line repeats in the transcript', dupLine === null, dupLine ? `dup: ${String(dupLine).slice(0, 80)}` : '')
const answered = await countInBody('hello')
check('assistant actually answered (echo output referenced)', answered >= 1, `hits=${answered}`)

// ---- Turn 2: Agents tray. Force a subagent; the tray (◈ Agents header + a card
// with the type chip) must appear — before the fix it was gated out entirely.
await sendPrompt(
  'Use your Agent tool (the subagent launcher, sometimes called Task) to spawn ONE subagent — ' +
  'an Explore agent is fine — whose job is to list the files in /tmp and report back one line. ' +
  'You MUST delegate via the Agent tool; do not list the files yourself.')
// The tray should appear DURING the turn (tool_use lands before the result).
let trayDuring = false
{
  const t0 = Date.now()
  while (Date.now() - t0 < 150000) {
    const tray = await evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Agents'))`)
    if (tray) { trayDuring = true; break }
    const stop = await hasStop()
    if (!stop && Date.now() - t0 > 8000) break   // turn ended without a tray
    await wait(700)
  }
}
check('Agents tray appeared', trayDuring)
const card = await evaluate(`[...document.querySelectorAll('span')].some(s=>(s.className||'').includes('bg-ctp-mauve/15'))`)
check('an AgentCard rendered (type chip present)', card)
await waitTurnEnd(150000)
await wait(1000)
const cardDone = await evaluate(`(()=>{
  const spans=[...document.querySelectorAll('span')]
  return spans.some(s=>s.textContent.trim()==='done'||s.textContent.trim()==='running'||s.textContent.trim()==='failed') })()`)
check('agent card shows a status label', cardDone)

chrome.kill('SIGKILL')
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
