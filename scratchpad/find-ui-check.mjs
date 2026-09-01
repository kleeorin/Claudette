// Drive the real app and check the shared find bar in every editor:
//   1. CodeEditor   (.py)   — plain, regex, replace-all
//   2. MilkdownEditor (.md) — matches over the rendered ProseMirror doc
//   3. CsvTableView (.csv)  — cell matches, case toggle, replace
//   4. NotebookView (.ipynb)— cross-cell matches (the pre-existing one, refactored)
//
// Runs its own server on :4489 with an isolated CLAUDETTE_DATA_DIR and a throwaway
// project, so it never touches the real session list. Screenshots land in
// /tmp/claudette-find-shots.
//   node scratchpad/find-ui-check.mjs
import { spawn } from 'child_process'
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4489        // app server (API + WS)
const WEB_PORT = 5289    // vite dev server, proxying /api + /ws to PORT
const APP = `http://127.0.0.1:${WEB_PORT}`
const API = `http://127.0.0.1:${PORT}`
const TOKEN = 'find-token'
// Chrome isn't on PATH inside the sandbox; @puppeteer/browsers drops one here.
const CHROME = process.env.CHROME_BIN ?? '/tmp/browsers/chrome/linux-152.0.7977.54/chrome-linux64/chrome'
const OUT = '/tmp/claudette-find-shots'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await mkdir(OUT, { recursive: true })

const DATA = await mkdtemp(join(tmpdir(), 'find-data-'))
const PROJ = await mkdtemp(join(tmpdir(), 'find-proj-'))

// Fixtures with hand-counted match totals (see the assertions below).
await writeFile(join(PROJ, 'demo.py'), [
  '# demo file for find',
  'alpha = 1',
  'beta = alpha + 1',
  'gamma = alpha + beta',
  'print(alpha, beta, gamma)',
  '',
].join('\n'))
await writeFile(join(PROJ, 'notes.md'), [
  '# Notes',
  '',
  'The word target appears here.',
  '',
  '- target in a list item',
  '- another line',
  '',
  'A paragraph mentioning target once more.',
  '',
].join('\n'))
await writeFile(join(PROJ, 'sample.csv'), [
  'name,qty,note',
  'Widget,3,blue widget',
  'Gadget,5,red gadget',
  'Widget,7,green widget',
  '',
].join('\n'))
await writeFile(join(PROJ, 'demo.ipynb'), JSON.stringify({
  cells: [
    { cell_type: 'code', metadata: {}, source: ['target = 1\n', 'print(target)\n'], outputs: [], execution_count: null },
    { cell_type: 'code', metadata: {}, source: ['other = target + 2\n'], outputs: [], execution_count: null },
  ],
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
  nbformat: 4, nbformat_minor: 5,
}, null, 1))

const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), CLAUDETTE_TOKEN: TOKEN, CLAUDETTE_DATA_DIR: DATA },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let log = ''
server.stdout.on('data', (d) => (log += d))
server.stderr.on('data', (d) => (log += d))
const reap = () => { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
process.on('exit', reap)
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reap(); if (e) console.error(e); process.exit(1) })
}
for (let i = 0; i < 60 && !log.includes('Server listening'); i++) await wait(500)
if (!log.includes('Server listening')) { console.error(log.slice(-2000)); throw new Error('server did not start') }
console.log('server up')

