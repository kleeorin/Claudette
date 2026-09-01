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

import { check, results } from './assert.mjs'

// ── WHY THIS SHIM ALSO STUBS /api/usage — read this before deleting it ───────────────
// This test injects `rate_limit_event` frames and asserts on the chip they produce. But
// ChatView does not merge the two sources, it PREFERS one:
//
//     const limits = (usageChips.length ? usageChips : streamChips)     // ChatView.tsx:1070
//
// `usageChips` comes from `useUsage()`, which polls GET /api/usage — on MOUNT, on
// `visibilitychange`, and every 60s. So the injected fixtures are consulted ONLY when the
// polled list is empty. Without this stub the test asserts on the FALLBACK branch while the
// primary branch is live, and it is green only when the poll happens to return nothing.
//
// *** THAT IS WHY IT LOOKED LIKE A FLAKE AND IS NOT ONE. *** /api/usage answers with the
// operator's REAL account quota (see the isolation note below), which varies run to run: when
// the call yields windows the fixtures are ignored and the test reds with live values in the
// diagnostic (`● Session 52%`, `Weekly 12%` — never the 41/91 this file injects); when it
// yields nothing the fixtures are used and it passes. Same code, opposite results, no timing
// involved. Re-running it was never going to converge.
//
// The stub returns an EMPTY window list, which is the point: it makes `usageChips` empty BY
// CONSTRUCTION so the fixtures are the only source. Making the fixture merely arrive first
// would still be green-by-luck — a race won is not a branch removed.
//
// ── AND AN ISOLATION FINDING THIS EXPOSED, which is NOT this file's to fix ────────────
// run-suite starts the shared :4321 server with a throwaway data dir:
//     env -u CLAUDETTE_TOKEN CLAUDETTE_NO_AUTH=1 CLAUDETTE_DATA_DIR="$(mktemp -d)"
// That dir isolates nothing here. server/src/usage/usageApi.ts:13 reads
//     const CREDS = join(homedir(), '.claude', '.credentials.json')
// derived from homedir() and IGNORING CLAUDETTE_DATA_DIR, then makes an authenticated call to
// https://api.anthropic.com/api/oauth/usage. Measured 2026-09-01: that file exists and holds a
// live `sk-ant-` token, and `/api/usage` returns `{windows: []}` ONLY when there is no token —
// so every full suite run has been making authenticated calls on the operator's real account.
// One direct probe of a fresh throwaway server returned `{"windows":[],"fetchedAt":…}`; that
// does NOT refute the above, it is the same intermittency described earlier — it means that
// call yielded no windows, not that no token was read.
//
// ── TWO TESTS, TWO CAUSES — do not close the other one by association ─────────────────
// `real-turn-browser-test.mjs` also failed once in this group and was lumped in with this as
// "one srv4321 flake". It is NOT the same cause: it fails on Stop-indicator timing and never
// reads the usage chip. That one is still unexplained and still open.
const SHIM = `
  const RealWS = window.WebSocket;
  class CapWS extends RealWS { constructor(...a){ super(...a); if(String(a[0]).includes('/ws')) window.__appws=this; } }
  window.WebSocket = CapWS;
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (url.includes('/api/usage')) {
      window.__usageStubHits = (window.__usageStubHits || 0) + 1;
      return Promise.resolve(new Response(JSON.stringify({ windows: [], fetchedAt: Date.now() }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  };
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
// PRECONDITION: the /api/usage stub actually engaged. Without this, a shim that silently
// stopped working (a renamed route, a transport that is no longer window.fetch) would put
// this file straight back to asserting on the fallback branch while the live one wins —
// green again for the old wrong reason, and nothing in the output would say so.
const stubHits = await evaluate(`window.__usageStubHits ?? 0`)
check('PRECONDITION: /api/usage was stubbed, so the injected fixtures are the only source',
      typeof stubHits === 'number' && stubHits > 0, `stub served ${stubHits} request(s)`)

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
