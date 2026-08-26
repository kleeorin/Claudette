// CAN THE KEYBOARD PAN BE TESTED HEADLESSLY? — and what does the remedy actually buy?
//
//   CHROME_BIN=… node scratchpad/visual-viewport-pan-probe.mjs
//
// web/src/index.css carries a long comment ending "STATUS: open question, device-only,
// unresolved. Headless Chrome has no software keyboard and no visual-viewport pan, so this
// is not observable in any harness in this repo." THE SECOND HALF OF THAT IS FALSE, and it
// is what kept the remedy unexamined. Headless Chrome has no software keyboard — true — but
// it absolutely does have a pannable visual viewport, reachable from CDP:
//
//     Emulation.setPageScaleFactor { pageScaleFactor: N }   → visualViewport.height = innerHeight/N
//                                                             with innerHeight UNCHANGED
//     Input.dispatchMouseEvent { type: 'mouseWheel', … }    → visualViewport.offsetTop > 0
//                                                             with window.scrollY STILL 0
//
// offsetTop moving while scrollY stays 0 IS the pan: the visual viewport sliding inside an
// unchanged layout viewport. That is the same geometric relation the iOS keyboard creates,
// so the LAYOUT question ("can the visible window land on bare canvas below a --vvh-sized
// #root, and does `position: fixed` stop it?") is answerable here.
//
// WHAT THIS IS NOT. Pinch-zoom is a STRUCTURAL analogue, not an emulation of the keyboard:
//   • it scales, so the visual viewport narrows too (390 → 235) where a keyboard does not;
//   • it needs a user gesture, where iOS pans BY ITSELF to reveal a focused input.
// So this settles the geometry and cannot settle the trigger. Every check below is labelled
// [geo] (settled here) or [trigger] (still device-only) so nobody banks the wrong one.
//
// This is a STANDALONE page, not the app: it reproduces web/src/index.css's exact height
// contract in ~15 lines so the mechanism is isolated from a 1700-line App.tsx. The app-level
// cost of the same rule is measured by scratchpad/shell-fixed-cost-probe.mjs.
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const CDP = 9371
const LAYOUT_H = 844           // iPhone 14-ish layout viewport; a keyboard does NOT shrink this
const KEYBOARD_PX = 336        // iOS keyboard ≈ 40% of 844 — an ASSUMPTION, as in ask-card-height-probe
const VISIBLE_H = LAYOUT_H - KEYBOARD_PX   // 508
const SCALE = LAYOUT_H / VISIBLE_H         // pick the zoom that makes the visible height match

const wait = (ms) => new Promise(r => setTimeout(r, ms))
let failed = 0, passed = 0
const ok = (tag, name, cond, extra = '') => {
  cond ? passed++ : failed++
  console.log(`  ${cond ? '✅' : '❌'} [${tag}] ${name}${extra ? ` — ${extra}` : ''}`)
}

if (!process.env.CHROME_BIN) { console.error('SKIP: CHROME_BIN unset'); process.exit(0) }
const dir = await mkdtemp(join(tmpdir(), 'vvpan-chrome-'))
const chrome = spawn(process.env.CHROME_BIN, ['--headless=new', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${dir}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', 'about:blank'],
  { stdio: 'ignore', detached: true })
const reap = () => { try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} } }
process.on('exit', reap)
for (const s of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'])
  process.on(s, (e) => { reap(); if (e) console.error(e); process.exit(1) })

let wsUrl = null
for (let i = 0; i < 40 && !wsUrl; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()
        const p = l.find(t => t.type === 'page'); if (p?.webSocketDebuggerUrl) wsUrl = p.webSocketDebuggerUrl } catch {}
  await wait(250)
}
if (!wsUrl) { console.error('FAIL: no CDP target'); process.exit(1) }
const cdp = new WebSocket(wsUrl); await new Promise(r => cdp.on('open', r))
let id = 0; const pending = new Map(); let cdpDone = false
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died; aborting rather than hanging'); process.exit(1) })
cdp.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => { const i = ++id; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise(r => pending.set(i, r)) }
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: LAYOUT_H, deviceScaleFactor: 1, mobile: true })

