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
let failed = 0
const ok = (c, m) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++ }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production' },
  cwd: process.cwd(), stdio: 'pipe', detached: true,
})
server.stderr.on('data', () => {})
for (let i = 0; i < 40; i++) { try { if ((await fetch(`${APP}/api/health`)).ok) break } catch {} await wait(250) }

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9334', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', 'about:blank',
], { stdio: 'pipe' })

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
ok(await evaluate(`document.body.innerText.includes('Terminal')`), 'app shell + Terminal tab rendered')

// Click the Terminal tab.
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Terminal').click()`)

// Wait for xterm to attach + the pty prompt to arrive.
let xtermReady = false
for (let i = 0; i < 40; i++) { xtermReady = await evaluate(`!!document.querySelector('.xterm-rows')`); if (xtermReady) break; await wait(250) }
ok(xtermReady, 'xterm terminal attached')
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
ok(got, 'typed command executed in the shell and its output rendered (round-trip)')
ok(errors.length === 0, `no uncaught page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)

cdp.close(); chrome.kill(); try { process.kill(-server.pid, 'SIGKILL') } catch { server.kill() }
await rm(chromeDir, { recursive: true, force: true }).catch(() => {})
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
