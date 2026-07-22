// E2E for the inline edit-proposal "super editor" (DiffEditor + FileEditorView).
// Drives the REAL built app in headless Chrome against a throwaway :4321 server.
// No live Claude needed: we inject a `session:list` (one fake session) and a
// `session:permission` (an Edit on a REAL temp file the server reads) straight into
// the app's live WS, then assert:
//   - the target file auto-opens as a tab and renders an inline +/- diff
//   - CodeMirror merge chunks + per-hunk Accept/Reject controls are present
//   - clicking "Apply accepted" sends a session:permission ALLOW whose updatedInput
//     reconstructs the accepted whole-file text (Edit → old_string=disk, new_string=result)
//   - "Reject all" sends a DENY
//   node scratchpad/super-editor-test.mjs
//
// NOTE: in the hardened sandbox `web/dist` is READ-ONLY, so we can't replace the
// bundle the backend serves. Instead we build the app to a writable temp dir and
// run a thin proxy on :4321 that serves THAT build while forwarding /api + /ws to
// the real backend on :4322 — so the test drives the freshly-built code.
import { spawn, execSync } from 'child_process'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { createReadStream, existsSync, statSync } from 'fs'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { join, extname } from 'path'
import { WebSocket, WebSocketServer } from 'ws'

const ROOT = new URL('..', import.meta.url).pathname
const APP = 'http://127.0.0.1:4321'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// --- a real file on disk for the server to read as the diff's "before" ----------
const workDir = await mkdtemp(join(tmpdir(), 'super-editor-'))
const FILE = join(workDir, 'demo.ts')
const BASE = 'export function greet(name: string) {\n  return "hi " + name\n}\n'
await writeFile(FILE, BASE)

// --- build the current web source to a writable temp dir ------------------------
const buildDir = await mkdtemp(join(tmpdir(), 'se-build-'))
execSync(`NODE_ENV=production npx vite build --outDir ${buildDir} --emptyOutDir --logLevel warn`, { cwd: join(ROOT, 'web'), stdio: 'inherit' })

// --- boot the real backend on :4322 (no auth, isolated data dir) ----------------
const dataDir = await mkdtemp(join(tmpdir(), 'super-editor-data-'))
const env = { ...process.env, PORT: '4322', HOST: '127.0.0.1', CLAUDETTE_NO_AUTH: '1', CLAUDETTE_DATA_DIR: dataDir }
delete env.CLAUDETTE_TOKEN
const server = spawn('npx', ['tsx', 'src/index.ts'], { cwd: join(ROOT, 'server'), env, stdio: 'pipe', detached: true })
server.stderr.on('data', (d) => process.env.DEBUG && process.stderr.write(`[srv] ${d}`))
async function waitServer() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch('http://127.0.0.1:4322/api/health'); if (r.ok) return } catch {}
    await wait(250)
  }
  throw new Error('server never came up')
}
await waitServer()

// --- proxy on :4321: static(buildDir) + /api,/jupyter → :4322 + /ws bridge -------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' }
const proxy = createServer(async (req, res) => {
  const url = req.url || '/'
  if (url.startsWith('/api') || url.startsWith('/jupyter')) {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const r = await fetch(`http://127.0.0.1:4322${url}`, { method: req.method, headers: { ...req.headers, host: '127.0.0.1:4322' }, body, redirect: 'manual' })
    const buf = Buffer.from(await r.arrayBuffer())
    const h = Object.fromEntries(r.headers); delete h['content-encoding']; delete h['content-length']
    res.writeHead(r.status, h); res.end(buf); return
  }
  let p = join(buildDir, url.split('?')[0])
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(buildDir, 'index.html')  // SPA fallback
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' })
  createReadStream(p).pipe(res)
})
const wss = new WebSocketServer({ noServer: true })
proxy.on('upgrade', (req, socket, head) => {
  if (!(req.url || '').startsWith('/ws')) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (client) => {
    const up = new WebSocket(`ws://127.0.0.1:4322${req.url}`)
    const q = []
    up.on('open', () => { for (const m of q) up.send(m); q.length = 0 })
    client.on('message', (m) => (up.readyState === 1 ? up.send(m.toString()) : q.push(m.toString())))
    up.on('message', (m) => client.readyState === 1 && client.send(m.toString()))
    const bye = () => { try { client.close() } catch {} ; try { up.close() } catch {} }
    client.on('close', bye); up.on('close', bye); client.on('error', bye); up.on('error', bye)
  })
})
await new Promise((r) => proxy.listen(4321, '127.0.0.1', r))