// index.css's height contract, reproduced exactly: html/body and #root both sized to --vvh
// with overflow hidden, a bottom-anchored band standing in for the composer, and an input in
// it standing in for the composer's textarea. #root's rules are in a class we can swap so
// `position: fixed; inset: 0` is applied and removed WITHOUT reloading (a reload would reset
// the pan and quietly turn every comparison into a fresh-page measurement).
const HTML = [
  '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">',
  '<style>',
  '  html,body{margin:0;height:var(--vvh,100%);overflow:hidden;background:#17181c}',
  '  #root{height:var(--vvh,100%);display:flex;flex-direction:column;background:#1e1e2e}',
  // THE LITERAL REMEDY as index.css names it: no height, so `inset:0` sizes the shell to the
  // LAYOUT viewport (844) — which is a different rule from the one below, not a variant of it.
  '  #root.fixed-literal{position:fixed;inset:0;height:auto}',
  // The remedy someone would actually write, keeping --vvh. `inset:0` + `height` is
  // over-constrained, so `bottom` is dropped and height wins.
  '  #root.fixed-vvh{position:fixed;inset:0;height:var(--vvh,100%)}',
  '  #topbar{flex-shrink:0;height:44px;background:#89b4fa}',
  '  #transcript{flex:1;min-height:0;overflow-y:auto}',
  '  #composer{flex-shrink:0;height:56px;background:#f5c2e7}',
  '  #filler{height:2000px}',
  '</style>',
  '<div id=root><div id=topbar>topbar</div><div id=transcript><div id=filler>transcript</div></div>',
  '<div id=composer><input id=inp style="width:100%"></div></div>',
].join('\n')
await send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(HTML) })
await wait(500)
// Stand in for lib/visualViewport.ts with the keyboard already up: the layout viewport is
// still 844, the app believes it has 508. Set directly rather than via visualViewport.height,
// which headless will not shrink on its own.
await ev(`document.documentElement.style.setProperty('--vvh', '${VISIBLE_H}px')`)
await wait(200)

// visualViewport reports its window in LAYOUT css px; getBoundingClientRect is in the same
// coordinates, so the two are directly comparable. `visible` means "inside the window the
// user can actually see", which is NOT `0 <= top && bottom <= innerHeight` — that is the
// check the layout viewport lets you get away with and the one this whole file exists to
// replace.
const MEASURE = `(() => {
  const v = window.visualViewport
  const win = { top: v.offsetTop, bottom: v.offsetTop + v.height }
  const r = document.getElementById('root').getBoundingClientRect()
  const c = document.getElementById('composer').getBoundingClientRect()
  const t = document.getElementById('topbar').getBoundingClientRect()
  const inWin = (b) => b.top >= win.top - 1 && b.bottom <= win.bottom + 1
  return {
    innerH: innerHeight, scrollY: Math.round(scrollY), scale: +v.scale.toFixed(3),
    vvH: Math.round(v.height), offTop: Math.round(v.offsetTop),
    winTop: Math.round(win.top), winBottom: Math.round(win.bottom),
    rootBottom: Math.round(r.bottom), rootTop: Math.round(r.top),
    composerTop: Math.round(c.top), composerBottom: Math.round(c.bottom),
    composerVisible: inWin(c),
    topbarVisible: inWin(t),
    topbarTop: Math.round(t.top), topbarBottom: Math.round(t.bottom),
    rootH: Math.round(r.height),
    canvasExposedPx: Math.max(0, Math.round(win.bottom - r.bottom)),
    position: getComputedStyle(document.getElementById('root')).position,
  }
})()`

const panDown = async () => {
  // One big wheel is enough to hit the pan limit; a second is cheap insurance against the
  // compositor swallowing the first while the page is still settling.
  for (let i = 0; i < 2; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 300, deltaX: 0, deltaY: 1200 })
    await wait(300)
  }
}
const panTop = async () => {
  for (let i = 0; i < 2; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 300, deltaX: 0, deltaY: -1200 })
    await wait(300)
  }
}

console.log(`\nlayout viewport ${LAYOUT_H}px, app told it has ${VISIBLE_H}px (--vvh), zoom ${SCALE.toFixed(3)}× to match\n`)

