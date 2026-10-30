// PROJECT DEFAULTS — the browser half, on a throwaway instance.
//
// Builds the CURRENT web tree to a temp dir (never web/dist), boots its own server (:4347,
// proxy :4348, CDP 9383) with an isolated HOME / data dir (never the live :4319), makes a
// project from a session running ELEVATED with a custom sandbox, then drives Chrome:
//   · "+ new session in project" shows the project's mode pre-filled, RED, with the warning,
//     and the sandbox picker pre-filled from the project default (the extra docs mount)
//   · "Defaults…" in the project menu opens, Save changes the mode on the server, and the next
//     new-session dialog shows the new (non-elevated) mode
//   · "Clear defaults" removes them
// Sessions have no credentials (isolated HOME, CLAUDE_CONFIG_DIR removed); only the UI matters.
//   node scratchpad/project-defaults-probe.mjs
import { spawn, execSync } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { existsSync, statSync, createReadStream, mkdirSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { join, extname, basename } from 'path'
import { WebSocket, WebSocketServer } from 'ws'
import { check, passed, failed } from './assert.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const SRV = 4347, APP_PORT = 4348, CDP = 9383
const API = `http://127.0.0.1:${SRV}`
const APP = `http://127.0.0.1:${APP_PORT}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const tmpHome = await mkdtemp(join(tmpdir(), 'pd-home-'))
const dataDir = await mkdtemp(join(tmpdir(), 'pd-data-'))
const buildDir = await mkdtemp(join(tmpdir(), 'pd-build-'))
const shotDir = process.env.SHOT_DIR || ''
const work = join(tmpHome, 'work', 'pdproj'); mkdirSync(work, { recursive: true })
const docs = join(tmpHome, 'work', 'pddocs'); mkdirSync(docs, { recursive: true })
const gitEnv = { ...process.env }

execSync(`NODE_ENV=production npx vite build --outDir ${buildDir} --emptyOutDir --logLevel warn`, { cwd: join(ROOT, 'web'), stdio: 'inherit' })

const env = { ...gitEnv, PORT: String(SRV), HOST: '127.0.0.1', CLAUDETTE_NO_AUTH: '1', CLAUDETTE_DATA_DIR: dataDir, HOME: tmpHome }
delete env.CLAUDE_CONFIG_DIR   // see clear-race-test: isolating HOME alone is not isolation
delete env.CLAUDETTE_TOKEN
const server = spawn('npx', ['tsx', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: 'pipe', detached: true })
server.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(`[srv] ${d}`))

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }
const proxy = createServer(async (req, res) => {
  const url = req.url || '/'
  if (url.startsWith('/api') || url.startsWith('/jupyter')) {
    const chunks = []; for await (const c of req) chunks.push(c)
    const r = await fetch(`${API}${url}`, { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${SRV}` }, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'manual' })
    const buf = Buffer.from(await r.arrayBuffer())
    const h = Object.fromEntries(r.headers); delete h['content-encoding']; delete h['content-length']
    res.writeHead(r.status, h); res.end(buf); return
  }
  let p = join(buildDir, url.split('?')[0])
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(buildDir, 'index.html')
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
  createReadStream(p).pipe(res)
})
const wss = new WebSocketServer({ noServer: true })
proxy.on('upgrade', (req, socket, head) => {
  if (!(req.url || '').startsWith('/ws')) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (client) => {
    const up = new WebSocket(`ws://127.0.0.1:${SRV}${req.url}`)
    const q = []
    up.on('open', () => { for (const m of q) up.send(m); q.length = 0 })
    client.on('message', (m) => (up.readyState === 1 ? up.send(m.toString()) : q.push(m.toString())))
    up.on('message', (m) => client.readyState === 1 && client.send(m.toString()))
    const bye = () => { try { client.close() } catch {} ; try { up.close() } catch {} }
    client.on('close', bye); up.on('close', bye); client.on('error', bye); up.on('error', bye)
  })
})

const CHROME_BIN = process.env.CHROME_BIN
  || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null)
  || execSync(`ls ${ROOT}.chrome-headless/chrome/linux-*/chrome-linux64/chrome 2>/dev/null | head -1`).toString().trim()
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-pd-'))
const chrome = spawn(CHROME_BIN, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${chromeDir}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900', 'about:blank'], { stdio: 'pipe', detached: true })
// Reap server and Chrome by process GROUP on every exit path (npx forks the real node).
const reapServer = () => { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
const reapChrome = () => { try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} } }
process.on('exit', () => { reapChrome(); reapServer() })
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapChrome(); reapServer(); if (e) console.error(e); process.exit(1) })
}

