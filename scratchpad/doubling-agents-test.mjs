// DOUBLING + SUBAGENT-TRAY PROBE — driven by a STAND-IN `claude` CLI, not by a live model.
//
//   bash scratchpad/run-suite.sh doubling-agents-test.mjs
//
// Own server (4485), own vite (5285), own Chrome (CDP 9361). GROUP B: vite compiles the
// WORKING TREE, so a result here is evidence. It never serves web/dist, which is stale and
// unrebuildable from a sandboxed session.
//
// ── WHY THIS FILE WAS REWRITTEN, and WHAT THAT COST ──────────────────────────────────
// It used to ask a REAL Claude turn to (a) write a marker word once and (b) call its Agent
// tool. Half of that worked; the tray half sat at a permanent 3-red. Measured, not guessed:
// the `result` frames were captured off the hub socket and read
// `{"subtype":"success","is_error":false,"terminal_reason":"completed"}` — the turn ran fine,
// the model simply declined to delegate. A green that depends on a model CHOOSING to call a
// tool is not a test; it is a coin flip wearing an assertion's name.
// Two of those three assertions could not have passed even if it HAD delegated, which is the
// more interesting finding: they were written against a UI that no longer exists.
//   · "Agents tray appeared" looked for a button whose text contains "Agents". There is no
//     such control anywhere in web/src — the subagent surface is now a ◈N badge on the
//     session's SIDEBAR row (App.tsx:1468) that expands into one AgentLine per agent.
//   · "agent card shows a status label" looked for a <span> whose TEXT is done/running/failed.
//     AgentStatusDot (AgentDetail.tsx:173) puts that word in a `title` attribute on an empty
//     1.5px dot; it is never text. The only literal "done" text in the sidebar belongs to the
//     session attention light, an unrelated control.
//   So the old red was over-determined, and its name pointed at none of the causes.
//
// ★ STATED LIMITATION — the thing this file no longer does.
//   Driving from a stub means NOTHING here exercises the real CLI's delegation path: not the
//   engine's argv, not --include-partial-messages, not the CLI's own frame shapes, and not the
//   question "does a model asked to delegate actually delegate". The frame shapes below are
//   taken from what store/chat.tsx and shared/tasks.ts are WRITTEN to accept, i.e. from the
//   contract, not from a capture of a live CLI in this run. If that contract drifts from what
//   the CLI really emits, every check here stays green and the app is broken anyway. This
//   probe covers the RENDERING of those frames and nothing upstream of them.
//
// ── WHAT IT DOES TEST, and how each check was proven able to fire ────────────────────
// [1] The doubling half: four ways a transcript can duplicate or LOSE prose, each reached by
//     a different mutation. Every one of the sixteen checks below has been made to fail on
//     purpose and its diagnostic string read back — see the MUTATIONS block at the bottom of
//     this file for the ten mutations and the exact numbers.
// [2] The subagent half, against the CURRENT sidebar UI, including the fix this file is
//     named for: shared/tasks.ts matches BOTH `Task` and `Agent` as subagent tools. shared/
//     is read-only from here so that line cannot be mutated; instead the stub emits a THIRD
//     tool call (`Bash`) into the same transcript, so the ◈ count is only 2 if the collector
//     discriminates on the tool NAME — which is exactly what isSubagentTool decides.
import { spawn, execFileSync } from 'child_process'
import { mkdtemp, writeFile, chmod, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4485
const WEB_PORT = 5285
const CDP_PORT = 9361
const APP = `http://127.0.0.1:${WEB_PORT}`, API = `http://127.0.0.1:${PORT}`
const TOKEN = 'doubling-agents-token'
const SESSION = 'Probe'

// Marker words. Each appears in exactly ONE frame family and nowhere else in the app, so a
// count off document.body.innerText is unambiguous. They are never typed into the composer
// (nothing is), so any occurrence in the DOM came from the transcript.
const M_STREAM = 'quixotic'      // streamed, then re-sent as a completed snapshot
const M_SNAP = 'marmalade'       // never streamed; the SAME snapshot sent twice
const M_FIRST = 'peregrine'      // message 1 of a two-message pair
const M_SECOND = 'obsidianite'   // message 2 of the same pair
const STEP = 'zzsubstepzz'       // the subagent's own chain of thought

const TID_TASK = 'tu-doubling-task-1'    // tool named `Task`
const TID_AGENT = 'tu-doubling-agent-1'  // tool named `Agent` — the 2.1.207 rename
const TID_BASH = 'tu-doubling-bash-1'    // a tool that is NOT a subagent launcher
const DESC_TASK = 'Sweep the transcript for doubles'
const DESC_AGENT = 'Name the tray controls'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0, failed = 0
const ok = (tag, name, cond, extra = '') => {
  cond ? passed++ : failed++
  console.log(`  ${cond ? '✅' : '❌'} [${tag}] ${name}${extra ? ` — ${extra}` : ''}`)
}

const DATA = await mkdtemp(join(tmpdir(), 'doubling-data-'))
// A FRESH CWD PER RUN, and this is load-bearing even now that no real CLI runs. It used to be
// the literal '/tmp', which Claude keeps per-project history for (~/.claude/projects/-tmp).
// Successive runs then found each other's history and the marker word counted 1, then 2, then
// 3 over three runs of an unchanged file — the doubling assertions went red for accumulation
// rather than for the rendering bug they exist to catch. A test that fails because it ran
// before is worse than no test. Kept: a stub can be swapped back for a real CLI in one line,
// and the trap would come straight back with it.
const PROJ = await mkdtemp(join(tmpdir(), 'doubling-cwd-'))
const BIN = await mkdtemp(join(tmpdir(), 'doubling-bin-'))

// ── the frames ───────────────────────────────────────────────────────────────────────
// A wrapped Anthropic streaming event, the shape the client unwraps at chat.tsx:667.
const ev = (event) => ({ type: 'stream_event', event })
const snapshot = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
// Long lines on purpose: the duplicate-LINE check below only looks at lines over 40 chars,
// and these must be long enough for it to see them.
const T_STREAM = `The stream carried this paragraph token by token before the completed message restated it. Marker: ${M_STREAM}.`
const T_SNAP = `This paragraph was never streamed and its completed message arrived twice, cumulatively. Marker: ${M_SNAP}.`
const T_FIRST = `This is the first of two consecutive assistant messages, each with its own block index zero. Marker: ${M_FIRST}.`
const T_SECOND = `This is the second of the pair, and it must not land on top of the first one. Marker: ${M_SECOND}.`

const chunks = (s, n) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out }