// ── [geo] 1. the mechanism exists at all ───────────────────────────────────────────────
const flat = await ev(MEASURE)
ok('geo', 'baseline: visual viewport == layout viewport', flat.vvH === flat.innerH && flat.offTop === 0,
   `vvH ${flat.vvH} innerH ${flat.innerH} offTop ${flat.offTop}`)
await send('Emulation.setPageScaleFactor', { pageScaleFactor: SCALE })
await wait(300)
const zoomed = await ev(MEASURE)
ok('geo', 'visual viewport can be made SHORTER than the layout viewport',
   zoomed.vvH < zoomed.innerH && zoomed.innerH === LAYOUT_H,
   `vvH ${zoomed.vvH} < innerH ${zoomed.innerH}`)
await panDown()
const panned = await ev(MEASURE)
ok('geo', 'the visual viewport PANS: offsetTop > 0 while scrollY stays 0',
   panned.offTop > 0 && panned.scrollY === 0,
   `offTop ${panned.offTop}, scrollY ${panned.scrollY}`)

// ── [geo] 2. the symptom the index.css comment predicts ────────────────────────────────
// Pan DOWN. The window slides toward the bottom of the layout viewport while #root, sized to
// --vvh, ends at 508 — so the bottom of the window lands past the app. NOTE WHICH BAND MOVES:
// panning down keeps the COMPOSER in view (it is at the bottom of #root) and pushes the
// TOPBAR out. An earlier draft asserted the composer went out of view and went red for that
// reason; the check was wrong, not the app.
ok('geo', 'panned window lands BELOW #root — the "bare canvas" case is real',
   panned.canvasExposedPx > 0,
   `${panned.canvasExposedPx}px of window below #root (window ${panned.winTop}..${panned.winBottom}, #root ends ${panned.rootBottom})`)
ok('geo', 'and the app content panned out of the window is the TOP band, not the bottom one',
   !panned.topbarVisible && panned.composerVisible,
   `topbar ${panned.topbarTop}..${panned.topbarBottom} visible=${panned.topbarVisible}, composer visible=${panned.composerVisible}, window ${panned.winTop}..${panned.winBottom}`)

// ── [geo] 3. AT REST the app and the visible window are the SAME BOX ────────────────────
// This is the part that reframes the whole question. With --vvh applied, #root occupies
// layout 0..508 and the visible window at offsetTop 0 is 0..508 — identical. So there is
// nothing off-screen for the browser to reveal, and every pan measured here had to be
// USER-INITIATED. That does not prove iOS never pans; it does mean the app is not handing it
// a reason to.
await panTop()
const rest = await ev(MEASURE)
ok('geo', 'at rest the visible window and #root are the same box (nothing to reveal)',
   rest.offTop === 0 && rest.rootTop === rest.winTop && rest.rootBottom === rest.winBottom,
   `window ${rest.winTop}..${rest.winBottom}, #root ${rest.rootTop}..${rest.rootBottom}`)

// ── [geo] 4. THE QUESTION: what does `position: fixed; inset: 0` actually do? ───────────
// TWO DIFFERENT RULES, and conflating them is how this stayed open. Applied WITHOUT reloading
// so nothing but the rule changes.
//
//   (a) `position: fixed; inset: 0` LITERALLY — no height, so the shell is sized by the
//       insets to the LAYOUT viewport (844). Canvas exposure goes away because there is no
//       longer any canvas: the shell covers all of it.
//   (b) `position: fixed; inset: 0; height: var(--vvh)` — what anyone keeping the --vvh fix
//       would write. Over-constrained, so height wins and the shell is 508 again.
const variant = async (cls) => {
  await ev(`document.getElementById('root').className = ${JSON.stringify(cls)}`)
  await wait(200)
  await panDown()
  const m = await ev(MEASURE)
  await panTop()
  return m
}
const vUnfixed = await variant('')
const vLiteral = await variant('fixed-literal')
const vWithVvh = await variant('fixed-vvh')
const row = (n, m) => `  ${n.padEnd(26)} position ${m.position.padEnd(8)} rootH ${String(m.rootH).padEnd(4)} canvasExposed ${String(m.canvasExposedPx).padEnd(4)} composerBottom ${String(m.composerBottom).padEnd(4)} composerVisible ${m.composerVisible}`
console.log('\n  PANNED TO THE BOTTOM, one row per rule:')
console.log(row('unfixed (today)', vUnfixed))
console.log(row('fixed; inset:0 (literal)', vLiteral))
console.log(row('fixed; inset:0; h:--vvh', vWithVvh))
console.log('')

