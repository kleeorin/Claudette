// FILE-EDITOR REFRESH GUARD — does "reload from disk" reload, and does it ask first?
//
//   bash scratchpad/run-suite.sh editor-refresh-check.mjs
//
// Own server (4487), own vite (5287), own Chrome (CDP 9368). GROUP B: vite compiles the
// WORKING TREE, so a result here is evidence.
//
// ── WHAT IT COVERS ───────────────────────────────────────────────────────────────────
// The editor's load effect is keyed on `path` alone, so a file that changes underneath you
// — a Claude edit, a git checkout, another device — stays on screen as it was when the tab
// opened. The Reload button is the way back without closing and reopening the tab. Because
// it discards unsaved work it is gated behind a confirm, but ONLY when the file is dirty:
// a dialog you always dismiss is one you stop reading.
//
// ── MUTATION — the confirm is PINNED, not assumed ────────────────────────────────────
// As shipped: 8 passed / 0 failed.
// With the dirty check bypassed (`onClick={() => void doRefresh()}`, so it always refreshes
// immediately): **6 passed / 2 failed — [3] and [4]**, exactly as predicted.
// ★ [2], [5] and [6] stay GREEN under that mutation, and that is worth stating rather than
//   reading as reassurance: [5] passes because an immediate refresh also ends with the disk
//   text on screen, so it reaches the right end state by the wrong route. Only [3] and [4]
//   can see the confirm. Do not count the other four as coverage of it.
//
// ── [hole] ───────────────────────────────────────────────────────────────────────────
// Nothing here exercises a non-text preview (image/PDF), where refresh replaces the whole
// preview rather than patching `.text`; nor the error path when `api.fs.read` rejects
// mid-refresh. Both are reachable by inspection, neither is measured.
import { spawn, execFileSync } from 'child_process'
import { mkdtemp, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'
const PORT = 4487, WEB_PORT = 5287, CDP = 9368, TOKEN = 'refresh-probe'
const APP = `http://127.0.0.1:${WEB_PORT}`, API = `http://127.0.0.1:${PORT}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
import { withMarks, passed as pass, failed as fail } from './assert.mjs'
const ok = withMarks({ indent: '  ' })

const DATA = await mkdtemp(join(tmpdir(), 'refresh-data-'))
const PROJ = await mkdtemp(join(tmpdir(), 'refresh-proj-'))
execFileSync('git', ['-c', 'init.defaultBranch=main', '-C', PROJ, 'init', '-q'], { stdio: 'ignore' })
const FILE = join(PROJ, 'note.txt')
await writeFile(FILE, 'ORIGINAL-CONTENT-v1\n')

const server = spawn('npx', ['tsx', 'server/src/index.ts'], { env: { ...process.env, PORT: String(PORT), CLAUDETTE_TOKEN: TOKEN, CLAUDETTE_DATA_DIR: DATA, CLAUDETTE_ALLOW_UNSANDBOXED: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
let log = ''; server.stdout.on('data', d => log += d); server.stderr.on('data', d => log += d)
const web = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], { cwd: 'web', env: { ...process.env, PORT: String(PORT), WEB_PORT: String(WEB_PORT) }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
let wl = ''; web.stdout.on('data', d => wl += d); web.stderr.on('data', d => wl += d)
let chrome = null
const reap = () => { for (const p of [server, web, chrome]) { if (!p) continue; try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} } } }
process.on('exit', reap)
for (const s of ['SIGINT','SIGTERM','uncaughtException','unhandledRejection']) process.on(s, (e) => { reap(); if (e) console.error(e); process.exit(1) })
for (let i = 0; i < 90 && !log.includes('Server listening'); i++) await wait(500)
for (let i = 0; i < 90 && !wl.includes('ready in'); i++) await wait(500)
const hdr = { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` }
await fetch(`${API}/api/session/create`, { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'S', cwd: PROJ, rootDir: PROJ, sandbox: { enabled: false, mounts: [] } }) }).then(r => r.json())
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
if (!existsSync(CHROME)) { console.error('no chrome'); reap(); process.exit(1) }
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${await mkdtemp(join(tmpdir(), 'chrome-rf-'))}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900', 'about:blank'], { stdio: 'pipe', detached: true })
let ws
for (let i = 0; i < 40; i++) { try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); const p = l.find(t => t.type === 'page'); if (p) { ws = p.webSocketDebuggerUrl; break } } catch {} await wait(250) }
const cdp = new WebSocket(ws); await new Promise((r, j) => { cdp.on('open', r); cdp.on('error', j) })
let id = 0; const pend = new Map()
cdp.on('close', () => { console.error('chrome died'); reap(); process.exit(1) })
cdp.on('message', d => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const send = (method, params = {}) => { const i = ++id; cdp.send(JSON.stringify({ id: i, method, params })); return new Promise(r => pend.set(i, r)) }
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200)); return r.result?.result?.value }
const waitFor = async (e, ms = 25000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return true; await wait(200) } return false }

