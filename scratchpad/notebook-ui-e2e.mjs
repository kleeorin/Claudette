// Full-stack notebook UI E2E via Chrome DevTools Protocol (no puppeteer). Drives
// the REAL built SPA: open a notebook, type into a cell, run it, read the output —
// exercising web ↔ WS ↔ server ↔ kernel. Run:
//   npx tsx scratchpad/notebook-ui-e2e.mjs   (or: node scratchpad/notebook-ui-e2e.mjs)
import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4331
const APP = `http://127.0.0.1:${PORT}`
import { check as ok, failed } from './assert.mjs'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const nbDir = await mkdtemp(join(tmpdir(), 'nbui-'))
const nbPath = join(nbDir, 'ui.ipynb')

// --- start the built server (single-origin, loopback = no auth) ---------------
// ISOLATE THE DATA DIR. These were the only two Chrome harnesses that did not, so they
// booted against the operator's REAL ~/.config/claudette — restore() then relaunches every
// persisted session, spawning a `claude` process per entry before app.listen() is reached.
// The server therefore took a long time to bind (or failed outright), the health-check loop
// was satisfied by whatever else answered on this fixed port, and Chrome ended up talking to
// a stranger's server that required a token — surfacing as a missing tab. Every other Chrome
// test already does this (clear-race, find-ui-check, layout-check).
const dataDir = await mkdtemp(join(tmpdir(), 'e2e-data-'))
const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  // CLAUDETTE_NO_AUTH: the server otherwise mints a file token and REQUIRES it
  // (resolveAuth: loopback + no CLAUDETTE_TOKEN + no opt-out ⇒ required), and this harness
  // never authenticates the browser — so the SPA rendered the "Access token required"
  // AuthGate and no app chrome ever appeared. The failure surfaced as a missing tab, which
  // reads like selector rot; it was an unauthenticated page. Same opt-out clear-race-test
  // and doubling-agents-test already use. NB `...process.env` is inherited, so this also
  // pins the behaviour regardless of what the parent shell happens to export.
  // …and CLAUDETTE_TOKEN must be DELETED, not merely overridden. resolveAuth checks the
  // token FIRST — `if (token) return { required: true, token }` — and only consults
  // CLAUDETTE_NO_AUTH *after*. So spreading ...process.env while a token is present makes
  // the NO_AUTH opt-out INERT: the server still requires auth, the SPA renders AuthGate,
  // and every selector lookup fails on a login screen. That is why run-suite.sh:67 uses
  // `env -u CLAUDETTE_TOKEN` for the shared server and auth-loopback-test.mjs deletes both.
  env: (() => { const e = { ...process.env, CLAUDETTE_NO_AUTH: '1', CLAUDETTE_DATA_DIR: dataDir, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production' }
                delete e.CLAUDETTE_TOKEN; return e })(),
  cwd: process.cwd(), stdio: 'pipe', detached: true,
})
// PROVE WE OWN THE SERVER, rather than assuming a 200 means it is ours.
//
// `fetch(APP + '/api/health')` is satisfied by ANY server on this fixed port. When this
// harness's own child failed to bind (EADDRINUSE) or never reached app.listen(), the poll
// was answered by a STRANGER — Chrome then loaded that server's page, which required a
// token, so the SPA rendered AuthGate, no tabs existed, and every selector lookup failed
// with `undefined.click`. The test reported a missing tab; the truth was that its server
// was never up. A harness that cannot tell its own server from someone else's cannot
// report a startup failure at all.
//
// So: wait for OUR CHILD's own ready line, and fail loudly with its output if it exits or
// never prints one. Same family as auth-loopback connecting to its own orphan.
let ownLog = ''
server.stdout.on('data', (d) => { ownLog += d })
server.stderr.on('data', (d) => { ownLog += d })
let exited = null
server.on('exit', (c) => { exited = c })
let owned = false
for (let i = 0; i < 80; i++) {
  if (/Claudette server ready/.test(ownLog)) { owned = true; break }
  if (exited !== null) break
  await wait(250)
}
if (!owned) {
  console.error(`--- spawned server never reported ready (exit=${exited}) ---`)
  console.error(ownLog.slice(-2000) || '(no output captured)')
  throw new Error(exited !== null
    ? `server exited with ${exited} before listening — see output above`
    : 'server never printed its ready line; a 200 on /api/health would have been a STRANGER')
}

// --- launch headless chrome ---------------------------------------------------
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-'))
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', 'about:blank',
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
// …AND the server. This file reaped only Chrome on the signal/exit paths and killed the
// server ONLY on the happy path, so every failing run orphaned a detached server on this
// file's fixed port. Observed live: a listener still holding :4331 hours later. The next
// run then dies with EADDRINUSE and reports "server exited before listening" — a second,
// unrelated-looking symptom for the first failure, and it poisons anyone else's suite run
// that touches this port. Same fix as terminal-ui-e2e.mjs; negative pid because `detached`
// gives npx its own group and killing npx alone leaves the grandchild holding the port.
const reapServer = () => { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
process.on('exit', () => { reapChrome(); reapServer() })
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapChrome(); reapServer(); if (e) console.error(e); process.exit(1) })
}


