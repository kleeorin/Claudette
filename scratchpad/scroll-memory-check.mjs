// SCROLL-POSITION MEMORY PROBE — does switching sessions lose your place in a file?
//
//   CHROME_BIN=… node scratchpad/scroll-memory-check.mjs
//
// Operator report: "when moving between sessions, the position of view in a file is
// restarted and the file goes back to the beginning… not just terminals. Also the
// notebook, the viewer, the editor etc."
//
// The hypothesis under test is that the cause was the scroll-memory KEY: it was
// `file:${path}`, path only, so two sessions open on the same file shared ONE stored
// offset and each overwrote the other's. This probe is written to be able to FALSIFY that,
// not to agree with it — see the discriminating case below.
//
// Own server (4499), own vite (5299), own Chrome (CDP 9359). Never serves web/dist, which
// is stale and unrebuildable here; vite compiles the working tree.
//
// ── WHY THE CASES ARE SHAPED THIS WAY ────────────────────────────────────────────────
// [baseline]  A scrolls, leaves to a session that does NOT open the file, comes back.
//             Passes under the OLD key too — it proves the mechanism is alive, and
//             separates "scroll memory is entirely broken" from "the key collides". It is
//             NOT evidence for the diagnosis, and is labelled so it cannot be read as such.
// [discriminating]  The SAME file open in BOTH sessions, scrolled to DIFFERENT offsets.
//             This is the only case that isolates the key. Under `file:${path}` the second
//             session's scroll overwrites the first's entry and returning lands at the
//             wrong offset; under `file:${sessionId}:${path}` both survive. Verified by
//             reverting the key and re-running — see the falsifiability log at the bottom.
//
// ── TWO WAYS THIS PROBE COULD PASS FOR THE WRONG REASON, both guarded ────────────────
// 1. Asserting `scrollTop > 0` instead of "≈ where it was". A collision typically lands
//    you at the OTHER session's offset, which is usually non-zero — so a `> 0` assertion
//    is green on the exact bug. Every check below asserts proximity to a specific number.
// 2. Reading the offset before the restore settles. useScrollMemory re-applies across
//    frames with a 60-frame stability window and an 8s backstop, so a single read can
//    catch an intermediate clamped value. Everything here polls until the offset stops
//    moving (settleScroll) instead of reading once.
// ── FALSIFIABILITY LOG — the diagnosis was CONFIRMED, not merely consistent ──────────
// Baseline (per-session keys, as shipped):        15 passed / 0 failed.
// Keys reverted to path-only (`file:${path}` and `nb:${doc.path}`), same probe:
//        13 passed / 2 FAILED — and with the exact predicted signature, not just a red:
//        "Alpha still at ITS offset, not Beta — expected ~1500, got 120  ← this is BETA
//         offset: the keys collided"  … and the same for the notebook.
//        The [baseline] check stayed GREEN in that run, which is why it is labelled as not
//        being evidence: it cannot see this bug at all.
// So the key WAS the bug, for both the editor and the notebook, and the fix is load-bearing
// rather than incidental. Re-run the revert if you ever doubt it; it takes one edit.
//
// ── [hole] THIS PROBE COVERS ONE OF THE TWO CAUSES. MEASURED, NOT SUSPECTED ──────────
// The operator's report had a SECOND, independent cause: the `settled` counter in
// scrollMemory.ts incremented even when the container could not scroll at all, and "content
// has not loaded yet" is a perfectly stable scrollHeight. 60 frames (~1s) of an empty box
// declared the layout settled and abandoned the restore for good, eight times earlier than
// the RESTORE_MS=8000 backstop meant to catch exactly that. One slow load forgets the
// position permanently, on all five surfaces, with no second session involved.
// THIS PROBE IS BLIND TO IT. Proven by mutation on 2026-08-24: revert the `!canScroll`
// reset in scrollMemory.ts (leaving only `if (el.scrollHeight === lastHeight) settled++`)
// and this probe STILL PASSES 15/0. Not "probably untested" — measured untested.
// The reason is the false-pass trap itself: the bug survived this long precisely because a
// small or cached file resolves in well under a second, so the height changes and the
// counter resets. A probe opening a fixture file on localhost is that fast-load case.
// TO CLOSE IT: force a slow load (throttle the response, or a genuinely multi-MB file) and
// assert the offset still restores. It is only a real test if reverting the `!canScroll`
// reset turns it RED — otherwise it is another fast-load probe wearing a new name.
// ALSO UNCOVERED: DiffEditor, which had no scroll memory wired at all and has since been
// fixed; nothing here exercises it.
//
// ── [3] GIT PANEL — FALSIFIABILITY LOG. Five mutations, each measured, 2026-08-25 ─────
// Baseline, as shipped: 36 passed / 0 failed. Then, one break at a time:
//   M1  the three useScrollMemory calls removed  → 32/4: [3a] [3b] [3c] [3f] red, each at 0.
//       [3d] [3e] [3g] stayed GREEN — see below.
//   M2  key changed to `git:${sessionId}:…`      → 35/1: [3g] alone, "got 250 ← ALPHA's
//       earlier offset". This is the case for keying by cwd, and nothing else finds it.
//   M3  cwd dropped from the key                 → 35/1: [3d] alone, "got 250 ← ALPHA offset".
//   M4  the patch dropped from the diff key      → 35/1: [3c] alone, "got 300 ← BIG2 offset".
//   M5  constant keys instead of null-while-hidden → 35/1: [3f] alone, at 0.
// Every red carried its predicted diagnostic string, not merely a wrong number.
//
// ★ [3d], [3e] and [3g] PIN THE KEY, NOT THE WIRING — all three stay green under M1, when
//   there is no scroll memory at all. Do not read them as coverage that this feature works;
//   [3a], [3b] and [3f] are that, and they are the only ones M1 can reach.
//
// ── A CHECK THAT WAS WRONG UNTIL IT WAS MEASURED, kept here because the shape recurs ──
// [3e] first compared against the CONSTANT G_LIST. Under M1 the restore never happened, the
// list was already at 0 before the session switch, and [3e] went red announcing "the key is
// session-scoped" — a confident wrong diagnosis of a break that was not present. It now
// compares against the offset observed immediately before the switch, so it can only red for
// its own reason. Triage-masking, the same shape as refresh-survival-check's H3/H5.
// And [3e] was then found to be no evidence AT ALL for the cwd-vs-session question: under M2
// the entire section was 36/0. A key nobody has stored yet has target 0, and the hook only
// forces an offset when target > 0, so session-scoping is a no-op on a first switch rather
// than the "invented scroll jump" that had been predicted. [3g] exists because of that
// measurement — it makes Beta leave its own offset behind first, which is the only way the
// two schemes diverge. A correct belief plus a test that cannot falsify it is luck.

