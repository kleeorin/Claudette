// Full-stack terminal E2E via Chrome DevTools Protocol. Drives the REAL built SPA:
// open the Terminal tab, type a command, read its output from the xterm buffer —
// exercising web(xterm) ↔ WS ↔ server(node-pty). Run:
//   node scratchpad/terminal-ui-e2e.mjs
import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4332
const APP = `http://127.0.0.1:${PORT}`
import { check as ok, failed } from './assert.mjs'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ISOLATE THE DATA DIR. These were the only two Chrome harnesses that did not, so they
// booted against the operator's REAL ~/.config/claudette — restore() then relaunches every
// persisted session, spawning a `claude` process per entry before app.listen() is reached.
// The server therefore took a long time to bind (or failed outright), the health-check loop
// was satisfied by whatever else answered on this fixed port, and Chrome ended up talking to
// a stranger's server that required a token — surfacing as a missing tab. Every other Chrome
// test already does this (clear-race, find-ui-check, layout-check).
const dataDir = await mkdtemp(join(tmpdir(), 'e2e-data-'))
const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  // CLAUDETTE_NO_AUTH: this harness never authenticates the browser, and resolveAuth
  // (loopback + no CLAUDETTE_TOKEN + no opt-out) MINTS a file token and requires it — so
  // the SPA rendered its "Access token required" AuthGate and no app chrome ever appeared.
  // AuthGate gates on checkAuth(), which is a fetch of /api/session/list treated as gated
  // on 401. The failure surfaced as a missing tab, which reads like selector rot; it was an
  // unauthenticated page. Same opt-out clear-race-test and doubling-agents-test use.
  // RESOLVED: the 401 that persisted after this opt-out was NOT an auth bug at all — an
  // orphaned Claudette server was squatting this fixed port, so the spawned server died
  // EADDRINUSE and the harness's /api/health poll was answered by the squatter, whose page
  // was token-gated. Verified by running this file on a free port: the shell renders and
  // this assertion passes. The env settings below are still required (they are correct in
  // their own right); the port ownership check above is what makes the failure legible.
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
server.stderr.on('data', () => {})
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

// CREATE A SESSION BEFORE DRIVING THE UI. This was the whole bug, and it did not look like
// one: `toggleTerm` (App.tsx:401) opens with `if (!activeId) return`, so with no session the
// Terminal button is present, enabled, clickable — and INERT. The click landed, threw
// nothing, created no pty, and the next assertion waited 10s for an `.xterm-rows` that was
// never going to exist. It read as "the terminal attach path is broken"; the truth was that
// the test never established the precondition the toggle requires. Verified: with no
// session, /api/pane/list stays [] after the click and the page reports zero errors.
//
// `sandbox.enabled: false` deliberately — this test is about xterm ↔ WS ↔ node-pty, so the
// pane should be a plain host shell. A confined session's pane would additionally depend on
// bwrap and on sessionConfinement's resolution, which is a different test's job.
const session = await fetch(`${APP}/api/session/create`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Terminal e2e', cwd: process.cwd(), rootDir: process.cwd(), sandbox: { enabled: false, mounts: [] } }),
}).then((r) => r.json())
if (!session?.id) throw new Error(`could not create a session for the test: ${JSON.stringify(session)}`)
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-'))
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${chromeDir}`,
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
// …AND the server, which this file used to kill ONLY on the happy path. That made the
// failure self-perpetuating: the test fails → a detached server is orphaned on this fixed
// port → the NEXT run dies with EADDRINUSE and reports "server exited before listening",
// a third symptom for one cause. Negative pid: `detached` gives npx its own process group,
// and killing only npx leaves the tsx/node grandchild holding the port.
const reapServer = () => { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
process.on('exit', () => { reapChrome(); reapServer() })
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapChrome(); reapServer(); if (e) console.error(e); process.exit(1) })
}


async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9334/json')).json()
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
const errors = []
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
  if (m.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(m.params?.exceptionDetails?.exception?.description ?? m.params))
})
const send = (method, params = {}) => { const id = ++cdpId; cdp.send(JSON.stringify({ id, method, params })); return new Promise((res) => pending.set(id, res)) }
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}

await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP })
for (let i = 0; i < 40; i++) { if (await evaluate(`document.body.innerText.includes('Terminal')`)) break; await wait(250) }
ok('app shell + Terminal tab rendered', await evaluate(`document.body.innerText.includes('Terminal')`))

// …and wait for the SESSION to be selected, which is the precondition the Terminal toggle
// actually depends on. Asserted separately from the tab above because the tab renders with
// or without a session — that is exactly why its failure was unreadable. The store
// auto-selects the first session it receives (store/sessions.tsx), so this needs no click.
let sessionUp = false
for (let i = 0; i < 40; i++) { sessionUp = await evaluate(`document.body.innerText.includes('Terminal e2e')`); if (sessionUp) break; await wait(250) }
ok('a session exists and is selected (Terminal is inert without one)', sessionUp)

// Click the Terminal tab.
// PRECONDITION, ASSERTED rather than assumed. This lookup is gated by nothing above it, and it
// is the shape that costs a diagnosis: if the Terminal control ever stops being a <button>
// whose trimmed text is exactly 'Terminal', this line throws inside the page, the click never
// lands, and the FIRST RED IS `xterm terminal attached` — which names xterm and the pty, in a
// test whose whole subject is web(xterm) <-> WS <-> server(node-pty). A selector bug would read
// as a PTY bug and send the reader server-side.
// Verified 2026-08-25 against the working tree: the control does render as a <button> with that
// exact text (MainTabs, web/src/App.tsx), so this is FRAGILITY, NOT BREAKAGE — the assertion is
// green today and exists so that drift names itself.
const termClicked = await evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Terminal')
  if (!b) return false
  b.click(); return true
})()`)
ok('PRECONDITION: a <button> labelled "Terminal" exists and was clicked', termClicked)

