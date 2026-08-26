// WHAT DOES `position: fixed; inset: 0` ON THE SHELL WRAPPER ACTUALLY COST? — measured in
// the REAL app, at desktop and phone widths, with a pending permission card on screen.
//
//   CHROME_BIN=… node scratchpad/shell-fixed-cost-probe.mjs
//
// Companion to scratchpad/visual-viewport-pan-probe.mjs. That one answers whether the rule
// WORKS (it does not: it cannot stop a visual-viewport pan, because `fixed` resolves against
// the layout viewport, which is the box the visual viewport pans inside). This one answers
// what it would COST if applied anyway — the question worth asking separately, because
// "it does not help" and "it is harmless" are different claims and only one of them was ever
// checked.
//
// The bands under test are the ones slice 1 deliberately arranged: the pending permission
// card sits OUTSIDE the transcript's scroll container, as a `shrink-0` sibling between the
// scroller and the composer. A rule that changes the shell's containing block is exactly the
// kind that could quietly re-parent or re-size that arrangement, and nothing covered it.
//
// Group B: its own vite over the working tree. web/dist is never consulted.
import { spawn } from 'child_process'
import { mkdtemp, writeFile, rm, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4500, WEB_PORT = 5300, CDP = 9373
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
const req = { type: 'control_request', request_id: 'req-sfx-1', request: {
  subtype: 'can_use_tool', tool_name: 'AskUserQuestion', display_name: 'AskUserQuestion',
  input: ${JSON.stringify(JSON.stringify({ questions }))}, tool_use_id: 'tu-sfx-1', permission_suggestions: [] } }
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
await fetch(`${API}/api/session/create`, { method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` },
  body: JSON.stringify({ name: 'Shell', cwd: PROJ, rootDir: PROJ, sandbox: { enabled: false, mounts: [] } }) }).then(r => r.json())
await send('Page.navigate', { url: `${APP}/?token=${TOKEN}` })
for (let i = 0; i < 60; i++) { if (await ev(`document.body.innerText.includes('Shell')`)) break; await wait(250) }
await wait(1500)
await writeFile(GO, 'go')
let card = false
for (let i = 0; i < 60; i++) { card = await ev(`!!document.querySelector('[class*="border-ctp-blue"]')`); if (card) break; await wait(400) }
console.log('AskUserQuestion card rendered:', card)

// ── THE MEASUREMENT ────────────────────────────────────────────────────────────────────
// The shell wrapper is #root's only child — App.tsx's `<div className="flex h-full …">`.
// Applied and removed by hand via CDP rather than edited into index.css, so a rule that is
// NOT going to be adopted never touches the tree, and so all three variants are measured on
// ONE page load with nothing else differing.
const BANDS = `(() => {
  const shell = document.getElementById('root').firstElementChild
  const card = document.querySelector('[class*="border-ctp-blue"]')
  const ta = document.querySelector('textarea')
  const root = document.getElementById('root').getBoundingClientRect()
  // The transcript scroller: the tallest scrollable ancestor chain in the shell. Identified by
  // computed overflow rather than by class, so a Tailwind rename does not silently void this.
  const scrollers = [...shell.querySelectorAll('*')].filter(e => {
    const o = getComputedStyle(e).overflowY
    return (o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 2
  })
  const inScroller = card ? scrollers.some(s => s !== card && s.contains(card)) : null
  const r = (e) => e ? { top: Math.round(e.getBoundingClientRect().top),
                         bottom: Math.round(e.getBoundingClientRect().bottom),
                         h: Math.round(e.getBoundingClientRect().height) } : null
  const sh = shell.getBoundingClientRect()
  return {
    position: getComputedStyle(shell).position,
    shellTop: Math.round(sh.top), shellH: Math.round(sh.height), shellBottom: Math.round(sh.bottom),
    rootH: Math.round(root.height),
    card: r(card), composer: r(ta),
    cardInsideScroller: inScroller,
    scrollerCount: scrollers.length,
    composerBelowShell: ta ? ta.getBoundingClientRect().bottom > sh.bottom + 1 : null,
  }
})()`

const apply = async (mode) => {
  await ev(`(() => {
    const s = document.getElementById('root').firstElementChild
    s.style.position = ''; s.style.inset = ''; s.style.height = ''
    if (${JSON.stringify('literal')} === ${JSON.stringify(mode)}) { s.style.position = 'fixed'; s.style.inset = '0' }
    if (${JSON.stringify('vvh')} === ${JSON.stringify(mode)}) { s.style.position = 'fixed'; s.style.inset = '0'; s.style.height = 'var(--vvh, 100%)' }
    return s.getAttribute('style')
  })()`)
  await wait(500)
  return await ev(BANDS)
}

let failed = 0, passed = 0, open_ = 0
// [open] marks a defect this probe MEASURED but deliberately did not fix: it prints with its
// numbers and does not fail the run, so the suite stays green while the finding stays visible.
// Same convention as scratchpad/xterm-vvh-probe.mjs.
const ok = (name, cond, extra = '', tag = '') => {
  if (cond) passed++
  else if (tag === 'open') open_++
  else failed++
  const mark = cond ? '✅' : tag === 'open' ? '⚠️ ' : '❌'
  console.log(`  ${mark} ${tag ? `[${tag}] ` : ''}${name}${extra ? ` — ${extra}` : ''}`)
}

// PRECONDITIONS, asserted rather than logged — same reason as xterm-vvh-probe.mjs. The card is
// located by a TAILWIND CLASS FRAGMENT (`border-ctp-blue`, inherited from ask-card-height-probe)
// and the composer by TAG (`textarea`). Both rot silently on a theme rename or a control swap,
// and without these the failure would arrive as a TypeError on `.composer.bottom` inside a
// verdict about `position: fixed` — a stack trace pointing at the wrong subject entirely.
ok('PRECONDITION: the pending permission card rendered', card, 'located by the class fragment border-ctp-blue')

const VIEWPORTS = [
  { name: 'phone 390x844 (keyboard up, --vvh 508)', w: 390, h: 844, mobile: true, vvh: 508 },
  { name: 'desktop 1440x900', w: 1440, h: 900, mobile: false, vvh: 900 },
]
const results = {}
for (const vp of VIEWPORTS) {
  await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile })
  await wait(700)
  await ev(`document.documentElement.style.setProperty('--vvh', '${vp.vvh}px')`)
  await wait(700)
  const base = await apply('none')
  const lit = await apply('literal')
  const vvh = await apply('vvh')
  await apply('none')
  results[vp.name] = { base, lit, vvh }
  console.log(`\n${vp.name}`)
  const row = (n, m) => console.log(`  ${n.padEnd(24)} pos ${String(m.position).padEnd(7)} shell ${m.shellTop}..${m.shellBottom} (${m.shellH}px)  card ${m.card ? m.card.top + '..' + m.card.bottom : 'none'}  composer ${m.composer ? m.composer.top + '..' + m.composer.bottom : 'none'}  cardInScroller ${m.cardInsideScroller}`)
  row('unfixed (today)', base)
  row('fixed; inset:0', lit)
  row('fixed; inset:0; h:--vvh', vvh)
}

console.log('')
const phone = results[VIEWPORTS[0].name], desk = results[VIEWPORTS[1].name]
ok('PRECONDITION: both bands were located in every variant at both widths',
   [phone, desk].every(v => [v.base, v.lit, v.vvh].every(m => m.card && m.composer)),
   'card (class fragment) + composer (textarea tag) found in all 6 measurements')

// The premise slice 1 established. If this is red the rest of the file is measuring the
// wrong arrangement and its verdicts mean nothing.
ok('PREMISE: the pending card sits OUTSIDE the transcript scroll container',
   phone.base.cardInsideScroller === false && desk.base.cardInsideScroller === false,
   `phone ${phone.base.cardInsideScroller}, desktop ${desk.base.cardInsideScroller}`)

// COST 1 — the literal rule discards --vvh. This is the whole cost, and it is decisive on its
// own: the shell grows back to the LAYOUT viewport, so the composer returns below the visible
// area. Exactly the defect lib/visualViewport.ts exists to fix.
ok('COST: literal `inset: 0` regrows the shell to the LAYOUT viewport on a phone',
   phone.lit.shellH > phone.base.shellH,
   `shell ${phone.base.shellH}px → ${phone.lit.shellH}px with --vvh at ${VIEWPORTS[0].vvh}`)
// Stated as a DELTA, not as "the composer ends up off-screen". It already does, by 33px —
// see the [open] finding below — so an absolute check here would have passed for the wrong
// reason on one side and failed for the wrong reason on the other. What the rule costs is the
// 250px it ADDS.
ok('COST: …and that pushes the composer a further 250px below the visible viewport',
   phone.lit.composer.bottom - phone.base.composer.bottom > 200,
   `composer bottom ${phone.base.composer.bottom} → ${phone.lit.composer.bottom} against a ${VIEWPORTS[0].vvh}px visible height`)

// UNRELATED TO THE RULE, FOUND WHILE MEASURING THE BASELINE FOR IT. With a pending
// AskUserQuestion card at 390x844 and the keyboard up, the composer's bottom is ALREADY below
// the shell, which is overflow-hidden — so the bottom of the composer is clipped with nothing
// to scroll to it. ask-card-height-probe.mjs asserts that the card's own Submit is reachable,
// and it is; nothing asserted anything about the composer underneath it. NOT fixed here: which
// band should give up the 33px (the card's 0.55 cap, the transcript's floor, or the composer)
// is a layout-policy call, not a bug with one obvious repair.
ok('PRE-EXISTING, unowned: with a pending card + keyboard up, the composer fits inside the shell',
   phone.base.composer.bottom <= phone.base.shellBottom,
   `composer ends at ${phone.base.composer.bottom}, shell ends at ${phone.base.shellBottom} — ${phone.base.composer.bottom - phone.base.shellBottom}px clipped by overflow-hidden. Desktop is clean (composer ${desk.base.composer.bottom} in a ${desk.base.shellBottom}px shell), so this is phone + keyboard only.`,
   'open')

// COST 2 — what it does NOT cost. The bands themselves are untouched by either form: making an
// ancestor a fixed-position containing block does not change flex layout inside it, and the
// card does not migrate into the scroller. Worth pinning, because "it breaks the bands" was the
// suspected cost and it is not the real one.
ok('NOT A COST: neither form moves the card into the scroll container',
   phone.lit.cardInsideScroller === false && phone.vvh.cardInsideScroller === false &&
   desk.lit.cardInsideScroller === false && desk.vvh.cardInsideScroller === false,
   'the shrink-0 band arrangement survives both forms, at both widths')
ok('NOT A COST: keeping --vvh, the rule is geometrically inert at both widths',
   phone.vvh.shellH === phone.base.shellH && phone.vvh.composer.bottom === phone.base.composer.bottom &&
   desk.vvh.shellH === desk.base.shellH && desk.vvh.composer.bottom === desk.base.composer.bottom,
   `phone shell ${phone.base.shellH}→${phone.vvh.shellH}, desktop shell ${desk.base.shellH}→${desk.vvh.shellH}`)
ok('NOT A COST: desktop is unaffected by either form',
   desk.lit.shellH === desk.base.shellH && desk.lit.composer.bottom === desk.base.composer.bottom,
   `shell ${desk.base.shellH}px, composer bottom ${desk.base.composer.bottom} — unchanged (--vvh == the layout height here, so there is nothing to discard)`)

console.log(`\nVERDICT: on a phone with the keyboard up the literal rule costs the whole --vvh fix;`)
console.log(`         keeping --vvh it costs nothing and does nothing (see visual-viewport-pan-probe).`)
console.log(`         The suspected cost — breaking the shrink-0 bands — is NOT real either way.`)
console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed` + (open_ ? `, ${open_} OPEN (measured, deliberately not fixed — see ⚠️  above)` : ''))
cdpDone = true
cdp.close(); reapAll()
process.exit(failed ? 1 : 0)