const BATCH = {
  // [1a] The ordinary live path: message_start, a text block streamed as deltas, then the
  // COMPLETED assistant message restating the same text. ASSISTANT must finalize the streamed
  // item in place rather than append a second copy of the paragraph.
  stream: [
    ev({ type: 'message_start' }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    ...chunks(T_STREAM, 24).map((text) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    ev({ type: 'content_block_stop', index: 0 }),
    snapshot(T_STREAM),
  ],
  // [1b] The device-joined-mid-turn path: NO stream events at all, and the same completed
  // message delivered twice. The first materializes the item; the second must re-settle THAT
  // item, which it can only do if the first registered itself in the block-index map.
  snap: [ev({ type: 'message_start' }), snapshot(T_SNAP), snapshot(T_SNAP)],
  // [1c]/[1d] Two consecutive messages, neither streamed, both numbering their blocks from 0.
  // The index map must be reset on message_start or the second message's block 0 pairs with
  // the FIRST message's item and overwrites it. The second message is then re-sent, exactly
  // as in `snap` — without that repeat [1d] had NO way to fail: nothing in this batch could
  // ever have doubled it, so it was an assertion with no firing mode, which is the shape this
  // whole file was rewritten to get rid of. With it, [1d] reds under MU1 (measured).
  msgs: [ev({ type: 'message_start' }), snapshot(T_FIRST), ev({ type: 'message_start' }), snapshot(T_SECOND), snapshot(T_SECOND)],
  // [2] Two subagents and one ordinary tool, in one message. The async-launch ack is what
  // makes an agent LIVE with no turn running (isAgentLive = !result && (launched || turnActive)),
  // and its content must match shared/tasks.ts's ack pattern or it reads as a terminal result.
  task: [
    ev({ type: 'message_start' }),
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: TID_TASK, name: 'Task',
        input: { description: DESC_TASK, subagent_type: 'explorer', prompt: 'Count every rendered paragraph and report duplicates.' } },
      { type: 'tool_use', id: TID_AGENT, name: 'Agent',
        input: { description: DESC_AGENT, subagent_type: 'general', prompt: 'List the controls the subagent tray puts in the sidebar.' } },
      { type: 'tool_use', id: TID_BASH, name: 'Bash', input: { command: 'echo not-a-subagent' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: TID_TASK, content: 'Async agent launched successfully (probe task 1)' }] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: TID_AGENT, content: 'Async agent launched successfully (probe task 2)' }] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: TID_BASH, content: 'not-a-subagent' }] } },
    // The Task agent's OWN chain of thought, tagged with its parent's tool id. ChatView drops
    // every item carrying a parentId (ChatView.tsx:148), so this text belongs to the agent's
    // detail view and must not appear in the main transcript at all.
    { type: 'assistant', parent_tool_use_id: TID_TASK, message: { role: 'assistant', content: [
      { type: 'thinking', thinking: `${STEP} — walking the transcript items one at a time` }] } },
  ],
  // [2f] Settle ONE of the two agents. The other must stay running, which is what makes this
  // a check on per-tool-id pairing rather than on a global "some agent finished" flag.
  done: [
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: TID_TASK, content: 'Swept 4 paragraphs, no duplicates found.' }] } },
  ],
}

