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
const chrome = spawn(process.env.CHROME_BIN ?? '/usr/bin/google-chrome', [
  '--headless=new', '--remote-debugging-port=9355', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
  'about:blank',
], { stdio: 'pipe', detached: true })

// Reap the browser on EVERY exit path, not just the happy one. These tests used to kill
// Chrome only at the end, so any throw — a timeout on a dead selector, an assertion that
// blew up — orphaned the whole headless process tree. One session left 14 of them behind,
// which quietly eats a machine until someone reboots. Pattern copied from find-diff-check.
// Reap by process GROUP, not by pid — the same discipline this file uses for its server,
// where it IS load-bearing (`npx` forks the real node, so killing the wrapper by pid can
// strand the port). For Chrome it is defence in depth only: measured, the bare kill did
// not orphan it. See rule 3 in scratchpad/port-and-reap-lint.mts.
const reapChrome = () => { try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} } }
process.on('exit', reapChrome)
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapChrome(); if (e) console.error(e); process.exit(1) })
}


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
// A CDP reply is awaited on a promise that ONLY the socket can resolve, so if Chrome dies
// mid-run — crash, OOM, an external pkill — every pending send() hangs forever and the
// harness sleeps in ep_poll holding its ports until someone hunts it down. Abort loudly
// instead. No reap() here on purpose: process.exit() runs the process.on('exit') handlers,
// which already cover every child. `cdpDone` keeps this off the DELIBERATE teardown below,
// where the very same close event is expected and must not be read as a failure.
let cdpDone = false
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died; aborting rather than hanging'); process.exit(1) })
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

// Match the CHIP, not its wrapper. `querySelectorAll('span')` returns document order, so a
// plain find() hit the flex container that holds the chips — same text, no title attribute,
// which is why the tooltip read as null even though RateChip sets one. Require `span[title]`.
const CHIP = `[...document.querySelectorAll('span[title]')].find(s=>/Session/.test(s.textContent)&&/%/.test(s.textContent)&&s.textContent.length<40)`
const chipText = await evaluate(`(()=>{const el=${CHIP};return el?el.textContent.replace(/\\s+/g,' ').trim():null})()`)
console.log('chip text:', JSON.stringify(chipText))
check('session chip shows a usage percentage', !!chipText && /83%|82%|82\.5/.test(chipText), JSON.stringify(chipText))
// THE RESET TIME MOVED TO THE TOOLTIP — DELIBERATELY, NOT LOST. This asserted a `·`
// separator in the chip's visible text. ChatView.tsx:945 says why it is gone: "Compact
// (sidebar) chip keeps the reset clock in the tooltip only, to stay narrow", and :943 puts
// `resets …` in the `title`. So the information is still there and still worth pinning —
// just in a different place. Asserting the CURRENT contract keeps the coverage; deleting
// the check would have quietly stopped testing whether the reset clock survives at all.
const chipTitle = await evaluate(`(()=>{const el=${CHIP};return el?el.getAttribute('title'):null})()`)
console.log('chip title:', JSON.stringify(chipTitle))
check('reset time is present in the chip tooltip', !!chipTitle && /resets /.test(chipTitle), JSON.stringify(chipTitle))

// THE WEEKLY CHIP IS SUPPRESSED BELOW 85% — ALSO DELIBERATE. ChatView.tsx:991 filters
// `!isWeekly(type) || percentUsed > 85`: a weekly window is only worth screen space once it
// is nearly spent. The old check fed 41% and demanded the chip appear, which asserted the
// opposite of the intended behaviour. Pin BOTH SIDES of the threshold instead — that tests
// more than the original did, and a regression in either direction now shows up.
await feed({ type: 'session:event', id: 's1', event: {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed_warning', rateLimitType: 'weekly', resetsAt: resetsAt + 3600, utilization: 0.41 },
} })
await wait(400)
const weeklyLow = await evaluate(`document.body.innerText.match(/Weekly\\s*\\d+%/)?.[0] || null`)
check('a weekly window at 41% is NOT shown (below the 85% threshold)', weeklyLow === null, JSON.stringify(weeklyLow))

await feed({ type: 'session:event', id: 's1', event: {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed_warning', rateLimitType: 'weekly', resetsAt: resetsAt + 3600, utilization: 0.91 },
} })
await wait(400)
const weeklyHigh = await evaluate(`document.body.innerText.match(/Weekly\\s*91%/)?.[0] || null`)
check('a weekly window at 91% IS shown with its percentage', weeklyHigh !== null, JSON.stringify(weeklyHigh))

await send('Page.captureScreenshot', { format: 'png' }).then(async (r) => {
  const { writeFile } = await import('fs/promises'); await writeFile('/tmp/claudette-shots/ratelimit.png', Buffer.from(r.result.data, 'base64'))
})
console.log('📸 ratelimit')

cdpDone = true   // deliberate teardown from here — the CDP close below is expected
reapChrome()
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
