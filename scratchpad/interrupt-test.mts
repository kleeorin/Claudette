// Live E2E: interrupt actually stops a turn. Boots the real server, drives a real
// `claude` session, sends a long turn, interrupts mid-generation, and asserts the
// session returns to idle (and output stops growing). Run:
//   npx tsx scratchpad/interrupt-test.mts
import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4334
const APP = `http://127.0.0.1:${PORT}`
const CWD = process.cwd()
let failed = 0
const ok = (c: unknown, m: string) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++ }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const post = (path: string, body: unknown) => fetch(`${APP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())

const dataDir = await mkdtemp(join(tmpdir(), 'claudette-int-'))
const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDETTE_DATA_DIR: dataDir },
  cwd: CWD, stdio: 'pipe', detached: true,
})
server.stderr.on('data', () => {})
const kill = () => { try { process.kill(-server.pid!, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
process.on('exit', kill)
process.on('uncaughtException', (e) => { console.error(e); kill(); process.exit(1) })

async function waitHealth() { for (let i = 0; i < 60; i++) { try { if ((await fetch(`${APP}/api/health`)).ok) return } catch {} await wait(250) } throw new Error('server never came up') }
await waitHealth()

const { id } = await post('/api/session/create', { name: 'interrupt', cwd: CWD })
ok(!!id, 'session created')

// Observe state + streamed text over WS.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
let state = 'idle'
let textLen = 0
const states: string[] = []
ws.on('message', (raw) => {
  let m: any
  try { m = JSON.parse(raw.toString()) } catch { return }
  if (m.type === 'session:state' && m.id === id) { state = m.state; states.push(m.state) }
  if (m.type === 'session:event' && m.id === id) {
    const ev = m.event
    if (ev?.type === 'stream_event') {
      const d = ev.event?.delta
      if (d?.type === 'text_delta' && d.text) textLen += d.text.length
      if (d?.type === 'thinking_delta' && d.thinking) textLen += d.thinking.length
    }
  }
})
await new Promise((res) => ws.on('open', res))

// Send a turn that will generate for a while.
const send = (msg: unknown) => ws.send(JSON.stringify(msg))
send({ type: 'session:send', id, text: 'Write a very detailed 3000-word essay on the complete history of computing, from the abacus to modern GPUs. Be exhaustive and include many sections.' })

// Wait until it's actively running.
for (let i = 0; i < 80; i++) { if (state === 'running') break; await wait(250) }
ok(state === 'running', `session reached 'running' (states so far: ${states.join('→') || 'none'})`)

// Wait until it's actively streaming text (Fable spends the first seconds in
// signature-only thinking), then interrupt while output is flowing.
for (let i = 0; i < 60; i++) { if (textLen > 0) break; await wait(250) }
const lenAtInterrupt = textLen
ok(lenAtInterrupt > 0, `some output streamed before interrupt (${lenAtInterrupt} chars)`)
send({ type: 'session:interrupt', id })

// It should return to idle promptly.
let backToIdle = false
for (let i = 0; i < 40; i++) { if (state === 'idle') { backToIdle = true; break } await wait(250) }
ok(backToIdle, `session returned to 'idle' after interrupt (final state: ${state})`)

// And output should have essentially stopped growing after the interrupt.
const lenAfterIdle = textLen
await wait(1500)
const grewAfter = textLen - lenAfterIdle
ok(grewAfter < 200, `output stopped after interrupt (grew ${grewAfter} chars post-idle)`)

ws.close()
await post('/api/session/destroy', { id }).catch(() => {})
kill()
await wait(500)
await rm(dataDir, { recursive: true, force: true }).catch(() => {})
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
