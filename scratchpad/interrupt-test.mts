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
// A token is ALWAYS required, even on loopback (SANDBOX.md control-plane escape). Pin a
// throwaway one on the spawned server and present it on every HTTP request AND the WS
// upgrade — auth.ts accepts cookie, `Authorization: Bearer`, or ?token=.
const TOKEN = 'interrupt-test-token-interrupt-test-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

// Surface a non-2xx instead of letting `r.json()` turn it into a shapeless object: a 401
// used to reach the first assertion as `id === undefined`, which read as "session created
// failed" and sent the next reader hunting for a server crash that never happened.
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${APP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: JSON.stringify(body) })
  const text = await r.text()
  if (!r.ok) { console.error(`   ✗ POST ${path} → HTTP ${r.status}: ${text.slice(0, 300)}`); dumpServer() }
  try { return JSON.parse(text) } catch { return {} as any }
}

const dataDir = await mkdtemp(join(tmpdir(), 'claudette-int-'))
const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', CLAUDETTE_DATA_DIR: dataDir, CLAUDETTE_TOKEN: TOKEN },
  cwd: CWD, stdio: 'pipe', detached: true,
})
// Keep the server's stderr instead of discarding it. Swallowing it is why an auth
// rejection presented as `socket hang up` with no way to see the real cause.
const serverErr: string[] = []
server.stderr.on('data', (d) => { serverErr.push(d.toString()); if (serverErr.length > 80) serverErr.shift() })
function dumpServer(): void {
  if (!serverErr.length) return
  console.error('--- server stderr (tail) ---')
  console.error(serverErr.join('').trimEnd())
  console.error('--- end server stderr ---')
}
const kill = () => { try { process.kill(-server.pid!, 'SIGKILL') } catch { try { server.kill('SIGKILL') } catch {} } }
process.on('exit', kill)
// …and on the SIGNAL paths too. `process.on('exit')` does not fire for SIGINT/SIGTERM, so
// a Ctrl-C used to orphan the detached child and strand its port. This child is
// CLAUDETTE_TOKEN-protected rather than no-auth, so an orphan is a stuck port rather than
// an open server — but a stuck port is exactly what makes the NEXT run report false
// failures against a server it did not start.
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'] as const) {
  process.on(sig, (e?: unknown) => { (kill)(); if (e) console.error(e); process.exit(1) })
}

process.on('uncaughtException', (e) => { console.error(e); kill(); process.exit(1) })

async function waitHealth() { for (let i = 0; i < 60; i++) { try { if ((await fetch(`${APP}/api/health`)).ok) return } catch {} await wait(250) } dumpServer(); throw new Error('server never came up') }
await waitHealth()

const { id } = await post('/api/session/create', { name: 'interrupt', cwd: CWD })
ok(!!id, 'session created')
// Nothing below can work without a session; bail loudly rather than emitting a cascade
// of failures that all describe the same root cause.
if (!id) { console.error('no session id — aborting (see the POST status above)'); kill(); process.exit(1) }

// Observe state + streamed text over WS. The upgrade is auth-gated too.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: AUTH })
ws.on('error', (e) => { console.error(`   ✗ WS error: ${e instanceof Error ? e.message : String(e)}`); dumpServer() })
let state = 'idle'
let textLen = 0   // rendered characters — reported, but NOT the precondition (see below)
let frames = 0    // stream_event frames = "generation is in flight", phase-independent
const states: string[] = []
// An expired/absent credential is INVISIBLE to every channel this test used to watch, and
// that cost a day. Verified by starving the CLI of credentials and driving this same flow:
// the session is created, reaches 'running', returns to 'idle' promptly, and emits ZERO
// stream frames — so the ONLY red is `generation was streaming before interrupt (0
// frames)`, which is shape-identical to a genuinely broken interrupt. The CLI writes
// nothing to stderr, so dumpServer() prints an empty tail. The one trace is a `result`
// frame carrying `error: 'authentication_failed'` and `Not logged in · Please run /login`
// — note it also carries `subtype: 'success'`, so keying on subtype would miss it.
let apiError = ''
// ── WHAT COUNTS AS AN API FAILURE, AND WHY IT IS NOT THE APP'S CLASSIFIER ────────────
// This detector used to include `ev.is_error === true`, and it fired on EVERY run. The
// frame it tripped on, captured rather than guessed:
//   {"type":"result","subtype":"error_during_execution","is_error":true,"error":undefined}
// That is THIS TEST'S SUCCESS CONDITION. Interrupting a turn ends it in error by
// definition, so the harness was classifying the thing it exists to cause as a reason to
// disbelieve itself — and then, because `apiError` never reached the exit code, printed
// "this run is NOT a verdict" and exited 0 anyway. Both halves were wrong and each hid
// the other: the warning was a false alarm, and a GENUINE API failure would have passed
// just as silently. Measured three for three before the fix.
//
// chat.tsx:425-431 is the shipped classifier and it DOES count `is_error === true` — do
// not "align" this with it. It answers a different question: "did this turn fail?", for
// which an interrupted turn is correctly a failure and the UI says so. This harness asks
// the narrower "did the CLI fail for a reason that INVALIDATES the test?", and `is_error`
// cannot answer that because the interrupt under test sets it.
//
// The markers that do mean an API failure are the ones chat.tsx documents from the real
// measured auth-failure frame (`is_api_error_message`, `terminal_reason: 'api_error'`, a
// non-empty `error`) — note that frame arrives labelled `subtype: 'success'`, which is why
// subtype is not consulted here at all.
//
// ★ AND WHY THERE IS NO `subtype === 'error_during_execution'` EXCLUSION, despite that
//   being the obvious repair: a genuine API failure could carry that subtype too, and a
//   blacklist would then silence it. Discriminating on the API markers is strictly
//   narrower than excluding a subtype, and cannot mask a real failure the way a blacklist
//   can. The interrupt's own frame simply carries none of them.
//
// The `!== ''` guard matches chat.tsx and is deliberate: `typeof ev.error === 'string'` was
// true for an EMPTY error field, so a frame carrying `error: ''` counted as an API failure
// and reported itself as "unknown API error" — the shipped classifier already guards this
// and the divergence was a second, independent way for this to fire falsely.
const isApiFailure = (ev: any): boolean =>
  ev?.is_api_error_message === true
  || ev?.terminal_reason === 'api_error'
  || (typeof ev?.error === 'string' && ev.error !== '')
