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
import { check as ok, failed } from './assert.mjs'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// A token is ALWAYS required, even on loopback (SANDBOX.md control-plane escape). The
// same token is pinned across BOTH boots so the restore-after-restart leg keeps working.
const TOKEN = 'loose-ends-token-loose-ends-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

// Report a non-2xx instead of letting `r.json()` flatten it into a shapeless object. A 401
// used to arrive at the first assertion as `id === undefined`, then take out every later
// step with `Cannot read properties of null` — three failures and a stack trace, all
// describing one unauthenticated request.
const post = async (path, body) => {
  const r = await fetch(`${APP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify(body) })
  const text = await r.text()
  if (!r.ok) { console.error(`   ✗ POST ${path} → HTTP ${r.status}: ${text.slice(0, 300)}`); dumpServer() }
  try { return JSON.parse(text) } catch { return {} }
}
const getj = async (path) => {
  const r = await fetch(`${APP}${path}`, { headers: AUTH })
  const text = await r.text()
  if (!r.ok) { console.error(`   ✗ GET ${path} → HTTP ${r.status}: ${text.slice(0, 300)}`); dumpServer() }
  try { return JSON.parse(text) } catch { return {} }
}

const dataDir = await mkdtemp(join(tmpdir(), 'claudette-data-'))

// Keep the server's stderr instead of discarding it — swallowing it is why an auth
// rejection presented as a null-property TypeError with no visible cause.
let serverErr = []
function dumpServer() {
  if (!serverErr.length) return
  console.error('--- server stderr (tail) ---')
  console.error(serverErr.join('').trimEnd())
  console.error('--- end server stderr ---')
}

let current = null
function boot() {
  // detached so we can SIGKILL the whole process group (npx → tsx → node server);
  // killing just the npx parent would leave the real server grandchild holding the port.
  const p = spawn('npx', ['tsx', 'server/src/index.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDETTE_DATA_DIR: dataDir, CLAUDETTE_TOKEN: TOKEN },
    cwd: CWD, stdio: 'pipe', detached: true,
  })
  serverErr = []   // per-boot, so a dump after a restart shows THAT server's output
  p.stderr.on('data', (d) => { serverErr.push(d.toString()); if (serverErr.length > 80) serverErr.shift() })
  current = p
  return p
}
function killServer(p) { try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} } }
// Never leave a zombie server holding the port, even if an assertion throws.
process.on('exit', () => { if (current) killServer(current) })
// …and on the SIGNAL paths too. `process.on('exit')` does not fire for SIGINT/SIGTERM, so
// a Ctrl-C used to orphan the detached child and strand its port. This child is
// CLAUDETTE_TOKEN-protected rather than no-auth, so an orphan is a stuck port rather than
// an open server — but a stuck port is exactly what makes the NEXT run report false
// failures against a server it did not start.
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const) {
  process.on(sig, (e?: unknown) => { if (current) killServer(current); if (e) console.error(e); process.exit(1) })
}
process.on('uncaughtException', (e) => { console.error(e); if (current) killServer(current); process.exit(1) })
// /api/health is in the auth hook's open set, so this leg needs no token.
async function waitHealth() { for (let i = 0; i < 60; i++) { try { if ((await fetch(`${APP}/api/health`)).ok) return } catch {} await wait(250) } dumpServer(); throw new Error('server never came up') }

const readSaved = async () => JSON.parse(await readFile(join(dataDir, 'sessions.json'), 'utf8'))
const pollSaved = async (pred, tries = 40) => { for (let i = 0; i < tries; i++) { try { const s = await readSaved(); if (pred(s)) return s } catch {} await wait(200) } return null }

// --- boot #1 ------------------------------------------------------------------
let server = boot()
await waitHealth()

// Create a session (spawns real claude). claudeSessionId exists upfront, so the
// set persists on create — no need to wait for a model turn.
const { id } = await post('/api/session/create', { name: 'loose-ends', cwd: CWD })
ok('session created', !!id)

// P1.19 — persistence: the set is saved on create.
let saved = await pollSaved((s) => Array.isArray(s) && s.length === 1)
ok('sessions.json has 1 saved session', saved && saved.length === 1)
ok('saved session has cwd + claudeSessionId', saved?.[0]?.cwd === CWD && !!saved?.[0]?.claudeSessionId)
const origClaudeId = saved[0].claudeSessionId

// P1.4 — live permission-mode switch; the mode is persisted for restore.
const modeRes = await post('/api/session/setMode', { id, mode: 'plan' })
ok(`setMode → applied=${modeRes.applied}`, ['live', 'relaunched', 'restart'].includes(modeRes.applied))
saved = await pollSaved((s) => s[0]?.permissionMode === 'plan')
ok('permission mode persisted (plan)', saved?.[0]?.permissionMode === 'plan')

// P1.14 — conversation routes (list + read-back shape).
const conv = await getj(`/api/session/conversations?cwd=${encodeURIComponent(CWD)}`)
ok('conversations route returns an array', Array.isArray(conv.conversations))
const readBack = await getj(`/api/session/conversation?cwd=${encodeURIComponent(CWD)}&id=does-not-exist`)
ok('conversation read-back of unknown id → empty events', Array.isArray(readBack.events) && readBack.events.length === 0)

// P1.14 — /clear (restartFresh): the claude session id rotates to a fresh one.
const rf = await post('/api/session/restartFresh', { id })
ok('restartFresh route ok', rf.ok === true)
saved = await pollSaved((s) => s[0]?.claudeSessionId && s[0].claudeSessionId !== origClaudeId)
ok('/clear started a FRESH conversation (new claudeSessionId)', saved && saved[0].claudeSessionId !== origClaudeId)

killServer(server)
await wait(1500)

// --- boot #2 — restore --------------------------------------------------------
server = boot()
await waitHealth()
await wait(500)
const list = (await getj('/api/session/list')).sessions
ok('restored the session on restart (P1.19)', list.length >= 1 && list.some((s) => s.cwd === CWD && s.name === 'loose-ends'))

// cleanup: destroy the restored session, then kill.
for (const s of list) await post('/api/session/destroy', { id: s.id }).catch(() => {})
killServer(server)
await wait(500)
await rm(dataDir, { recursive: true, force: true }).catch(() => {})

console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