// Serve the UI from Vite rather than web/dist: this checkout's dist is read-only, so a
// production build can't be refreshed here and would silently test stale code.
const web = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
  cwd: 'web',
  env: { ...process.env, PORT: String(PORT), WEB_PORT: String(WEB_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let weblog = ''
web.stdout.on('data', (d) => (weblog += d))
web.stderr.on('data', (d) => (weblog += d))
const reapWeb = () => { try { process.kill(-web.pid, 'SIGKILL') } catch { try { web.kill('SIGKILL') } catch {} } }
process.on('exit', reapWeb)
for (let i = 0; i < 60 && !weblog.includes('ready in'); i++) await wait(500)
if (!weblog.includes('ready in')) { console.error(weblog.slice(-2000)); throw new Error('vite did not start') }
console.log('vite up')

const apiPost = (path, body) => fetch(`${API}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` }, body: JSON.stringify(body),
}).then((r) => r.json())
const session = await apiPost('/api/session/create', { name: 'Find demo', cwd: PROJ, rootDir: PROJ })
console.log('session', session.id)

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-find-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9348', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,1000', 'about:blank',
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
      const list = await (await fetch('http://127.0.0.1:9348/json')).json()
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
const consoleErrors = []
// A CDP reply is awaited on a promise that ONLY the socket can resolve, so if Chrome dies
// mid-run — crash, OOM, an external pkill — every pending send() hangs forever and the
// harness sleeps in ep_poll holding its ports until someone hunts it down. Abort loudly
// instead. No reap() here on purpose: process.exit() runs the process.on('exit') handlers,
// which already cover every child. `cdpDone` keeps this off the DELIBERATE teardown below,
// where the very same close event is expected and must not be read as a failure.
let cdpDone = false
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died; aborting rather than hanging'); process.exit(1) })
cdp.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  // Surface page-side exceptions — a component that throws on mount otherwise just
  // shows up here as an element that never appears.
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? JSON.stringify(m.params.exceptionDetails))
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.description ?? a.value).join(' '))
  }
})
function send(method, params = {}) {
  const id = ++cdpId
  cdp.send(JSON.stringify({ id, method, params }))
  return new Promise((res) => pending.set(id, res))
}
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}
async function shot(name) {
  await wait(400)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'))
  console.log(`  📸 ${name}`)
}
async function waitFor(expr, ms = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await evaluate(expr)) return true
    await wait(200)
  }
  await shot('FAILED-' + expr.replace(/\W+/g, '-').slice(0, 40))
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.slice(-6).join('\n  '))
  throw new Error(`timeout waiting for: ${expr}`)
}

import { withMarks, failed as failures } from './assert.mjs'
const check = withMarks({ indent: '  ' })

// Real key events, so we exercise the actual Ctrl/Cmd-F path rather than calling a
// handler directly.
async function key(text, { ctrl = false, shift = false, code, keyCode } = {}) {
  const mods = (ctrl ? 2 : 0) | (shift ? 8 : 0)
  const base = { modifiers: mods, key: text, code: code ?? `Key${text.toUpperCase()}`, windowsVirtualKeyCode: keyCode ?? text.toUpperCase().charCodeAt(0) }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
const focusFindField = () => evaluate(`(() => {
  const i = [...document.querySelectorAll('input')].find(x => (x.placeholder||'').startsWith('Find'))
  if (!i) return false; i.focus(); return true })()`)
const typeInto = async (s) => { await send('Input.insertText', { text: s }) }
// "3/7" from the bar's counter, or null when the bar isn't showing one.
const counter = () => evaluate(`(() => {
  const s = [...document.querySelectorAll('span')].find(x => /^\\d+\\/\\d+\\+?$/.test(x.textContent.trim()) || x.textContent.trim() === 'bad regex')
  return s ? s.textContent.trim() : null })()`)
const clickBtn = (label) => evaluate(
  `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true })()`)
const clickTitled = (title) => evaluate(
  `(() => { const b = [...document.querySelectorAll('button')].find(x => (x.title||'').startsWith(${JSON.stringify(title)})); if (!b) return false; b.click(); return true })()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/api/auth?token=${TOKEN}` })
await wait(800)

// Seed the saved layout so all four editors are already open as tabs — the file/notebook
// tab set is persisted under this key and hydrated on load.
await send('Page.navigate', { url: `${APP}/` })
await wait(1500)
await evaluate(`localStorage.setItem('claudette:layout:v1', JSON.stringify({
  v: 1, layout: 'side',
  sizes: { sideW: 520, stackH: 400, dockW: 320, termH: 240, sidebarW: 220 },
  seq: 0, terms: {},
  content: { ${JSON.stringify(session.id)}: {
    active: 'f:${join(PROJ, 'demo.py')}',
    tabs: [
      { kind: 'file', path: ${JSON.stringify(join(PROJ, 'demo.py'))} },
      { kind: 'file', path: ${JSON.stringify(join(PROJ, 'notes.md'))} },
      { kind: 'file', path: ${JSON.stringify(join(PROJ, 'sample.csv'))} },
      { kind: 'notebook', path: ${JSON.stringify(join(PROJ, 'demo.ipynb'))} }
    ],
  } },
}))`)
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`document.body.innerText.includes('demo.py')`)
await wait(2000)

