// DOES THE TERMINAL PANE TRACK THE **VISIBLE** VIEWPORT? — Group B (own vite over the
// working tree; web/dist is not consulted).
//
//   CHROME_BIN=… node scratchpad/xterm-vvh-probe.mjs
//
// lib/visualViewport.ts names the terminal as the second consumer of `--vvh` and says it is
// "NOT yet adopted by TerminalView — a deliberate follow-up". This measures what that
// non-adoption actually costs, and it is NOT what the note predicts.
//
// The note blames xterm: "FitAddon re-fits from a ResizeObserver gated on
// `contentRect.width`, so a keyboard never triggers a re-fit at all." Measured here, that
// diagnosis is wrong twice over. A ResizeObserver fires on ANY box change including a
// height-only one, and the guard is `width > 0` — a liveness test, not a width-CHANGED test
// — so it passes and `fit()` runs. xterm is not the thing that is broken.
//
// What is broken is one line of App.tsx: the terminal dock is `shrink-0` with an inline
// `height: termH` in ABSOLUTE PIXELS, restored from localStorage and never bounded by the
// viewport. `--vvh` shrinks the shell; the dock does not participate, so the space comes out
// of whatever can flex — and when termH alone exceeds the visible viewport the dock overflows
// a shell that is `overflow-hidden`, clipping the bottom of the terminal (the prompt) with no
// way to scroll to it.
import { spawn } from 'child_process'
import { mkdtemp, writeFile, rm, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4497, WEB_PORT = 5297, CDP = 9372
const APP = `http://127.0.0.1:${WEB_PORT}`, API = `http://127.0.0.1:${PORT}`
const TOKEN = 'xterm-vvh-token'
const LAYOUT_H = 844
// A dock height a DESKTOP user plausibly drags to and localStorage then carries onto the
// phone. Well under the 700 the divider allows, and harmless at 844.
// 600 is inside the divider's own 700 max and harmless on the 844 layout viewport
// (48px mobile bar + ~40px tab bar + 600 = 688 < 844). It is the SAME saved value that
// overflows once the keyboard leaves 508px. A smaller value makes the two checks below pass
// vacuously — measured at 380 they did exactly that, which is how this constant got chosen.
const SAVED_TERM_H = 600
const PORTRAIT_KB = 508   // 844 - a ~336px iOS keyboard (the ask-card-height-probe allowance)
const wait = (ms) => new Promise(r => setTimeout(r, ms))
let failed = 0, passed = 0, open_ = 0
// Three tags. [today] must pass now; [fix] is what this slice delivers. [open] is a defect
// this probe MEASURED but deliberately did not fix — it reports with a ⚠️ and does NOT fail
// the run, so the suite stays green while the finding stays in the output with its numbers.
// The alternative (registering another EXPECTED-RED harness, as layout-check is) hands the
// suite a red that everyone learns to skip past, which is how a real failure gets buried.
const ok = (tag, name, cond, extra = '') => {
  if (cond) passed++
  else if (tag === 'open') open_++
  else failed++
  const mark = cond ? '✅' : tag === 'open' ? '⚠️ ' : '❌'
  console.log(`  ${mark} [${tag}] ${name}${extra ? ` — ${extra}` : ''}`)
}
if (!process.env.CHROME_BIN) { console.error('SKIP: CHROME_BIN unset'); process.exit(0) }

const DATA = await mkdtemp(join(tmpdir(), 'xvvh-data-'))
const PROJ = await mkdtemp(join(tmpdir(), 'xvvh-proj-'))
const BIN = await mkdtemp(join(tmpdir(), 'xvvh-bin-'))
// A `claude` that does nothing but stay alive: this harness never drives a turn, it only
// needs session creation to succeed so the Terminal toolbar button is enabled.
await writeFile(join(BIN, 'claude'), `#!/usr/bin/env node
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.resume(); setTimeout(() => process.exit(0), 300000)
`)
await chmod(join(BIN, 'claude'), 0o755)
await writeFile(join(PROJ, 'demo.py'), 'x = 1\nprint(x)\n')

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
const chromeDir = await mkdtemp(join(tmpdir(), 'xvvh-chrome-'))
const chrome = spawn(process.env.CHROME_BIN,
  ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${chromeDir}`,
   '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', 'about:blank'], { stdio: 'ignore', detached: true })
const reapAll = () => {
  for (const c of [server, web]) { try { process.kill(-c.pid, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch {} } }
  try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} }
}
process.on('exit', reapAll)
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapAll(); if (e) console.error(e); process.exit(1) })
}
for (let i = 0; i < 90 && !log.includes('Server listening'); i++) await wait(500)
if (!log.includes('Server listening')) { console.error('server never started:\n' + log.slice(-2000)); process.exit(1) }
for (let i = 0; i < 90 && !weblog.includes('ready in'); i++) await wait(500)
if (!weblog.includes('ready in')) { console.error('vite never started:\n' + weblog.slice(-2000)); process.exit(1) }

let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()
        const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) wsUrl = p.webSocketDebuggerUrl } catch {}
  await wait(250)
}
const cdp = new WebSocket(wsUrl); await new Promise(r => cdp.on('open', r))
let id = 0; const pending = new Map(); let cdpDone = false
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died; aborting rather than hanging'); process.exit(1) })
cdp.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => { const i = ++id; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise(r => pending.set(i, r)) }
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: LAYOUT_H, deviceScaleFactor: 1, mobile: true })
await fetch(`${API}/api/session/create`, { method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` },
  body: JSON.stringify({ name: 'Xterm', cwd: PROJ, rootDir: PROJ, sandbox: { enabled: false, mounts: [] } }) }).then(r => r.json())