// ── the stand-in CLI ────────────────────────────────────────────────────────────────
// Gated on marker files so each batch arrives when this harness asks for it. Ungated, every
// frame would land before the page finished rendering and the checks below could not tell
// "the transcript settled correctly" from "the transcript never changed".
const MARK = await mkdtemp(join(tmpdir(), 'doubling-go-'))
const GO = Object.fromEntries(Object.keys(BATCH).map((k) => [k, join(MARK, `go-${k}`)]))
for (const f of Object.values(GO)) await rm(f, { force: true })

await writeFile(join(BIN, 'claude'), `#!/usr/bin/env node
const { existsSync } = require('fs')
const GO = ${JSON.stringify(GO)}
const BATCH = ${JSON.stringify(BATCH)}
const sent = {}
const tick = setInterval(() => {
  for (const k of Object.keys(GO)) {
    if (sent[k] || !existsSync(GO[k])) continue
    sent[k] = true
    for (const f of BATCH[k]) process.stdout.write(JSON.stringify(f) + '\\n')
  }
}, 120)
// Exit when the server that spawned us goes away — parking on the timer alone leaves one of
// these reparented to init after every run.
process.stdin.on('end', () => { clearInterval(tick); process.exit(0) })
process.stdin.on('close', () => { clearInterval(tick); process.exit(0) })
process.stdin.resume()
setTimeout(() => process.exit(0), 300000)
`)
await chmod(join(BIN, 'claude'), 0o755)

const server = spawn('npx', ['tsx', 'server/src/index.ts'], {
  env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, PORT: String(PORT),
         CLAUDETTE_TOKEN: TOKEN, CLAUDETTE_DATA_DIR: DATA, CLAUDETTE_ALLOW_UNSANDBOXED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let log = ''; server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d))
const web = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
  cwd: 'web', env: { ...process.env, PORT: String(PORT), WEB_PORT: String(WEB_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
})
let weblog = ''; web.stdout.on('data', (d) => (weblog += d)); web.stderr.on('data', (d) => (weblog += d))

