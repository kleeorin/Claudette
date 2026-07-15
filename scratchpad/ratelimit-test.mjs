// Verify the session-usage chip shows HOW MUCH is used, not just the reset time.
// The CLI's rate_limit_event reports usage as `utilization` (0–1); we inject a
// warning-shaped event and assert the chip renders the percentage.
//   node scratchpad/ratelimit-test.mjs
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-rl-'))
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9355', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
  'about:blank',
], { stdio: 'pipe' })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9355/json')).json()
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
const pending = new Map()
cdp.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
function send(method, params = {}) { const id = ++cdpId; return new Promise((res) => { pending.set(id, res); cdp.send(JSON.stringify({ id, method, params })) }) }
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error('eval threw: ' + JSON.stringify(r.result.exceptionDetails))
  return r.result?.result?.value
}
async function waitFor(expr, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) } throw new Error(`timeout: ${expr}`) }

const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`) }

const SHIM = `
  const RealWS = window.WebSocket;
  class CapWS extends RealWS { constructor(...a){ super(...a); if(String(a[0]).includes('/ws')) window.__appws=this; } }
  window.WebSocket = CapWS;
`
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', { source: SHIM })
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await waitFor(`!!window.__appws`)
await wait(600)

const feed = (frame) => evaluate(`(()=>{window.__appws.onmessage({data:${JSON.stringify(JSON.stringify(frame))}});return true})()`)
await feed({ type: 'session:list', sessions: [
  { id: 's1', name: 'usage-demo', cwd: '/tmp', rootDir: '/tmp', state: 'idle' },
] })
await wait(400)

// A warning-shaped five_hour event: 82.5% used, resets in ~2h. Matches the CLI's
// `{status:'allowed_warning', resetsAt, rateLimitType, utilization}` shape.
const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600
await feed({ type: 'session:event', id: 's1', event: {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt, utilization: 0.825, isUsingOverage: false },
} })
await wait(400)

const chipText = await evaluate(`(()=>{const el=[...document.querySelectorAll('span')].find(s=>/Session/.test(s.textContent)&&/%/.test(s.textContent)&&s.textContent.length<40);return el?el.textContent.replace(/\\s+/g,' ').trim():null})()`)
console.log('chip text:', JSON.stringify(chipText))
check('session chip shows a usage percentage', !!chipText && /83%|82%|82\.5/.test(chipText), JSON.stringify(chipText))
check('session chip still shows the reset time', !!chipText && /·/.test(chipText))

// A weekly event with utilization too, to confirm both windows compute percent.
await feed({ type: 'session:event', id: 's1', event: {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed_warning', rateLimitType: 'weekly', resetsAt: resetsAt + 3600, utilization: 0.41 },
} })
await wait(400)
const weekly = await evaluate(`document.body.innerText.match(/Weekly\\s*41%/)?.[0] || null`)
check('weekly chip also shows its percentage', weekly !== null, JSON.stringify(weekly))

await send('Page.captureScreenshot', { format: 'png' }).then(async (r) => {
  const { writeFile } = await import('fs/promises'); await writeFile('/tmp/claudette-shots/ratelimit.png', Buffer.from(r.result.data, 'base64'))
})
console.log('📸 ratelimit')

chrome.kill('SIGKILL')
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