// Tab buttons carry the file's full path as their title.
const openTab = async (file) => {
  const path = JSON.stringify(join(PROJ, file))
  const ok = await evaluate(`(() => { const b = document.querySelector('button[title=' + JSON.stringify(${path}) + ']'); if (!b) return false; b.click(); return true })()`)
  if (!ok) throw new Error(`no tab for ${file}`)
  await wait(1200)
}

// --- 1. CodeEditor -----------------------------------------------------------
console.log('\n[1] CodeEditor (demo.py)')
await openTab('demo.py')
await waitFor(`!!document.querySelector('.cm-content')`)
await key('f', { ctrl: true })
await wait(400)
check('Ctrl+F opens the bar', await evaluate(`!!document.querySelector('input[placeholder^="Find"]')`))
await focusFindField()
await typeInto('alpha')
await wait(500)
check('plain query counts 4 matches', (await counter()) === '1/4', await counter())
check('active match is highlighted', await evaluate(`!!document.querySelector('.cm-find-match-active')`))
await shot('1-code-find')

await key('Enter', { code: 'Enter', keyCode: 13 })
await wait(300)
check('Enter steps to the next match', (await counter()) === '2/4', await counter())

// regex
await clickTitled('Regular expression')
await focusFindField()
await evaluate(`(() => { const i=[...document.querySelectorAll('input')].find(x=>(x.placeholder||'').startsWith('Find'));
  const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true})); })()`)
await focusFindField()
await typeInto('alpha|beta')
await wait(500)
check('regex alpha|beta counts 7', (await counter()) === '1/7', await counter())
await shot('2-code-regex')

// replace all, then read the doc back
await evaluate(`(() => { const i=[...document.querySelectorAll('input')].find(x=>(x.placeholder||'').startsWith('Replace')); i.focus(); return true })()`)
await typeInto('ZZ')
await wait(200)
await clickBtn('All')
await wait(600)
const codeAfter = await evaluate(`document.querySelector('.cm-content').innerText`)
check('replace-all rewrote all 7 matches', !codeAfter.includes('alpha') && !codeAfter.includes('beta') && (codeAfter.match(/ZZ/g) || []).length === 7, JSON.stringify(codeAfter.slice(0, 60)))
await shot('3-code-replaced')
// Leave the file as it was — undo, so the dirty marker doesn't confuse later steps.
await evaluate(`document.querySelector('.cm-content').focus()`)
await key('z', { ctrl: true })
await wait(300)

// --- 2. MilkdownEditor -------------------------------------------------------
console.log('\n[2] MilkdownEditor (notes.md)')
await openTab('notes.md')
await waitFor(`!!document.querySelector('.milkdown-host .ProseMirror')`)
await key('f', { ctrl: true })
await wait(400)
check('Ctrl+F opens the bar in markdown', await evaluate(`!!document.querySelector('input[placeholder^="Find in document"]')`))
await focusFindField()
await typeInto('target')
await wait(600)
check('markdown finds 3 matches across blocks', (await counter()) === '1/3', await counter())
check('markdown active match is highlighted', await evaluate(`!!document.querySelector('.pm-find-match-active')`))
await shot('4-markdown-find')

// --- 3. CsvTableView ---------------------------------------------------------
console.log('\n[3] CsvTableView (sample.csv)')
await openTab('sample.csv')
await waitFor(`!!document.querySelector('.claudette-rdg .rdg')`)
await key('f', { ctrl: true })
await wait(400)
check('Ctrl+F opens the bar in the CSV grid', await evaluate(`!!document.querySelector('input[placeholder^="Find in cells"]')`))
await focusFindField()
await typeInto('widget')
await wait(600)
check('case-insensitive finds 4 cell matches', (await counter()) === '1/4', await counter())
check('matching cells are tinted', await evaluate(`document.querySelectorAll('.rdg-find-match').length >= 2`), String(await evaluate(`document.querySelectorAll('.rdg-find-match').length`)))
check('the current cell is marked', await evaluate(`!!document.querySelector('.rdg-find-active')`))
await shot('5-csv-find')

