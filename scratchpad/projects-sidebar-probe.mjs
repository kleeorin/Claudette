// PROJECTS — the sidebar in a real browser, desktop AND phone.
//
// Builds the CURRENT web tree to a temp dir (never the shared web/dist), boots a throwaway
// server on its own port with an isolated HOME / data dir (never the live :4319), sets up
// projects and sessions through the real HTTP API, then drives headless Chrome over CDP:
//   · a project header renders above its sessions, with name and count, and its sessions are
//     indented under it while an ungrouped one is not
//   · the chevron collapses it, the fold persists on the server and survives a reload
//   · the session menu offers Make project / Move to project / Remove from project by the rules
//     in lib/projectMenu (a different-cwd session is offered no Move), and Remove works
//   · the header "+" opens New session LOCKED to the project's directory
//   · Rename and Delete through the header menu; Delete's confirm says it ungroups, and after
//     it every session is still there
//   · at a phone viewport the header's actions are visible without hover
// The sessions it creates have no credentials (isolated HOME, CLAUDE_CONFIG_DIR removed), so
// they never reach the API; only their sidebar rows matter here.
//   node scratchpad/projects-sidebar-probe.mjs
import { spawn, execSync } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { existsSync, statSync, createReadStream, mkdirSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { join, extname, basename } from 'path'
import { WebSocket, WebSocketServer } from 'ws'
import { check, passed, failed } from './assert.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const SRV = 4341, APP_PORT = 4342, CDP = 9381
const API = `http://127.0.0.1:${SRV}`
const APP = `http://127.0.0.1:${APP_PORT}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const tmpHome = await mkdtemp(join(tmpdir(), 'pj-home-'))
const dataDir = await mkdtemp(join(tmpdir(), 'pj-data-'))
const buildDir = await mkdtemp(join(tmpdir(), 'pj-build-'))
const shotDir = process.env.SHOT_DIR || ''
const work = join(tmpHome, 'work', 'alphaproj'); mkdirSync(work, { recursive: true })
const other = join(tmpHome, 'work', 'betadir'); mkdirSync(other, { recursive: true })

execSync(`NODE_ENV=production npx vite build --outDir ${buildDir} --emptyOutDir --logLevel warn`, { cwd: join(ROOT, 'web'), stdio: 'inherit' })

const env = { ...process.env, PORT: String(SRV), HOST: '127.0.0.1', CLAUDETTE_NO_AUTH: '1', CLAUDETTE_DATA_DIR: dataDir, HOME: tmpHome }
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
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-pj-'))
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
const s1 = (await post('/api/session/create', { name: 'lead', cwd: work })).id
const made = await post('/api/project/fromSession', { sessionId: s1 })
const P = made.project
const s2 = (await post('/api/session/create', { name: 'second', cwd: '', projectId: P?.id })).id
const kid = (await post('/api/session/create', { name: 'kiddo', cwd: work, parentId: s1 })).id
const s3 = (await post('/api/session/create', { name: 'loner', cwd: other })).id
check('0. setup through the API: a project from a session, a second session in it, a subsession, one ungrouped',
  !!P && P.name === 'alphaproj' && !!s2 && !!kid && !!s3, JSON.stringify({ P, s2, kid, s3 }))

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
const load = async () => { await send('Page.navigate', { url: APP }); await waitFor(`!!document.querySelector('[data-testid="project-header"]')`) }

// helpers evaluated in the page
const H = `
  window.__hdr = (id) => document.querySelector('[data-testid="project-header"][data-project-id="' + id + '"]');
  window.__row = (name) => { const el = [...document.querySelectorAll('aside span, aside div')].find((e) => e.childElementCount === 0 && e.textContent.trim() === name); return el ? el.closest('.group') : null };
  window.__btn = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text));
  window.__pad = (el) => el ? parseFloat(getComputedStyle(el).paddingLeft) : -1;
  // The count is its own element (title "N sessions"); reading it off the header's whole text
  // cannot work, because the name runs straight into it ("alphaproj3" has no word boundary).
  window.__count = (id) => { const c = __hdr(id)?.querySelector('span[title$="session"], span[title$="sessions"]'); return c ? Number(c.textContent.trim()) : -1 };