let chrome = null
// Reap by process GROUP on EVERY exit path. `npx` forks the real node, so killing the
// wrapper by pid strands the port; and a throw anywhere below used to orphan a whole
// headless Chrome tree (one session left 14 of them behind). See port-and-reap-lint rule 3.
const reapAll = () => {
  for (const p of [server, web, chrome]) {
    if (!p) continue
    try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} }
  }
}
process.on('exit', reapAll)
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapAll(); if (e) console.error(e); process.exit(1) })
}

for (let i = 0; i < 90 && !log.includes('Server listening'); i++) await wait(500)
if (!log.includes('Server listening')) { console.error(log.slice(-1500)); reapAll(); process.exit(1) }
for (let i = 0; i < 90 && !weblog.includes('ready in'); i++) await wait(500)
if (!weblog.includes('ready in')) { console.error(weblog.slice(-1500)); reapAll(); process.exit(1) }
console.log('server + vite up')

// A git repo so the app has an ordinary project to open; `-c user.*` rather than
// `git config`, so this never reads or touches the operator's global git identity.
execFileSync('git', ['-c', 'init.defaultBranch=main', '-C', PROJ, 'init', '-q'], { stdio: 'ignore' })
await writeFile(join(PROJ, 'readme.txt'), 'doubling probe fixture\n')

const hdr = { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` }
const created = await fetch(`${API}/api/session/create`, {
  method: 'POST', headers: hdr,
  body: JSON.stringify({ name: SESSION, cwd: PROJ, rootDir: PROJ, sandbox: { enabled: false, mounts: [] } }),
}).then((r) => r.json())
// Created over the authenticated HTTP API, which is a TRUSTED caller — so this never meets
// the workspace-trust dialog the composer path does (App.tsx renders "Trust this folder?"
// INSTEAD of creating, and a harness that does not answer it silently gets no session).
if (!created?.id) { console.error('session create failed: ' + JSON.stringify(created)); reapAll(); process.exit(1) }
console.log(`session ${SESSION}=${created.id.slice(0, 8)}`)

const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
if (!existsSync(CHROME)) { console.error(`no Chrome at ${CHROME} (set CHROME_BIN)`); reapAll(); process.exit(1) }
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${await mkdtemp(join(tmpdir(), 'chrome-dblag-'))}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1300,900', 'about:blank'],
  { stdio: 'pipe', detached: true })

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      const pg = l.find((t) => t.type === 'page')
      if (pg?.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl
    } catch {}
    await wait(250)
  }
  throw new Error('no CDP target')
}
const cdp = new WebSocket(await cdpTarget())
await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej) })
let cdpId = 0
const pendingCdp = new Map()
// A CDP reply is awaited on a promise only the socket can resolve, so if Chrome dies mid-run
// every pending send() hangs forever and this harness sleeps holding its ports until someone
// hunts it down (measured: a 9-minute squatter, see layout-check.mjs).
cdp.on('close', () => { console.error('CDP socket closed — Chrome died; aborting'); reapAll(); process.exit(1) })
cdp.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.id && pendingCdp.has(m.id)) { pendingCdp.get(m.id)(m); pendingCdp.delete(m.id) }
})
const send = (method, params = {}) => {
  const id = ++cdpId
  cdp.send(JSON.stringify({ id, method, params }))
  return new Promise((res) => pendingCdp.set(id, res))
}
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}
const waitFor = async (expr, ms = 25000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (await evaluate(expr)) return true; await wait(200) }
  return false
}

// Exactly ONE session exists in this app, so a document-wide search by `title` is
// unambiguous — the containment scoping scroll-memory-check needs (three sessions, two of
// them holding an agent with the same id) buys nothing here and only adds ways to be wrong.
const HELPERS = `
window.__db = {
  count(word) { return (document.body.innerText.toLowerCase().match(new RegExp(word, 'g')) || []).length },
  // The ◈N badge on the session row: the toggle for the agent list. Identified by its title,
  // which App.tsx builds as "<n> subagent(s) …", not by its glyph.
  badge() { const a = document.querySelector('aside'); return a ? a.querySelector('button[title*="subagent"]') : null },
  badgeText() { const b = this.badge(); return b ? b.textContent.trim() : null },
  // One AgentLine. Its title is "<type>: <description> — open its thought process".
  line(desc) {
    return [...document.querySelectorAll('button')]
      .find((b) => (b.title || '').includes('open its thought process') && (b.title || '').includes(desc)) || null
  },
  lineTitle(desc) { const b = this.line(desc); return b ? b.title : null },
  // AgentStatusDot renders the status as a TITLE on an empty 1.5px dot, never as text — the
  // single fact the old version of this file got wrong in both directions.
  status(desc) { const b = this.line(desc); const d = b && b.querySelector('span[title]'); return d ? d.title : null },
  // Any line over 40 chars rendered twice anywhere on the page.
  dupLine() {
    const lines = document.body.innerText.split('\\n').map((s) => s.trim()).filter((s) => s.length > 40)
    const seen = new Set()
    for (const l of lines) { if (seen.has(l)) return l; seen.add(l) }
    return null
  },
}; true`

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/api/auth?token=${TOKEN}` })
await wait(1200)
await send('Page.navigate', { url: `${APP}/` })
if (!await waitFor(`!!document.querySelector('aside') || !!document.querySelector('textarea')`, 40000)) {
  console.error('app never rendered'); console.error(weblog.slice(-1200)); reapAll(); process.exit(1)
}
await evaluate(HELPERS)
ok('setup', 'the session is on screen', await waitFor(`document.body.innerText.includes(${JSON.stringify(SESSION)})`, 20000))
await wait(800)

