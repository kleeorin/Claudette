// Verify the "token even on loopback" posture (SANDBOX.md control-plane escape,
// local leg). Boots real servers on :4322 with an isolated XDG_CONFIG_HOME +
// CLAUDETTE_DATA_DIR and checks:
//   1. no env token → API is 401, a token file is minted (0600) and honored
//   2. the file token survives a restart (devices stay logged in)
//   3. the WS upgrade is gated the same way
//   4. CLAUDETTE_NO_AUTH=1 → explicitly open
//   5. CLAUDETTE_TOKEN env still wins over the file
//   node scratchpad/auth-loopback-test.mjs
import { spawn } from 'child_process'
import { mkdtemp, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4322
const APP = `http://127.0.0.1:${PORT}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`) }

const cfgDir = await mkdtemp(join(tmpdir(), 'claudette-cfg-'))
const dataDir = await mkdtemp(join(tmpdir(), 'claudette-data-'))

function boot(extraEnv = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: cfgDir, CLAUDETTE_DATA_DIR: dataDir, PORT: String(PORT), HOST: '127.0.0.1', ...extraEnv }
  delete env.CLAUDETTE_TOKEN
  delete env.CLAUDETTE_NO_AUTH
  for (const [k, v] of Object.entries(extraEnv)) if (v == null) delete env[k]; else env[k] = v
  // detached → own process group, so stop() can kill npx AND its tsx/node
  // grandchild (killing just npx orphans the real server, which keeps the port).
  const child = spawn('npx', ['tsx', 'src/index.ts'], { cwd: new URL('../server', import.meta.url).pathname, env, stdio: 'pipe', detached: true })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  return { child, log: () => log }
}
async function up() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${APP}/api/health`); if (r.ok) return true } catch {}
    await wait(300)
  }
  return false
}
const kill = (pid, sig) => { try { process.kill(-pid, sig) } catch {} }
async function stop(s) {
  kill(s.child.pid, 'SIGTERM')
  // Wait until the port is actually released, not just until npx exits.
  for (let i = 0; i < 20; i++) {
    try { await fetch(`${APP}/api/health`, { signal: AbortSignal.timeout(400) }) } catch { return }
    if (i === 8) kill(s.child.pid, 'SIGKILL')
    await wait(300)
  }
}
const status = async (path, opts) => { try { return (await fetch(`${APP}${path}`, opts)).status } catch { return -1 } }
const wsResult = (headers) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers })
  const done = (v) => { try { ws.terminate() } catch {}; res(v) }
  ws.on('open', () => done('open'))
  ws.on('error', () => done('refused'))
  ws.on('unexpected-response', () => done('refused'))
  setTimeout(() => done('timeout'), 5000)
})

// ---- 1. Default loopback: token minted + required.
let s = boot()
check('server came up (no env token)', await up())
check('API is gated: /api/session/list → 401', await status('/api/session/list') === 401)
const tokenFile = join(cfgDir, 'claudette', 'token')
let token = ''
try {
  token = (await readFile(tokenFile, 'utf8')).trim()
  const mode = (await stat(tokenFile)).mode & 0o777
  check('token file minted at $XDG_CONFIG_HOME/claudette/token, mode 600', token.length >= 32 && mode === 0o600, `len=${token.length} mode=${mode.toString(8)}`)
} catch (e) {
  check('token file minted at $XDG_CONFIG_HOME/claudette/token, mode 600', false, String(e))
}
check('wrong token still 401', await status('/api/session/list', { headers: { authorization: 'Bearer nope' } }) === 401)
check('file token grants access (Bearer)', await status('/api/session/list', { headers: { authorization: `Bearer ${token}` } }) === 200)
const authRes = await fetch(`${APP}/api/auth?token=${token}`)
const cookie = (authRes.headers.get('set-cookie') || '').split(';')[0]
check('/api/auth?token= sets the auth cookie', authRes.ok && cookie.startsWith('claudette_auth='))
check('cookie grants access', await status('/api/session/list', { headers: { cookie } }) === 200)

// --- /api/health discloses NOTHING about the host before you authenticate ------
// It is in the auth hook's OPEN set, so everything it returns is readable by anyone who
// can reach the port. It used to answer with the host's GPU device inventory and the
// server user's home directory — exactly what you want before guessing a ?token= or
// naming a path under ~/.claude.
{
  const anon = await (await fetch(`${APP}/api/health`)).json()
  check('unauthenticated /api/health still answers liveness', anon.ok === true && typeof anon.version === 'string')
  check('unauthenticated /api/health keeps the sandbox capability flag', typeof anon.sandboxAvailable === 'boolean')
  check('unauthenticated /api/health hides homeDir', anon.homeDir === undefined, `got ${JSON.stringify(anon.homeDir)}`)
  check('unauthenticated /api/health hides gpuDevices', anon.gpuDevices === undefined, `got ${JSON.stringify(anon.gpuDevices)}`)

  const authed = await (await fetch(`${APP}/api/health`, { headers: { cookie } })).json()
  check('authenticated /api/health still serves homeDir (the UI needs it)', typeof authed.homeDir === 'string' && authed.homeDir.length > 0)
  check('authenticated /api/health still serves gpuDevices', Array.isArray(authed.gpuDevices))
}

// --- /api/auth compares the token in constant time ----------------------------
// The one unauthenticated, unrate-limited endpoint whose whole job is checking a token,
// i.e. the only place a timing oracle is actually reachable. A plain !== leaks the
// length and the position of the first wrong character.
{
  const rejects = async (t) => (await fetch(`${APP}/api/auth?token=${encodeURIComponent(t)}`)).status === 401
  check('/api/auth rejects a short wrong token', await rejects('x'))
  check('/api/auth rejects a same-length wrong token', await rejects('z'.repeat(token.length)))
  check('/api/auth rejects a token sharing a long prefix', await rejects(token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')))
  check('/api/auth rejects a token that is a prefix of the real one', await rejects(token.slice(0, -1)))
  check('/api/auth still accepts the real token', (await fetch(`${APP}/api/auth?token=${token}`)).ok)
}
check('WS upgrade refused without token', (await wsResult({})) === 'refused')
check('WS upgrade accepted with cookie', (await wsResult({ cookie })) === 'open')
await stop(s)

// ---- 2. Restart: same token (stable logins).
s = boot()
check('server restarted', await up())
check('persisted token still works after restart', await status('/api/session/list', { headers: { authorization: `Bearer ${token}` } }) === 200)
check('restart minted no new token', (await readFile(tokenFile, 'utf8')).trim() === token)
await stop(s)

// ---- 3. Explicit opt-out.
s = boot({ CLAUDETTE_NO_AUTH: '1' })
check('CLAUDETTE_NO_AUTH=1 server came up', await up())
check('opt-out: API open without token', await status('/api/session/list') === 200)
await stop(s)

// ---- 4. Env token beats the file token.
s = boot({ CLAUDETTE_TOKEN: 'envtok-envtok-envtok-envtok' })
check('env-token server came up', await up())
check('env token grants access', await status('/api/session/list', { headers: { authorization: 'Bearer envtok-envtok-envtok-envtok' } }) === 200)
check('file token rejected when env token set', await status('/api/session/list', { headers: { authorization: `Bearer ${token}` } }) === 401)
await stop(s)

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
