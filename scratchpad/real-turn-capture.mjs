// Capture the REAL state/event sequence for a live Claude turn — to see why the
// session shows 'idle' while responses stream. Creates a session, sends a short
// prompt that triggers a tool + multi-step work, and logs every session:state and
// session:event (type only) in order with timestamps.
//   node scratchpad/real-turn-capture.mjs
import { WebSocket } from 'ws'

const BASE = 'http://127.0.0.1:4321'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`

// 1. Create a real session in /tmp.
const created = await (await fetch(`${BASE}/api/session/create`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'capture', cwd: '/tmp' }),
})).json()
const id = created.id
console.log('session', id)

// 2. Connect the WS and log frames for this session.
const ws = new WebSocket('ws://127.0.0.1:4321/ws')
let states = []
await new Promise((res) => { ws.on('open', res) })
ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw) } catch { return }
  if (m.type === 'session:state' && m.id === id) { states.push(m.state); console.log(`${ts()} STATE -> ${m.state}`) }
  else if (m.type === 'session:event' && m.id === id) {
    const e = m.event || {}
    let extra = e.type
    if (e.type === 'stream_event') extra += `/${e.event?.type || ''}${e.event?.content_block?.type ? ':' + e.event.content_block.type : ''}`
    if (e.type === 'assistant') { const c = e.message?.content || []; extra += ` [${c.map((b) => b.type).join(',')}]` }
    if (e.type === 'result') extra += `/${e.subtype || ''}`
    console.log(`${ts()} EVENT ${extra}`)
  }
  else if (m.type === 'session:ready' && m.id === id) console.log(`${ts()} READY`)
})

// 3. Wait for init, then send a prompt that does a tiny multi-step tool task.
await wait(3500)
console.log(`${ts()} --- sending turn ---`)
ws.send(JSON.stringify({ type: 'session:send', id, text: 'Run the bash command `echo hello` and then tell me what it printed, in one short sentence.' }))

// 4. Watch for up to 60s or until we see a result + trailing idle.
const deadline = Date.now() + 60000
while (Date.now() < deadline) {
  await wait(500)
  if (states.length && states[states.length - 1] === 'idle' && states.includes('running')) break
}
await wait(500)
console.log('\nSTATE SEQUENCE:', states.join(' -> '))
ws.close()
await fetch(`${BASE}/api/session/destroy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => {})
process.exit(0)