// Seed the SAVED layout before the app's module-level loadPersisted() runs, so termH arrives
// the way a real phone gets it: restored from a desktop session, not dragged here.
await send('Page.navigate', { url: `${APP}/?token=${TOKEN}` })
for (let i = 0; i < 60; i++) { if (await ev(`document.body.innerText.includes('Xterm')`)) break; await wait(250) }
await ev(`localStorage.setItem('claudette:layout:v1', JSON.stringify({
  v: 1, layout: 'stack', seq: 0, terms: {}, content: {},
  sizes: { sideW: 420, stackH: 280, dockW: 320, termH: ${SAVED_TERM_H}, sidebarW: 288 } }))`)
await send('Page.reload')
for (let i = 0; i < 60; i++) { if (await ev(`document.body.innerText.includes('Xterm')`)) break; await wait(250) }
await wait(1200)

// Open the terminal dock via the real toolbar button, then wait for xterm to paint.
const clicked = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Terminal'); if (!b) return 'no-button'; if (b.disabled) return 'disabled'; b.click(); return 'ok' })()`)
// ASSERT THE PRECONDITIONS, do not just log them. Every lookup below finds a control by TAG
// or by VISIBLE TEXT, which is the selector class that rots silently: if the toolbar button
// stops being a <button>, or its label changes, `clicked` becomes 'no-button', no xterm ever
// paints, and the first red is "the terminal actually mounted and fitted" — a name that points
// at the terminal when the cause is the selector. An over-determined red whose name matches
// none of its causes is worse than no coverage. Each is verified to render this way TODAY
// (all five were observed 'ok'/true on every run, and the demo.py one was caught needing
// dblclick rather than click); these checks exist so DRIFT names itself.
console.log('Terminal toolbar button:', clicked)
ok('today', 'PRECONDITION: a <button> labelled "Terminal" exists, is enabled, and was clicked',
   clicked === 'ok', `lookup returned: ${clicked}`)
let hasXterm = false
for (let i = 0; i < 60; i++) { hasXterm = await ev(`!!document.querySelector('.xterm-rows')`); if (hasXterm) break; await wait(400) }
console.log('xterm painted:', hasXterm)
ok('today', 'PRECONDITION: xterm painted a .xterm-rows element', hasXterm)
await wait(1500)