// ── [4] AGENT DETAIL — FALSIFIABILITY LOG. Four mutations, each measured, 2026-08-25 ──
// Baseline, whole file as shipped: 58 passed / 0 failed ([1]-[3] = 36, [4] = 22).
//   MA  the useScrollMemory call removed        → 56/2: [4a] [4b].
//   MB  pinnedByKey neither read nor written    → 55/3: [4a] [4b] [4c], [4c] carrying
//       "← this is the END: the pin was re-asserted as true on remount".
//   MC  sessionId dropped from the key          → 57/1: [4b] alone, "got 90 ← this is BETA
//       offset: the key is not session-scoped".
//   MD  useScrollMemory moved BELOW the follow effect → 57/1: [4d] alone, "landed=6891
//       ← the RESTORE won: parked at the OLD end, no longer following".
//
// ★ WHAT EACH CHECK ACTUALLY PINS, since the four mutations do not partition cleanly:
//   [4a] the wiring          — red under MA and MB
//   [4b] the wiring AND the session in the key — red under MA, MB and MC. It is NOT a pure key
//        check, because a same-id session switch does not remount the view (see its note), so
//        its diagnostic is GATED on [4a] having passed. Ungated it announced "the key is not
//        session-scoped" under MA, which removed the scroll memory entirely — a confident wrong
//        diagnosis of a break that was not present, exactly the fault [3e] was fixed for.
//   [4c] the pin memory      — the ONLY check that separates MB from MA.
//   [4d] the ORDER of the hook against the follow effect — red under MD alone, and GREEN under
//        both MA and MB. It is not coverage that either fix works; do not count it as such.
//
// ★ TWO JUSTIFICATIONS IN THIS SECTION WERE WRITTEN, THEN MEASURED FALSE, AND BOTH ARE KEPT
//   IN PLACE WITH THEIR MEASUREMENTS (see [4c] and [4d]). Both failed the same way: they
//   reasoned about what the scroll-memory hook does over time and ignored what ORDER it runs
//   in relative to the follow effect. A justification is a claim, and an unmeasured one is
//   worth no more than an unmeasured STATUS line.

import { spawn, execFileSync } from 'child_process'
import { mkdtemp, writeFile, mkdir, chmod, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4499, WEB_PORT = 5299, CDP_PORT = 9359
const APP = `http://127.0.0.1:${WEB_PORT}`, API = `http://127.0.0.1:${PORT}`
const TOKEN = 'scroll-memory-token'
const A_OFFSET = 1500, B_OFFSET = 120     // deliberately far apart and both non-zero
// Git panel offsets. Its three containers are much shorter than a 4000-line file, so they
// get their own targets; each is asserted to be well short of its container's own max.
const G_LIST = 250, G_DIFF = 900, G_LOG = 200
// Agent detail offsets. A_AGENT is deliberately mid-document: far from 0, and far enough
// from the end that the follow-on-new-activity effect cannot produce it by accident.
const A_AGENT = 400, B_AGENT = 90
// Both sessions' stubs emit the SAME Task tool id on purpose — agentKey() is the tool id, so
// Alpha and Beta end up holding an agent with an IDENTICAL agentId. That is the only way to
// test that `agent:${sessionId}:${agentId}` keeps two readers apart, exactly as [1] does for
// a file open in two sessions.
const TASK_TOOL_ID = 'tu-probe-agent-1'
const AGENT_DESC = 'Trace the scroll path'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
import { withMarks, passed, failed } from './assert.mjs'
const ok = withMarks({ indent: '  ' })

const DATA = await mkdtemp(join(tmpdir(), 'scroll-data-'))
const PROJ = await mkdtemp(join(tmpdir(), 'scroll-proj-'))
const BIN = await mkdtemp(join(tmpdir(), 'scroll-bin-'))
// A SECOND repo, for the only case that can prove `cwd` is really in the git panel's key.
const PROJ2 = await mkdtemp(join(tmpdir(), 'scroll-proj2-'))

// Long enough that A_OFFSET is nowhere near the end — an offset that clamps to the bottom
// would compare equal for the wrong reason.
await writeFile(join(PROJ, 'long.py'), Array.from({ length: 4000 }, (_, i) => `line_${i} = ${i}  # filler`).join('\n') + '\n')
await writeFile(join(PROJ, 'long.ipynb'), JSON.stringify({
  cells: Array.from({ length: 120 }, (_, i) => ({
    cell_type: 'code', source: [`# cell ${i}\nx${i} = ${i}\n`], metadata: {}, outputs: [], execution_count: null,
  })),
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } },
  nbformat: 4, nbformat_minor: 5,
}))

// ── git fixture ──────────────────────────────────────────────────────────────────────
// Each repo needs all three of the git panel's scroll containers to actually overflow, or
// the checks below would pass on a container that cannot scroll — the same false-pass the
// `maxScroll > OFFSET * 2` assertions guard against elsewhere in this file.
//   · changed-files list: 60 modified files + a rewritten big.txt
//   · diff pane:          big.txt rewritten line-for-line → ~1600 diff lines
//   · commit list:        40 commits
// `-c user.*` rather than `git config`, so this never depends on (or touches) the operator's
// global git identity — the harness must not read config from outside its own temp dirs.
const git = (dir, ...args) => execFileSync('git',
  ['-c', 'user.email=scroll@probe.invalid', '-c', 'user.name=Scroll Probe',
   '-c', 'init.defaultBranch=main', '-C', dir, ...args],
  { stdio: ['ignore', 'pipe', 'pipe'] }).toString()

async function makeRepo(dir, tag) {
  git(dir, 'init', '-q')
  for (let i = 0; i < 60; i++) await writeFile(join(dir, `f${String(i).padStart(2, '0')}.txt`), `${tag} original ${i}\n`)
  await writeFile(join(dir, 'big.txt'), Array.from({ length: 800 }, (_, i) => `${tag} big original line ${i}`).join('\n') + '\n')
  await writeFile(join(dir, 'big2.txt'), Array.from({ length: 800 }, (_, i) => `${tag} big2 original line ${i}`).join('\n') + '\n')
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', `${tag} base`)
  // Empty commits are enough: only the subject/author/date rows are rendered in the log list.
  for (let i = 0; i < 40; i++) git(dir, 'commit', '-q', '--allow-empty', '-m', `${tag} nudge ${i}`)
  // Now dirty the tree: every file changed → a list that overflows, and big.txt rewritten
  // line-for-line → a diff long enough that G_DIFF is nowhere near its end.
  for (let i = 0; i < 60; i++) await writeFile(join(dir, `f${String(i).padStart(2, '0')}.txt`), `${tag} CHANGED ${i}\n`)
  await writeFile(join(dir, 'big.txt'), Array.from({ length: 800 }, (_, i) => `${tag} big REWRITTEN line ${i}`).join('\n') + '\n')
  await writeFile(join(dir, 'big2.txt'), Array.from({ length: 800 }, (_, i) => `${tag} big2 REWRITTEN line ${i}`).join('\n') + '\n')
}
await makeRepo(PROJ, 'alpha')
await makeRepo(PROJ2, 'gamma')

// ── the stand-in CLI ────────────────────────────────────────────────────────────────
// ★ THIS STUB IS SHARED BY ALL THREE SESSIONS THROUGH PATH, so it must stay SILENT until
//   section [4] asks for a subagent. Sections [1]-[3] are 36 checks that measure the file,
//   notebook and git-panel scrollers; an unconditional Task frame would put a subagent card
//   in front of every one of them and change what they are measuring. Each batch fires once,
//   when its marker file appears, and never on its own.
const MARK = await mkdtemp(join(tmpdir(), 'scroll-go-'))
const GO = { a: join(MARK, 'go-agent'), b: join(MARK, 'go-more-b'), c: join(MARK, 'go-more-c') }
for (const f of Object.values(GO)) await rm(f, { force: true })

