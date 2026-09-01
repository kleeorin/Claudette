// Regression test for the "/clear sometimes does nothing, had to do it twice" bug.
// Root cause: emptying the transcript is exactly the auto-resume trigger, and an
// auto-resume that's already in-flight (started on mount for a RESTORED session) would
// complete its fetch and reload the old conversation OVER the /clear. The fix marks the
// session aborted so the in-flight pull bails.
//
// Harness (same as super-editor-test): build web → temp dir, run the real backend with
// an isolated HOME (so a fixture conversation lands in an isolated ~/.claude/projects),
// and a thin proxy that serves the build + forwards /api,/ws to the backend — with an
// ARTIFICIAL DELAY on readConversation so we can fire /clear mid-fetch deterministically.
//   node scratchpad/clear-race-test.mjs
import { spawn, execSync } from 'child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { createReadStream, existsSync, statSync } from 'fs'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { join, extname } from 'path'
import { WebSocket, WebSocketServer } from 'ws'

const ROOT = new URL('..', import.meta.url).pathname
// Own port, not the shared :4321. super-editor-test.mjs ALSO binds a proxy on 4321, so the
// two collided with each other — and :4321 is additionally the port an operator's manual
// dev server uses, which would make this proxy fail EADDRINUSE on a developer's machine.
const APP = 'http://127.0.0.1:4329'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const READ_DELAY = 2000   // ms the proxy holds readConversation, so /clear lands mid-fetch

const tmpHome = await mkdtemp(join(tmpdir(), 'clr-home-'))
const workDir = await mkdtemp(join(tmpdir(), 'clr-cwd-'))
const dataDir = await mkdtemp(join(tmpdir(), 'clr-data-'))
const buildDir = await mkdtemp(join(tmpdir(), 'clr-build-'))

// --- fixture conversation on disk (what auto-resume would pull) -----------------
const MARKER = 'OLDCONVERSATIONMARKER42'
const convId = 'conv-old-1'
const encoded = workDir.replace(/[^a-zA-Z0-9]/g, '-')
const projDir = join(tmpHome, '.claude', 'projects', encoded)
await mkdir(projDir, { recursive: true })
await writeFile(join(projDir, `${convId}.jsonl`), [
  { type: 'user', uuid: 'u1', timestamp: '2026-07-22T10:00:00Z', message: { role: 'user', content: 'earlier question' } },
  { type: 'assistant', uuid: 'a1', timestamp: '2026-07-22T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: MARKER }] } },
].map((l) => JSON.stringify(l)).join('\n') + '\n')

// --- build web to a temp dir ----------------------------------------------------
execSync(`NODE_ENV=production npx vite build --outDir ${buildDir} --emptyOutDir --logLevel warn`, { cwd: join(ROOT, 'web'), stdio: 'inherit' })

// --- backend on :4327 with the isolated HOME ------------------------------------
const env = { ...process.env, PORT: '4327', HOST: '127.0.0.1', CLAUDETTE_NO_AUTH: '1', CLAUDETTE_DATA_DIR: dataDir, HOME: tmpHome }
// ISOLATING $HOME IS NOT ENOUGH. The server resolves its project dir through
// claudeConfigDir(), which prefers $CLAUDE_CONFIG_DIR and only falls back to
// homedir()/.claude — and this env is a `...process.env` spread, so an inherited
// CLAUDE_CONFIG_DIR silently wins over the tmpHome we just set. Every Claudette sandbox
// sets that variable, so running this suite from inside one sent the server looking for
// the fixture conversation in the REAL config dir, found nothing, and failed only the
// positive control at :131 — leaving the three race assertions passing VACUOUSLY, because
// with no conversation served there was nothing for auto-resume to race against. A test
// that isolates one of two config roots is not isolated.
delete env.CLAUDE_CONFIG_DIR
delete env.CLAUDETTE_TOKEN
const server = spawn('npx', ['tsx', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: 'pipe', detached: true })
server.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(`[srv] ${d}`))
for (let i = 0; i < 80; i++) { try { if ((await fetch('http://127.0.0.1:4327/api/health')).ok) break } catch {} await wait(250) }

// --- proxy on :4329 (delays readConversation) -----------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }
const proxy = createServer(async (req, res) => {
  const url = req.url || '/'
  if (url.startsWith('/api') || url.startsWith('/jupyter')) {
    // The exact endpoint auto-resume awaits second — hold it so /clear can land first.
    if (url.startsWith('/api/session/conversation?')) await wait(READ_DELAY)
    const chunks = []; for await (const c of req) chunks.push(c)
    const r = await fetch(`http://127.0.0.1:4327${url}`, { method: req.method, headers: { ...req.headers, host: '127.0.0.1:4327' }, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'manual' })
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
    const up = new WebSocket(`ws://127.0.0.1:4327${req.url}`)
    const q = []
    up.on('open', () => { for (const m of q) up.send(m); q.length = 0 })
    client.on('message', (m) => (up.readyState === 1 ? up.send(m.toString()) : q.push(m.toString())))
    up.on('message', (m) => client.readyState === 1 && client.send(m.toString()))
    const bye = () => { try { client.close() } catch {} ; try { up.close() } catch {} }
    client.on('close', bye); up.on('close', bye); client.on('error', bye); up.on('error', bye)
  })
})
await new Promise((r) => proxy.listen(4329, '127.0.0.1', r))

