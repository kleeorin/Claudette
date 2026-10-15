// THE PENDING CARD UNDER SQUEEZE — can the card actually YIELD without losing its controls?
//
// ★ THE GAP THIS CLOSES. shell-fixed-cost-probe proved the composer is no longer clipped once
// the pending band became `shrink min-h-0 flex flex-col`. Its argument for why that is safe is
// "the card owns an inner overflow-y-auto, so shrinking it is LOSSLESS". That is demonstrated
// for AskUserQuestionCard, whose body is `overflow-y-auto min-h-0`. It was NOT demonstrated
// for PermissionCard — the COMMON card — whose only scroller is a FIXED `max-h-48` and whose
// root is not in a min-h-0/flex-col chain. A fixed max-height cannot yield: squeeze the band
// and the card does not shrink, it overflows, and the controls that overflow are Allow and
// Deny. "Lossless" was true of the card that was measured and assumed of the one that was not.
//
// ★★ WHAT IS ASSERTED, AND WHY THESE THREE. A composer that is merely un-clipped is not
// enough: the state is only recoverable if the user can also ANSWER the card.
//   1. the composer is not clipped by the shell   (the original guarantee, re-checked here)
//   2. the card's ACTION BUTTONS are fully inside the shell — Allow/Deny, Submit/Dismiss
//   3. the card does not OVERLAP the composer
// (2) is the one the original probe cannot see: it measures the card's bounding box, and a
// card whose box is inside the shell can still have its buttons pushed out of its own
// scrollable area.
//
// Two viewports, because the failure is a function of how little height there is:
// 390x844 with the keyboard up (--vvh 508) is the case the band fix was written for, and
// 375x667 (--vvh ~380) is a shorter phone where the same squeeze is harder.
//
// Boots its own server + vite + Chrome, so it compiles the WORKING TREE rather than web/dist —
// a source-only fix to ChatView.tsx is invisible to a dist-serving harness.
//
//   CHROME_BIN=… node scratchpad/pending-card-squeeze-probe.mjs
//
// Each case also asserts two PRECONDITIONS before any verdict: the shell really is sized to
// --vvh, and the card really had to yield (its own scroller overflows). Without both, ①-③ can
// pass with nothing squeezed — this probe reported 24/25 green that way before the first one
// existed.
//
// Group B: its own vite over the working tree. web/dist is never consulted.
import { spawn } from 'child_process'
import { mkdtemp, writeFile, rm, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

// Distinct from shell-fixed-cost-probe's 4500/5300/9373 — copying its boot half brought
// those constants along, and two harnesses sharing a port is a collision that only
// shows up in a full run, as a timeout that looks like a UI failure.
const PORT = 4502, WEB_PORT = 5302, CDP = 9375
const APP = `http://127.0.0.1:${WEB_PORT}`, API = `http://127.0.0.1:${PORT}`
const TOKEN = 'shell-fixed-token'
const GO = '/tmp/claudette-shellfixed-go'
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
for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector('textarea')`)) break; await wait(500) }
await writeFile(GO, 'go')
// Wait for a card to actually mount, rather than sleeping a fixed amount and measuring
// whatever happened to be on screen.
for (let i = 0; i < 60; i++) { if (await ev(`!!document.querySelector('[class*="border-ctp-yellow"], [class*="border-ctp-blue"]')`)) break; await wait(500) }
await wait(800)

// Geometry of the one thing each assertion is about. Buttons are found by their LABEL, not by
// position, so the measurement survives a layout change and fails loudly on a rename instead
// of silently measuring the wrong element.
const MEASURE = (labels) => `(() => {
  const shell = document.querySelector('[data-phone]');
  const ta = document.querySelector('textarea');
  const card = document.querySelector('[class*="border-ctp-yellow"], [class*="border-ctp-blue"]');
  const r = (e) => e ? { top: Math.round(e.getBoundingClientRect().top), bottom: Math.round(e.getBoundingClientRect().bottom) } : null;
  const btns = ${JSON.stringify(labels)}.map(t => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith(t));
    return { label: t, box: r(b) };
  });
  const sh = r(shell);
  // Did the card actually have to YIELD? Its own scroller holds more than it shows only when
  // the band squeezed it below its content height.
  const scroller = card ? [...card.querySelectorAll('.overflow-y-auto')].find(e => e.scrollHeight > e.clientHeight + 1) : null;
  return { shell: sh, composer: r(ta), card: r(card), btns, cardScrolls: !!scroller,
           composerClipped: !!(sh && r(ta) && r(ta).bottom > sh.bottom + 1),
           cardOverlapsComposer: !!(r(card) && r(ta) && r(card).bottom > r(ta).top + 1) };
})()`

const VIEWPORTS = [
  { name: 'phone 390x844, keyboard up (--vvh 508)', w: 390, h: 844, vvh: 508 },
  { name: 'short phone 375x667 (--vvh 380)', w: 375, h: 667, vvh: 380 },
]

async function measureAt(vp, labels) {
  await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: true })
  // ★ SET --vvh *AFTER* THE RESIZE HAS SETTLED, AND AGAIN BELOW.
  // lib/visualViewport.ts installs a resize handler that writes --vvh from the REAL viewport.
  // Setting ours first means the app's handler overwrites it a moment later, and whether the
  // test value survives is a race — measured as an alternating pattern across the four cases
  // (1 and 4 constrained, 2 and 3 not), which is exactly what a race looks like and exactly
  // what a precondition is for. Writing after the handler has run makes ours the last word.
  await wait(500)
  await ev(`document.documentElement.style.setProperty('--vvh', '${vp.vvh}px')`)
  // ★ SETTING THE VARIABLE IS NOT ENOUGH — the shell must actually be SIZED by it.
  // Measured: with only the variable set, the shell still reported 0..667 at --vvh 380, i.e.
  // the full viewport. Every assertion then passed against a roomy layout and proved nothing
  // about the squeeze this file exists to test. This is the same rule shell-fixed-cost-probe
  // applies as its `vvh` variant, pinned here so the constraint genuinely reaches the bands.
  // ★ A STYLESHEET RULE, INJECTED ONCE — NOT an inline style.
  // An inline style on the shell is React-managed state's to clobber: a viewport change
  // re-renders and drops it, so the pin held for the first measurement and silently lapsed
  // for every one after. Measured in that state: viewport 1 reported shell 508px (correct)
  // while 2..4 reported the full viewport height. A rule in a stylesheet targets the element
  // by selector and survives any number of re-renders, because React never owns it.
  await ev(`(()=>{ if (document.getElementById('vvh-pin')) return true;
    const st = document.createElement('style'); st.id = 'vvh-pin';
    st.textContent = '[data-phone]{position:fixed;inset:0;height:var(--vvh,100%)}';
    document.head.appendChild(st); return true })()`)
  await wait(700)
  // Last word again, immediately before measuring.
  await ev(`document.documentElement.style.setProperty('--vvh', '${vp.vvh}px')`)
  await wait(400)
  return ev(MEASURE(labels))
}

// ★ PRECONDITIONS, ASSERTED NOT ASSUMED. Without these a missing card or a renamed button
// arrives as `null.bottom` inside an assertion and reads as a layout failure.
async function assertCard(kind, labels) {
  for (const vp of VIEWPORTS) {
    const m = await measureAt(vp, labels)
    const where = `${kind} @ ${vp.name}`
    check(`${where}: card and composer are both present`, !!(m.card && m.composer && m.shell),
      JSON.stringify({ card: m.card, composer: m.composer, shell: m.shell }))
    // ★ THE PRECONDITION THAT MAKES THE REST MEAN ANYTHING. If the shell is not actually
    // constrained to --vvh, there is no squeeze and every assertion below passes trivially.
    check(`${where}: (precondition) the shell is actually constrained to --vvh`,
      !!m.shell && Math.abs((m.shell.bottom - m.shell.top) - vp.vvh) <= 2,
      m.shell ? `shell is ${m.shell.bottom - m.shell.top}px, --vvh is ${vp.vvh}px` : 'no shell')
    // ★ AND A SQUEEZE WAS NEEDED. A constrained shell with a card that fits anyway passes ①-③
    // without the fix being exercised at all. The card's own scroller overflowing is the
    // evidence it was made to yield (QC review, 2026-10-06).
    check(`${where}: (precondition) the card had to yield — its scroller overflows`, m.cardScrolls,
      m.cardScrolls ? 'card body is scrolling' : 'card fits without yielding — this case exercises nothing')
    for (const b of m.btns) check(`${where}: the "${b.label}" button was found`, !!b.box,
      b.box ? `${b.box.top}..${b.box.bottom}` : 'NOT IN THE DOM')
    if (!m.card || !m.composer || !m.shell || m.btns.some((b) => !b.box)) continue

    check(`${where}: ① the composer is NOT clipped by the shell`, !m.composerClipped,
      `composer ends ${m.composer.bottom}, shell ends ${m.shell.bottom}`)
    for (const b of m.btns) {
      check(`${where}: ② "${b.label}" is fully inside the shell`,
        b.box.bottom <= m.shell.bottom + 1 && b.box.top >= m.shell.top - 1,
        `button ${b.box.top}..${b.box.bottom}, shell ${m.shell.top}..${m.shell.bottom}`)
    }
    check(`${where}: ③ the card does not overlap the composer`, !m.cardOverlapsComposer,
      `card ends ${m.card.bottom}, composer starts ${m.composer.top}`)
  }
}

try {
  // PermissionCard first — the common card, and the one whose yielding was never shown.
  await assertCard('PermissionCard', ['Allow once', 'Deny'])

  // Answer it so the queued AskUserQuestion takes its place. Deny, because it ends the prompt
  // without changing any stored permission.
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('Deny'));if(b)b.click();return !!b})()`)
  await wait(1200)
  const askUp = await ev(`!!document.querySelector('[class*="border-ctp-blue"], [class*="border-ctp-yellow"]')`)
  check('the queued AskUserQuestion card replaced the answered PermissionCard', askUp === true)
  if (askUp) await assertCard('AskUserQuestionCard', ['Submit'])
} finally {
  cdpDone = true
  reapAll()
}

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