async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9333/json')).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await wait(250)
  }
  throw new Error('no CDP target')
}

const wsUrl = await cdpTarget()
const cdp = new WebSocket(wsUrl)
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
cdp.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
function send(method, params = {}) {
  const id = ++cdpId
  cdp.send(JSON.stringify({ id, method, params }))
  return new Promise((res) => pending.set(id, res))
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
// Collect uncaught page errors.
const consoleErrors = []
cdp.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(m.params?.exceptionDetails?.exception?.description ?? m.params))
})

// A SESSION FIRST. Two reasons, and the second is the one that bit terminal-ui-e2e:
// the Files dock opens its tree at the ACTIVE SESSION's cwd (`termCwd` in App.tsx), so
// without a session it starts in $HOME and this test would create its notebook in the
// operator's home directory. And more generally, driving this shell without a session is
// how terminal-ui-e2e came to look like a broken attach path — a missing precondition
// presents as a dead selector. Point it at the throwaway nbDir instead.
await fetch(`${APP}/api/session/create`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Notebook e2e', cwd: nbDir, rootDir: nbDir, sandbox: { enabled: false, mounts: [] } }),
}).then((r) => r.json())

await send('Page.navigate', { url: APP })
// Wait for the shell.
for (let i = 0; i < 40; i++) {
  const ready = await evaluate(`!!document.querySelector('main') && document.body.innerText.includes('Files')`)
  if (ready) break
  await wait(250)
}
ok('app shell rendered', await evaluate(`document.body.innerText.includes('Files')`))

// --- create a notebook through the Files dock --------------------------------
// The old single click on a tab-strip "+ notebook" button is GONE, and this is genuine
// rot, not a missing precondition: `FileManager.tsx:23` records that "the old modal file
// picker and the tab-strip '+ notebook' are retired in favour of this", and the string
// exists nowhere in web/src except that comment. The flow is now three steps —
// Files dock → "+ New ▾" → "Notebook" → name it and press Enter.
//
// ★ MATCHED BY TEXT ALONE, NOT BY THE ICON, AND THAT IS THE POINT (fixed 2026-08-28).
// This asserted `textContent.trim() === '📓 Notebook'`. Commit 9df0744 replaced the emoji
// with a drawn <FileIcon kind="notebook" /> — an SVG, which contributes NO text — so the
// button's text became plain "Notebook" and the exact-equality match could never hold
// again. Nothing about the feature changed; the harness was asserting a glyph the product
// had deliberately stopped rendering.
// It went unnoticed because this file needs jupyter_server, which was unavailable on this
// machine until 2026-08-28 — so it SKIPped for the whole life of the change that broke it.
// A test that cannot run is a test that cannot tell you it has gone stale.
// Matching on the label rather than the decoration also makes this survive the next icon
// change, which is the one thing about a files dock you can be sure will happen again.
// EXACT text match, not `includes`. A substring match silently hit the sidebar's
// "+ New session" button — it contains "+ New" and comes earlier in the DOM — which opened
// the New Session dialog instead of the dock's "+ New ▾" menu. And because the helper
// returned "true, I clicked something", the assertion went GREEN while the flow was already
// off the rails; the failure only surfaced two steps later as a missing Notebook item.
// A click helper that reports success for clicking the WRONG thing is the same class of
// lie as a selector that has rotted.
const clickExact = async (label) => evaluate(
  `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)});
            if (!b) return false; b.click(); return true })()`)

