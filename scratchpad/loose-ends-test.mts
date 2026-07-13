// E2E for the Phase-1 loose ends: P1.4 (live permission-mode switch), P1.14
// (/clear restartFresh + /resume conversation routes), P1.19 (session persistence
// + restore across a server restart). Boots the real server against an isolated
// data dir, drives a real `claude` session. Run:
//   npx tsx scratchpad/loose-ends-test.mts
import { spawn } from 'child_process'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4333
const APP = `http://127.0.0.1:${PORT}`
const CWD = process.cwd()
let failed = 0
const ok = (c, m) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++ }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const post = (path, body) => fetch(`${APP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
const getj = (path) => fetch(`${APP}${path}`).then((r) => r.json())

const dataDir = await mkdtemp(join(tmpdir(), 'claudette-data-'))

let current = null
function boot() {
  // detached so we can SIGKILL the whole process group (npx → tsx → node server);
  // killing just the npx parent would leave the real server grandchild holding the port.
  const p = spawn('npx', ['tsx', 'server/src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDETTE_DATA_DIR: dataDir },
    cwd: CWD, stdio: 'pipe', detached: true,
  })
  p.stderr.on('data', () => {})
  current = p
  return p
}
function killServer(p) { try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} } }
// Never leave a zombie server holding the port, even if an assertion throws.
process.on('exit', () => { if (current) killServer(current) })
process.on('uncaughtException', (e) => { console.error(e); if (current) killServer(current); process.exit(1) })
async function waitHealth() { for (let i = 0; i < 60; i++) { try { if ((await fetch(`${APP}/api/health`)).ok) return } catch {} await wait(250) } throw new Error('server never came up') }

const readSaved = async () => JSON.parse(await readFile(join(dataDir, 'sessions.json'), 'utf8'))
const pollSaved = async (pred, tries = 40) => { for (let i = 0; i < tries; i++) { try { const s = await readSaved(); if (pred(s)) return s } catch {} await wait(200) } return null }

// --- boot #1 ------------------------------------------------------------------
let server = boot()
await waitHealth()

// Create a session (spawns real claude). claudeSessionId exists upfront, so the
// set persists on create — no need to wait for a model turn.
const { id } = await post('/api/session/create', { name: 'loose-ends', cwd: CWD })
ok(!!id, 'session created')

// P1.19 — persistence: the set is saved on create.
let saved = await pollSaved((s) => Array.isArray(s) && s.length === 1)
ok(saved && saved.length === 1, 'sessions.json has 1 saved session')
ok(saved?.[0]?.cwd === CWD && !!saved?.[0]?.claudeSessionId, 'saved session has cwd + claudeSessionId')
const origClaudeId = saved[0].claudeSessionId

// P1.4 — live permission-mode switch; the mode is persisted for restore.
const modeRes = await post('/api/session/setMode', { id, mode: 'plan' })
ok(['live', 'relaunched', 'restart'].includes(modeRes.applied), `setMode → applied=${modeRes.applied}`)
saved = await pollSaved((s) => s[0]?.permissionMode === 'plan')
ok(saved?.[0]?.permissionMode === 'plan', 'permission mode persisted (plan)')

// P1.14 — conversation routes (list + read-back shape).
const conv = await getj(`/api/session/conversations?cwd=${encodeURIComponent(CWD)}`)
ok(Array.isArray(conv.conversations), 'conversations route returns an array')
const readBack = await getj(`/api/session/conversation?cwd=${encodeURIComponent(CWD)}&id=does-not-exist`)
ok(Array.isArray(readBack.events) && readBack.events.length === 0, 'conversation read-back of unknown id → empty events')

// P1.14 — /clear (restartFresh): the claude session id rotates to a fresh one.
const rf = await post('/api/session/restartFresh', { id })
ok(rf.ok === true, 'restartFresh route ok')
saved = await pollSaved((s) => s[0]?.claudeSessionId && s[0].claudeSessionId !== origClaudeId)
ok(saved && saved[0].claudeSessionId !== origClaudeId, '/clear started a FRESH conversation (new claudeSessionId)')

killServer(server)
await wait(1500)

// --- boot #2 — restore --------------------------------------------------------
server = boot()
await waitHealth()
await wait(500)
const list = (await getj('/api/session/list')).sessions
ok(list.length >= 1 && list.some((s) => s.cwd === CWD && s.name === 'loose-ends'), 'restored the session on restart (P1.19)')

// cleanup: destroy the restored session, then kill.
for (const s of list) await post('/api/session/destroy', { id: s.id }).catch(() => {})
killServer(server)
await wait(500)
await rm(dataDir, { recursive: true, force: true }).catch(() => {})

console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