// --- headless Chrome + CDP ------------------------------------------------------
const CHROME_BIN = process.env.CHROME_BIN
  || (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : null)
  || execSync(`ls ${ROOT}.chrome-headless/chrome/linux-*/chrome-linux64/chrome 2>/dev/null | head -1`).toString().trim()
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-se-'))
const chrome = spawn(CHROME_BIN, [
  '--headless=new', '--remote-debugging-port=9358', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1500,950',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9358/json')).json()
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
const pend = new Map()
cdp.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (method, params = {}) => { const id = ++cdpId; return new Promise((res) => { pend.set(id, res); cdp.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error('page eval threw: ' + JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}
async function waitFor(expr, ms = 12000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) } throw new Error(`timeout: ${expr}`) }

// Capture the app's WS + record everything it SENDS (to read back the decision).
const SHIM = `
  window.__sent = [];
  const RealWS = window.WebSocket;
  class CapWS extends RealWS {
    constructor(...a) {
      super(...a);
      if (String(a[0]).includes('/ws')) {
        window.__appws = this;
        const origSend = this.send.bind(this);
        this.send = (d) => { try { window.__sent.push(JSON.parse(d)) } catch {} ; return origSend(d) };
      }
    }
  }
  window.WebSocket = CapWS;
`
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })

