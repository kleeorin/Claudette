// DIAGNOSTIC (not an assertion test): why does terminal-ui-e2e's `xterm terminal attached`
// fail? Reproduces its boot exactly, clicks Terminal, then dumps the DOM + the server's
// own pane list — which distinguishes "the click never created a pty" (test/UI bug) from
// "the pty exists but xterm never rendered" (attach-path bug).
// Own port (4351/9351) so it cannot collide with terminal-ui-e2e's 4332 or QA's runs.
import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4351, CDP = 9351, WEB_PORT = 5351
// --vite: point the BROWSER at a vite dev server compiled from web/src, instead of at the
// app server's prebuilt web/dist. web/dist is stale (08-22 08:42, older than App.tsx and
// ChatView.tsx) and is --ro-bind read-only, so nobody on the team can rebuild it — which
// makes every result from a dist-serving harness uninterpretable in BOTH directions: a
// green proves yesterday's bundle worked, not today's source. vite dissolves that confound.
// The API still lives on PORT; vite.config proxies /api and /ws there (SERVER_PORT ?? PORT).
const VITE = process.argv.includes('--vite')
const APP = `http://127.0.0.1:${VITE ? WEB_PORT : PORT}`
const API = `http://127.0.0.1:${PORT}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const dataDir = await mkdtemp(join(tmpdir(), 'tdiag-'))

const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: (() => { const e = { ...process.env, CLAUDETTE_NO_AUTH: '1', CLAUDETTE_DATA_DIR: dataDir, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production' }
                delete e.CLAUDETTE_TOKEN; return e })(),
  cwd: process.cwd(), stdio: 'pipe', detached: true,
})
let log = ''
server.stdout.on('data', (d) => { log += d }); server.stderr.on('data', (d) => { log += d })

const chromeDir = await mkdtemp(join(tmpdir(), 'tdiag-chrome-'))
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', [
  '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,1000', 'about:blank',
], { stdio: 'ignore', detached: true })

let web = null
const reapServer = () => {
  for (const c of [server, web]) { if (!c) continue; try { process.kill(-c.pid, 'SIGKILL') } catch { try { c.kill('SIGKILL') } catch {} } }
}
// Reap by process GROUP, not by pid — the same discipline this file uses for its server,
// where it IS load-bearing (`npx` forks the real node, so killing the wrapper by pid can
// strand the port). For Chrome it is defence in depth only: measured, the bare kill did
// not orphan it. See rule 3 in scratchpad/port-and-reap-lint.mts.
const reapChrome = () => { try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} } }
process.on('exit', () => { reapChrome(); reapServer() })
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapChrome(); reapServer(); if (e) console.error(e); process.exit(1) })
}

for (let i = 0; i < 80; i++) { if (/Claudette server ready/.test(log)) break; await wait(250) }
if (!/Claudette server ready/.test(log)) { console.error(log.slice(-1500)); throw new Error('server never came up') }

if (VITE) {
  web = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: 'web', env: { ...process.env, PORT: String(PORT), WEB_PORT: String(WEB_PORT) },
    stdio: 'pipe', detached: true,
  })
  let vlog = ''
  web.stdout.on('data', (d) => { vlog += d }); web.stderr.on('data', (d) => { vlog += d })
  for (let i = 0; i < 120; i++) { if (/ready in/.test(vlog)) break; await wait(250) }
  if (!/ready in/.test(vlog)) { console.error(vlog.slice(-1200)); throw new Error('vite did not start') }
  console.log('vite up — serving from web/src (NOT the stale web/dist)')
}

let wsUrl = null
for (let i = 0; i < 40; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); const p = l.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) { wsUrl = p.webSocketDebuggerUrl; break } } catch {}
  await wait(250)
}
const cdp = new WebSocket(wsUrl)
await new Promise((r) => cdp.on('open', r))
let id = 0; const pending = new Map(); const errors = []
// A CDP reply is awaited on a promise that ONLY the socket can resolve, so if Chrome dies
// mid-run — crash, OOM, an external pkill — every pending send() hangs forever and the
// harness sleeps in ep_poll holding its ports until someone hunts it down. Abort loudly
// instead. No reap() here on purpose: process.exit() runs the process.on('exit') handlers,
// which already cover every child. `cdpDone` keeps this off the DELIBERATE teardown below,
// where the very same close event is expected and must not be read as a failure.
let cdpDone = false
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died; aborting rather than hanging'); process.exit(1) })
cdp.on('message', (d) => { const m = JSON.parse(d.toString())
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 200))
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console: ' + m.params.args.map((a) => a.value).join(' ').slice(0, 200))
})
const send = (method, params = {}) => { const i = ++id; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pending.set(i, r)) }
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value

await send('Page.enable'); await send('Runtime.enable'); await send('Page.navigate', { url: APP })
for (let i = 0; i < 40; i++) { if (await ev(`document.body.innerText.includes('Terminal')`)) break; await wait(250) }

// --confined: create the session with a REAL bwrap box AND sandboxTerminals, so the pane
// goes through sessionConfinement -> wrapCommand -> nested bwrap. Without this flag the
// diagnosis only ever proved the HOST pty path, which is not the seam that carries the
// security guarantee. Run both ways before concluding anything about attach.
const CONFINED = process.argv.includes('--confined')
const sess = await fetch(`${API}/api/session/create`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Diag', cwd: process.cwd(), rootDir: process.cwd(),
    sandbox: CONFINED
      ? { enabled: true, mounts: [{ path: process.cwd(), mode: 'rw' }], sandboxTerminals: true }
      : { enabled: false, mounts: [] },
  }),
}).then((r) => r.json())
console.log(`\nsession: ${sess?.id ? 'created' : JSON.stringify(sess)}  mode=${CONFINED ? 'CONFINED (bwrap + sandboxTerminals)' : 'host'}`)
for (let i = 0; i < 40; i++) { if (await ev(`document.body.innerText.includes('Diag')`)) break; await wait(250) }
console.log('session visible in UI:', await ev(`document.body.innerText.includes('Diag')`))

console.log('\n=== BEFORE the click ===')
console.log('buttons with text "Terminal":', await ev(`[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Terminal').length`))
console.log('all button texts:', JSON.stringify(await ev(`[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(Boolean).slice(0,25)`)))
console.log('server panes:', JSON.stringify(await (await fetch(`${API}/api/pane/list`)).json()))

await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Terminal').click()`)
await wait(3000)

console.log('\n=== AFTER the click (3s) ===')
console.log('.xterm        present:', await ev(`!!document.querySelector('.xterm')`))
console.log('.xterm-rows   present:', await ev(`!!document.querySelector('.xterm-rows')`))
console.log('.xterm-screen present:', await ev(`!!document.querySelector('.xterm-helper-textarea')`))
console.log('server panes:', JSON.stringify(await (await fetch(`${API}/api/pane/list`)).json()))
if (await ev(`!!document.querySelector('.xterm-helper-textarea')`)) {
  await ev(`document.querySelector('.xterm-helper-textarea').focus()`)
  for (const ch of 'echo DIAG_OK_7\r') {
    await send('Input.dispatchKeyEvent', ch === '\r'
      ? { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', text: '\r' }
      : { type: 'keyDown', text: ch })
    await send('Input.dispatchKeyEvent', { type: 'keyUp' })
  }
  let hits = 0
  for (let i = 0; i < 30; i++) { hits = await ev(`(document.querySelector('.xterm-rows')?.innerText.match(/DIAG_OK_7/g)||[]).length`); if (hits >= 2) break; await wait(400) }
  console.log('ROUND-TRIP (shell executed the command):', hits >= 2 ? 'YES' : `no (matches=${hits})`)
}
console.log('page errors:', JSON.stringify(errors.slice(0, 6), null, 1))
console.log('\n=== server log tail ===')
console.log(log.split('\n').filter((l) => /pane|pty|error|refus|deny|Error/i.test(l)).slice(-12).join('\n') || '(nothing pane/pty related)')

cdpDone = true   // deliberate teardown from here — the CDP close below is expected
cdp.close(); reapChrome(); reapServer()
await rm(chromeDir, { recursive: true, force: true }).catch(() => {})
await rm(dataDir, { recursive: true, force: true }).catch(() => {})