// The dock is the nearest ancestor of the xterm carrying an inline height — App.tsx renders
// it as `style={{ height: termH }}`. Rows come from xterm's own DOM (one div per row), which
// is what FitAddon actually computed, not a number we derive ourselves.
const MEASURE = `(() => {
  const rows = document.querySelector('.xterm-rows')
  if (!rows) return { err: 'no xterm' }
  // LOCATE THE DOCK BY ITS TEST HOOK. Three selectors were wrong here before this one, each
  // silently, and the comment predicting a third drift was itself proven right by the third:
  //   closest('[style*=height])   also matches min-height/max-height in the style attribute
  //   walking up from .xterm-rows  lands on .xterm-screen, which xterm sizes INLINE itself
  //   walking up for an INLINE height finds NOTHING at phone since slice 2B, because the dock
  //     is deliberately flex-sized there (App.tsx sizes it only when NOT isPhone). The
  //     premise "the dock always carries an inline height" became false.
  // data-testid="pane" is structural rather than stylistic, so it does not move when the
  // sizing strategy does. closest() from .xterm picks the ONE pane that contains the terminal.
  // (No backticks in here: this whole block lives inside a JS template literal.)
  const xterm = document.querySelector('.xterm')
  const dock = xterm ? xterm.closest('[data-testid="pane"]') : null
  if (!dock) return { err: 'dock pane not found', hasXterm: !!xterm }
  const root = document.getElementById('root')
  const dr = dock ? dock.getBoundingClientRect() : null
  const rr = root.getBoundingClientRect()
  const sr = rows.getBoundingClientRect()
  const vvh = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--vvh')) || innerHeight
  return {
    // Which invariant applies is a property of the LAYOUT MODE, not of the viewport width the
    // harness happens to have set — read it from the source (2B publishes it on the shell).
    phoneLayout: (document.querySelector('[data-phone]') || {}).getAttribute
      ? document.querySelector('[data-phone]').getAttribute('data-phone') === 'true' : null,
    vvh, rootH: Math.round(rr.height),
    dockH: dr && Math.round(dr.height), dockTop: dr && Math.round(dr.top), dockBottom: dr && Math.round(dr.bottom),
    dockInlineH: dock ? dock.style.height : null,
    dockClass: dock ? dock.className.slice(0, 60) : null,
    rowCount: rows.children.length,
    rowsBottom: Math.round(sr.bottom),
    clippedPx: dr ? Math.max(0, Math.round(dr.bottom - rr.bottom)) : 0,
  }
})()`

const setVvh = async (px) => { await ev(`document.documentElement.style.setProperty('--vvh', '${px}px')`); await wait(900) }
const setViewport = async (w, h) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 })
  await wait(900)
}
// A width that is NOT phone (>= Tailwind's md) but is still short enough for a keyboard to
// matter — a small tablet in portrait, and also every phone in LANDSCAPE, which is the case
// that now exercises the inline bound hardest: 844x390 is desktop-layout by width while a
// keyboard takes half the height.
const TABLET_W = 900

// EVERY assertion below states WHICH LAYOUT MODE's invariant it is checking, because since
// slice 2B there are two different correct answers and neither is wrong:
//   phone  — the dock IS the single pane, flex-sized, bounded by #root (which is var(--vvh));
//            it carries NO inline height, deliberately.
//   >= md  — the dock is a dragged-to pixel height, bounded by min(termH, --vvh - reserve).
// Asserting the >= md invariant at phone is what made this probe report on a box that did not
// exist. `guard()` refuses to let an assertion run on a failed lookup at all: the previous
// version had `kb.dockH <= kb.vvh` evaluate `null <= 508` — which JS says is TRUE — so two
// checks went GREEN while measuring nothing.
const guard = (m, tag, name) => {
  if (m && !m.err && m.dockH !== null && m.dockH !== undefined) return true
  ok(tag, name, false, `lookup failed: ${m ? (m.err || 'dockH is ' + m.dockH) : 'no measurement'}`)
  return false
}

// ══ PHONE LAYOUT (390x844) ═════════════════════════════════════════════════════════════
console.log('\n── phone layout (390x844): the dock is the single pane, flex-sized ──')
await setVvh(LAYOUT_H)
const rest = await ev(MEASURE)
console.log('  at rest      (--vvh 844):', JSON.stringify(rest))
await setVvh(PORTRAIT_KB)
const kb = await ev(MEASURE)
console.log('  keyboard up  (--vvh 508):', JSON.stringify(kb))
console.log('')

ok('today', 'the terminal actually mounted and fitted', !rest.err && rest.rowCount > 0,
   `${rest.rowCount} rows`)