// --- headless Chrome + CDP ------------------------------------------------------
const CHROME_BIN = process.env.CHROME_BIN
  || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null)
  || execSync(`ls ${ROOT}.chrome-headless/chrome/linux-*/chrome-linux64/chrome 2>/dev/null | head -1`).toString().trim()
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-clr-'))
const chrome = spawn(CHROME_BIN, ['--headless=new', '--remote-debugging-port=9360', `--user-data-dir=${chromeDir}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900', 'about:blank'], { stdio: 'pipe', detached: true })

// Reap the browser on EVERY exit path, not just the happy one (see find-diff-check).
// Reap the SERVER too, not just at the end of the happy path. This test runs its backend
// with CLAUDETTE_NO_AUTH=1, so an orphan is an UNAUTHENTICATED server left listening.
// It used to sit on :4322 — the port auth-loopback-test.mjs uses — and a leaked instance
// silently hijacked that run, making the security test report 8 false failures including
// "WS upgrade refused without token". A security alarm that cries wolf is worse than none.
// Two independent fixes, deliberately both: the port moved to :4327 so the collision
// cannot recur, and the reap below stops the leak itself.
const reapServer = () => { try { process.kill(-server.pid, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
// Reap by process GROUP, not by pid — the same discipline this file uses for its server,
// where it IS load-bearing (`npx` forks the real node, so killing the wrapper by pid can
// strand the port). For Chrome it is defence in depth only: measured, the bare kill did
// not orphan it. See rule 3 in scratchpad/port-and-reap-lint.mts.
const reapChrome = () => { try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} } }
process.on('exit', () => { reapChrome(); reapServer() })
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapChrome(); reapServer(); if (e) console.error(e); process.exit(1) })
}
async function cdpTarget() { for (let i = 0; i < 40; i++) { try { const list = await (await fetch('http://127.0.0.1:9360/json')).json(); const page = list.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl } catch {} await wait(250) } throw new Error('no CDP target') }
const cdp = new WebSocket(await cdpTarget())
await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej) })
let cdpId = 0; const pend = new Map()
// A CDP reply is awaited on a promise that ONLY the socket can resolve, so if Chrome dies
// mid-run — crash, OOM, an external pkill — every pending send() hangs forever and the
// harness sleeps in ep_poll holding its ports until someone hunts it down. Abort loudly
// instead. No reap() here on purpose: process.exit() runs the process.on('exit') handlers,
// which already cover every child. `cdpDone` keeps this off the DELIBERATE teardown below,
// where the very same close event is expected and must not be read as a failure.
let cdpDone = false
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died; aborting rather than hanging'); process.exit(1) })
cdp.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (method, params = {}) => { const id = ++cdpId; return new Promise((res) => { pend.set(id, res); cdp.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value }
async function waitFor(expr, ms = 12000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) } throw new Error(`timeout: ${expr}`) }

const SHIM = `const R=window.WebSocket;class C extends R{constructor(...a){super(...a);if(String(a[0]).includes('/ws'))window.__appws=this}}window.WebSocket=C;`
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
await send('Page.navigate', { url: `${APP}/` })

import { check, results, failures as failed } from './assert.mjs'
const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)

try {
  await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
  await waitFor(`!!window.__appws`)
  await wait(300)

  // Positive control: the backend really serves the fixture conversation (so absent the
  // fix, auto-resume WOULD reload MARKER into the transcript).
  const served = await evaluate(`fetch('/api/session/conversation?cwd=${encodeURIComponent(workDir)}&id=${convId}').then(r=>r.json()).then(j=>JSON.stringify(j.events).includes('${MARKER}')).catch(()=>false)`)
  check('backend serves the fixture conversation', served === true)

  // Inject a RESTORED session (not created via UI → not "fresh" → auto-resume eligible).
  await feed({ type: 'session:list', sessions: [{ id: 's1', name: 'restored', cwd: workDir, rootDir: workDir, state: 'idle' }] })
  await waitFor(`!!document.querySelector('textarea')`)
  // Auto-resume has now fired: listConversations resolved, readConversation is holding
  // in the proxy delay. Fire /clear during that window.
  await wait(500)
  const preClear = await evaluate(`document.body.innerText.includes('${MARKER}')`)
  check('marker not shown yet (auto-resume mid-fetch)', preClear === false)

  const cleared = await evaluate(`(()=>{const ta=document.querySelector('textarea');if(!ta)return false;const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;set.call(ta,'/clear');ta.dispatchEvent(new Event('input',{bubbles:true}));ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return true})()`)
  check('/clear submitted during the fetch window', cleared === true)

  // Let the delayed readConversation resolve; the in-flight auto-resume must ABORT.
  await wait(READ_DELAY + 800)
  const leaked = await evaluate(`document.body.innerText.includes('${MARKER}')`)
  check('old conversation did NOT come back after /clear', leaked === false, leaked ? 'MARKER reappeared (race not fixed)' : '')
} catch (e) {
  check('test run completed', false, String(e))
} finally {
  cdpDone = true   // deliberate teardown from here — the CDP close below is expected
  reapChrome()
  try { proxy.close() } catch {}
  try { process.kill(-server.pid, 'SIGKILL') } catch { server.kill('SIGKILL') }
  for (const d of [tmpHome, workDir, dataDir, buildDir]) await rm(d, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