ok('geo', 'the fixed rules took effect at all',
   vLiteral.position === 'fixed' && vWithVvh.position === 'fixed' && vUnfixed.position === 'static',
   `${vUnfixed.position} / ${vLiteral.position} / ${vWithVvh.position}`)
ok('geo', 'keeping --vvh: `position: fixed` changes NOTHING about the pan',
   vWithVvh.canvasExposedPx === vUnfixed.canvasExposedPx && vWithVvh.composerBottom === vUnfixed.composerBottom,
   `identical to unfixed (canvasExposed ${vWithVvh.canvasExposedPx}px both) — fixed positions against the LAYOUT viewport, which is the very box the visual viewport pans inside, so it cannot escape a pan`)
ok('geo', 'literal `inset:0` removes the canvas — BY DISCARDING --vvh, not by stopping the pan',
   vLiteral.canvasExposedPx === 0 && vLiteral.rootH === LAYOUT_H && vLiteral.composerBottom > VISIBLE_H,
   `shell grows back to ${vLiteral.rootH}px and the composer returns to ${vLiteral.composerBottom} — under the keyboard, the exact defect --vvh was added to fix`)

// ── [geo] 5. prove the measurement discriminates ───────────────────────────────────────
// A check that can only ever print one answer is the `[hole]` ask-card-height-probe already
// carries. canvasExposedPx and topbarVisible both flip with the pan, and canvasExposedPx also
// differs BETWEEN rules above — so "identical fixed and unfixed" is a measured equality, not
// a measurement that cannot tell them apart.
await ev(`document.getElementById('root').className = ''`)
await panTop()
const unpanned = await ev(MEASURE)
ok('geo', 'CONTROL: un-panning flips the measures back (they are not constants)',
   unpanned.offTop === 0 && unpanned.topbarVisible && unpanned.canvasExposedPx === 0,
   `offTop ${unpanned.offTop}, topbarVisible ${unpanned.topbarVisible}, canvasExposed ${unpanned.canvasExposedPx}px`)
ok('geo', 'CONTROL: the same measure DOES separate the two fixed rules',
   vLiteral.canvasExposedPx !== vUnfixed.canvasExposedPx,
   `literal ${vLiteral.canvasExposedPx}px vs unfixed ${vUnfixed.canvasExposedPx}px`)

// ── [trigger] 6. does the browser pan BY ITSELF to reveal a focused input? ──────────────
// The closest reachable analogue to iOS's keyboard auto-pan. It needs a configuration where
// the input is genuinely OUTSIDE the visible window, which the --vvh layout never produces
// (check 3) — so set --vvh back to the full layout height, i.e. the PRE-FIX shell, pan to the
// top so the composer at 788..844 is off-window, and focus its input.
await ev(`document.documentElement.style.setProperty('--vvh', '${LAYOUT_H}px')`)
await wait(200)
await panTop()
const beforeFocus = await ev(MEASURE)
await ev(`document.getElementById('inp').focus()`)
await wait(800)
const afterFocus = await ev(MEASURE)
ok('trigger', 'pre-fix shell: the composer really is outside the visible window first',
   !beforeFocus.composerVisible,
   `composer ${beforeFocus.composerTop}..${beforeFocus.composerBottom}, window ${beforeFocus.winTop}..${beforeFocus.winBottom}`)
const autoPanned = afterFocus.offTop !== beforeFocus.offTop || afterFocus.composerVisible
ok('trigger', 'browser auto-pans the VISUAL viewport to reveal a focused input', autoPanned,
   `offTop ${beforeFocus.offTop} → ${afterFocus.offTop}; composerVisible ${beforeFocus.composerVisible} → ${afterFocus.composerVisible}; scrollY ${afterFocus.scrollY}` +
   (autoPanned ? '' : ' — NOT reproducible headlessly; the TRIGGER stays device-only even though the geometry above is settled'))

await send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
console.log(`\n${failed ? '❌' : '✅'} ${passed} passed, ${failed} failed`)
cdpDone = true; reap()
process.exit(failed ? 1 : 0)