if (guard(rest, 'today', 'PHONE: the dock pane was located by its test hook') &&
    guard(kb, 'today', 'PHONE: the dock pane is still located with the keyboard up')) {
  ok('today', 'PHONE: the layout really is in phone mode (data-phone)', rest.phoneLayout === true,
     `data-phone=${rest.phoneLayout}`)
  // THE PHONE INVARIANT, and it is the opposite of the desktop one. Slice 2B makes the dock the
  // single pane and sizes it with flex, so an inline pixel height here would be the DEFECT — it
  // is what would pin the dock to a dragged desktop size the pane layout cannot override.
  ok('fix', 'PHONE: the dock is flex-sized, carrying NO inline height',
     !rest.dockInlineH, `inline height: ${rest.dockInlineH || '(none)'}`)
  // …and what replaces the --vvh arithmetic is a structural fact: flex inside #root, which IS
  // var(--vvh). So the property to assert is the OUTCOME the bound existed to produce.
  ok('fix', 'PHONE: the dock never extends below the shell, at rest or with the keyboard up',
     rest.clippedPx === 0 && kb.clippedPx === 0,
     `clipped ${rest.clippedPx}px at rest, ${kb.clippedPx}px with the keyboard up (dock ends ${kb.dockBottom}, #root ends ${kb.rootH})`)
  ok('fix', 'PHONE: the dock tracks --vvh through flex (it shrinks with the visible viewport)',
     kb.dockH < rest.dockH && kb.dockH > 0, `dock ${rest.dockH}px → ${kb.dockH}px`)
  ok('fix', 'PHONE: xterm RE-FITS when --vvh changes: fewer rows with the keyboard up',
     kb.rowCount < rest.rowCount, `rows ${rest.rowCount} → ${kb.rowCount}`)
}

// ══ >= md LAYOUT (900x844) ═════════════════════════════════════════════════════════════
// Where the inline --vvh bound still lives. 900px wide is past Tailwind's md, so App.tsx takes
// the desktop branch, while 844px tall leaves a keyboard something to take.
console.log('\n── >= md layout (900x844): the dock keeps its dragged pixel height, bounded ──')
await setViewport(TABLET_W, LAYOUT_H)
await setVvh(LAYOUT_H)
const mdRest = await ev(MEASURE)
console.log('  at rest      (--vvh 844):', JSON.stringify(mdRest))
await setVvh(PORTRAIT_KB)
const mdKb = await ev(MEASURE)
console.log('  keyboard up  (--vvh 508):', JSON.stringify(mdKb))
console.log('')

if (guard(mdRest, 'today', '>=md: the dock pane was located') &&
    guard(mdKb, 'today', '>=md: the dock pane is still located with the keyboard up')) {
  ok('today', '>=md: the layout really is in desktop mode (data-phone)', mdRest.phoneLayout === false,
     `data-phone=${mdRest.phoneLayout}`)
  ok('fix', '>=md: the dock height is expressed against --vvh, not as a raw pixel value',
     /--vvh/.test(mdRest.dockInlineH || ''), `inline height: ${mdRest.dockInlineH}`)
  ok('fix', '>=md: the dock is bounded by the VISIBLE viewport, not just the layout one',
     mdKb.dockH <= mdKb.vvh, `dock ${mdKb.dockH}px inside a ${mdKb.vvh}px visible viewport`)
  ok('fix', '>=md: nothing is clipped below the shell when the keyboard is up',
     mdKb.clippedPx === 0, `${mdKb.clippedPx}px of dock below #root (dock ends ${mdKb.dockBottom}, #root ends ${mdKb.rootH})`)
  ok('fix', '>=md: xterm RE-FITS when --vvh changes: fewer rows with the keyboard up',
     mdKb.rowCount < mdRest.rowCount, `rows ${mdRest.rowCount} → ${mdKb.rowCount}`)
  ok('today', '>=md CONTROL: at rest the dock keeps the full saved height (the bound is conditional, not a blanket shrink)',
     mdRest.dockH === SAVED_TERM_H, `dock ${mdRest.dockH}px of a saved ${SAVED_TERM_H}px`)
}