// ═══ [1] DOUBLING ════════════════════════════════════════════════════════════════════
console.log('\n[1] transcript doubling')
await writeFile(GO.stream, 'go')
// Gate everything below on the stub's output actually ARRIVING. Without this a dead engine
// reports four confident reds about doubling, which is a probe describing a subject it never
// managed to load. The marker reaching the DOM at all is the precondition; the COUNT is the test.
const arrived = await waitFor(`window.__db.count(${JSON.stringify(M_STREAM)}) > 0`, 30000)
ok('setup', "the stub CLI's frames reach the transcript", arrived)

if (!arrived) {
  console.log('  ⚠ nothing from the engine — section [1] and [2] did not run')
  console.log(log.slice(-1200))
} else {
  await wait(600)
  const cStream = await evaluate(`window.__db.count(${JSON.stringify(M_STREAM)})`)
  ok('core', '[1a] a streamed message restated by its completed snapshot renders ONCE',
    cStream === 1, `count=${cStream}${cStream > 1 ? ' ← the completed message appended a second copy instead of settling the streamed item' : ''}`)

  await writeFile(GO.snap, 'go')
  await waitFor(`window.__db.count(${JSON.stringify(M_SNAP)}) > 0`, 20000)
  await wait(800)
  const cSnap = await evaluate(`window.__db.count(${JSON.stringify(M_SNAP)})`)
  ok('core', '[1b] the SAME completed message sent twice, never streamed, renders ONCE',
    cSnap === 1, `count=${cSnap}${cSnap > 1 ? ' ← the first copy did not register itself in the block-index map' : ''}`)

  await writeFile(GO.msgs, 'go')
  await waitFor(`window.__db.count(${JSON.stringify(M_SECOND)}) > 0`, 20000)
  await wait(800)
  const cFirst = await evaluate(`window.__db.count(${JSON.stringify(M_FIRST)})`)
  const cSecond = await evaluate(`window.__db.count(${JSON.stringify(M_SECOND)})`)
  // The two halves of the message_start reset, split because they fail for different reasons:
  // losing the FIRST message means the index map was not reset, while a doubled SECOND means
  // it was reset but the new item registered wrongly.
  ok('core', '[1c] the first of two consecutive messages SURVIVES the second',
    cFirst === 1, `count=${cFirst}${cFirst === 0 ? " ← message 2's block 0 landed on message 1's item: the index map was not reset on message_start" : ''}`)
  ok('core', '[1d] the second of the pair renders ONCE',
    cSecond === 1, `count=${cSecond}${cSecond > 1 ? ' ← re-sending it appended a copy: a block materialized AFTER a reset did not register itself either' : ''}`)

  // Belt-and-braces, and deliberately weaker than [1a]-[1d]: it catches any repeated
  // paragraph, but it is BLIND to the message_start bug, which loses text rather than
  // duplicating it. Do not read a green here as covering [1c].
  const dup = await evaluate(`window.__db.dupLine()`)
  ok('core', '[1e] no long line is rendered twice anywhere on the page',
    dup === null, dup ? `dup: ${String(dup).slice(0, 70)}` : '')

  // ═══ [2] THE SUBAGENT SURFACE ══════════════════════════════════════════════════════
  console.log('\n[2] the subagent tray (sidebar ◈ badge → AgentLine)')
  await writeFile(GO.task, 'go')
  const badgeUp = await waitFor(`!!window.__db.badge()`, 30000)
  ok('core', '[2a] a subagent reaches the sidebar as a ◈ badge', badgeUp)

  if (!badgeUp) {
    console.log('  ⚠ no badge ever appeared — the rest of [2] did not run')
  } else {
    // Three tool calls went out; exactly two of them are subagent launchers. A collector that
    // did not discriminate on the tool name would say 3, and one that still only knew `Task`
    // would say 1 — which is the regression shared/tasks.ts's `Agent` clause exists to stop.
    const badgeText = await evaluate(`window.__db.badgeText()`)
    ok('core', '[2b] the badge counts exactly the TWO subagent tools, not the Bash call beside them',
      badgeText === '◈2', `badge reads ${JSON.stringify(badgeText)}${badgeText === '◈1' ? ' ← only one of Task/Agent was recognised as a subagent launcher' : ''}`)

    await evaluate(`window.__db.badge().click()`)
    const tLine = await waitFor(`!!window.__db.line(${JSON.stringify(DESC_TASK)})`, 15000)
    ok('core', '[2c] expanding it lists the `Task`-named subagent', tLine)
    const aLine = await evaluate(`!!window.__db.line(${JSON.stringify(DESC_AGENT)})`)
    ok('core', '[2d] …and the `Agent`-named one, which older builds dropped entirely', aLine)
    const tTitle = await evaluate(`window.__db.lineTitle(${JSON.stringify(DESC_TASK)})`)
    ok('core', "[2e] a line carries the agent's own subagent_type, not a placeholder",
      typeof tTitle === 'string' && tTitle.startsWith('explorer: '), `title=${JSON.stringify(tTitle)}`)

    // A launch ack and no result: live, with no turn running. This is the whole of
    // isAgentLive's `launched` limb — remove it and this reads "stopped".
    const sTask = await evaluate(`window.__db.status(${JSON.stringify(DESC_TASK)})`)
    ok('core', '[2f] a launched, unfinished agent reads RUNNING with no turn in flight',
      sTask === 'running', `status=${JSON.stringify(sTask)}`)

    // The agent's own chain of thought belongs to its detail view. In the main transcript it
    // must not appear at all — this is the same parentId tag that, when it was ignored,
    // put a subagent's prose into the conversation AND then doubled it.
    const leak = await evaluate(`window.__db.count(${JSON.stringify(STEP)})`)
    ok('core', "[2g] the subagent's own prose does not leak into the main transcript",
      leak === 0, `count=${leak}`)

    // Settle ONE of the two. The other staying `running` is what makes this a check on
    // per-tool-id pairing rather than on a global "something finished" flag.
    await writeFile(GO.done, 'go')
    const settled = await waitFor(`window.__db.status(${JSON.stringify(DESC_TASK)}) === 'done'`, 20000)
    const sTask2 = await evaluate(`window.__db.status(${JSON.stringify(DESC_TASK)})`)
    ok('core', '[2h] a terminal tool_result settles THAT agent to done',
      settled, `status=${JSON.stringify(sTask2)}`)
    const sAgent2 = await evaluate(`window.__db.status(${JSON.stringify(DESC_AGENT)})`)
    ok('core', '[2i] …and leaves its unfinished sibling running',
      sAgent2 === 'running', `status=${JSON.stringify(sAgent2)}`)
  }
}