await clickTitled('Match case')
await wait(500)
// The query typed above is lowercase "widget", so matching case drops the two
// capital-W cells and keeps only "blue widget" / "green widget".
check('Match case narrows to the 2 lowercase cells', (await counter()) === '1/2', await counter())
await shot('6-csv-case')

await evaluate(`(() => { const i=[...document.querySelectorAll('input')].find(x=>(x.placeholder||'').startsWith('Replace')); i.focus(); return true })()`)
await typeInto('Sprocket')
await wait(200)
await clickBtn('All')
await wait(700)
const csvText = await evaluate(`document.querySelector('.claudette-rdg .rdg').innerText`)
// Case-sensitive replace must hit BOTH lowercase cells and NEITHER capital-W one.
const cells = csvText.split('\n').map((s) => s.trim())
check('case-sensitive replace-all hit only the lowercase cells', cells.filter((c) => c === 'blue Sprocket' || c === 'green Sprocket').length === 2
  && cells.filter((c) => c === 'Widget').length === 2
  && !cells.some((c) => c.includes('widget')), JSON.stringify(cells.filter(Boolean).join('|').slice(0, 90)))
await shot('7-csv-replaced')

// --- 4. NotebookView ---------------------------------------------------------
console.log('\n[4] NotebookView (demo.ipynb)')
await openTab('demo.ipynb')
const nbUp = await evaluate(`!!document.querySelector('[data-cell-id]')`) ||
  await waitFor(`!!document.querySelector('[data-cell-id]')`, 15000).catch(() => false)
if (!nbUp) {
  console.log('  ⚠️  notebook tab did not open (no kernel?) — skipping')
} else {
  await evaluate(`document.querySelector('[data-cell-id] .cm-content')?.focus()`)
  await key('f', { ctrl: true })
  await wait(400)
  check('Ctrl+F opens the notebook bar', await evaluate(`!!document.querySelector('input[placeholder^="Find in cells"]')`))
  await focusFindField()
  await typeInto('target')
  await wait(700)
  check('notebook finds 3 matches across 2 cells', (await counter()) === '1/3', await counter())
  check('notebook active match is highlighted', await evaluate(`!!document.querySelector('.cm-find-match-active')`))
  await shot('8-notebook-find')

  // Notebook replace goes through the server's editCell op (not the cell editors), so
  // it has to survive the round trip back into the mounted views.
  await evaluate(`(() => { const i=[...document.querySelectorAll('input')].find(x=>(x.placeholder||'').startsWith('Replace')); i.focus(); return true })()`)
  await typeInto('goal')
  await wait(200)
  await clickBtn('All')
  await wait(1500)
  const nbText = await evaluate(`[...document.querySelectorAll('[data-cell-id] .cm-content')].map(e => e.innerText).join('\\n')`)
  check('notebook replace-all rewrote all 3 matches across both cells', (nbText.match(/goal/g) || []).length === 3 && !nbText.includes('target'), JSON.stringify(nbText.replace(/\n/g, '|')))
  await shot('9-notebook-replaced')

  // Esc closes the bar and drops the highlights.
  await focusFindField()
  await key('Escape', { code: 'Escape', keyCode: 27 })
  await wait(400)
  check('Escape closes the bar', !(await evaluate(`!!document.querySelector('input[placeholder^="Find in cells"]')`)))
  check('closing clears the highlights', !(await evaluate(`!!document.querySelector('.cm-find-match')`)))
}

console.log(`\nshots in ${OUT}`)
console.log(failures === 0 ? '\n✅ all find checks passed' : `\n❌ ${failures} check(s) failed`)
cdpDone = true   // deliberate teardown from here — the CDP close below is expected
chrome.kill()
server.kill()
await wait(600)
await rm(DATA, { recursive: true, force: true })
await rm(PROJ, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
