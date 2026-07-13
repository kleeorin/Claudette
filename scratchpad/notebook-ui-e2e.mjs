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
let failed = 0
const ok = (c, m) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++ }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const nbDir = await mkdtemp(join(tmpdir(), 'nbui-'))
const nbPath = join(nbDir, 'ui.ipynb')

// --- start the built server (single-origin, loopback = no auth) ---------------
const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
  cwd: process.cwd(), stdio: 'pipe', detached: true,
})
server.stderr.on('data', () => {})
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(`${APP}/api/health`); if (r.ok) break } catch {}
  await wait(250)
}

// --- launch headless chrome ---------------------------------------------------
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', 'about:blank',
], { stdio: 'pipe' })

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

await send('Page.navigate', { url: APP })
// Wait for the shell.
for (let i = 0; i < 40; i++) {
  const ready = await evaluate(`!!document.querySelector('main') && document.body.innerText.includes('+ notebook')`)
  if (ready) break
  await wait(250)
}
ok(await evaluate(`document.body.innerText.includes('+ notebook')`), 'app shell + notebook tab rendered')

// --- open the "+ notebook" dialog and create a notebook -----------------------
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('+ notebook')).click()`)
await wait(200)
// Set the path input via the native setter (React-controlled), then Create new.
await evaluate(`(() => {
  const input = document.querySelector('input.modal-input');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(input, ${JSON.stringify(nbPath)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`)
await wait(100)
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Create new').click()`)

// Wait for the NotebookView (a CodeMirror editor) to render.
let cmReady = false
for (let i = 0; i < 40; i++) {
  cmReady = await evaluate(`!!document.querySelector('.cm-content')`)
  if (cmReady) break
  await wait(250)
}
ok(cmReady, 'notebook view rendered with a cell editor')

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
ok(got42, 'cell ran through the UI and output 42 appeared')

// Kernel status dot should have reached idle (title="kernel: idle").
ok(await evaluate(`!!document.querySelector('[title="kernel: idle"], [title="kernel: busy"]')`), 'kernel status surfaced in header')

ok(consoleErrors.length === 0, `no uncaught page errors${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''}`)

// --- teardown -----------------------------------------------------------------
cdp.close(); chrome.kill(); try { process.kill(-server.pid, 'SIGKILL') } catch { server.kill() }
await rm(nbDir, { recursive: true, force: true }).catch(() => {})
await rm(chromeDir, { recursive: true, force: true }).catch(() => {})
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
