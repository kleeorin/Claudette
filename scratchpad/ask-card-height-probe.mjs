// Slice-1 defect: AskUserQuestionCard has NO height bound. It is now `shrink-0` inside a
// bounded flex column whose wrapper deliberately carries no overflow, so a tall card can
// neither shrink nor scroll — the transcript collapses first and then Submit/Dismiss go
// below the viewport with no way to reach them. AskUserQuestion is in ALWAYS_PROMPT, so it
// is the one card guaranteed to reach a human, and phones are this slice's target.
// Measures the real thing at 390×844 rather than arguing from CSS.
import { spawn } from 'child_process'
import { mkdtemp, writeFile, rm, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4495, WEB_PORT = 5295, CDP = 9365
const APP = `http://127.0.0.1:${WEB_PORT}`, API = `http://127.0.0.1:${PORT}`
const TOKEN = 'ask-card-token'
const GO = '/tmp/claudette-askcard-go'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await rm(GO, { force: true })

const DATA = await mkdtemp(join(tmpdir(), 'ask-data-'))
const PROJ = await mkdtemp(join(tmpdir(), 'ask-proj-'))
const BIN = await mkdtemp(join(tmpdir(), 'ask-bin-'))

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
const req = { type: 'control_request', request_id: 'req-ask-1', request: {
  subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion',
  input: ${JSON.stringify(JSON.stringify({ questions }))}, tool_use_id: 'tu-ask-1', permission_suggestions: [] } }
req.request.input = JSON.parse(req.request.input)
const tick = setInterval(() => { if (!existsSync(${JSON.stringify(GO)})) return
  clearInterval(tick); process.stdout.write(JSON.stringify(req) + '\\n') }, 200)
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
const chromeDir = await mkdtemp(join(tmpdir(), 'ask-chrome-'))
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
await fetch(`${API}/api/session/create`, { method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` },
  body: JSON.stringify({ name: 'Ask', cwd: PROJ, rootDir: PROJ, sandbox: { enabled: false, mounts: [] } }) }).then(r => r.json())
await send('Page.navigate', { url: `${APP}/?token=${TOKEN}` })
for (let i = 0; i < 60; i++) { if (await ev(`document.body.innerText.includes('Ask')`)) break; await wait(250) }
await wait(1500)
await writeFile(GO, 'go')
let card = false
for (let i = 0; i < 60; i++) { card = await ev(`!!document.querySelector('[class*="border-ctp-blue"]')`); if (card) break; await wait(400) }
console.log('AskUserQuestion card rendered:', card)

// KEYBOARD-AWARE MEASUREMENT. `max-h-[60vh]` is sized off the LAYOUT viewport, and on iOS
// the software keyboard does not shrink that — it only changes window.visualViewport. So a
// check against innerHeight reports success while Submit sits under the keyboard. Worse, the
// free-text "Other" input is INSIDE the card, so the interaction that needs Submit is exactly
// the one that hides it, and there is nothing for iOS to scroll into view (the shell is
// h-full with no page scroll — the same property that made the card move necessary).
//
// HONEST LIMIT: headless Chrome has no soft keyboard, so visualViewport.height === innerHeight
// here and cannot be emulated. What follows is REAL measured geometry checked against a
// STATED allowance (iOS keyboard ≈ 40% of a 390×844 screen ≈ 336px, leaving ≈508px visible).
// The geometry is observed; the allowance is an assumption, and it is labelled as one.
const KEYBOARD_PX = 336
const m = await ev(`(() => {
  const card = document.querySelector('[class*="border-ctp-blue"]');
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Submit');
  if (!card || !btn) return { err: 'missing', card: !!card, btn: !!btn };
  const cr = card.getBoundingClientRect(), br = btn.getBoundingClientRect();
  return { viewportH: innerHeight, cardTop: Math.round(cr.top), cardH: Math.round(cr.height),
           submitBottom: Math.round(br.bottom),
           submitReachable: br.bottom <= innerHeight && br.top >= 0,
           cardScrolls: card.scrollHeight > card.clientHeight,
           visualH: (window.visualViewport && window.visualViewport.height) || innerHeight,
           innerScrollers: [...card.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 2).length }
})()`)
const visibleWithKeyboard = m.viewportH - KEYBOARD_PX
const reachableWithKeyboard = m.submitBottom <= visibleWithKeyboard
console.log(`\n  naive check (innerHeight ${m.viewportH}): submit ${m.submitBottom} → ${m.submitReachable ? 'PASSES' : 'fails'}`)
console.log(`  keyboard-aware (visible ${visibleWithKeyboard} = ${m.viewportH} - ${KEYBOARD_PX}): submit ${m.submitBottom} → ${reachableWithKeyboard ? 'reachable' : 'HIDDEN by ' + (m.submitBottom - visibleWithKeyboard) + 'px'}`)
console.log(JSON.stringify(m, null, 1))
console.log(m.submitReachable ? '\n✅ Submit is reachable at 390×844' : `\n❌ Submit is OFF-SCREEN — bottom=${m.submitBottom} viewport=${m.viewportH} (overflow ${m.submitBottom - m.viewportH}px)`)
// VERIFY THE MECHANISM, since the keyboard trigger itself cannot be emulated here.
// Publishing --vvh is what makes the card keyboard-aware; drive it directly and confirm the
// card actually resizes and Submit comes back into the visible area.
const vvhSet = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--vvh').trim()`)
// ASSERTED, not merely printed — and this is the one check in the file that cannot be
// replaced by any of the others. The next line OVERRIDES --vvh by hand to stand in for a
// keyboard headless Chrome does not have. So if lib/visualViewport.ts ever stopped publishing
// the property, every remaining assertion here would still pass, on the probe's OWN override,
// while the real app sized itself off a fallback. The probe would be measuring itself.
// Printed-but-not-asserted, this was invisible: a drift in the PUBLISHER would have surfaced
// as nothing at all here, and later as an unexplained card in someone's hand.
const vvhPublished = /^\d+px$/.test(vvhSet || '')
console.log(`  --vvh published by lib/visualViewport.ts: ${vvhSet || '(absent)'} → ${vvhPublished ? '✅ published' : '❌ NOT PUBLISHED — every check below is measuring this probe\'s own override'}`)
await ev(`document.documentElement.style.setProperty('--vvh', '${visibleWithKeyboard}px')`)
await wait(400)
const after = await ev(`(() => {
  const card = document.querySelector('[class*="border-ctp-blue"]');
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Submit');
  const br = btn.getBoundingClientRect();
  return { cardH: Math.round(card.getBoundingClientRect().height), submitBottom: Math.round(br.bottom) } })()`)
const okKb = after.submitBottom <= visibleWithKeyboard
console.log(`  with --vvh = ${visibleWithKeyboard}px (keyboard up): cardH ${after.cardH}, submit ${after.submitBottom} → ${okKb ? '✅ reachable' : '❌ still hidden'}`)

// [hole] THE SLACK MEASUREMENT — REPORTS, DOES NOT ASSERT. IT CANNOT DISCRIMINATE HERE.
// Measured both ways on 2026-08-24: with html/body at `height:100%` (unfixed) and at
// `var(--vvh)` + `overflow:hidden` (fixed), this prints the IDENTICAL line — scrollHeight 844,
// drifted 0. So it is NOT a proof of the fix and must not be counted as one.
// WHY, and it is worth knowing before someone "repairs" it: `scrollingElement.scrollHeight` is
// floored at the initial containing block (the 844px layout viewport), so it reads 844 whatever
// html's height is; and `drifted` stays 0 because `body{height:100%}` EQUALS the layout
// viewport rather than exceeding it, so no document overflow is created in either state.
// WHAT THIS LEAVES OPEN: the concern is that on a REAL iOS device the browser can pan the
// visual viewport within the layout viewport and push Submit back off-screen. That is visual-
// viewport panning, not document scroll, and headless Chrome has no software keyboard and no
// visual-viewport pan — so it is not observable in this repo's harnesses at all. Same class of
// limit as KEYBOARD_PX above. Needs a device, or CDP visual-viewport emulation if that ever
// gains a keyboard. Do not convert this back into an assertion without first demonstrating it
// fails on the unfixed CSS; it does not today.
// (Original reasoning, retained because the CSS fix rests on it rather than on this probe:)
// Shrinking #root to --vvh while html/body stay at the LAYOUT viewport
// turns the difference into DOCUMENT SCROLL that did not exist before. That is worse than the
// bug this file exists to pin: iOS's scroll-the-focused-input-into-view then has somewhere to
// scroll and can push Submit back off-screen, in a form no max-h can reach. This probe's own
// premise -- "the shell is h-full with no page scroll" -- is only true while html/body clip.
// Measured with --vvh already overridden above; measuring BEFORE the override is a false pass.
// Use scrollingElement, NOT document.body.scrollHeight: body's own box reads the same either
// way, so body would give the right number for the wrong reason.
const slack = await ev(`(() => {
  const doc = document.scrollingElement;
  window.scrollTo(0, 9999);
  const drifted = window.pageYOffset;
  window.scrollTo(0, 0);
  return { scrollH: doc.scrollHeight, clientH: doc.clientHeight, drifted } })()`)
const slackPx = slack.scrollH - visibleWithKeyboard
const okSlack = slackPx <= 0 && slack.drifted === 0   // reported only; NOT in the exit code
console.log(`  [hole] document slack at --vvh=${visibleWithKeyboard}: scrollHeight ${slack.scrollH}, scrolled to ${slack.drifted} — NOT DISCRIMINATING (identical fixed/unfixed; see note above)`)
// THE HOLE IS NOW COVERED, by a different harness and a different mechanism. It is not that
// this check needed a better assertion — document scroll genuinely IS identical fixed and
// unfixed, because the pan is not a scroll. scratchpad/visual-viewport-pan-probe.mjs measures
// the visual viewport directly (Emulation.setPageScaleFactor + a wheel event pans it, offsetTop
// 0 -> 336 with scrollY 0) and settles the question this note left open: `position: fixed;
// inset: 0` does NOT stop the pan. Keep this line — a red here would still mean something —
// but do not read it as "the pan is untestable" any more.

cdpDone = true   // deliberate teardown from here — the CDP close below is expected
cdp.close(); reapAll()
// Chrome may still be flushing its profile when reapAll() returns, so this rm can lose a
// race and throw ENOTEMPTY *after* every assertion has already been decided. At top level
// that rejection overrides process.exitCode and reports the probe RED while its own output
// says the card is bounded and Submit is reachable — a green test wearing a red hat, and
// the most expensive kind of false alarm because it looks like the fix regressed.
// Cleanup must never outrank the result.
await rm(GO, { force: true }).catch(() => {})
await rm(chromeDir, { recursive: true, force: true }).catch(() => {})
process.exitCode = (m.submitReachable && okKb && vvhPublished) ? 0 : 2   // okSlack deliberately excluded: it cannot fail
