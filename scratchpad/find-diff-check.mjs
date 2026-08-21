// The one find surface the main harness can't reach: the DiffEditor, which only
// renders while a session has a PENDING Edit permission for the open file.
//
// Gets there with a stand-in `claude` on PATH (same trick as fake-claude.mjs) that
// raises one can_use_tool request for demo.py on cue, so FileEditorView flips into
// review mode for real rather than being poked into it.
//   node scratchpad/find-diff-check.mjs
import { spawn } from 'child_process'
import { mkdtemp, writeFile, mkdir, rm, chmod } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4491
const WEB_PORT = 5291
const APP = `http://127.0.0.1:${WEB_PORT}`
const API = `http://127.0.0.1:${PORT}`
const TOKEN = 'find-diff-token'
const OUT = '/tmp/claudette-find-shots'
const GO = '/tmp/claudette-find-diff-go'   // touch this and the shim raises the edit
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await mkdir(OUT, { recursive: true })
await rm(GO, { force: true })

const DATA = await mkdtemp(join(tmpdir(), 'fdiff-data-'))
const PROJ = await mkdtemp(join(tmpdir(), 'fdiff-proj-'))
const BIN = await mkdtemp(join(tmpdir(), 'fdiff-bin-'))

const FILE = join(PROJ, 'demo.py')
await writeFile(FILE, [
  '# demo file for find',
  'alpha = 1',
  'beta = alpha + 1',
  'gamma = alpha + beta',
  'print(alpha, beta, gamma)',
  '',
].join('\n'))

// The stand-in CLI. It waits for the marker so the browser is up and looking at the
// file before the permission lands — otherwise review mode opens before we can watch.
await writeFile(join(BIN, 'claude'), `#!/usr/bin/env node
import { existsSync } from 'fs'
const req = {
  type: 'control_request',
  request_id: 'req-diff-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Edit',
    display_name: 'Edit',
    input: {
      file_path: ${JSON.stringify(FILE)},
      old_string: 'gamma = alpha + beta',
      new_string: 'gamma = alpha * beta  # alpha scaled',
    },
    tool_use_id: 'tu-diff-1',
    permission_suggestions: [],
  },
}
const tick = setInterval(() => {
  if (!existsSync(${JSON.stringify(GO)})) return
  clearInterval(tick)
  process.stdout.write(JSON.stringify(req) + '\\n')
}, 200)
process.stdin.resume()
setTimeout(() => process.exit(0), 300000)
`)
await chmod(join(BIN, 'claude'), 0o755)

const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, PORT: String(PORT), CLAUDETTE_TOKEN: TOKEN, CLAUDETTE_DATA_DIR: DATA },
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
// Unsandboxed: bwrap would resolve a different `claude` than the PATH shim.
const session = await apiPost('/api/session/create', {
  name: 'Diff find', cwd: PROJ, rootDir: PROJ,
  sandbox: { enabled: false, mounts: [] },
})
console.log('session', session.id, 'sandboxed:', session.sandboxed)

const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-fdiff-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9350', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,1000', 'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9350/json')).json()
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
cdp.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? '')
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
async function waitFor(expr, ms = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await evaluate(expr)) return true
    await wait(200)
  }
  await shot('FAILED-diff')
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.slice(-4).join('\n  '))
  throw new Error(`timeout waiting for: ${expr}`)
}
let failures = 0
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}
async function key(text, { ctrl = false, shift = false, code, keyCode } = {}) {
  const mods = (ctrl ? 2 : 0) | (shift ? 8 : 0)
  const base = { modifiers: mods, key: text, code: code ?? `Key${text.toUpperCase()}`, windowsVirtualKeyCode: keyCode ?? text.toUpperCase().charCodeAt(0) }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}
const focusFindField = () => evaluate(`(() => {
  const i = [...document.querySelectorAll('input')].find(x => (x.placeholder||'').startsWith('Find'))
  if (!i) return false; i.focus(); return true })()`)
const counter = () => evaluate(`(() => {
  const s = [...document.querySelectorAll('span')].find(x => /^\\d+\\/\\d+\\+?$/.test(x.textContent.trim()))
  return s ? s.textContent.trim() : null })()`)

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/api/auth?token=${TOKEN}` })
await wait(800)
await send('Page.navigate', { url: `${APP}/` })
await wait(1500)
await evaluate(`localStorage.setItem('claudette:layout:v1', JSON.stringify({
  v: 1, layout: 'side',
  sizes: { sideW: 460, stackH: 400, dockW: 320, termH: 240, sidebarW: 200 },
  seq: 0, terms: {},
  content: { ${JSON.stringify(session.id)}: {
    active: 'f:${FILE}',
    tabs: [{ kind: 'file', path: ${JSON.stringify(FILE)} }],
  } },
}))`)
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!document.querySelector('.cm-content')`)
await wait(1500)

console.log('\n[DiffEditor — pending Edit review]')
await writeFile(GO, 'go')                      // cue the shim
await waitFor(`document.body.innerText.includes('Claude proposes changes')`)
await wait(1200)
check(await evaluate(`document.querySelectorAll('.cm-deletedChunk, .cm-changedLine').length > 0`),
  'review mode is showing the inline diff')
await shot('10-diff-review')

// Ctrl+F from the container, with focus wherever review mode left it.
await key('f', { ctrl: true })
await wait(500)
check(await evaluate(`!!document.querySelector('input[placeholder^="Find"]')`), 'Ctrl+F opens the bar in the diff view')
await focusFindField()
await send('Input.insertText', { text: 'alpha' })
await wait(600)
// 5, not 4: the proposed line adds "# alpha scaled" on top of the original four.
check((await counter()) === '1/5', 'diff view finds all 5 matches in the proposed text', await counter())
check(await evaluate(`!!document.querySelector('.cm-find-match-active')`), 'diff active match is highlighted')
// Find only here — deciding hunks is the review's job, not the find bar's.
check(!(await evaluate(`[...document.querySelectorAll('input')].some(x => (x.placeholder||'').startsWith('Replace'))`)),
  'the diff view offers find WITHOUT replace')
await shot('11-diff-find')

await key('Enter', { code: 'Enter', keyCode: 13 })
await wait(400)
check((await counter()) === '2/5', 'Enter steps through diff matches', await counter())

console.log(`\nshots in ${OUT}`)
console.log(failures === 0 ? '\n✅ diff find checks passed' : `\n❌ ${failures} check(s) failed`)
chrome.kill()
server.kill()
web.kill()
await wait(600)
await rm(GO, { force: true })
await rm(DATA, { recursive: true, force: true })
await rm(PROJ, { recursive: true, force: true })
await rm(BIN, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