// Wait for xterm to attach + the pty prompt to arrive.
let xtermReady = false
for (let i = 0; i < 40; i++) { xtermReady = await evaluate(`!!document.querySelector('.xterm-rows')`); if (xtermReady) break; await wait(250) }
ok('xterm terminal attached', xtermReady)
await wait(800) // let the shell start + prompt render

// Type a command into xterm's hidden textarea, then Enter.
await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`)
await wait(100)
await send('Input.insertText', { text: 'echo TERMINAL_OK_42' })
await wait(200)
for (const type of ['keyDown', 'keyUp']) {
  await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
}

// Poll the rendered rows for the command output.
let got = false
for (let i = 0; i < 40; i++) {
  // Count occurrences: one is the typed line (echoed by the pty), a second is the
  // command's stdout — proving round-trip execution, not just local echo.
  const n = await evaluate(`(document.querySelector('.xterm-rows')?.innerText.match(/TERMINAL_OK_42/g) || []).length`)
  if (n >= 2) { got = true; break }
  await wait(250)
}
ok('typed command executed in the shell and its output rendered (round-trip)', got)
ok(`no uncaught page errors${errors.length ? ': ' + errors.join(' | ') : ''}`, errors.length === 0)

// THE NO-SESSION PATH, asserted here because THIS TEST'S OWN FIX HID IT.
// The original bug was that toggleTerm opens `if (!activeId) return`, so with no session the
// Terminal button rendered enabled, normally-styled, and silently did nothing. The fix to this
// harness was to create a session first — which is correct, but it means nothing would ever
// exercise the no-session path again. A fix that removes its own witness is not fixed.
// So: destroy the session and assert the button DISABLES. This is the real "after closing the
// last session" transition, not a synthetic one, and it is reachable on a fresh install too.
// Asserted last so it cannot disturb the round-trip flow above.
await fetch(`${APP}/api/session/destroy`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: session.id }),
}).catch(() => {})
let termDisabled = false
for (let i = 0; i < 40; i++) {
  termDisabled = await evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Terminal'); return !!b && b.disabled })()`
  )
  if (termDisabled) break
  await wait(250)
}
ok('with no session the Terminal button is DISABLED, not enabled-and-inert', termDisabled)

cdpDone = true   // deliberate teardown from here — the CDP close below is expected
cdp.close(); chrome.kill(); try { process.kill(-server.pid, 'SIGKILL') } catch { server.kill() }
await rm(chromeDir, { recursive: true, force: true }).catch(() => {})
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