const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`) }
const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)

try {
  await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
  await waitFor(`!!window.__appws`)
  await wait(300)

  // 1. Inject a session → it becomes active.
  await feed({ type: 'session:list', sessions: [
    { id: 's1', name: 'demo', cwd: workDir, rootDir: workDir, state: 'idle' },
  ] })
  await waitFor(`!!window.__appws`)
  const active = await waitFor(`(()=>{const el=[...document.querySelectorAll('*')].find(n=>n.textContent==='demo');return !!el})()`).then(() => true).catch(() => false)
  check('session appears in sidebar', active)

  // 2. Claude requests an Edit on the real file.
  await feed({ type: 'session:permission', id: 's1', request: {
    requestId: 'r1', toolName: 'Edit', displayName: 'Edit', toolUseId: 'tu1', suggestions: [],
    input: { file_path: FILE, old_string: 'return "hi " + name', new_string: 'return `hi ${name}!`' },
  } })

  // 3. The file auto-opens and the inline diff renders.
  await waitFor(`!!document.querySelector('.cm-merge-revert, .cm-changedLine, .cm-deletedChunk')`, 12000)
  const hasReviewBar = await evaluate(`!!([...document.querySelectorAll('*')].find(n=>/Claude proposes changes/.test(n.textContent)&&n.children.length<3))`)
  check('inline diff + review bar rendered', hasReviewBar)
  const chunkCount = await evaluate(`document.querySelectorAll('.cm-changedLine').length + document.querySelectorAll('.cm-deletedChunk').length`)
  check('diff has changed/deleted chunks', chunkCount > 0, `chunks=${chunkCount}`)
  const controls = await evaluate(`document.querySelectorAll('.cm-merge-revert, .cm-merge-accept, .cm-changeButtons button, [name=accept], [name=reject]').length`)
  check('per-hunk accept/reject controls present', controls > 0 || (await evaluate(`document.body.innerHTML.includes('cm-merge')`)), `controls=${controls}`)

  // 4. Accept the hunk with CodeMirror's OWN per-hunk ✓ (name=accept) — deciding every
  // hunk in-editor must auto-resolve the permission everywhere (the reported bug).
  const acceptBtns = await evaluate(`document.querySelectorAll('button[name=accept]').length`)
  check('per-hunk accept (name=accept) button present', acceptBtns > 0, `n=${acceptBtns}`)
  // CodeMirror binds the control to mousedown (not click).
  const applied = await evaluate(`(()=>{const b=document.querySelector('button[name=accept]');if(!b)return false;b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));return true})()`)
  check('per-hunk accept clicked (no Apply button)', applied === true)
  await wait(400)
  const decision = await evaluate(`window.__sent.filter(m=>m.type==='session:permission'&&m.requestId==='r1').slice(-1)[0]?.decision ?? null`)
  const wantNew = 'export function greet(name: string) {\n  return \`hi \${name}!\`\n}\n'
  check('decision is ALLOW', decision && decision.behavior === 'allow', JSON.stringify(decision)?.slice(0, 120))
  check('updatedInput old_string = disk base', decision?.updatedInput?.old_string === BASE)
  check('updatedInput new_string = accepted result', decision?.updatedInput?.new_string === wantNew,
    JSON.stringify(decision?.updatedInput?.new_string))

  // 4b. LIVE update: applying resolves the chat permission AND swaps the editor to the
  // accepted text at once — no waiting on the chat card, no stale view.
  await waitFor(`!document.querySelector('.cm-deletedChunk, .cm-changedLine')`, 4000)  // diff gone
  const cardGone = await evaluate(`!([...document.querySelectorAll('button')].find(x=>/Allow once|Apply accepted/.test(x.textContent)))`)
  check('permission resolved (chat card + review bar gone)', cardGone)
  const shownNow = await evaluate(`(document.querySelector('.cm-content')?.textContent||'')`)
  check('editor shows accepted text live (optimistic)', shownNow.includes('hi ${name}!'), shownNow.slice(0, 60))
  // The CLI now writes the file (old_string=disk → new_string=result); simulate it and
  // confirm the disk-reconcile keeps the new text (doesn't revert to the old load).
  await writeFile(FILE, decision.updatedInput.new_string)
  await wait(700)
  const shownAfter = await evaluate(`(document.querySelector('.cm-content')?.textContent||'')`)
  check('editor stays on new text after disk reconcile', shownAfter.includes('hi ${name}!'), shownAfter.slice(0, 60))
  check('disk has the accepted change', (await readFile(FILE, 'utf8')) === wantNew)

  // 5. Reject flow: new permission → Reject all → DENY, editor returns to current file.
  await feed({ type: 'session:permission', id: 's1', request: {
    requestId: 'r2', toolName: 'Edit', displayName: 'Edit', toolUseId: 'tu2', suggestions: [],
    input: { file_path: FILE, old_string: 'greet', new_string: 'welcome' },
  } })
  await waitFor(`!!([...document.querySelectorAll('button')].find(x=>/Reject all/.test(x.textContent)))`, 12000)
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Reject all/.test(x.textContent));b.click();return true})()`)
  await wait(250)
  const deny = await evaluate(`window.__sent.filter(m=>m.type==='session:permission'&&m.requestId==='r2').slice(-1)[0]?.decision ?? null`)
  check('Reject all sends DENY', deny && deny.behavior === 'deny', JSON.stringify(deny))

  // 6. Chat-side Allow ALSO updates the editor live (not just the on-disk file).
  await writeFile(FILE, wantNew)   // current disk state after step 4
  await feed({ type: 'session:permission', id: 's1', request: {
    requestId: 'r3', toolName: 'Edit', displayName: 'Edit', toolUseId: 'tu3', suggestions: [],
    input: { file_path: FILE, old_string: 'greet', new_string: 'salute' },
  } })
  await waitFor(`!!document.querySelector('.cm-deletedChunk, .cm-changedLine')`, 12000)
  // Click "Allow once" in the chat permission card (NOT the editor's Apply button).
  const allowClicked = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Allow once');if(!b)return false;b.click();return true})()`)
  check('chat "Allow once" clicked', allowClicked === true)
  // Simulate the CLI applying the original edit to disk, then assert the editor reloads.
  await writeFile(FILE, wantNew.replace('greet', 'salute'))
  await wait(900)
  const afterAllow = await evaluate(`(document.querySelector('.cm-content')?.textContent||'')`)
  check('editor reloads live after chat Allow', afterAllow.includes('salute') && !afterAllow.includes('greet'), afterAllow.slice(0, 60))

  // 7. TOGGLE OFF + CLOSED file → no editor popup (edit stays in the chat card).
  const wasPressed = await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/auto-open editor for edits/.test(x.getAttribute('aria-label')||''));if(!b)return null;const was=b.getAttribute('aria-pressed');b.click();return was})()`)
  await wait(150)  // let React re-render before reading the new pressed state
  const nowPressed = await evaluate(`([...document.querySelectorAll('button')].find(x=>/auto-open editor for edits/.test(x.getAttribute('aria-label')||''))?.getAttribute('aria-pressed'))`)
  check('auto-open toggle found + flips off', wasPressed === 'true' && nowPressed === 'false', `${wasPressed}→${nowPressed}`)
  const FILE2 = join(workDir, 'other.ts')
  await writeFile(FILE2, 'export const x = 1\n')
  await feed({ type: 'session:permission', id: 's1', request: {
    requestId: 'r4', toolName: 'Edit', displayName: 'Edit', toolUseId: 'tu4', suggestions: [],
    input: { file_path: FILE2, old_string: 'export const x = 1', new_string: 'export const x = 2' },
  } })
  // The chat card must appear, but NO editor tab/diff for the closed file.
  await waitFor(`!!([...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Allow once'))`, 8000)
  await wait(300)
  const noPopup = await evaluate(`!document.querySelector('.cm-deletedChunk, .cm-changedLine') && !([...document.querySelectorAll('*')].find(n=>/Claude proposes changes/.test(n.textContent)&&n.children.length<3)) && (document.querySelector('.cm-content')?.textContent||'').includes('salute')`)
  check('toggle off + closed → no editor popup (chat card only)', noPopup === true)
  // Resolve r4 via the chat card to clean up.
  await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Deny');b&&b.click();return true})()`)
  await wait(200)

  // 8. TOGGLE OFF but file already OPEN → still shows the inline diff.
  await feed({ type: 'session:permission', id: 's1', request: {
    requestId: 'r5', toolName: 'Edit', displayName: 'Edit', toolUseId: 'tu5', suggestions: [],
    input: { file_path: FILE, old_string: 'salute', new_string: 'hail' },
  } })
  const openStillDiffs = await waitFor(`!!document.querySelector('.cm-deletedChunk, .cm-changedLine')`, 8000).then(() => true).catch(() => false)
  check('toggle off + already open → diff still shows', openStillDiffs === true)
} catch (e) {
  check('test run completed', false, String(e))
} finally {
  chrome.kill('SIGKILL')
  try { proxy.close() } catch {}
  try { process.kill(-server.pid, 'SIGKILL') } catch { server.kill('SIGKILL') }   // whole tree (npx → tsx)
  await rm(workDir, { recursive: true, force: true }).catch(() => {})
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  await rm(buildDir, { recursive: true, force: true }).catch(() => {})
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