// …and assert on the STATE each click was supposed to produce, not on the click landing.
ok('Files dock opened', await clickExact('Files'))
await wait(400)
ok('Files dock actually rendered (not just a click that landed somewhere)', await evaluate(`!!document.querySelector('input[placeholder="Filter…"], button[title="Add to this folder"]')`))
ok('"+ New ▾" menu opened', await clickExact('+ New ▾'))
await wait(200)
ok('the add-menu is open and offers a Notebook item', await evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Notebook')`))
ok('"Notebook" chosen', await clickExact('Notebook'))
await wait(200)
ok('the name input appeared', await evaluate(`!!document.querySelector('input[placeholder="name.ipynb"]')`))
// The name input is React-controlled, so set it through the native setter and fire `input`;
// assigning .value alone leaves React's state untouched and submitCreate() reads ''.
await evaluate(`(() => {
  const input = document.querySelector('input[placeholder="name.ipynb"]');
  if (!input) return false;
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(input, 'ui.ipynb');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true })()`)
await wait(100)
// Enter submits (FileManager's onKeyDown); there is no separate confirm button.
// Dispatched through CDP rather than as a synthetic KeyboardEvent: React attaches its
// listener at the root and a hand-built event does reach it, but it carries no key text and
// several handlers in this app read `e.key` off a trusted event. A real key press is what a
// user does and is what this harness is for.
// PRECONDITION, ASSERTED. Ungated, and the input is CONDITIONAL — FileManager only renders
// this placeholder while `creating === 'notebook'` (web/src/components/FileManager.tsx), so it
// exists only if the "Notebook" menu click above actually landed. If that first step fails,
// this line throws inside the page, Enter goes nowhere, no notebook is created, and the red
// surfaces on whatever asserts the notebook exists — naming step two after step one's failure.
// Verified 2026-08-25: the placeholder does render with that exact text, so this is fragility,
// not breakage.
const nameInputReady = await evaluate(`(() => {
  const i = document.querySelector('input[placeholder="name.ipynb"]')
  if (!i) return false
  i.focus(); return true
})()`)
ok('PRECONDITION: the notebook-name input is open and focused', nameInputReady)
await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', text: '\r' })
await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter' })
await wait(600)
// Surface a server-side refusal instead of letting it read as "the view never rendered".
const createErr = await evaluate(`(document.body.innerText.match(/(cannot|failed|already exists)[^\\n]*/i) || [])[0] || ''`)
if (createErr) console.log('   (create reported: ' + createErr + ')')
await wait(800)
ok('the notebook was created and is listed in the Files dock', await evaluate(`document.body.innerText.includes('ui.ipynb')`))

// OPEN IT WITH A DOUBLE-CLICK. Creating a notebook does NOT open a content tab — the row
// that appears is a FILE-BROWSER ROW, not a tab (its class is the dock's list-row class and
// `main` still shows the Chat pane). And a file row opens on DOUBLE-click, which
// FileManager.tsx states in its own row `title`: "Double-click to open · right-click for
// actions". A single click selects and does nothing visible, so the old harness's one click
// left the editor unmounted and the failure surfaced far downstream as a null `.cm-content`.
// Verified both ways here: single click → cm-editor false; dblclick → cm-editor true.
await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('ui.ipynb'));
  if (!b) return false;
  b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
  return true })()`)

// Wait for the NotebookView (a CodeMirror editor) to render.
let cmReady = false
for (let i = 0; i < 40; i++) {
  cmReady = await evaluate(`!!document.querySelector('.cm-content')`)
  if (cmReady) break
  await wait(250)
}
ok('notebook view rendered with a cell editor', cmReady)

// --- type into the first cell and run it --------------------------------------
await evaluate(`document.querySelector('.cm-content').focus()`)
await wait(100)
await send('Input.insertText', { text: 'print(6 * 7)' })
await wait(700)  // let the 500ms commit debounce fire (editCell → server)

// Ctrl+Enter to run in place (Mod-Enter).
for (const type of ['keyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2 })
}

// Poll the output DOM for "42".
let got42 = false
for (let i = 0; i < 60; i++) {
  got42 = await evaluate(`document.body.innerText.includes('42')`)
  if (got42) break
  await wait(500)
}
ok('cell ran through the UI and output 42 appeared', got42)

// Kernel status in the notebook header. This looked for `[title="kernel: idle"]`, an
// attribute nothing in web/src renders — NotebookView surfaces the status as a coloured dot
// plus a STATUS_LABEL span inside the "Choose kernel" button (web/src/lib/kernelStatus.ts:
// none/idle/busy/starting…/dead). So the check could not pass however healthy the kernel
// was, and it went unnoticed for the same reason as the emoji above: this file needs
// jupyter_server, which was unavailable here until 2026-08-28, so it SKIPped throughout.
//
// Scoped to the notebook HEADER rather than the whole page, and asserted against the labels
// that mean a kernel is actually up. A bare innerText search for "idle" would also match the
// sessions sidebar, which renders that word for every idle session — it would have passed
// with no kernel at all, which is worse than the red it replaces.
ok('kernel status surfaced in the notebook header', await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.title === 'Choose kernel')
  if (!btn) return false
  const t = btn.textContent || ''
  return t.includes('idle') || t.includes('busy') || t.includes('starting')
})()`))

ok(`no uncaught page errors${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''}`, consoleErrors.length === 0)

// --- teardown -----------------------------------------------------------------
cdpDone = true   // deliberate teardown from here — the CDP close below is expected
cdp.close(); chrome.kill(); try { process.kill(-server.pid, 'SIGKILL') } catch { server.kill() }
await rm(nbDir, { recursive: true, force: true }).catch(() => {})
await rm(chromeDir, { recursive: true, force: true }).catch(() => {})
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
