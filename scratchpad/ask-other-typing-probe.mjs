// THE AskUserQuestion "Other…" FIELD — do typed characters land in order on a phone?
//
//   CHROME_BIN=… node scratchpad/ask-other-typing-probe.mjs
//
// Regression guard for the 2026-10-19 report (Android Chrome typed this field backwards).
// See the block above the typing loop for what it does and does not prove.
//
// Group B: its own server (4506) + vite (5306) + Chrome (9379), over the WORKING TREE.
import { spawn } from 'child_process'
import { mkdtemp, writeFile, rm, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

// Distinct from shell-fixed-cost-probe's 4500/5300/9373 — copying its boot half brought
// those constants along, and two harnesses sharing a port is a collision that only
// shows up in a full run, as a timeout that looks like a UI failure.
const PORT = 4506, WEB_PORT = 5306, CDP = 9379
const APP = `http://127.0.0.1:${WEB_PORT}`, API = `http://127.0.0.1:${PORT}`
const TOKEN = 'shell-fixed-token'
const GO = '/tmp/claudette-asktype-go'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await rm(GO, { force: true })

const DATA = await mkdtemp(join(tmpdir(), 'sfx-data-'))
const PROJ = await mkdtemp(join(tmpdir(), 'sfx-proj-'))
const BIN = await mkdtemp(join(tmpdir(), 'sfx-bin-'))

// WORST CASE THE TOOL ACTUALLY ALLOWS: 4 questions × 4 options, each with a label AND a
// description, plus the free-text "Other" input the card adds per question.
const questions = Array.from({ length: 4 }, (_, q) => ({
  question: `Question ${q + 1}: which approach should we take for the subsystem under review?`,
  header: `Q${q + 1}`,
  multiSelect: false,
  options: Array.from({ length: 4 }, (_, o) => ({
    label: `Option ${o + 1} for question ${q + 1}`,
    description: `A reasonably detailed explanation of what option ${o + 1} means in practice, the trade-offs it implies, and what it would cost to undo later.`,
  })),
}))
const LONG = Array.from({ length: 120 }, (_, i) => `line ${i + 1} of filler so the transcript overflows`).join('\\n')
await writeFile(join(BIN, 'claude'), `#!/usr/bin/env node
import { existsSync } from 'fs'
process.stdout.write(JSON.stringify({ type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: ${JSON.stringify(LONG)} }] } }) + '\\n')

const permReq = { type: 'control_request', request_id: 'req-perm-1', request: {
  subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash',
  input: { command: 'placeholder', description: 'A deliberately long description of what this command does, why it is needed, and what it will touch on disk, long enough that the detail block wants far more than the band can give it.' }, tool_use_id: 'tu-perm-1',
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], destination: 'session' }] } }
permReq.request.input.command = Array.from({ length: 60 }, function (_, i) { return 'echo "line ' + (i + 1) + ' of a very long command that must not be clipped"' }).join('\\n')
const askReq = { type: 'control_request', request_id: 'req-ask-1', request: {
  subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion',
  input: ${JSON.stringify(JSON.stringify({ questions }))}, tool_use_id: 'tu-ask-1', permission_suggestions: [] } }
askReq.request.input = JSON.parse(askReq.request.input)
const tick = setInterval(() => { if (!existsSync(${JSON.stringify(GO)})) return
  clearInterval(tick)
  // BOTH queued: the store holds a QUEUE of unanswered prompts, so answering the first
  // reveals the second. One rig measures both card types.
  process.stdout.write(JSON.stringify(permReq) + '\\n')
  setTimeout(() => process.stdout.write(JSON.stringify(askReq) + '\\n'), 300) }, 200)
// Exit when the server that spawned us goes away. Parking on a timer alone left one of
// these reparented to init after every run — a harmless-looking orphan that still shows up
// in anyone's ps while they are diagnosing a real one, which is exactly when a clean ps
// matters most.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.resume(); setTimeout(() => process.exit(0), 300000)
`)
await chmod(join(BIN, 'claude'), 0o755)

const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, PORT: String(PORT),
         CLAUDETTE_TOKEN: TOKEN, CLAUDETTE_DATA_DIR: DATA, CLAUDETTE_ALLOW_UNSANDBOXED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d)