console.log(`\n${passed} passed / ${failed} failed`)
reapAll()
process.exit(failed === 0 ? 0 : 1)

// ── MUTATIONS — every check above proven able to FIRE, not just to stay silent ────────
// Ten mutations, each measured on 2026-08-25, each reverted afterwards (both source files
// restored byte-identically, md5-checked). Baseline, as shipped: 16 passed / 0 failed.
// MU1-MU3, MU5 and MU8 edit web/src; MU4a-c, MU6 and MU7 edit only the STUB'S OUTPUT, which
// is how the parts of the contract that live in the read-only shared/ get covered from here.
//
//   MU1  chat.tsx: drop `nextOpen[b.index] = newId` (a materialized block no longer
//        registers itself in the index map)          → 13/3: [1b] count=2, [1d] count=2, [1e]
//   MU2  chat.tsx: MSG_START → `return state`        → 15/1: [1c] alone, count=0
//   MU3  chat.tsx: isAgentLive drops the `launched`
//        limb (`!a.result && turnActive`)            → 14/2: [2f] and [2i], both "stopped"
//   MU5  ChatView.tsx: drop the `it.parentId` filter → 15/1: [2g] alone, count=1
//   MU8  chat.tsx: `knownId = undefined` (no block
//        pairing at all)                             → 12/4: [1a] [1b] [1d] count=2, [1e]
//   MU4a stub emits the `Agent` tool as `Bash`       → 13/3: [2b] "◈1", [2d], [2i] null
//   MU4b stub emits the `Task` tool as `Bash`        → 11/5: [2b] "◈1", [2c], and the three
//        checks that read the Task line ([2e] [2f] [2h]) go null — a cascade, listed so it
//        is not mistaken for four independent findings
//   MU4c stub emits BOTH as `Bash`                   → 7/1: [2a] alone, and the rest of [2]
//        correctly reports "did not run" instead of a row of confident reds
//   MU6  stub omits `subagent_type` from the Task    → 15/1: [2e] alone, title "agent: …"
//   MU7  the terminal tool_result carries a tool id
//        nobody launched                             → 15/1: [2h] alone, still "running"
//
// ★ WHAT EACH CHECK ACTUALLY PINS — the mutations do not partition cleanly, so read this
//   rather than inferring coverage from a name:
//   [1a] the streamed-item ↔ completed-block PAIRING. Only MU8 reaches it; MU1 cannot,
//        because a STREAMED block registers itself via STREAM_START whether or not the
//        materialize path does. [1a] is therefore NOT coverage of the open-map fix.
//   [1b] the open-map REGISTRATION on the materialize path — the fix this file is named for.
//   [1c] the message_start RESET, and nothing else. It is the only check MU2 can reach.
//   [1d] the same registration as [1b], on a block that follows a reset.
//   [1e] any repeated paragraph. Strictly WEAKER than [1a]-[1d] and BLIND to MU2, which
//        loses text rather than duplicating it — a green here says nothing about [1c].
//   [2b] that the collector discriminates on the tool NAME. It is the only check that can
//        see a regression to `Task`-only, since shared/tasks.ts cannot be mutated from here.
//   [2f] isAgentLive's `launched` limb specifically — a launched agent must read running
//        with NO turn in flight, which is the whole background-agent case.
//   [2h]/[2i] terminal-result pairing BY TOOL ID. [2h] alone would also pass under a global
//        "something finished" flag; [2i] is what rules that out, and MU7 is what proves it.
//
// ★ AND ONE MEASUREMENT THAT CORRECTED A PREDICTION, kept because the shape recurs: MU2 was
//   predicted to red [1a], [1b] AND [1c], on the reasoning that one un-reset index map would
//   collapse every later message onto the first item. It reds [1c] ALONE. Each check is read
//   immediately after its own batch lands and before the next one is asked for, so the
//   earlier markers had already been counted while they were still correct. That temporal
//   isolation is a property of the gating, not an accident, and it is why MU1 and MU2
//   partition into two disjoint signatures instead of one smeared red.