let ready = false
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${API}/api/health`)).ok) { ready = true; break } } catch {} await wait(250) }
if (!ready) { console.error('throwaway server never came up'); process.exit(1) }
await new Promise((r) => proxy.listen(APP_PORT, '127.0.0.1', r))

const post = async (path, body) => (await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
const getJ = async (path) => (await fetch(`${API}${path}`)).json()

// --- state through the real API -------------------------------------------------------
const s1 = (await post('/api/session/create', { name: 'lead', cwd: work, permissionMode: 'bypassPermissions',
  sandbox: { enabled: true, mounts: [{ path: work, mode: 'ro' }, { path: docs, mode: 'ro' }] } })).id
const P = (await post('/api/project/fromSession', { sessionId: s1 })).project
check('0. setup: project made from an ELEVATED session with a custom sandbox snapshots both',
  P?.defaults?.permissionMode === 'bypassPermissions' && P?.defaults?.sandbox?.mounts?.some((m) => m.path === docs), JSON.stringify(P?.defaults))

// --- CDP ----------------------------------------------------------------------------
async function cdpTarget() { for (let i = 0; i < 40; i++) { try { const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); const page = list.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl } catch {} await wait(250) } throw new Error('no CDP target') }
const cdp = new WebSocket(await cdpTarget())
await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej) })
let cdpId = 0; const pend = new Map(); let cdpDone = false
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died; aborting rather than hanging'); process.exit(1) })
cdp.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (method, params = {}) => { const id = ++cdpId; return new Promise((res) => { pend.set(id, res); cdp.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value }
async function waitFor(expr, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await evaluate(expr)) return true } catch {} await wait(200) } return false }
async function shot(name) {
  if (!shotDir) return
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(shotDir, `${name}.png`), Buffer.from(r.result.data, 'base64'))
}
await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: APP })
await waitFor(`!!document.querySelector('[data-testid="project-header"]')`)
await evaluate(`
  window.__hdr = (id) => document.querySelector('[data-testid="project-header"][data-project-id="' + id + '"]');
  window.__btn = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  window.__pick = (sel, v) => { const el = document.querySelector(sel); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })) };
`)
const openNew = async () => {
  await evaluate(`__hdr('${P.id}').querySelector('[aria-label^="New session in"]').click()`)
  await waitFor(`!!document.querySelector('[data-testid="new-session-mode"]')`)
}
const projectNow = async () => (await getJ('/api/project/list')).projects.find((p) => p.id === P.id)

// 1. the new-session dialog shows the project defaults, elevated in red
{
  await openNew()
  const d = await evaluate(`(() => { const s = document.querySelector('[data-testid="new-session-mode"]'); return { value: s?.value, red: s?.className.includes('text-ctp-red'), warn: !!document.querySelector('[data-testid="new-session-mode-warning"]'), docs: document.body.innerText.includes(${JSON.stringify(docs)}) || document.body.innerText.includes('pddocs') } })()`)
  check('1. new-session dialog: the ELEVATED project mode is pre-filled, red, with a warning', d.value === 'bypassPermissions' && d.red && d.warn, JSON.stringify(d))
  check('1b …and the sandbox picker is pre-filled from the project default (its extra docs mount)', d.docs === true, JSON.stringify(d))
  await shot('new-elevated')
  await evaluate(`__btn('Cancel').click()`)
  await wait(200)
}

// 2. Defaults… opens and saves
{
  await evaluate(`__hdr('${P.id}').querySelector('[aria-label="Project actions"]').click()`)
  await wait(200)
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Defaults…')).click()`)
  const open = await waitFor(`!!document.querySelector('[data-testid="project-defaults-dialog"]') && document.querySelector('[data-testid="project-defaults-mode"]').value === 'bypassPermissions'`)
  check('2. "Defaults…" opens the dialog showing the current defaults', open)
  const cwdShown = await evaluate(`document.querySelector('[data-testid="project-defaults-cwd"]')?.title`)
  check('2a …and shows the project\'s folder (not only as a header hover title)', cwdShown === P.cwd && !!P.cwd, String(cwdShown))
  await shot('defaults-dialog')
  await evaluate(`__pick('[data-testid="project-defaults-mode"]', 'plan')`)
  await evaluate(`__btn('Save').click()`)
  const saved = await waitFor(`!document.querySelector('[data-testid="project-defaults-dialog"]')`)
  const srv = await projectNow()
  check('2b Save stores the new mode on the server (sandbox default kept)', saved && srv?.defaults?.permissionMode === 'plan' && srv?.defaults?.sandbox?.mounts?.some((m) => m.path === docs), JSON.stringify(srv?.defaults))
  await wait(400)
  await openNew()
  const d = await evaluate(`(() => { const s = document.querySelector('[data-testid="new-session-mode"]'); return { value: s?.value, red: s?.className.includes('text-ctp-red'), warn: !!document.querySelector('[data-testid="new-session-mode-warning"]') } })()`)
  check('2c the next new-session dialog shows the new mode, not red', d.value === 'plan' && !d.red && !d.warn, JSON.stringify(d))
  await evaluate(`__btn('Cancel').click()`)
  await wait(200)
}

// 3. Clear defaults
{
  await evaluate(`__hdr('${P.id}').querySelector('[aria-label="Project actions"]').click()`)
  await wait(200)
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Defaults…')).click()`)
  await waitFor(`!!document.querySelector('[data-testid="project-defaults-dialog"]')`)
  await evaluate(`__btn('Clear defaults').click()`)
  const closed = await waitFor(`!document.querySelector('[data-testid="project-defaults-dialog"]')`)
  const srv = await projectNow()
  check('3. "Clear defaults" removes them on the server', closed && srv && !srv.defaults, JSON.stringify(srv))
}

cdpDone = true
try { cdp.close() } catch {}
reapChrome(); reapServer()
await Promise.all([tmpHome, dataDir, buildDir, chromeDir].map((d) => rm(d, { recursive: true, force: true }).catch(() => {})))
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