const web = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
  cwd: 'web', env: { ...process.env, PORT: String(PORT), WEB_PORT: String(WEB_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let weblog = ''; web.stdout.on('data', d => weblog += d); web.stderr.on('data', d => weblog += d)
const chromeDir = await mkdtemp(join(tmpdir(), 'sfx-chrome-'))
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome',
  ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${chromeDir}`,
   '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', 'about:blank'], { stdio: 'ignore', detached: true })
const reapAll = () => { for (const c of [server, web]) { try { process.kill(-c.pid, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch {} } }
                        try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} } }
process.on('exit', reapAll)
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapAll(); if (e) console.error(e); process.exit(1) })
}
for (let i = 0; i < 90 && !log.includes('Server listening'); i++) await wait(500)
for (let i = 0; i < 90 && !weblog.includes('ready in'); i++) await wait(500)

let wsUrl = null
for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()
  const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break } } catch {} await wait(250) }
const cdp = new WebSocket(wsUrl); await new Promise(r => cdp.on('open', r))
let id = 0; const pending = new Map()
// A CDP reply is awaited on a promise that ONLY the socket can resolve, so if Chrome dies
// mid-run — crash, OOM, an external pkill — every pending send() hangs forever and the
// harness sleeps in ep_poll holding its ports until someone hunts it down. Abort loudly
// instead. No reap() here on purpose: process.exit() runs the process.on('exit') handlers,
// which already cover every child. `cdpDone` keeps this off the DELIBERATE teardown below,
// where the very same close event is expected and must not be read as a failure.
let cdpDone = false
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died; aborting rather than hanging'); process.exit(1) })
cdp.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => { const i = ++id; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise(r => pending.set(i, r)) }
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
import { check, results } from './assert.mjs'
// A session must exist before the engine runs and the card can appear. This call sits just
// after the viewport line in shell-fixed-cost-probe, so copying that file's boot half stopped
// one line short of it — the symptom was a mounted shell with no composer and no card, which
// reads as a layout failure rather than a missing fixture.
await fetch(`${API}/api/session/create`, { method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` },
  body: JSON.stringify({ name: 'Squeeze', cwd: PROJ, rootDir: PROJ, sandbox: { enabled: false, mounts: [] } }) }).then(r => r.json())

// `?token=` — the documented way this rig authenticates; a localStorage write before the
// app has loaded is written into the wrong origin's store and the app never mounts.
await send('Page.navigate', { url: `${APP}/?token=${TOKEN}` })
for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector('[data-testid="composer"]')`)) break; await wait(500) }
await writeFile(GO, 'go')
// Wait for a card to actually mount, rather than sleeping a fixed amount and measuring
// whatever happened to be on screen.
for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector('[class*="border-ctp-yellow"], [class*="border-ctp-blue"]')`)) break; await wait(500) }
await wait(800)


// ── TYPING INTO THE AskUserQuestion "Other…" FIELD ON A PHONE ─────────────────────────────
// Reported 2026-10-19 on Android Chrome: this field typed BACKWARDS (each character landed at
// the start), the composer on the same phone did not. NOT reproduced here — headless Chrome
// types correctly through key events, IME composition and insertText, with or without viewport
// resizes between keystrokes. So this is a REGRESSION GUARD for the fix (the field is now an
// uncontrolled textarea React never writes back to), not a reproduction of the trigger: it
// pins that every input route still lands the characters in order, and that the typed text
// reaches the card's answer state (Submit enables once every question has an answer).
const SEL = 'textarea[placeholder="Other…"]'
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('Deny'));if(b)b.click();return !!b})()`)
for (let i = 0; i < 30; i++) { if (await ev(`!!document.querySelector('${SEL}')`)) break; await wait(300) }
check('the Other… field is a textarea', await ev(`!!document.querySelector('${SEL}')`))
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
const TEXT = 'abc def'
const fields = await ev(`document.querySelectorAll('${SEL}').length`)
const MODES = ['keys', 'insert', 'ime']
for (let m = 0; m < MODES.length && m < fields; m++) {
  const MODE = MODES[m]
  await ev(`(()=>{const i=document.querySelectorAll('${SEL}')[${m}];i.focus();return document.activeElement===i})()`)
  for (const ch of TEXT) {
    if (MODE === 'keys') {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    } else if (MODE === 'insert') {
      await send('Input.insertText', { text: ch })
    } else {
      await send('Input.imeSetComposition', { text: ch, selectionStart: 1, selectionEnd: 1 })
      await send('Input.insertText', { text: ch })
    }
    // A real keyboard resizes the viewport as its suggestion strip changes.
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: (TEXT.indexOf(ch) % 2) ? 500 : 496, deviceScaleFactor: 1, mobile: true })
    await wait(100)
  }
  await wait(250)
  const got = await ev(`(()=>{const i=document.querySelectorAll('${SEL}')[${m}];return {v:i.value, caret:i.selectionStart}})()`)
  check(`${MODE}: characters land in order`, got && got.v === TEXT && got.caret === TEXT.length, JSON.stringify(got))
}
// Answer any remaining questions by option so Submit's enablement depends on the typed ones too.
await ev(`(()=>{const f=[...document.querySelectorAll('${SEL}')];f.slice(${MODES.length}).forEach(t=>{const b=t.parentElement.querySelector('button');b&&b.click()});return true})()`)
await wait(300)
check('the typed answers reach the card state (Submit enabled)', await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Submit');return !!b&&!b.disabled})()`))
cdpDone = true
reapAll()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
