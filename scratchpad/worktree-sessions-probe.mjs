// ISOLATED (git worktree) SESSIONS — the browser half, on a throwaway instance.
//
// Builds the CURRENT web tree to a temp dir (never web/dist), boots its own server (:4345,
// proxy :4346, CDP 9382) with an isolated HOME / data dir (never the live :4319), makes a git
// repo with a commit and a project on it plus a project on a non-repo dir, then drives Chrome:
//   · "+ new session in project" offers "Isolated (git worktree)": enabled for the repo
//     project, disabled with the reason for the non-repo one
//   · ticking it shows a Branch field defaulting to a slug of the name, and Create makes the
//     worktree on disk; the sidebar row shows the branch
//   · closing an isolated session asks Keep worktree / Remove worktree; Keep leaves the dir
//   · Remove on a DIRTY worktree shows the dirty file and needs a second confirm; after it the
//     dir is gone and the branch is kept
// Sessions have no credentials (isolated HOME, CLAUDE_CONFIG_DIR removed); only the UI matters.
//   node scratchpad/worktree-sessions-probe.mjs
import { spawn, execSync } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { existsSync, statSync, createReadStream, mkdirSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { join, extname, basename } from 'path'
import { WebSocket, WebSocketServer } from 'ws'
import { check, passed, failed } from './assert.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const SRV = 4345, APP_PORT = 4346, CDP = 9382
const API = `http://127.0.0.1:${SRV}`
const APP = `http://127.0.0.1:${APP_PORT}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const tmpHome = await mkdtemp(join(tmpdir(), 'wt-home-'))
const dataDir = await mkdtemp(join(tmpdir(), 'wt-data-'))
const buildDir = await mkdtemp(join(tmpdir(), 'wt-build-'))
const shotDir = process.env.SHOT_DIR || ''
const repo = join(tmpHome, 'work', 'wtrepo'); mkdirSync(repo, { recursive: true })
const plain = join(tmpHome, 'work', 'plaindir'); mkdirSync(plain, { recursive: true })
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' }
const g = (cmd, cwd = repo) => execSync(`git ${cmd}`, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
g('init -q -b main'); writeFileSync(join(repo, 'a.txt'), 'a\n'); g('add -A'); g('commit -qm one')

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
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-wt-'))
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
const P = (await post('/api/project/create', { name: 'wtrepo', cwd: repo })).project
const PP = (await post('/api/project/create', { name: 'plaindir', cwd: plain })).project
check('0. setup: a project on a git repo with a commit, one on a plain dir', !!P && !!PP, JSON.stringify({ P, PP }))

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
  window.__iso = () => [...document.querySelectorAll('label')].find((l) => l.textContent.includes('Isolated (git worktree)'));
  window.__isoBox = () => __iso()?.querySelector('input[type="checkbox"]');
  window.__set = (input, v) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, v); input.dispatchEvent(new Event('input', { bubbles: true })) };
  window.__rowOf = (name) => { const el = [...document.querySelectorAll('aside span')].find((e) => e.childElementCount === 0 && e.textContent.trim() === name); return el ? el.closest('.group') : null };
`)
const openNew = async (pid) => {
  await evaluate(`__hdr('${pid}').querySelector('[aria-label^="New session in"]').click()`)
  await waitFor(`/New session in/.test(document.body.innerText) && !!__iso()`)
}
const sessions = async () => (await getJ('/api/session/list')).sessions

// 1. option disabled for a non-repo project, with the reason
{
  await openNew(PP.id)
  const ok = await waitFor(`!!__isoBox() && __isoBox().disabled && /not inside a git repository/.test(document.body.innerText)`)
  check('1. non-repo project: "Isolated (git worktree)" is shown DISABLED with the reason', ok)
  await evaluate(`__btn('Cancel').click()`)
  await wait(200)
}

