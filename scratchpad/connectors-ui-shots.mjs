// Screenshot the two connector UI surfaces, to check they actually render:
//   1. the GLOBAL Claudette deck (brand → ⚙) with a seeded catalog + the strict pre-flight
//   2. the PER-SESSION grants inside the Sandbox dock panel
//
// Runs its own server on :4488 with an isolated CLAUDETTE_DATA_DIR, so it never touches the
// real catalog or session list. Creates one session (which spawns `claude -p` idle — it
// costs nothing until a turn is sent) because the sandbox dock needs an active session.
//   node scratchpad/connectors-ui-shots.mjs
import { spawn } from 'child_process'
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4488
const APP = `http://127.0.0.1:${PORT}`
const TOKEN = 'shots-token'
const OUT = '/tmp/claudette-connector-shots'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await mkdir(OUT, { recursive: true })

const DATA = await mkdtemp(join(tmpdir(), 'conn-shots-data-'))
const PROJ = await mkdtemp(join(tmpdir(), 'conn-shots-proj-'))
// A config the strict pre-flight will find, so the report has something real to show.
await mkdir(join(PROJ, '.claude'), { recursive: true })
await writeFile(join(PROJ, '.mcp.json'), JSON.stringify({
  mcpServers: {
    'legacy-notes': { command: 'notes-mcp', args: ['--db', '/tmp/notes.db'] },
    'old-sse': { type: 'sse', url: 'https://retired.example/sse' },
  },
}, null, 2))

// `detached` so the whole process GROUP can be signalled. Killing the npx wrapper alone
// leaves the real tsx/node child holding :4488, and the next run then fails to start for a
// reason that has nothing to do with the UI it is meant to be checking.
const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), CLAUDETTE_TOKEN: TOKEN, CLAUDETTE_DATA_DIR: DATA },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let log = ''
server.stdout.on('data', (d) => (log += d))
server.stderr.on('data', (d) => (log += d))
// Always reap the server, however this script ends. Without it a thrown assertion leaves
// :4488 held and the NEXT run fails to start for an unrelated reason — which is a
// confusing way to learn your UI check is broken.
const reap = () => { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
process.on('exit', reap)
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reap(); if (e) console.error(e); process.exit(1) })
}
for (let i = 0; i < 60 && !log.includes('Server listening'); i++) await wait(500)
if (!log.includes('Server listening')) { console.error(log.slice(-2000)); throw new Error('server did not start') }
console.log('server up')

const apiPost = (path, body) => fetch(`${APP}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` }, body: JSON.stringify(body),
}).then((r) => r.json())

// Seed a catalog worth looking at: an http connector with a secret, a stdio one, and an
// account connector — so redaction, health and the account caveat all appear.
await apiPost('/api/connectors/save', {
  id: 'github', name: 'GitHub Issues', transport: 'http',
  url: 'https://user:pw@api.github.example/mcp?token=SECRET',
  headers: { Authorization: 'Bearer NEVER-SHOWN' },
})
await apiPost('/api/connectors/save', {
  id: 'postgres', name: 'App Database', transport: 'stdio',
  command: 'mcp-server-postgres', args: ['postgres://u:p@db/app'], env: { PGPASSWORD: 'hunter2' },
  enabledByDefault: true,
})
await apiPost('/api/connectors/account', { accountConnectors: [{ name: 'gmail' }, { name: 'drive' }] })
const session = await apiPost('/api/session/create', { name: 'Connector demo', cwd: PROJ, rootDir: PROJ })
console.log('seeded catalog + session', session.id)
// Grant one of the two, so the sandbox panel shows a mixed state rather than all-on/all-off.
await apiPost('/api/session/setConnectors', { id: session.id, connectors: ['github'], accountConnectors: ['gmail'] })

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-conn-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9347', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,1000', 'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9347/json')).json()
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
cdp.on('message', (data) => {
  const m = JSON.parse(data.toString())
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
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
  console.log(`📸 ${name}`)
}
async function waitFor(expr, ms = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await evaluate(expr)) return true
    await wait(200)
  }
  throw new Error(`timeout waiting for: ${expr}`)
}
const clickText = (label, tag = 'button') => evaluate(
  `(() => { const b = [...document.querySelectorAll(${JSON.stringify(tag)})].find(x => x.textContent.trim().startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true })()`)

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/api/auth?token=${TOKEN}` })
await wait(800)
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Claudette⚙' || b.textContent.trim().startsWith('Claudette')))`)
await wait(1500)

// --- 1. the global deck --------------------------------------------------------
console.log('open deck:', await clickText('Claudette'))
// NB: lower-cased before matching — innerText reflects CSS text-transform, and this
// caption is styled `uppercase`, so a literal match silently never fires.
await waitFor(`document.body.innerText.toLowerCase().includes('applies to every session')`)
await shot('1-claudette-deck')

const leaked = await evaluate(`['NEVER-SHOWN','hunter2','SECRET','postgres://u:p@db/app'].filter(s => document.body.innerText.includes(s))`)
console.log(leaked.length === 0 ? '✅ no secret rendered in the deck' : `❌ LEAKED: ${leaked.join(', ')}`)

// --- 2. the strict pre-flight --------------------------------------------------
console.log('open preflight:', await clickText('What would this change?'))
await waitFor(`document.body.innerText.includes('If you turn strict mode on')`)
await shot('2-strict-preflight')
const sawImportable = await evaluate(`document.body.innerText.includes('legacy-notes')`)
const sawSkipped = await evaluate(`document.body.innerText.toLowerCase().includes('sse')`)
console.log(sawImportable ? '✅ pre-flight lists the importable server' : '❌ importable server missing')
console.log(sawSkipped ? '✅ pre-flight names the un-carryable SSE entry' : '❌ SSE skip missing')

// Close the deck. Take the LAST aria-label="Close" — the sidebar has a mobile close button
// with the same label, and the deck is portalled to the end of <body>, so first-match hits
// the wrong one and silently leaves the deck up.
await evaluate(`[...document.querySelectorAll('button[aria-label="Close"]')].pop()?.click()`)
await wait(600)
console.log(
  (await evaluate(`!document.body.innerText.toLowerCase().includes('applies to every session')`))
    ? '✅ deck closes' : '❌ deck did not close',
)

// --- 3. per-session grants in the sandbox dock ---------------------------------
console.log('open sandbox dock:', await clickText('Sandbox'))
await waitFor(`document.body.innerText.includes('Connectors')`)
await wait(600)
await shot('3-sandbox-connectors')
const grantState = await evaluate(`(() => {
  const t = document.body.innerText
  return { hasHeading: t.includes('Connectors'), granted: t.includes('1 granted'),
           github: t.includes('GitHub Issues'), db: t.includes('App Database'),
           accountCaveat: t.includes('deny rule rather than a real grant') }
})()`)
console.log('grants panel:', JSON.stringify(grantState))

console.log(`\nshots in ${OUT}`)
chrome.kill()
server.kill()
await wait(600)
await rm(DATA, { recursive: true, force: true })
await rm(PROJ, { recursive: true, force: true })
process.exit(0)