ws.on('message', (raw) => {
  let m: any
  try { m = JSON.parse(raw.toString()) } catch { return }
  if (m.type === 'session:state' && m.id === id) { state = m.state; states.push(m.state) }
  if (m.type === 'session:event' && m.id === id) {
    const ev = m.event
    if (ev?.type === 'stream_event') {
      frames++
      const d = ev.event?.delta
      if (d?.type === 'text_delta' && d.text) textLen += d.text.length
      if (d?.type === 'thinking_delta' && d.thinking) textLen += d.thinking.length
    } else if (!apiError && isApiFailure(ev)) {
      const text = ev.result || ev.message?.content?.[0]?.text || ''
      apiError = [ev.error, text].filter(Boolean).join(' — ') || 'unknown API error'
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

// Wait until generation is genuinely in flight, then interrupt.
//
// The precondition is STREAM FRAMES, not rendered characters. This used to wait for
// `textLen > 0`, which made the test hostage to which PHASE the model happened to be in:
// a turn that opens with extended thinking emits thinking_delta frames carrying only a
// signature and no `.thinking` text, so textLen stayed 0 for the whole 15s budget and the
// test failed while the engine was streaming perfectly. Verified against a live session:
// the same prompt produced 67 stream_events / 60 text_deltas, so the transport was never
// the problem — the assertion was measuring the wrong thing.
//
// What this test exists to prove is that interrupt STOPS a turn in flight. Frames are the
// honest measure of "in flight", and they are phase-independent.
for (let i = 0; i < 80; i++) { if (frames > 0) break; await wait(250) }
// Let generation get properly underway before interrupting. Firing on the very first
// frame would "pass" while barely exercising the thing under test — and it would make
// the post-interrupt assertion vacuous, since nothing was flowing to stop.
await wait(2500)
const framesAtInterrupt = frames
ok(framesAtInterrupt > 0, `generation was streaming before interrupt (${framesAtInterrupt} frames, ${textLen} chars)`)
send({ type: 'session:interrupt', id })

// It should return to idle promptly.
let backToIdle = false
for (let i = 0; i < 40; i++) { if (state === 'idle') { backToIdle = true; break } await wait(250) }
ok(backToIdle, `session returned to 'idle' after interrupt (final state: ${state})`)

// And generation should have stopped: no further frames once it reports idle. A couple of
// already-in-flight frames may still land, so allow a small tail rather than demanding 0.
const framesAfterIdle = frames
await wait(1500)
const grewAfter = frames - framesAfterIdle
ok(grewAfter <= 2, `generation stopped after interrupt (grew ${grewAfter} frames post-idle)`)

ws.close()
await post('/api/session/destroy', { id }).catch(() => {})
kill()
await wait(500)
await rm(dataDir, { recursive: true, force: true }).catch(() => {})
// ── THE OUTCOME MUST FOLLOW THE DIAGNOSIS ────────────────────────────────────────────
// A real API failure invalidates this run, so the assertions above are not a verdict in
// EITHER direction and reporting their outcome would be a lie whichever way it fell. It is
// also not a test failure: nothing in the app is broken, the harness could not reach its
// subject. That is a PREREQUISITE problem, and this suite's own rule is that a prerequisite
// problem must never be reported as a test result — so it exits 77, the runner's runtime-
// skip code, which lands in the SKIP column with this reason attached. See run-suite.sh.
if (apiError) {
  console.error(`\n[skip] the CLI reported an API failure, so this run is not a verdict on interrupt: ${apiError}`)
  console.error('   Re-running until it goes green proves nothing — fix the credential, then re-run.')
  console.error(`   (assertions this run, reported for information only: ${failed === 0 ? 'all passed' : failed + ' failed'})`)
  process.exit(77)
}
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