`
await load()
await evaluate(H)

// 1. header + indent
{
  const info = await evaluate(`(() => { const h = __hdr('${P.id}'); return h && { name: h.textContent, count: __count('${P.id}') } })()`)
  check('1. the project header renders with its name and a count of 3 (two sessions + a subsession)',
    !!info && /alphaproj/.test(info.name) && info.count === 3, JSON.stringify(info))
  const pads = await evaluate(`({ lead: __pad(__row('lead')), second: __pad(__row('second')), loner: __pad(__row('loner')) })`)
  check('1b. sessions in the project are indented under it; the ungrouped one is not',
    pads.lead > pads.loner && pads.second > pads.loner && pads.loner > 0, JSON.stringify(pads))
  const order = await evaluate(`(() => { const h = __hdr('${P.id}'), a = __row('lead'), b = __row('second'); return !!(h && a && b && (h.compareDocumentPosition(a) & 4) && (h.compareDocumentPosition(b) & 4)) })()`)
  check("1c. the project's sessions come AFTER its header in the list", order === true)
  await shot('desktop-expanded')
}

// 2. collapse persists
{
  await evaluate(`__hdr('${P.id}').querySelector('[role="button"]').click()`)
  const gone = await waitFor(`!__row('lead') && !__row('second') && !!__row('loner')`)
  const srv = (await getJ('/api/project/list')).projects.find((p) => p.id === P.id)
  check('2. the chevron collapses the project: its sessions leave the list, the ungrouped one stays', gone)
  check('2b. …and the fold is persisted on the SERVER', srv?.collapsed === true, JSON.stringify(srv))
  await load(); await evaluate(H)
  check('2c. …and survives a reload', await waitFor(`!!__hdr('${P.id}') && !__row('lead')`, 6000))
  await shot('desktop-collapsed')
  await evaluate(`__hdr('${P.id}').querySelector('[role="button"]').click()`)
  await waitFor(`!!__row('lead')`)
}

// 3. session menu rules
const openMenuFor = async (name) => {
  await evaluate(`(() => { document.body.click(); const r = __row('${name}'); r.querySelector('[aria-label="Session actions"]').click() })()`)
  await wait(300)
}
{
  await openMenuFor('loner')
  const loner = await evaluate(`({ make: !!__btn('📁 Make project'), move: !!__btn('📂 Move to project'), remove: !!__btn('⤴ Remove from project') })`)
  check('3. an ungrouped session in ANOTHER directory: Make project yes, Move no (cwd differs), Remove no',
    loner.make && !loner.move && !loner.remove, JSON.stringify(loner))
  await openMenuFor('second')
  const second = await evaluate(`({ make: !!__btn('📁 Make project'), remove: !!__btn('⤴ Remove from project') })`)
  check('3b. a session in the project: Remove yes, Make project no', second.remove && !second.make, JSON.stringify(second))
  await evaluate(`__btn('⤴ Remove from project').click()`)
  const ok = await waitFor(`__count('${P.id}') === 2 && __pad(__row('second')) === __pad(__row('loner'))`)
  const srvS2 = (await getJ('/api/session/list')).sessions.find((s) => s.id === s2)
  check('3c. Remove from project ungroups it (count 3 → 2, row un-indented, server agrees)', ok && srvS2 && !srvS2.projectId, JSON.stringify(srvS2?.projectId))
  await openMenuFor('kiddo')
  const kidM = await evaluate(`({ make: !!__btn('📁 Make project'), move: !!__btn('📂 Move to project'), remove: !!__btn('⤴ Remove from project') })`)
  check('3d. a SUBSESSION offers no project actions', !kidM.make && !kidM.move && !kidM.remove, JSON.stringify(kidM))
  await openMenuFor('second')
  const mv = await evaluate(`!!__btn('📂 Move to project')`)
  check('3e. the ungrouped same-directory session IS offered Move to project', mv === true)
  await evaluate(`document.body.click()`)
}

// 4. "+" opens New session locked to the project's directory
{
  await evaluate(`__hdr('${P.id}').querySelector('[aria-label^="New session in"]').click()`)
  await waitFor(`/New session in/.test(document.body.innerText)`)
  const dlg = await evaluate(`(() => { const i = [...document.querySelectorAll('input')].find((x) => x.value === ${JSON.stringify(work)}); return { found: !!i, readOnly: !!i?.readOnly, browse: !!__btn('Browse') } })()`)
  check('4. the header "+" opens New session in <project> with the directory pre-set and READ-ONLY, no Browse',
    dlg.found && dlg.readOnly && !dlg.browse, JSON.stringify(dlg))
  await shot('desktop-new-in-project')
  await evaluate(`__btn('Cancel').click()`)
}

// 5. rename + delete through the header menu
{
  await evaluate(`__hdr('${P.id}').querySelector('[aria-label="Project actions"]').click()`)
  await wait(200)
  await evaluate(`__btn('✎ Rename').click()`)
  await wait(200)
  await evaluate(`(() => { const i = document.querySelector('input[aria-label="Project name"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Renamed Alpha'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`)
  const renamed = await waitFor(`/Renamed Alpha/.test(__hdr('${P.id}')?.textContent ?? '')`)
  check('5. Rename through the header menu applies (and comes back via project:list)', renamed && (await getJ('/api/project/list')).projects.some((p) => p.name === 'Renamed Alpha'))
  await evaluate(`__hdr('${P.id}').querySelector('[aria-label="Project actions"]').click()`)
  await wait(200)
  await evaluate(`__btn('🗑 Delete project').click()`)
  await waitFor(`/ungroups/.test(document.body.innerText)`)
  const says = await evaluate(`/ungroups/.test(document.body.innerText) && /No session is closed/.test(document.body.innerText)`)
  check("5b. Delete's confirm says it UNGROUPS and closes no session", says === true)
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Delete project').click()`)
  const gone = await waitFor(`!__hdr('${P.id}') && !!__row('lead') && !!__row('second') && !!__row('kiddo') && !!__row('loner')`)
  const left = (await getJ('/api/session/list')).sessions.length
  check('5c. after Delete the header is gone and EVERY session is still there', gone && left === 4, `sessions=${left}`)
}

// 6. phone viewport — headers first-class
{
  const P2 = (await post('/api/project/fromSession', { sessionId: s1 })).project
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await load(); await evaluate(H)
  await evaluate(`document.querySelector('[aria-label="Open sessions"]')?.click()`)
  await wait(400)
  const phone = await evaluate(`(() => { const h = __hdr('${P2.id}'); if (!h) return null; const plus = h.querySelector('[aria-label^="New session in"]'), dots = h.querySelector('[aria-label="Project actions"]'); const r = h.getBoundingClientRect(); return { plus: getComputedStyle(plus).opacity, dots: getComputedStyle(dots).opacity, onScreen: r.left >= 0 && r.right <= innerWidth && r.width > 0, plusW: plus.getBoundingClientRect().width } })()`)
  check('6. phone: the header is on screen with its + and ⋯ VISIBLE without hover, finger-sized',
    !!phone && phone.plus === '1' && phone.dots === '1' && phone.onScreen && phone.plusW >= 24, JSON.stringify(phone))
  await shot('phone-sidebar')
}

cdpDone = true
try { cdp.close() } catch {}
reapChrome(); reapServer()
await Promise.all([tmpHome, dataDir, buildDir, chromeDir].map((d) => rm(d, { recursive: true, force: true }).catch(() => {})))
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