// One step of the subagent's own activity, as a THINKING block: rendered in full by
// AgentDetail (unlike the collapsed rows in the conversation), so a handful of them make the
// pane genuinely overflow — a pane that cannot scroll would pass every check below for the
// wrong reason. The `probe-step-` token is what agentSteps() counts, which is how the two
// growth cases prove more activity actually arrived rather than assuming it did.
const stepFrame = (n) => ({
  type: 'assistant', parent_tool_use_id: TASK_TOOL_ID,
  message: { role: 'assistant', content: [{ type: 'thinking', thinking:
    `probe-step-${n}\n` + Array.from({ length: 5 }, (_, i) => `  reasoning line ${i} of step ${n}`).join('\n') }] },
})
const BATCH = {
  // a: the Task call itself, then the async-launch ack. The ack is what makes the agent
  // LIVE without a running turn (isAgentLive = !result && (launched || turnActive)), and
  // `active` is the gate on AgentDetail's follow effect — without it [4c]/[4d] could not
  // test the pin at all, because the effect they exercise would never run.
  a: [
    { type: 'assistant', message: { role: 'assistant', content: [{
      type: 'tool_use', id: TASK_TOOL_ID, name: 'Task',
      input: { description: AGENT_DESC, subagent_type: 'explorer',
               prompt: 'Find every scroll container in the app and report where each keeps its position.' },
    }] } },
    { type: 'user', message: { role: 'user', content: [{
      type: 'tool_result', tool_use_id: TASK_TOOL_ID,
      content: 'Async agent launched successfully (probe task 1)',
    }] } },
    ...Array.from({ length: 40 }, (_, i) => stepFrame(i)),
  ],
  b: Array.from({ length: 20 }, (_, i) => stepFrame(100 + i)),   // arrives while MOUNTED  → [4c]
  c: Array.from({ length: 20 }, (_, i) => stepFrame(200 + i)),   // arrives while UNMOUNTED → [4d]
}

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
}, 150)
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
if (!log.includes('Server listening')) { console.error(log.slice(-1500)); throw new Error('server did not start') }
for (let i = 0; i < 90 && !weblog.includes('ready in'); i++) await wait(500)
if (!weblog.includes('ready in')) { console.error(weblog.slice(-1500)); throw new Error('vite did not start') }
console.log('server + vite up')

const hdr = { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` }
const apiPost = (p, b) => fetch(`${API}${p}`, { method: 'POST', headers: hdr, body: JSON.stringify(b) }).then((r) => r.json())
const mk = (name, dir = PROJ) => apiPost('/api/session/create', { name, cwd: dir, rootDir: dir, sandbox: { enabled: false, mounts: [] } })
// Alpha and Beta deliberately SHARE a cwd — that is what makes [3]'s no-jump case meaningful,
// since <GitPanelView key={termCwd}> then does not remount when you switch between them.
// Gamma is the odd one out, on its own repo, so switching to it DOES remount the panel.
const alpha = await mk('Alpha'), beta = await mk('Beta'), gamma = await mk('Gamma', PROJ2)
console.log(`sessions: Alpha=${alpha.id.slice(0, 8)} Beta=${beta.id.slice(0, 8)}`)

const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
if (!existsSync(CHROME)) { console.error(`no Chrome at ${CHROME} (set CHROME_BIN)`); reapAll(); process.exit(1) }
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${await mkdtemp(join(tmpdir(), 'chrome-scroll-'))}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,900', 'about:blank'],
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
// A dead socket must be a loud failure, not a silent hang holding the ports (see
// scratchpad/layout-check.mjs, where exactly that produced a 9-minute squatter).
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

const HELPERS = `
window.__sm = {
  // The scroll container for the code editor: the nearest ancestor of .cm-content that
  // actually overflows. Resolved by MEASUREMENT rather than by class name, so a Tailwind
  // or CodeMirror change cannot silently retarget it to a non-scrolling wrapper.
  codeScroller() {
    let n = document.querySelector('.cm-content');
    while (n && n !== document.body) {
      if (n.scrollHeight - n.clientHeight > 50) return n;
      n = n.parentElement;
    }
    return null;
  },
  nbScroller() {
    const els = [...document.querySelectorAll('div')].filter((e) => e.scrollHeight - e.clientHeight > 50);
    return els.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? null;
  },
  clickSession(name) {
    const aside = document.querySelector('aside'); if (!aside) return false;
    const row = [...aside.querySelectorAll('button, [role="button"], li, div')]
      .filter((e) => (e.textContent || '').trim().startsWith(name))
      .sort((a, b) => a.textContent.length - b.textContent.length)[0];
    if (!row) return false;
    row.click(); return true;
  },
  clickExact(label) {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === label);
    if (!b) return false; b.click(); return true;
  },
  // Find a scroll container by CONTENT, taking the INNERMOST scrollable element that
  // contains it. An ANCESTOR matches the same text and can also scroll, and measuring the
  // ancestor would pass for the wrong reason — it moves when you set scrollTop, so nothing
  // about the assertion would look wrong. Same reason codeScroller resolves by measurement
  // instead of by class name. Used by the git panel's three containers AND by [4]'s agent
  // detail pane, which is why it is not named for the git panel.
  innermostScrollable(pred) {
    const hits = [...document.querySelectorAll('div')]
      .filter((e) => e.scrollHeight - e.clientHeight > 20 && pred(e.textContent || ''));
    if (!hits.length) return null;
    return hits.sort((a, b) => a.getElementsByTagName('*').length - b.getElementsByTagName('*').length)[0];
  },
  gitChangesScroller() { return this.innermostScrollable((t) => t.includes('Staged (') && t.includes('Changed (')); },
  gitDiffScroller() { return this.innermostScrollable((t) => t.includes('@@')); },
  gitLogScroller() { return this.innermostScrollable((t) => t.includes('nudge 39')); },
  // FileRow's title attribute is the path, an em dash, then the status word — the only
  // thing on the row unique to it: the text content is a one-letter badge, the path, and a
  // stage button. (No template placeholders in this comment: HELPERS is itself a template
  // literal, so a dollar-brace here would be interpolated by the harness, not by the page.)
  gitClickFile(path) {
    const row = document.querySelector('div[title^=' + JSON.stringify(path + ' \u2014 ') + ']');
    if (!row) return false;
    row.click(); return true;
  },
  gitSelected(path) {
    const row = document.querySelector('div[title^=' + JSON.stringify(path + ' \u2014 ') + ']');
    return !!row && row.className.includes('bg-ctp-surface1');
  },
  // ── [4] the agent detail view ──────────────────────────────────────────────────────
  // A control belonging to ONE session's sidebar row: the SMALLEST element whose text starts
  // with that session's name and which contains the control we want, then the control inside
  // it. Scoping by containment rather than by document order or index, because the badge and
  // the expanded agent list live in different wrappers within the row, and a name only
  // identifies a subtree — every ancestor of Alpha's row ALSO starts with "Alpha", so the
  // smallest match is the row itself. (The first attempt here searched only BUTTON elements
  // for the row anchor and found nothing, because a session row is not a button —
  // that is what made the whole section report "no subagent ever appeared".)
  // Two sessions hold an agent with the SAME id here, which is exactly the situation where
  // picking the wrong one would look like a passing test — so every use is ALSO cross-checked
  // against the detail header's own "in <session>" line (agentInSession).
  sidebarPick(name, sel) {
    const aside = document.querySelector('aside'); if (!aside) return null;
    const els = [...aside.querySelectorAll('*')]
      .filter((e) => (e.textContent || '').trim().startsWith(name) && e.querySelector(sel));
    if (!els.length) return null;
    const scope = els.sort((a, b) => a.getElementsByTagName('*').length - b.getElementsByTagName('*').length)[0];
    return scope.querySelector(sel);
  },
  agentBadge(name) { return this.sidebarPick(name, 'button[title*="subagent"]'); },
  agentLine(name) { return this.sidebarPick(name, 'button[title*="open its thought process"]'); },
  agentScroller() { return this.innermostScrollable((t) => t.includes('Thought process')); },
  // AgentDetail's own header says which session it belongs to. Reading it back is a direct
  // answer to "did I open the one I meant?", rather than an inference from sidebar order.
  agentInSession() {
    const el = this.agentScroller(); if (!el) return null;
    // The HEADER element specifically, not the parent's whole textContent: textContent
    // concatenates with no separators, so " · in Alpha" would run straight into "Task
    // prompt…" and any regex would capture the transcript along with the name.
    const head = el.parentElement && el.parentElement.firstElementChild;
    const m = head ? head.textContent.match(/· in (.+)$/) : null;
    return m ? m[1].trim() : null;
  },
  // How much of the agent's activity is on screen. Both growth cases assert this INCREASED
  // rather than assuming the new frames arrived — a batch that never lands would otherwise
  // leave them measuring a transcript that did not change and calling it a pass.
  agentSteps() {
    const el = this.agentScroller(); if (!el) return -1;
    return (el.textContent.match(/probe-step-/g) || []).length;
  },
  // The content tab for the agent, in the strip. Its title is the agent's description.
  agentTab(label) {
    const b = [...document.querySelectorAll('button')].find((x) => (x.title || '') === label);
    if (!b) return false; b.click(); return true;
  },
  openFile(name) {
    const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').includes(name));
    if (!b) return false;
    b.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
    return true;
  },
}; true`

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/api/auth?token=${TOKEN}` })
await wait(1200)
await send('Page.navigate', { url: `${APP}/` })
if (!await waitFor(`!!document.querySelector('aside') || !!document.querySelector('textarea')`, 40000)) {
  console.error('app never rendered'); console.error(weblog.slice(-1200)); reapAll(); process.exit(1)
}
await evaluate(HELPERS)
await wait(800)