// ── the OTHER site that carries termH: the stacked Claude column ───────────────────────
// With a content tab open, App.tsx sizes the Claude column to `stackH + dock + 1`. If only
// the dock were bounded, the column would keep reserving the FULL saved termH and the bound
// would buy a gap below the terminal instead of an unclipped one — so this asserts the two
// agree. Opening a file is the cheapest way to reach that branch.
//
// RUNS AT >= md, NOT AT PHONE, and that is a correctness requirement rather than a preference.
// Since slice 2B the Claude column takes NO inline style at phone either (App.tsx gates it on
// `!isPhone && active`), and at phone the content pane REPLACES the column outright rather than
// sharing a split with it — so there is no stacked column to measure and the section asserted
// against a box that does not exist. It was reporting "column not found" and reading as a
// missing fix. The stacked-column invariant is a desktop one now; this is where it lives.
await setViewport(TABLET_W, LAYOUT_H)
await setVvh(LAYOUT_H)
const opened = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Files')
  if (!b || b.disabled) return 'no-files-button'
  b.click(); return 'ok'
})()`)
await wait(1500)
// FileManager opens on onDoubleClick — a single click only SELECTS the row. A plain
// .click() therefore left `active` null and the column branch unreachable, which read as
// "the fix does not apply there" rather than "the harness never opened a file".
const picked = await ev(`(() => {
  const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === 'demo.py')
  if (!el) return 'no-file'
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
  return 'ok'
})()`)
await wait(2000)
console.log(`\n  files dock: ${opened}, demo.py: ${picked}`)
ok('today', 'PRECONDITION: a <button> labelled "Files" opened the dock', opened === 'ok', `lookup returned: ${opened}`)
ok('today', 'PRECONDITION: a leaf element with the text "demo.py" was found and double-clicked',
   picked === 'ok', `lookup returned: ${picked}`)
const COLUMN = `(() => {
  const xterm = document.querySelector('.xterm')
  // The DOCK comes from the pane hook (see MEASURE); only the COLUMN above it is found by its
  // inline height, which at >= md it genuinely has (calc(stackH + boundedDockH + 1px)).
  const dockPane = xterm ? xterm.closest('[data-testid="pane"]') : null
  let dock = null
  dock = dockPane
  let col = null
  for (let e = dock && dock.parentElement; e; e = e.parentElement) { if (e.style && e.style.height) { col = e; break } }
  const root = document.getElementById('root').getBoundingClientRect()
  if (!dock || !col) return { err: 'not found', dock: !!dock, col: !!col,
    inlineHeights: [...document.querySelectorAll('[style]')].filter(e => e.style.height && !e.closest('.xterm')).map(e => (e.tagName + '.' + String(e.className).slice(0, 40) + '=' + e.style.height)),
    hasDemoTab: document.body.innerText.includes('demo.py') }
  const dr = dock.getBoundingClientRect(), cr = col.getBoundingClientRect()
  // THE FULL BUDGET, term by term. The summary number alone ("clipped 73px") invites a
  // single-culprit reading, and the clip is a SUM — every competing term is reported so the
  // attribution can be checked rather than inferred.
  //   splitRow  the flex row the column lives in (what the column must fit inside)
  //   chromeH   everything above that row (MainTabs, plus the md:hidden mobile bar at phone)
  //   contentH  the content pane, which is the elastic one and collapses FIRST
  //   dividerH  the drag handle between them
  const splitRow = col.parentElement
  const sp = splitRow ? splitRow.getBoundingClientRect() : null
  const content = splitRow ? [...splitRow.children].find(e => e !== col && !e.getAttribute('title')) : null
  const divider = splitRow ? [...splitRow.children].find(e => e.getAttribute('title') === 'Drag to resize') : null
  const chat = col.firstElementChild
  return { colInlineH: col.style.height, colH: Math.round(cr.height), colBottom: Math.round(cr.bottom),
           dockH: Math.round(dr.height), dockBottom: Math.round(dr.bottom),
           gapPx: Math.round(cr.bottom - dr.bottom), clippedPx: Math.max(0, Math.round(dr.bottom - root.bottom)),
           rootH: Math.round(root.height),
           splitTop: sp ? Math.round(sp.top) : null, splitH: sp ? Math.round(sp.height) : null,
           chromeH: sp ? Math.round(sp.top) : null,
           contentH: content ? Math.round(content.getBoundingClientRect().height) : null,
           dividerH: divider ? Math.round(divider.getBoundingClientRect().height) : null,
           chatH: chat ? Math.round(chat.getBoundingClientRect().height) : null,
           colTop: Math.round(cr.top) }
})()`
const colRest = await ev(COLUMN)
await setVvh(PORTRAIT_KB)
const colKb = await ev(COLUMN)
console.log(`  column at rest    : ${JSON.stringify(colRest)}`)
console.log(`  column keyboard up: ${JSON.stringify(colKb)}\n`)
if (colRest.err || colKb.err) {
  ok('fix', 'content-tab branch reachable (column found)', false, JSON.stringify(colRest))
} else {
  ok('fix', 'with a content tab open the column height tracks the BOUNDED dock, not raw termH',
     /--vvh/.test(colKb.colInlineH || ''), `column height: ${colKb.colInlineH}`)
  ok('fix', 'no gap opens below the terminal when the dock is bounded',
     Math.abs(colKb.gapPx) <= 2, `${colKb.gapPx}px between the dock's bottom and the column's`)
  // FIXED 2026-08-26 — and the attribution this line used to carry was WRONG, which is worth
  // keeping because it is the reason the item sat open so long. It read "the residual is
  // stackH (280px), not the dock". Measured term by term, the clip is a SUM: 32 chrome + 0
  // content + 4 divider + 881 column against an 844px shell. Neither term alone can clip. The
  // cause was two INDEPENDENT bounds on one shared budget — the dock bounded by `--vvh - 164`
  // (blind to stackH) and stackH's drag max by `splitRef - 200` (blind to the dock).
  // The content pane was never a candidate for "which gives way": it measured 0px in BOTH
  // states, so it had already given everything before the terminal was cut at all.
  ok('fix', 'the stacked column does NOT clip the terminal, at rest or with the keyboard up',
     colRest.clippedPx === 0 && colKb.clippedPx === 0,
     `clipped ${colRest.clippedPx}px at rest (--vvh 844) and ${colKb.clippedPx}px with the keyboard up`)
  // THE HALF THAT PROVES THE SQUEEZE WAS NOT JUST MOVED. Capping the column alone would also
  // read as "not clipped" while leaving the content pane at 0 and the chat at 11px — the same
  // budget failure one element over. At rest the content pane must get its full reserve back.
  ok('fix', 'the content pane gets its reserve back at rest, rather than the clip moving to it',
     colRest.contentH >= 200,
     `content pane ${colRest.contentH}px at rest (was 0px), chat ${colRest.chatH}px, dock ${colRest.dockH}px`)
  // With the keyboard up the floor wins and the content pane goes under its reserve — stated
  // rather than asserted away, because a 120px terminal that is fully visible is the correct
  // outcome and pretending otherwise would need a number nobody chose.
  console.log(`  [note] keyboard-up: content ${colKb.contentH}px (below the 200px reserve — DOCK_MIN_PX floor wins, nothing clipped)`)

  // WHAT THE BOUND ACTUALLY BOUGHT, measured rather than computed. Put the dock and the
  // column back to their UNBOUNDED values by hand and re-measure the same clip. This runs
  // last on purpose: it leaves the DOM inconsistent with React's state, and nothing is
  // measured after it.
  const before = await ev(`(() => {
    const xterm = document.querySelector('.xterm')
    let dock = null
    for (let e = xterm && xterm.parentElement; e; e = e.parentElement) { if (e.style && e.style.height) { dock = e; break } }
    let col = null
    for (let e = dock && dock.parentElement; e; e = e.parentElement) { if (e.style && e.style.height) { col = e; break } }
    dock.style.height = '${SAVED_TERM_H}px'
    col.style.height = (280 + ${SAVED_TERM_H} + 1) + 'px'
    const root = document.getElementById('root').getBoundingClientRect()
    return Math.max(0, Math.round(dock.getBoundingClientRect().bottom - root.bottom))
  })()`)
  ok('fix', 'the --vvh bound measurably shrinks the keyboard-up clip',
     before > colKb.clippedPx,
     `${before}px clipped unbounded → ${colKb.clippedPx}px bounded`)
}

// ── DESKTOP NO-REGRESSION ──────────────────────────────────────────────────────────────
// The bound must be inert where the viewport was never the problem. 1440x900 leaves
// 900-164=736px of allowance, so a 600px dock is untouched.
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await wait(600)
await setVvh(900)
const desk = await ev(MEASURE)
ok('today', 'DESKTOP 1440x900: the bound is inert, the saved dock height is untouched',
   desk.dockH === SAVED_TERM_H, `dock ${desk.dockH}px of a saved ${SAVED_TERM_H}px`)

console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed` + (open_ ? `, ${open_} OPEN (measured, deliberately not fixed — see ⚠️  above)` : ''))
cdpDone = true; reapAll()
process.exit(failed ? 1 : 0)