// 2. enabled for the repo project; branch defaults to a slug of the name; create makes it
const W1 = join(repo, '.claude', 'worktrees', 'fix-login')
{
  await openNew(P.id)
  const enabled = await waitFor(`!!__isoBox() && !__isoBox().disabled`)
  check('2. repo project: the option is ENABLED', enabled)
  await evaluate(`__set(document.querySelector('input[placeholder="defaults to the folder name"]'), 'Fix Login')`)
  await evaluate(`__isoBox().click()`)
  const branchVal = await (async () => { await waitFor(`!!document.querySelector('input.font-mono[value="fix-login"]')`, 4000); return evaluate(`[...document.querySelectorAll('input')].map((i) => i.value).includes('fix-login')`) })()
  check('2b. ticking it shows a Branch field defaulting to a slug of the name ("fix-login")', branchVal === true)
  await shot('new-isolated')
  await evaluate(`__btn('Create session').click()`)
  // A fresh folder is untrusted, so the dialog's own trust prompt comes first.
  if (await waitFor(`!!__btn('Trust folder')`, 4000)) await evaluate(`__btn('Trust folder').click()`)
  const made = await waitFor(`!!__rowOf('Fix Login')`, 20000)
  const s = (await sessions()).find((x) => x.name === 'Fix Login')
  check('2c. Create makes the worktree on disk and the session runs in it',
    made && existsSync(W1) && s?.cwd === W1 && s?.worktree?.branch === 'fix-login', JSON.stringify(s?.worktree))
  const label = await waitFor(`(__rowOf('Fix Login')?.textContent ?? '').includes('⎇ fix-login')`)
  check('2d. the sidebar row shows its branch', label)
  await shot('row-branch')
}

// 3. close → Keep worktree leaves the dir
{
  const r = await post('/api/session/create', { name: 'keeper', cwd: '', projectId: P.id, isolated: {} })
  const dir = (await sessions()).find((x) => x.id === r.id)?.cwd
  await waitFor(`!!__rowOf('keeper')`)
  await evaluate(`__rowOf('keeper').querySelector('button[title="Close session"]').click()`)
  const asks = await waitFor(`document.body.innerText.includes('Close this isolated session?') && !!__btn('Keep worktree') && !!__btn('Remove worktree')`)
  check('3. closing an isolated session asks Keep worktree / Remove worktree', asks)
  await shot('close-ask')
  await evaluate(`__btn('Keep worktree').click()`)
  const gone = await waitFor(`!__rowOf('keeper')`)
  check('3b. Keep: the session closes, the worktree stays on disk', gone && !!dir && existsSync(dir) && !(await sessions()).some((x) => x.id === r.id))
}

// 4. Remove on a dirty worktree → shows it → second confirm → dir gone, branch kept
{
  writeFileSync(join(W1, 'wip.txt'), 'unsaved\n')
  await evaluate(`__rowOf('Fix Login').querySelector('button[title="Close session"]').click()`)
  await waitFor(`!!__btn('Remove worktree')`)
  await evaluate(`__btn('Remove worktree').click()`)
  const warned = await waitFor(`document.body.innerText.includes('Remove a worktree with unsaved work?') && document.body.innerText.includes('wip.txt') && !!__btn('Remove anyway')`)
  check('4. Remove on a dirty worktree: shows the dirty file and asks again (session still open)',
    warned && existsSync(W1) && (await sessions()).some((x) => x.name === 'Fix Login'))
  await shot('close-dirty')
  await evaluate(`__btn('Remove anyway').click()`)
  const gone = await waitFor(`!__rowOf('Fix Login')`)
  check('4b. second confirm: session closed, worktree dir gone, branch kept',
    gone && !existsSync(W1) && g('branch --list fix-login').trim() !== '')
}

cdpDone = true
try { cdp.close() } catch {}
reapChrome(); reapServer()
await Promise.all([tmpHome, dataDir, buildDir, chromeDir].map((d) => rm(d, { recursive: true, force: true }).catch(() => {})))
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