// Poll until the offset stops moving. useScrollMemory re-applies across frames, so a
// single read can catch a clamped intermediate value and report the wrong answer either way.
// Every scroll container this probe measures. A MAP rather than the nb/code ternary this
// started as: a ternary sends an unrecognised name to the code editor, so a typo would have
// silently measured the wrong container and reported a confident wrong number.
const SCROLLER = {
  code: 'window.__sm.codeScroller()',
  nb: 'window.__sm.nbScroller()',
  gitList: 'window.__sm.gitChangesScroller()',
  gitDiff: 'window.__sm.gitDiffScroller()',
  gitLog: 'window.__sm.gitLogScroller()',
  agent: 'window.__sm.agentScroller()',
}
async function settleScroll(which) {
  const expr = SCROLLER[which]
  if (!expr) throw new Error(`unknown scroller: ${which}`)
  let last = -1, stable = 0
  for (let i = 0; i < 120; i++) {
    const v = await evaluate(`(() => { const el = ${expr}; return el ? Math.round(el.scrollTop) : -1 })()`)
    if (v === last) { stable++; if (stable >= 6) return v } else { stable = 0; last = v }
    await wait(120)
  }
  return last
}
const setScroll = async (which, top) => {
  const expr = SCROLLER[which]
  return evaluate(`(() => { const el = ${expr}; if (!el) return -1; el.scrollTop = ${top}; return Math.round(el.scrollTop) })()`)
}
const maxScrollOf = (which) =>
  evaluate(`(() => { const el = ${SCROLLER[which]}; return el ? Math.round(el.scrollHeight - el.clientHeight) : -1 })()`)