await send('Page.enable')
await send('Page.navigate', { url: `${APP}/api/auth?token=${TOKEN}` }); await wait(1200)
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!document.querySelector('aside')`, 40000); await wait(1500)
await ev(`window.__r = {
  btn: () => [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'') === 'Reload from disk') || null,
  editorText: () => { const c = document.querySelector('.cm-content'); return c ? c.innerText : null },
  dirtyDot: () => [...document.querySelectorAll('span')].some(s => s.title === 'Unsaved changes'),
  dialog: () => document.body.innerText.includes('Discard unsaved changes?'),
  clickText: (t) => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === t); if (!b) return false; b.click(); return true },
  openFile: (n) => { const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').includes(n)); if (!b) return false; b.dispatchEvent(new MouseEvent('dblclick', {bubbles:true,cancelable:true,view:window})); return true },
  dump: () => [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean).slice(0, 40).join(' | '),
}; true`)
await ev(`window.__r.clickText('Files')`); await wait(1200)
await ev(`window.__r.openFile('note.txt')`)
const clicked = await ev(`window.__r.openFile('note.txt')`)
const opened = await waitFor(`(window.__r.editorText()||'').includes('ORIGINAL-CONTENT-v1')`, 20000)
ok('PRECONDITION: the file opened in the editor', opened, opened ? '' : `openFile returned ${clicked}; buttons on screen: ${await ev('window.__r.dump()')}`)
if (!opened) { console.log('\n  ⚠ could not open the file — the checks below did not run'); console.log(`${pass} passed / ${fail} failed`); reap(); process.exit(1) }
ok('[1] the Reload button is present', await ev(`!!window.__r.btn()`))

// [2] clean refresh — no dialog, picks up a change made underneath
await writeFile(FILE, 'CHANGED-ON-DISK-v2\n')
await ev(`window.__r.btn().click()`)
const got2 = await waitFor(`(window.__r.editorText()||'').includes('CHANGED-ON-DISK-v2')`, 12000)
ok('[2] a CLEAN refresh reloads changed disk content with no prompt', got2 && !await ev(`window.__r.dialog()`))

// [3] dirty refresh prompts
await ev(`(()=>{const c=document.querySelector('.cm-content');c.focus();document.execCommand('insertText',false,'MY-UNSAVED-EDIT');return true})()`)
await wait(600)
const isDirty = await ev(`window.__r.dirtyDot()`)
ok('PRECONDITION: typing made it dirty', isDirty)
await ev(`window.__r.btn().click()`); await wait(600)
ok('[3] a DIRTY refresh asks before discarding', await ev(`window.__r.dialog()`))

// [4] cancel keeps the edit
await ev(`window.__r.clickText('Cancel')`); await wait(600)
ok('[4] Cancel keeps the unsaved edit', (await ev(`window.__r.editorText()`)||'').includes('MY-UNSAVED-EDIT') && await ev(`window.__r.dirtyDot()`))

// [5] confirm discards and reloads
await writeFile(FILE, 'THIRD-VERSION-v3\n')
await ev(`window.__r.btn().click()`); await wait(500)
await ev(`window.__r.clickText('Discard and reload')`)
const got5 = await waitFor(`(window.__r.editorText()||'').includes('THIRD-VERSION-v3')`, 12000)
ok('[5] Discard-and-reload replaces the edit with disk content', got5)
ok('[6] …and the dirty marker is cleared', !await ev(`window.__r.dirtyDot()`))
console.log(`\n${pass} passed / ${fail} failed`)
reap(); process.exit(fail ? 1 : 0)