async function switchTo(name) {
  await evaluate(`window.__sm.clickSession(${JSON.stringify(name)})`)
  await wait(900)
  await evaluate(HELPERS)
}
async function openInDock(file, which) {
  await evaluate(`window.__sm.clickExact('Files')`); await wait(500)
  await evaluate(`window.__sm.openFile(${JSON.stringify(file)})`)
  const sel = which === 'nb' ? `!!window.__sm.nbScroller()` : `!!document.querySelector('.cm-content')`
  const up = await waitFor(sel, 25000)
  await evaluate(`window.__sm.clickExact('Files')`)   // close the dock so it can't be the scroller we measure
  await wait(500)
  return up
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[1] the CODE EDITOR (CodeEditor / CodeMirror)')
// ═══════════════════════════════════════════════════════════════════════════════
ok('Alpha is the active session on load', await evaluate(`!!document.querySelector('aside')`), '', 'setup')
ok('long.py opened in Alpha', await openInDock('long.py', 'code'), '', 'setup')
const maxScroll = await evaluate(`(() => { const el = window.__sm.codeScroller(); return el ? Math.round(el.scrollHeight - el.clientHeight) : -1 })()`)
ok('the editor actually scrolls, and A_OFFSET is well short of the end', maxScroll > A_OFFSET * 2, `max=${maxScroll} target=${A_OFFSET}`, 'setup')
await setScroll('code', A_OFFSET)
const aSet = await settleScroll('code')
ok('Alpha scrolled to the target offset', Math.abs(aSet - A_OFFSET) <= 2, `at ${aSet}`, 'setup')

// ── [baseline] leave to a session that never opens the file, and come back ──────
await switchTo('Beta'); await wait(600)
await switchTo('Alpha')
const aBack = await settleScroll('code')
ok('returning to Alpha keeps its place (passes under the OLD key too — not evidence)', Math.abs(aBack - A_OFFSET) <= 3, `expected ~${A_OFFSET}, got ${aBack}`, 'baseline')

// ── [discriminating] the SAME file open in BOTH sessions at DIFFERENT offsets ───
await switchTo('Beta')
ok('long.py opened in Beta as well', await openInDock('long.py', 'code'), '', 'setup')
await setScroll('code', B_OFFSET)
const bSet = await settleScroll('code')
ok('Beta scrolled to its own, different offset', Math.abs(bSet - B_OFFSET) <= 2, `at ${bSet}`, 'setup')

await switchTo('Alpha')
const aFinal = await settleScroll('code')
ok('Alpha still at ITS offset, not Beta (the per-session key)', Math.abs(aFinal - A_OFFSET) <= 3, `expected ~${A_OFFSET}, got ${aFinal}${Math.abs(aFinal - B_OFFSET) <= 3 ? '  ← this is BETA offset: the keys collided' : ''}`, 'discriminating')

await switchTo('Beta')
const bFinal = await settleScroll('code')
ok('Beta still at ITS offset, not Alpha', Math.abs(bFinal - B_OFFSET) <= 3, `expected ~${B_OFFSET}, got ${bFinal}${Math.abs(bFinal - A_OFFSET) <= 3 ? '  ← this is ALPHA offset: the keys collided' : ''}`, 'discriminating')

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[2] the NOTEBOOK (NotebookView)')
// NotebookView keys nb:${sessionId}:${doc.path} — same collision, same shape of test.
// ═══════════════════════════════════════════════════════════════════════════════
await switchTo('Alpha')
const nbOpen = await openInDock('long.ipynb', 'nb')
ok('long.ipynb opened in Alpha', nbOpen, '', 'setup')
if (nbOpen) {
  const nbMax = await evaluate(`(() => { const el = window.__sm.nbScroller(); return el ? Math.round(el.scrollHeight - el.clientHeight) : -1 })()`)
  ok('the notebook actually scrolls', nbMax > A_OFFSET * 2, `max=${nbMax}`, 'setup')
  await setScroll('nb', A_OFFSET)
  const nbA = await settleScroll('nb')
  ok('Alpha notebook scrolled to the target offset', Math.abs(nbA - A_OFFSET) <= 2, `at ${nbA}`, 'setup')

  await switchTo('Beta')
  ok('long.ipynb opened in Beta as well', await openInDock('long.ipynb', 'nb'), '', 'setup')
  await setScroll('nb', B_OFFSET)
  const nbB = await settleScroll('nb')
  ok('Beta notebook scrolled to its own offset', Math.abs(nbB - B_OFFSET) <= 2, `at ${nbB}`, 'setup')

  await switchTo('Alpha')
  const nbAFinal = await settleScroll('nb')
  ok('Alpha notebook still at ITS offset, not Beta', Math.abs(nbAFinal - A_OFFSET) <= 3, `expected ~${A_OFFSET}, got ${nbAFinal}${Math.abs(nbAFinal - B_OFFSET) <= 3 ? '  ← BETA offset: the keys collided' : ''}`, 'discriminating')
} else {
  console.log('  ⚠ notebook did not open — the notebook half of this probe did not run')
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[3] the GIT PANEL (GitPanelView)')
// Mounted as <GitPanelView key={termCwd} cwd={termCwd}> (App.tsx), so the panel is destroyed
// and rebuilt whenever the dock is closed or the active session's cwd changes — both ordinary
// things to do while halfway down a 60-file change list or a 1600-line diff.
//
// ── WHY THIS ONE IS KEYED BY CWD AND NOT BY SESSION ──────────────────────────────────
// Every other consumer of this hook keys `${sessionId}:` (file:, nb:, agent:). This one keys
// `git:${cwd}:`, and [3d]/[3e] are the two cases that pin that choice, one in each direction:
//   [3d] proves cwd IS in the key   — a second repo must not inherit the first's offset.
//   [3g] proves session is NOT in it — Alpha and Beta share a cwd, so the panel does not
//        remount when you switch between them and there is only ONE scroll position in
//        existence. [3g] is the check that goes red if someone "unifies" this key with the
//        other five.
// ⚠ [3e] is NOT that check, though it was written believing it was. The claim it was built on
//   — "session-scoping would invent a scroll jump where today there is none" — was MEASURED
//   FALSE (M2 below: the whole section stayed 36/0 under a session key). An unseen key has
//   target 0 and the hook only forces an offset when target > 0, so session-scoping is a
//   no-op on a first switch, not a jump. [3e] still earns its place as "the switch moved
//   nothing", but it decides nothing about the key. See the note further down.
// ═══════════════════════════════════════════════════════════════════════════════
const G_DIFF_B = 300          // big2.txt's offset — far from G_DIFF, and non-zero
const G_LIST_B = 600          // where Beta leaves the change list — far from G_LIST, and non-zero
const toggleGit = async () => {
  const hit = await evaluate(`window.__sm.clickExact('Git')`)
  await wait(700)
  return hit
}
const gitStatusShown = `document.body.textContent.includes('Changed (')`

await switchTo('Alpha')
const gitOpened = await toggleGit() && await waitFor(gitStatusShown, 25000)
ok('the Git dock opens on Alpha', gitOpened, '', 'setup')
const listMax = gitOpened ? await maxScrollOf('gitList') : -1
ok('the changed-files list actually scrolls, and G_LIST is well short of its end', listMax > G_LIST * 2, `max=${listMax} target=${G_LIST}`, 'setup')

// Everything below reads a container this probe has just proved it can find and measure.
// Without this gate a missing scroller reports -1 everywhere, and `-1 !== G_LIST` renders as
// a confident row of red findings about scroll memory rather than "the probe lost the panel".
if (listMax > G_LIST * 2) {
  await setScroll('gitList', G_LIST)
  const listSet = await settleScroll('gitList')
  ok('the changed-files list is at the target offset', Math.abs(listSet - G_LIST) <= 2, `at ${listSet}`, 'setup')

  // [3a] The plain case: close the dock, open it again.
  await toggleGit()
  const closed = !await evaluate(gitStatusShown)
  // Assert the TEARDOWN, not just that the click landed: if the panel never unmounted, [3a]
  // would pass with no scroll memory involved at all — the DOM node would simply still be
  // there, still scrolled. This is the check that makes [3a] mean something.
  ok('the dock really closed, so the panel really unmounted', closed, '', 'setup')
  await toggleGit()
  await waitFor(`!!window.__sm.gitChangesScroller()`, 25000)
  const listBack = await settleScroll('gitList')
  ok('[3a] the changed-files list comes back where you left it', Math.abs(listBack - G_LIST) <= 3, `expected ~${G_LIST}, got ${listBack}`, 'core')

  // [3b]/[3c] The diff pane. Its subject is the specific patch, so the patch is in the key.
  const picked = await evaluate(`window.__sm.gitClickFile('big.txt')`)
  ok('big.txt is selectable in the changed-files list', picked, '', 'setup')
  const diffUp = picked && await waitFor(`!!window.__sm.gitDiffScroller()`, 25000)
  const diffMax = diffUp ? await maxScrollOf('gitDiff') : -1
  ok("big.txt's diff actually scrolls, and G_DIFF is well short of its end", diffMax > G_DIFF * 2, `max=${diffMax} target=${G_DIFF}`, 'setup')

  if (diffMax > G_DIFF * 2) {
    await setScroll('gitDiff', G_DIFF)
    const diffSet = await settleScroll('gitDiff')
    ok("big.txt's diff is at the target offset", Math.abs(diffSet - G_DIFF) <= 2, `at ${diffSet}`, 'setup')

    // [3c] Two patches, one container, NO unmount — the case that isolates the subject half
    // of the key. With `git:${cwd}:diff` alone the key never changes as you switch files, so
    // the effect never re-runs: the browser just keeps whatever scrollTop the previous patch
    // had, and coming back to big.txt lands on big2.txt's offset.
    await evaluate(`window.__sm.gitClickFile('big2.txt')`)
    const bUp = await waitFor(`document.body.textContent.includes('big2 REWRITTEN')`, 25000)
    ok("big2.txt's diff is showing", bUp, '', 'setup')
    await setScroll('gitDiff', G_DIFF_B)
    const bSet = await settleScroll('gitDiff')
    ok("big2.txt's diff is at its own offset", Math.abs(bSet - G_DIFF_B) <= 2, `at ${bSet}`, 'setup')
    await evaluate(`window.__sm.gitClickFile('big.txt')`)
    await waitFor(`!document.body.textContent.includes('big2 REWRITTEN')`, 25000)
    const aBack = await settleScroll('gitDiff')
    ok("[3c] each file's diff keeps its own place in the shared pane", Math.abs(aBack - G_DIFF) <= 3, `expected ~${G_DIFF}, got ${aBack}${Math.abs(aBack - G_DIFF_B) <= 3 ? '  ← this is BIG2 offset: the patch is not in the key' : ''}`, 'discriminating')
  } else {
    console.log('  ⚠ the diff pane never scrolled — [3c] did not run')
  }

  // [3d] A DIFFERENT repo. Gamma's cwd is PROJ2, so the panel's mount key changes and it
  // remounts. Its list must start at the top; inheriting Alpha's offset means cwd fell out
  // of the key. Gamma's list is asserted to scroll first, so "at the top" cannot pass merely
  // because there was nothing to scroll.
  await switchTo('Gamma')
  await waitFor(`!!window.__sm.gitChangesScroller()`, 25000)
  const gMax = await maxScrollOf('gitList')
  ok("Gamma's own change list also scrolls, so 'at the top' is not trivially true", gMax > G_LIST * 2, `max=${gMax}`, 'setup')
  const gList = await settleScroll('gitList')
  ok("[3d] a second repo's panel starts at the top, not at Alpha's offset", gList <= 3, `expected ~0, got ${gList}${Math.abs(gList - G_LIST) <= 3 ? '  ← this is ALPHA offset: cwd is not in the key' : ''}`, 'discriminating')

  // [3e] Back to Alpha (remount, must restore), then Alpha → Beta, which share a cwd and so
  // share the mounted panel. Nothing should move at all.
  await switchTo('Alpha')
  await waitFor(`!!window.__sm.gitChangesScroller()`, 25000)
  const aList = await settleScroll('gitList')
  ok('[3b] the list survives a round-trip through another repo', Math.abs(aList - G_LIST) <= 3, `expected ~${G_LIST}, got ${aList}`, 'core')
  await switchTo('Beta')
  const betaList = await settleScroll('gitList')
  // Compared against the offset OBSERVED a moment ago, not against G_LIST. This asks one
  // question — "did the switch MOVE anything?" — and comparing to the constant answered a
  // different one: MEASURED under the no-wiring mutation, [3b] failed, the list was already at 0
  // before the switch, and this went red anyway saying "the key is session-scoped" — a confident
  // wrong diagnosis of a break that was not present. Triage-masking, same shape as H3/H5 in
  // refresh-survival-check. Against `aList` it can only ever red for its own reason.
  ok('[3e] switching to a session that SHARES the cwd does not move the panel', Math.abs(betaList - aList) <= 3, `expected it to stay at ${aList}, got ${betaList}`, 'discriminating')

  // [3g] ★ THE CHECK THAT ACTUALLY DECIDES THE KEY. [3e] above does NOT — MEASURED: mutating the
  // key to `git:${sessionId}:…` and threading the active session in left the whole section at
  // 34/0. The predicted "session-scoping invents a scroll jump" does not happen on a first
  // switch, because a key nobody has stored yet has target 0, and the hook only FORCES an offset
  // when target > 0 (`restoring = target > 0`) — an unseen key is a no-op, not a jump.
  // It takes a session that has left its OWN offset behind to tell the two apart. So: Beta moves
  // the panel, then we return to Alpha. One panel, one DOM node, one position — it should still
  // be where Beta left it. Under a session key, returning to Alpha restores Alpha's older offset
  // and the view scrolls out from under you with nothing having remounted.
  // ★ [3g] STAYS GREEN when the wiring is removed entirely (measured) — it pins the KEY, not the
  //   wiring. Do not count it as coverage that scroll memory works; [3a]/[3b]/[3f] are that.
  await setScroll('gitList', G_LIST_B)
  const betaSet = await settleScroll('gitList')
  ok('Beta moves the shared panel to a different offset', Math.abs(betaSet - G_LIST_B) <= 2, `at ${betaSet}`, 'setup')
  await switchTo('Alpha')
  const alphaAfter = await settleScroll('gitList')
  ok('[3g] one panel, one position: it stays where Beta left it', Math.abs(alphaAfter - G_LIST_B) <= 3, `expected ~${G_LIST_B}, got ${alphaAfter}${Math.abs(alphaAfter - G_LIST) <= 3 ? '  \u2190 this is ALPHA\'s earlier offset: the key is session-scoped' : ''}`, 'discriminating')

  // [3f] The Log tab. Its container and the Changes container are mutually exclusive, and
  // each is a NEW DOM node every time its tab is selected. This is the case that pins passing
  // a NULL key while a container is not rendered: with a constant key the effect does not
  // re-run on the tab switch, so it stays attached to the discarded node and the fresh one
  // opens at the top.
  const logUp = await evaluate(`window.__sm.clickExact('log')`) && await waitFor(`!!window.__sm.gitLogScroller()`, 25000)
  ok('the Log tab shows a commit list', logUp, '', 'setup')
  const logMax = logUp ? await maxScrollOf('gitLog') : -1
  ok('the commit list actually scrolls, and G_LOG is well short of its end', logMax > G_LOG * 2, `max=${logMax} target=${G_LOG}`, 'setup')
  if (logMax > G_LOG * 2) {
    await setScroll('gitLog', G_LOG)
    const logSet = await settleScroll('gitLog')
    ok('the commit list is at the target offset', Math.abs(logSet - G_LOG) <= 2, `at ${logSet}`, 'setup')
    await evaluate(`window.__sm.clickExact('changes')`); await wait(700)
    await evaluate(`window.__sm.clickExact('log')`)
    await waitFor(`!!window.__sm.gitLogScroller()`, 25000)
    const logBack = await settleScroll('gitLog')
    ok('[3f] the commit list survives a Changes/Log tab round-trip', Math.abs(logBack - G_LOG) <= 3, `expected ~${G_LOG}, got ${logBack}`, 'core')
  } else {
    console.log('  ⚠ the commit list never scrolled — [3f] did not run')
  }
} else {
  console.log('  ⚠ the git panel never produced a scrollable change list — section [3] did not run')
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[4] the AGENT DETAIL view (AgentDetail)')
// Mounted as <AgentDetail key={active.id} sessionId={activeId} agentId={active.id}> (App.tsx),
// inside a pane that renders NOTHING for a content tab that is not selected — so the view is
// destroyed and rebuilt by selecting the Chat tab, and again by switching session. Both are
// ordinary things to do halfway down a long agent transcript.
//
// This view carries TWO pieces of remembered state, and they are not the same thing:
//   · the scroll offset,  via useScrollMemory(`agent:${sessionId}:${agentId}`)
//   · whether the reader was PINNED to the bottom, via the module-level pinnedByKey map
// [4a]/[4b] exercise the offset. [4c]/[4d] exercise the pin. They fail independently and are
// labelled so, because a check that reds under both cannot tell you which one broke.
//
// ── WHY THE STUB IS GATED ────────────────────────────────────────────────────────────
// One stub serves all three sessions through PATH. It stays silent until GO.a exists, so the
// 36 checks in [1]-[3] run against a CLI that emits nothing at all.
// ═══════════════════════════════════════════════════════════════════════════════

// [3] leaves the Git dock open on Alpha. Close it: its three containers are scrollable and
// still on screen, and agentScroller() picks a container by content — one fewer way to
// measure the wrong box.
await evaluate(`window.__sm.clickExact('Git')`); await wait(600)
await switchTo('Alpha')

await writeFile(GO.a, 'go')
const badgeUp = await waitFor(`!!window.__sm.agentBadge('Alpha')`, 40000)
ok("the subagent reaches Alpha's sidebar", badgeUp, '', 'setup')

if (!badgeUp) {
  console.log('  ⚠ no subagent ever appeared — section [4] did not run')
} else {
  await evaluate(`window.__sm.agentBadge('Alpha').click()`); await wait(500)
  const lineUp = await waitFor(`!!window.__sm.agentLine('Alpha')`, 15000)
  ok("Alpha's agent is listed under its session row", lineUp, '', 'setup')
  if (lineUp) await evaluate(`window.__sm.agentLine('Alpha').click()`)
  const agUp = lineUp && await waitFor(`!!window.__sm.agentScroller()`, 25000)
  ok("the agent's thought process opens as a content tab", agUp, '', 'setup')
  // Alpha and Beta hold an agent with an IDENTICAL id. Reading the session back off the
  // view's own header is what stops the rest of this section from measuring Beta's pane and
  // reporting it as Alpha's.
  const inSession = agUp ? await evaluate(`window.__sm.agentInSession()`) : null
  ok("…and it is ALPHA's agent, not another session's with the same id", inSession === 'Alpha', `the view's header says "in ${inSession}"`, 'setup')
  const agMax = agUp ? await maxScrollOf('agent') : -1
  ok('the agent detail actually scrolls, and A_AGENT is well short of the end', agMax > A_AGENT * 2, `max=${agMax} target=${A_AGENT}`, 'setup')

  // Everything below reads a pane this probe has just proved it can find, identify and
  // measure. Without the gate a missing pane reports -1 everywhere and renders as a row of
  // confident red findings about scroll memory rather than "the probe lost the view".
  if (!(agUp && inSession === 'Alpha' && agMax > A_AGENT * 2)) {
    console.log('  ⚠ the agent detail pane was not measurable — the checks in [4] did not run')
  } else {
    await setScroll('agent', A_AGENT)
    const agSet = await settleScroll('agent')
    ok('the agent detail is at the target offset', Math.abs(agSet - A_AGENT) <= 2, `at ${agSet}`, 'setup')
    // ★ The reader must be OUT of the 80px bottom-pin zone. Parked at the bottom, the follow
    //   effect puts them back at the end by itself on every remount — [4a] would then be green
    //   with the scroll memory removed entirely, passing for a reason that has nothing to do
    //   with what it claims to test.
    ok('the target sits outside the 80px pin zone, so a pass cannot come from the follow effect', agMax - A_AGENT > 80, `max=${agMax} target=${A_AGENT} gap=${agMax - A_AGENT}`, 'setup')

    // ── [4a] select the Chat tab and come back ────────────────────────────────────────
    await evaluate(`window.__sm.clickExact('Chat')`); await wait(700)
    // Assert the TEARDOWN, not just that the click landed: if the pane never unmounted the DOM
    // node would still be there, still scrolled, and [4a] would pass with no scroll memory
    // involved at all. This is the check that makes [4a] mean something.
    ok('the detail view really unmounted, so the round-trip means something', !await evaluate(`!!window.__sm.agentScroller()`), '', 'setup')
    ok("the agent's tab is re-selectable from the tab strip", await evaluate(`window.__sm.agentTab(${JSON.stringify(AGENT_DESC)})`), '', 'setup')
    await waitFor(`!!window.__sm.agentScroller()`, 25000)
    const agBack = await settleScroll('agent')
    // Kept, because [4b]'s diagnosis below is only meaningful if the wiring works at all.
    const restoreWorks = Math.abs(agBack - A_AGENT) <= 3
    ok('[4a] the agent detail comes back where you left it after a tab round-trip', restoreWorks, `expected ~${A_AGENT}, got ${agBack}`, 'core')

    // ── [4b] the same agent id, in two sessions ───────────────────────────────────────
    // Both stubs emitted the same Task tool id, so agentKey() is identical in Alpha and Beta.
    // This is [1]'s discriminating case for the agent view: under a key without the session in
    // it, the two readers share one stored offset and each overwrites the other's.
    //
    // ★ AND THIS SWITCH DOES NOT REMOUNT THE VIEW. <AgentDetail key={active.id}> uses the AGENT
    //   id as its key, so with the same agent open in both sessions React sees the same element
    //   type and the same key in the same slot and RE-USES the DOM node, passing a new
    //   sessionId as a prop. Nothing unmounts and the browser keeps the scrollTop it had. What
    //   moves the view is the hook's key changing, which is exactly what is under test — but it
    //   also means [4b] reds when the WIRING is removed as well as when the KEY loses its
    //   session, so its diagnostic below has to tell those two apart instead of asserting one.
    //   (AgentDetail's own comment says the view "remounts on a session switch"; that holds
    //   only when the two sessions' agents have different ids.)
    await switchTo('Beta')
    const bBadge = await waitFor(`!!window.__sm.agentBadge('Beta')`, 40000)
    ok('Beta holds an agent with the same id', bBadge, '', 'setup')
    if (bBadge) {
      await evaluate(`window.__sm.agentBadge('Beta').click()`); await wait(500)
      if (await waitFor(`!!window.__sm.agentLine('Beta')`, 15000)) await evaluate(`window.__sm.agentLine('Beta').click()`)
    }
    const bUp = bBadge && await waitFor(`!!window.__sm.agentScroller()`, 25000)
    const bIn = bUp ? await evaluate(`window.__sm.agentInSession()`) : null
    ok("Beta's own view of that agent is open", bUp && bIn === 'Beta', `header says "in ${bIn}"`, 'setup')
    if (bUp && bIn === 'Beta') {
      await setScroll('agent', B_AGENT)
      const bSet2 = await settleScroll('agent')
      ok('Beta scrolled its view to a different offset', Math.abs(bSet2 - B_AGENT) <= 2, `at ${bSet2}`, 'setup')
      await switchTo('Alpha')
      await waitFor(`!!window.__sm.agentScroller()`, 25000)
      const aFinal2 = await settleScroll('agent')
      // The suffix is gated on [4a]. Ungated it announced "the key is not session-scoped" under
      // a mutation that removed the scroll memory ENTIRELY — a confident wrong diagnosis of a
      // break that was not present, the same triage-masking that [3e] was fixed for. A landed
      // Beta offset means the key collided only if the wiring is otherwise working.
      const isBeta = Math.abs(aFinal2 - B_AGENT) <= 3
      ok("[4b] Alpha's view of that agent keeps ITS offset, not Beta's", Math.abs(aFinal2 - A_AGENT) <= 3, `expected ~${A_AGENT}, got ${aFinal2}` + (!isBeta ? '' : restoreWorks
          ? '  ← this is BETA offset: the key is not session-scoped'
          : '  ← this is BETA offset, but [4a] failed too: the wiring is gone, not the key'), 'discriminating')
    } else {
      console.log('  ⚠ Beta never opened its own view of the agent — [4b] did not run')
    }

    // ── [4c] the pin, and the check that separates it from the wiring ─────────────────
    // pinnedByKey seeds pinnedRef at MOUNT, and nothing corrects that seed in time: onScroll is
    // a delegated handler that runs in a LATER task, while the follow effect runs in the SAME
    // commit as the restore. So with `useRef(true)` a live agent is dragged to the end on every
    // remount and the restore is defeated at ANY offset, not just at the top.
    // ★ The first version of this comment claimed the exact opposite — that the two seeds
    //   "behave identically everywhere a restore happens", because onScroll would overwrite the
    //   seed a frame later, and therefore that only a reader parked at the TOP could see this
    //   map at all. MB below MEASURED that false: it reds [4a] and [4b] as well as this check.
    //   The reasoning ignored ordering, which is the same thing that made my prediction for
    //   [4d] wrong. Written down rather than quietly fixed, because it is the third justification
    //   in this file to survive being plausible and fail being measured.
    // So what [4c] is FOR is discrimination: MA (no useScrollMemory) and MB (no pinnedByKey)
    // both red [4a] and [4b], and [4c] is the only check that tells the two apart. Parked at the
    // top is still the right shape for it — with target 0 the hook does not restore at all
    // (`restoring = target > 0`), so nothing but the pin can move the view and a red here cannot
    // be blamed on the offset machinery.
    // In the reader's words: "I scrolled up to re-read the task prompt, switched away and back,
    // and the next thing the agent did threw me to the end."
    await evaluate(`window.__sm.agentTab(${JSON.stringify(AGENT_DESC)})`)
    await waitFor(`!!window.__sm.agentScroller()`, 25000)
    await setScroll('agent', 0)
    const topSet = await settleScroll('agent')
    ok('the agent detail is parked at the very top', topSet <= 1, `at ${topSet}`, 'setup')
    const stepsBefore = await evaluate(`window.__sm.agentSteps()`)
    await evaluate(`window.__sm.clickExact('Chat')`); await wait(700)
    ok('the detail view unmounted with the reader at the top', !await evaluate(`!!window.__sm.agentScroller()`), '', 'setup')
    await evaluate(`window.__sm.agentTab(${JSON.stringify(AGENT_DESC)})`)
    await waitFor(`!!window.__sm.agentScroller()`, 25000)
    await writeFile(GO.b, 'go')
    const grew = await waitFor(`window.__sm.agentSteps() > ${stepsBefore}`, 40000)
    // Without this the whole case is vacuous: if no new activity arrives, "still at the top"
    // is true because nothing happened, and [4c] would be green on a broken pin.
    ok("more of the agent's activity arrived after the remount", grew, `steps before=${stepsBefore}`, 'setup')
    if (grew) {
      const afterTop = await settleScroll('agent')
      const maxNow = await maxScrollOf('agent')
      ok('[4c] a reader parked at the top is not thrown to the end by new activity', afterTop <= 3, `expected ~0, got ${afterTop}${afterTop >= maxNow - 5 ? '  ← this is the END: the pin was re-asserted as true on remount' : ''}`, 'core')
    } else {
      console.log('  ⚠ no new agent activity arrived — [4c] did not run')
    }

    // ── [4d] the one place "restore the offset" and "follow the output" DISAGREE ──────
    // For an unpinned reader the two cannot conflict: the follow effect no-ops. For a pinned
    // reader they normally agree, because a pinned reader's stored offset IS the bottom. They
    // diverge in exactly one situation — the transcript GREW while the tab was unmounted — and
    // then the stored offset is short of the new end and the two want different things.
    //
    // ★ MEASURED, and it is the OPPOSITE of what this check was first written to assert.
    //   I predicted the restore would win, reasoning that the hook re-applies its target every
    //   frame while the follow effect fires only once. Measured: remembered=6891, new end=9411,
    //   landed=9411 — the FOLLOW effect wins.
    //   Why: the hook gives up the moment it LANDS (`if (landed || …) restoring = false`), and
    //   on a remount the transcript is already in the store at full height, so it lands on its
    //   very first tick and stops. The follow effect runs AFTER it in the same commit (the hook
    //   is called above the effect, and effects run in order), so it has the last word and
    //   nothing forces the view back. The "re-applies every frame" intuition only holds while
    //   content is still growing INTO the target — never on a target that is already reachable.
    //
    //   And this is the right behaviour, not a defect to route around: pinned means "follow the
    //   live output", so a reader who was following is carried to the latest, while [4c] shows a
    //   reader who was NOT following is left exactly where they were. AgentDetail's own comment
    //   ("if the reader was pinned, the follow effect below puts them at the bottom anyway")
    //   describes precisely this and was right where my prediction was wrong. [4d] pins the
    //   ORDER of the two — swap the useScrollMemory call below the follow effect and the reader
    //   silently stops following instead.
    await setScroll('agent', 999999)
    const botSet = await settleScroll('agent')
    const maxBefore = await maxScrollOf('agent')
    ok('the agent detail is parked at the bottom, so the reader is following', Math.abs(botSet - maxBefore) <= 3, `at ${botSet} of ${maxBefore}`, 'setup')
    const steps2 = await evaluate(`window.__sm.agentSteps()`)
    await evaluate(`window.__sm.clickExact('Chat')`); await wait(700)
    ok('the detail view unmounted with the reader pinned to the bottom', !await evaluate(`!!window.__sm.agentScroller()`), '', 'setup')
    // The growth happens HERE, with the view unmounted — that is the whole point of the case.
    await writeFile(GO.c, 'go')
    await wait(3000)
    await evaluate(`window.__sm.agentTab(${JSON.stringify(AGENT_DESC)})`)
    await waitFor(`!!window.__sm.agentScroller()`, 25000)
    const steps3 = await evaluate(`window.__sm.agentSteps()`)
    ok('the transcript grew while the tab was closed', steps3 > steps2, `${steps2} → ${steps3}`, 'setup')
    if (steps3 > steps2) {
      const afterBottom = await settleScroll('agent')
      const maxAfter = await maxScrollOf('agent')
      ok('[4d] a pinned reader whose transcript grew while away is carried to the NEW end', Math.abs(afterBottom - maxAfter) <= 6, `remembered=${maxBefore} new end=${maxAfter} landed=${afterBottom}` +
        `${Math.abs(afterBottom - maxBefore) <= 6 ? '  ← the RESTORE won: parked at the OLD end, no longer following' : ''}`, 'discriminating')
    } else {
      console.log('  ⚠ the transcript did not grow while unmounted — [4d] did not run')
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
reapAll()
process.exit(failed ? 1 : 0)
