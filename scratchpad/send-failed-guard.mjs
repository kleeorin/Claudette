// SEND-FAILED GUARD — does a turn that never reached a live engine SAY so?
//
//   bash scratchpad/run-suite.sh send-failed-guard.mjs
//
// Own server (4486), own vite (5286), own Chrome (CDP 9367). GROUP B: vite compiles the
// WORKING TREE, so a result here is evidence.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
// `session:send` used to drop sendUserTurn's boolean. That boolean is the ONLY signal that
// a turn reached a live claude process, and every `false` path returns BEFORE any side
// effect — no session:userTurn, no state flip, nothing rendered. Meanwhile the client had
// already appended its optimistic echo. So a turn sent into a dead/relaunching/just-died
// session sat in the transcript looking delivered forever, and no reply ever came.
// The fix broadcasts `session:sendFailed`; the client marks that turnId undelivered and
// ChatView renders it muted + dashed with "Not delivered — the session wasn't running."
//
// ── ★ WHY THE EXISTING SUITE COULD NOT COVER THIS, IN EITHER DIRECTION ───────────────
// Seven registered harnesses send a real user turn (real-turn-browser-test, interrupt-test,
// history-resume-test, optimistic-busy-test, ready-clobber-test, composer-history-repro,
// team-test) and all seven are green. That is worth exactly one thing: normal delivery has
// not regressed. It is not evidence about this fix, and the reason is worth stating plainly
// because it generalises:
//   · the failure branch never fires in any of them, AND
//   · if the `delivered` check were INVERTED — sendFailed broadcast on every SUCCESSFUL
//     send — every user bubble in the app would render dashed and "Not delivered", and all
//     seven would STILL be green, because not one of them inspects a bubble's delivery
//     state (measured: `grep -rn "undelivered\\|Not delivered" scratchpad/` found nothing).
// A branch that can neither fire nor mis-fire without the suite noticing is untested in
// both directions. That is why [2] below — the LIVE control — matters at least as much as
// [1], and it is the half the rest of the suite is completely blind to.
//
// ── HOW THE DEAD ENGINE IS MADE, and why it is real rather than injected ─────────────
// One stand-in `claude` on PATH serves both sessions and branches on its own cwd, which is
// the session's cwd (claudeEngine spawns the child with it). The DEAD session's stub exits
// immediately WITHOUT emitting system/init: sessionManager's exit handler reads a missing
// init as a startup failure, nulls `session.engine` and parks the session in `exited` with
// no relaunch. A later send then hits `!session?.engine` inside the REAL sendUserTurn and
// returns false through the REAL code path — nothing here injects a sendFailed frame to
// make [1] pass. (The composer stays usable on an exited session, which is the whole
// reported scenario: you type, it looks sent, nothing ever answers. [0c] asserts that
// premise rather than assuming it.)
//
// ── [hole] WHAT THIS DOES NOT COVER ──────────────────────────────────────────────────
// Only the `!session.engine` limb of the guard. The other two — `replacing`/`closing`
// (mid-relaunch) and `!engine.alive` (the child died microseconds ago, before the exit
// event nulled the object) — are timing windows this harness cannot open deterministically,
// and they are NOT exercised here. They share the same broadcast, so a regression in the
// broadcast or in any client layer below it still reds this file; a regression in either of
// those two conditions specifically would not.
import { spawn, execFileSync } from 'child_process'
import { mkdtemp, writeFile, chmod } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const PORT = 4486
const WEB_PORT = 5286
const CDP_PORT = 9367
const APP = `http://127.0.0.1:${WEB_PORT}`, API = `http://127.0.0.1:${PORT}`
const TOKEN = 'send-failed-token'
// Set by the fails-first run: the page drops every session:sendFailed frame, which is
// exactly what the pre-fix server did (it never sent one). See the MUTATIONS block below.
const DROP = process.env.DROP_SENDFAILED === '1'

const DEAD = 'Deadsession', LIVE = 'Livesession'
const DEAD_TEXT = 'zzdeadturnzz please answer this one'
const LIVE_TEXT = 'zzliveturnzz please answer this one'
const ECHO = 'zzstubechozz'          // the live stub echoes this back: POSITIVE proof of delivery
const MARK = 'Not delivered'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
import { withMarks, passed, failed } from './assert.mjs'
const ok = withMarks({ indent: '  ' })

const DATA = await mkdtemp(join(tmpdir(), 'sendfail-data-'))
const BIN = await mkdtemp(join(tmpdir(), 'sendfail-bin-'))
// The cwd is how the ONE stub tells the two sessions apart, so these names are load-bearing.
const DEAD_CWD = await mkdtemp(join(tmpdir(), 'sendfail-dead-'))
const LIVE_CWD = await mkdtemp(join(tmpdir(), 'sendfail-live-'))

// ── the stand-in CLI ────────────────────────────────────────────────────────────────
await writeFile(join(BIN, 'claude'), `#!/usr/bin/env node
// DEAD: exit before emitting system/init. sessionManager reads a missing init as a startup
// failure, nulls the engine and leaves the session 'exited' — no relaunch, so it stays dead.
if (process.cwd().includes('sendfail-dead')) process.exit(1)
// LIVE: announce init so the session goes idle-and-usable, then answer any turn. Echoing
// the user's own text back is what lets [2b] prove the turn REACHED the engine, rather than
// inferring delivery from the absence of a marker.
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'stub', slash_commands: [] }) + '\\n')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.type !== 'user') continue
    const text = typeof m.message?.content === 'string' ? m.message.content : ''
    // Deliberately does NOT echo the user's text. It used to, and that quietly broke the
    // measurement: bubble() takes the innermost element containing the search text, the
    // assistant echo also contained it, and so every assertion about "the user's bubble"
    // could land on the ASSISTANT's instead. [3c] went red for that and for nothing else.
    // Reporting the LENGTH still proves the turn arrived, without putting the same string
    // on screen twice.
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant',
      content: [{ type: 'text', text: ${JSON.stringify(ECHO)} + ' received ' + text.length + ' chars' }] } }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
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
// Reap by process GROUP on every exit path — `npx` forks the real node, so killing the
// wrapper by pid strands the port. See port-and-reap-lint rule 3.
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
console.log('server + vite up' + (DROP ? '  [DROP_SENDFAILED=1 — simulating the pre-fix server]' : ''))

for (const d of [DEAD_CWD, LIVE_CWD]) {
  execFileSync('git', ['-c', 'init.defaultBranch=main', '-C', d, 'init', '-q'], { stdio: 'ignore' })
  await writeFile(join(d, 'readme.txt'), 'send-failed fixture\n')
}
const hdr = { 'content-type': 'application/json', cookie: `claudette_auth=${TOKEN}` }
// Created over the authenticated HTTP API — a TRUSTED caller, so this never meets the
// workspace-trust dialog the composer path would raise on an untrusted cwd.
const mk = (name, cwd) => fetch(`${API}/api/session/create`, { method: 'POST', headers: hdr,
  body: JSON.stringify({ name, cwd, rootDir: cwd, sandbox: { enabled: false, mounts: [] } }) }).then((r) => r.json())
const live = await mk(LIVE, LIVE_CWD)
const dead = await mk(DEAD, DEAD_CWD)
if (!live?.id || !dead?.id) { console.error('session create failed: ' + JSON.stringify({ live, dead })); reapAll(); process.exit(1) }
console.log(`sessions: ${LIVE}=${live.id.slice(0, 8)} ${DEAD}=${dead.id.slice(0, 8)}`)

const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
if (!existsSync(CHROME)) { console.error(`no Chrome at ${CHROME} (set CHROME_BIN)`); reapAll(); process.exit(1) }
chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${await mkdtemp(join(tmpdir(), 'chrome-sendfail-'))}`,
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
// A dead socket must be a loud failure, not a silent hang holding the ports.
cdp.on('close', () => { console.error('CDP socket closed — Chrome died; aborting'); reapAll(); process.exit(1) })
const consoleLines = []
cdp.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.method === 'Runtime.consoleAPICalled') {
    consoleLines.push((m.params.args || []).map((a) => String(a.value ?? a.description ?? '')).join(' '))
  }
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

await send('Page.enable')
await send('Runtime.enable')
// Hold the hub socket and record OUTGOING session:send frames. The turnId is generated
// inside sendTurn and never appears in the DOM, so capturing the frame is the only way to
// know which id the client actually used — [3] needs it, and guessing would make [3] pass
// or fail for reasons unrelated to what it claims.
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__sent = [];
  window.__hub = null;
  // Count document loads. The helper object below used to be installed with a ONE-OFF
  // Runtime.evaluate, so any navigation silently wiped it and the next check died with
  // "Cannot read properties of undefined" — a harness failure that reads exactly like an
  // app failure. Both are fixed here: the helpers are re-installed on every document (this
  // script is addScriptToEvaluateOnNewDocument), and the counter makes a reload VISIBLE
  // instead of leaving it as the unexplained cause of a red.
  try { sessionStorage.setItem('__loads', String(Number(sessionStorage.getItem('__loads') || 0) + 1)) } catch {}
  const RealWS = window.WebSocket;
  const DROP = ${DROP ? 'true' : 'false'};
  class CapWS extends RealWS {
    constructor(...a) {
      super(...a);
      if (String(a[0]).includes('/ws')) {
        window.__hub = this;
        window.__socks = (window.__socks || 0) + 1;
        // Simulate the PRE-FIX server, which never sent this message at all. Filtering at
        // the client boundary is indistinguishable from it never arriving, and needs no
        // edit to server/src (which is read-only from a pinned session anyway).
        if (DROP) this.addEventListener('message', (ev) => {
          try { if (JSON.parse(ev.data)?.type === 'session:sendFailed') ev.stopImmediatePropagation() } catch {}
        }, true);
      }
    }
    send(data) {
      try { const m = JSON.parse(data); if (m && m.type === 'session:send') window.__sent.push(m) } catch {}
      return super.send(data);
    }
  }
  window.WebSocket = CapWS;
window.__sf = {
  clickSession(name) {
    const aside = document.querySelector('aside'); if (!aside) return false;
    const row = [...aside.querySelectorAll('*')]
      .filter((e) => (e.textContent || '').trim().startsWith(name))
      .sort((a, b) => a.getElementsByTagName('*').length - b.getElementsByTagName('*').length)[0];
    if (!row) return false; row.click(); return true;
  },
  // The bubble for a turn: the INNERMOST element carrying that text. ChatView puts the
  // dashed border on the very element that holds the text, and the "Not delivered" line is
  // a CHILD of it — so taking the innermost match lands on the styled element itself rather
  // than on some ancestor that also contains it and would report nothing about its styling.
  bubble(text) {
    const hits = [...document.querySelectorAll('div')].filter((e) => (e.textContent || '').includes(text));
    return hits.sort((a, b) => a.getElementsByTagName('*').length - b.getElementsByTagName('*').length)[0] || null;
  },
  // Two INDEPENDENT witnesses of the same state, deliberately: the styling (dashed border)
  // and the explicit sentence. A change that keeps one and loses the other is still a
  // regression — the whole point is that the failure is otherwise invisible.
  dashed(text) { const b = this.bubble(text); return !!b && (b.className || '').includes('border-dashed'); },
  says(text) { const b = this.bubble(text); return !!b && b.textContent.includes(${JSON.stringify(MARK)}); },
  markCount() { return (document.body.innerText.match(/Not delivered/g) || []).length; },
  composer() { return document.querySelector('textarea'); },
  type(text) {
    const ta = this.composer(); if (!ta) return false;
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    s.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  },
  submit() {
    const ta = this.composer(); if (!ta) return false;
    ta.focus(); ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  },
  turnIdFor(text) { const m = (window.__sent || []).find((x) => (x.text || '').includes(text)); return m ? (m.turnId ?? null) : null; },
  value() { const ta = this.composer(); return ta ? ta.value : null; },
  // recallPrev only hijacks Up when there is no line above the caret — at level 0 it asks for
  // the very start. Without this the Up presses below are swallowed as ordinary caret moves and
  // every assertion in [4] would measure a history pointer that never left 0.
  caret(pos) { const ta = this.composer(); if (!ta) return false; ta.focus(); ta.selectionStart = ta.selectionEnd = pos; return true; },
  // Hand the page a sendFailed frame as if the server had sent it. Used ONLY by [3], which
  // pins a CLIENT-side decision that no server can produce: the server always sends a
  // turnId, so a frame without one cannot be generated end-to-end.
  inject(sessionId, turnId) {
    if (!window.__hub) return false;
    const msg = turnId === null ? { type: 'session:sendFailed', id: sessionId }
                                : { type: 'session:sendFailed', id: sessionId, turnId };
    window.__hub.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }));
    return true;
  },
};
` })
await send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/api/auth?token=${TOKEN}` })
await wait(1200)
await send('Page.navigate', { url: `${APP}/` })
if (!await waitFor(`!!document.querySelector('aside') && !!window.__sf`, 40000)) {
  console.error('app never rendered'); console.error(weblog.slice(-1200)); reapAll(); process.exit(1)
}
await wait(1500)
const loadsAtStart = await evaluate(`Number(sessionStorage.getItem('__loads') || 0)`)



// Real key events, not synthetic ones: `recallPrev`/`recallNext` read `selectionStart` off the
// DOM, and the composer's handler calls `preventDefault()` — both behave faithfully only for a
// genuine key press. `n` repeats it (walking back down several levels at once).
const pressKey = async (name, code, n = 1) => {
  await evaluate(`(() => { const ta = window.__sf.composer(); if (ta) ta.focus(); return true })()`)
  for (let i = 0; i < n; i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    await wait(180)
  }
}

const sendTurn = async (text) => {
  await evaluate(`window.__sf.type(${JSON.stringify(text)})`)
  await wait(200)
  await evaluate(`window.__sf.submit()`)
}

// ═══ [0] PRECONDITIONS ═══════════════════════════════════════════════════════════════
// Everything below reads a UI this harness must first prove it reached. Without these a
// broken selector reports a confident row of reds about the fix.
console.log('\n[0] preconditions')
ok('[0a] both sessions are on screen', await waitFor(`document.body.innerText.includes(${JSON.stringify(DEAD)}) && document.body.innerText.includes(${JSON.stringify(LIVE)})`, 20000), '', 'setup')
ok(`[0b] the ${DEAD} session really is dead (its stub exited before init)`, await waitFor(`window.__sf.clickSession(${JSON.stringify(DEAD)}) && document.body.innerText.includes('Claude exited')`, 20000), '', 'setup')
// The premise of the whole bug: an exited session still lets you type. If this ever stops
// being true the fix is unreachable from the UI and this file should be re-scoped, not
// patched — so it is a precondition, not an assertion about the fix.
ok('[0c] …and its composer is still usable, which is what makes the bug reachable', await evaluate(`!!window.__sf.composer()`), '', 'setup')
ok('[0d] nothing is marked undelivered before anything is sent', (await evaluate(`window.__sf.markCount()`)) === 0, '', 'setup')

if (failed) {
  console.log('  ⚠ preconditions failed — the assertions below did not run')
} else {
  // ═══ [1] THE FAILURE PATH ══════════════════════════════════════════════════════════
  console.log('\n[1] a turn into a dead session')
  await sendTurn(DEAD_TEXT)
  const marked = await waitFor(`window.__sf.says(${JSON.stringify(DEAD_TEXT)})`, 15000)
  ok('[1a] the bubble says the turn was NOT delivered', marked, marked ? '' : '← the optimistic echo still reads as delivered: this is the reported bug', 'core')
  ok('[1b] …and is styled as undelivered (dashed), not as an ordinary turn', await evaluate(`window.__sf.dashed(${JSON.stringify(DEAD_TEXT)})`), '', 'core')

  // ═══ [2] ★ THE NEGATIVE CONTROL — the half the rest of the suite cannot see ════════
  console.log('\n[2] a turn into a LIVE session (the inversion control)')
  await evaluate(`window.__sf.clickSession(${JSON.stringify(LIVE)})`)
  await wait(800)
  await sendTurn(LIVE_TEXT)
  // Delivery proved POSITIVELY, off the engine's own echo — not inferred from the absence
  // of a marker. Without this, [2b] would also be green if the turn silently went nowhere.
  const echoed = await waitFor(`document.body.innerText.includes(${JSON.stringify(ECHO)})`, 20000)
  ok('[2a] the turn actually reached the engine (it echoed the text back)', echoed, '', 'core')
  await wait(1200)
  ok('[2b] a DELIVERED turn is NOT marked undelivered', !await evaluate(`window.__sf.says(${JSON.stringify(LIVE_TEXT)})`), '← if this reds, sendFailed is firing on success: the delivered check is inverted', 'core')
  // ═══ [2c]/[2d] SESSION SWITCHING — last, because switching may re-load a transcript
  // Scoped to what is ON SCREEN, because ChatView renders only the SELECTED session's
  // transcript. The first version of this asserted "exactly one turn is marked in the whole
  // app" and went red at count=0 — measuring a transcript that was not mounted and calling
  // it a finding about the fix. The app-wide claim is not observable from the DOM at all.
  ok('[2c] with the live session selected, NOTHING on screen is marked', (await evaluate(`window.__sf.markCount()`)) === 0, `count=${await evaluate(`window.__sf.markCount()`)}`, 'core')
  // The mark lives in the store, not in a DOM artefact of the moment it arrived — so it has
  // to survive unmounting and remounting the transcript.
  await evaluate(`window.__sf.clickSession(${JSON.stringify(DEAD)})`)
  await wait(900)
  ok('[2d] switching back to the dead session, its turn is STILL marked', await evaluate(`window.__sf.says(${JSON.stringify(DEAD_TEXT)})`) && (await evaluate(`window.__sf.markCount()`)) === 1, `count=${await evaluate(`window.__sf.markCount()`)}`, 'core')
  await evaluate(`window.__sf.clickSession(${JSON.stringify(LIVE)})`)
  await wait(900)

  // ═══ [3] A sendFailed WITH NO turnId MARKS NOTHING ═════════════════════════════════
  // chat.tsx drops it rather than guessing "the last user item", because guessing would
  // mislabel a turn that DID land. That is a deliberate decision, not an oversight, and it
  // is pinned here so nobody "fixes" it later.
  console.log('\n[3] a sendFailed carrying no turnId')
  const liveTurnId = await evaluate(`window.__sf.turnIdFor(${JSON.stringify(LIVE_TEXT)})`)
  console.log(`  ↳ diag: sockets=${await evaluate('window.__socks')} loads=${await evaluate("Number(sessionStorage.getItem('__loads')||0)")}`)
  ok('[3a] the outgoing send carried a turnId at all', typeof liveTurnId === 'string' && !!liveTurnId, `turnId=${liveTurnId}`, 'setup')
  const injectedNull = await evaluate(`window.__sf.inject(${JSON.stringify(live.id)}, null)`)
  ok('[3a2] the injection mechanism has a socket to fire at', injectedNull === true, `__hub present=${await evaluate(`!!window.__hub`)}`, 'setup')
  await wait(900)
  ok('[3b] a sendFailed with no turnId marks nothing — it does not guess', !await evaluate(`window.__sf.says(${JSON.stringify(LIVE_TEXT)})`), '', 'core')
  // ★ AND THE CONTROL THAT STOPS [3b] BEING VACUOUS. Injecting a frame the page ignores
  // and a frame that never arrived look identical from the DOM, so [3b] alone would be
  // green even if inject() were broken. Fire the SAME mechanism with a real turnId and
  // require it to land. This deliberately runs last: it marks the live bubble, so every
  // measurement above it is already taken.
  const injectedReal = await evaluate(`window.__sf.inject(${JSON.stringify(live.id)}, ${JSON.stringify(liveTurnId)})`)
  const landed = await waitFor(`window.__sf.says(${JSON.stringify(LIVE_TEXT)})`, 8000)
  const loadsNow = await evaluate(`Number(sessionStorage.getItem('__loads') || 0)`)
  // ★ A RELOAD GATES [3c] RATHER THAN JOINING IT AS A SECOND RED. An undelivered mark is
  // in-memory only — the reconnect snapshot carries no undelivered flag — so a reload wipes
  // every mark and [3c] would go red for a reason that has nothing to do with the injection.
  // Reporting both would be two findings for one cause, and the louder one would be wrong.
  // MEASURED, not feared: this fired on two runs while web/src/App.tsx was being edited
  // under the harness (vite cannot Fast Refresh App.tsx — it exports a non-component — so
  // it forces a full page reload), and it correctly explained a red I would otherwise have
  // spent the afternoon attributing to the app.
  if (loadsNow !== loadsAtStart) {
    console.log(`  ⚠ the page reloaded mid-section (document loads ${loadsAtStart} → ${loadsNow}) — [3c] DID NOT RUN.`)
    console.log('    An undelivered mark does not survive a reload, so nothing here is measurable after one.')
    console.log('  ↳ console said:\n' + consoleLines.slice(-8).map((l) => '     | ' + l).join('\n'))
  } else {
    ok('[3c] CONTROL: the same injection WITH a turnId does mark, so [3b] is not vacuous', landed, landed ? '' : `← inject returned ${injectedReal}; the frame is not reaching the client, so [3b] proves nothing`, 'core')
  }
}

  // ═══ [4] THE COMPOSER RESTORE — the feature, and the guard on it ═══════════════════
  // Added because NOTHING tested this. Sections [1]–[3] assert the BUBBLE (its sentence,
  // its dashed styling, its turnId handling) and only that the composer stays USABLE. The
  // restore — putting the lost turn's text back so the user can edit and resend — had no
  // coverage at all, in either direction, which is how a correct feature came to be blamed
  // for a stale test premise in composer-history-repro.
  console.log('\n[4] the failed turn is restored INTO the composer')
  const loads4 = await evaluate(`Number(sessionStorage.getItem('__loads') || 0)`)
  if (loads4 !== loadsAtStart) {
    console.log(`  ⚠ the page reloaded before [4] (document loads ${loadsAtStart} → ${loads4}) — [4] DID NOT RUN.`)
    console.log('    A reload re-seeds the composer from the draft store, so nothing here is measurable after one.')
  } else {
  await evaluate(`window.__sf.clickSession(${JSON.stringify(DEAD)})`)
  await wait(900)
  // Start from a known place: level 0, empty box. Down walks back out of any recalled level.
  await pressKey('ArrowDown', 40, 6)
  await evaluate(`window.__sf.type('')`)
  await wait(300)

  // ── [4a] THE FEATURE. End to end, no injection: the DEAD session's engine really is gone,
  // so this send really fails and the real frame really arrives.
  const RESTORE_TEXT = 'zzrestoremezz the words I do not want to retype'
  await sendTurn(RESTORE_TEXT)
  const restored = await waitFor(`window.__sf.value() === ${JSON.stringify(RESTORE_TEXT)}`, 15000)
  ok('[4a] a failed send puts its text BACK in the empty composer', restored, restored ? '' : `composer holds ${JSON.stringify(await evaluate(`window.__sf.value()`))} — the words are lost`, 'core')

  // ── [4b] THE GUARD. The restore must not fire while the user is BROWSING history.
  // Reaching the state needs care: at a recalled level the box normally holds the recalled
  // text, so the empty-composer guard already blocks and this one would never be exercised.
  // The window where they differ is REAL but narrow — recall a message, decide against it,
  // clear the box, and you are sitting at level 1 with an empty composer. That is the state
  // built below, and it is the only one in which [4b] tests anything.
  await evaluate(`window.__sf.type('')`)
  await wait(300)
  await evaluate(`window.__sf.caret(0)`)
  await pressKey('ArrowUp', 38)                       // level 0 → 1, box = the recalled turn
  const recalledText = await evaluate(`window.__sf.value()`)
  ok('[4b0] PRECONDITION: Up actually recalled a message (history level is not 0)', typeof recalledText === 'string' && recalledText.length > 0, `box=${JSON.stringify(recalledText)}`, 'setup')
  await evaluate(`window.__sf.type('')`)              // clear it, still at level 1
  await wait(300)

  const restoreTurnId = await evaluate(`window.__sf.turnIdFor(${JSON.stringify(RESTORE_TEXT)})`)
  ok('[4b1] PRECONDITION: the restored turn has a turnId to inject', typeof restoreTurnId === 'string' && !!restoreTurnId, `turnId=${restoreTurnId}`, 'setup')
  await evaluate(`window.__sf.inject(${JSON.stringify(dead.id)}, ${JSON.stringify(restoreTurnId)})`)
  await wait(1200)
  const midBrowseBox = await evaluate(`window.__sf.value()`)
  ok('[4b2] mid-browse, the restore DECLINES: the composer is left alone', midBrowseBox === '', midBrowseBox === '' ? 'box still empty'
      : `composer holds ${JSON.stringify(midBrowseBox)} — it wrote into a box the user is browsing with`, 'core')

  // ★ AND THE HALF THAT MATTERS MORE — assert the LEVEL, not the visible text.
  // `goTo` saves the box's live DOM value against the level it is LEAVING, so a restore that
  // lands mid-browse is not merely overwritten by the next keypress: it is recorded as the
  // user's own edit of that level and comes back every time they return to it. Walking away
  // and back is what makes that persistence observable; asserting the visible text alone
  // would pass even while level 1 carried a message the user never typed.
  await evaluate(`window.__sf.caret(0)`)
  await pressKey('ArrowDown', 40)                     // level 1 → 0, saving the box against 1
  await evaluate(`window.__sf.caret(0)`)
  await pressKey('ArrowUp', 38)                       // back to level 1
  const level1 = await evaluate(`window.__sf.value()`)
  ok('[4b3] …and the browsed LEVEL is not corrupted: it still holds what the user left', level1 === '', level1 === '' ? 'level 1 still holds the empty box the user left there'
      : `level 1 holds ${JSON.stringify(level1)} — a fake edit the user never typed, persisted by goTo`, 'core')
  }

console.log(`\n${passed} passed / ${failed} failed`)
reapAll()
process.exit(failed === 0 ? 0 : 1)

// ── MUTATIONS + THE TRAPS THIS FILE FELL INTO ────────────────────────────────────────
// GREEN as shipped: 14 passed / 0 failed, repeated runs, no reloads. (It was 15 while the
// reload check was a counted assertion; it is now a GATE that prints a warning instead — see
// the note at [3c] for why a reload must not produce a second red for the same cause.)
// FAILS-FIRST: `DROP_SENDFAILED=1` makes the page discard every session:sendFailed frame,
// which is indistinguishable from the pre-fix server that never sent one — and needs no edit
// to server/src (read-only from a pinned session). Result, on a run with no reload:
//   **10 passed / 4 failed — [1a], [1b], [2d] and [3c]**, which is exactly what was predicted
//   before running it, and [1a] carried its predicted diagnostic ("the optimistic echo still
//   reads as delivered: this is the reported bug"). [2b] and [2c] stay GREEN under the drop,
//   correctly: they assert an ABSENCE, and absence is what the pre-fix build also produced.
//   ★ So [2b] is not evidence on its own. It is the INVERSION control — it only says
//   something when paired with [1a] being green in the same run, because together they mean
//   the marker appears exactly where it should and nowhere else. Read them as a pair.
//
// ── THREE THINGS THAT WENT WRONG HERE, ALL MINE, ALL WORTH KEEPING ───────────────────
// 1. [2c] first asserted "exactly ONE turn is marked in the whole app" and went red at 0.
//    ChatView renders only the SELECTED session's transcript, so the claim is not observable
//    from the DOM at all — a probe measuring an unmounted component and calling it a finding.
// 2. [3c] went red for four runs while the injection was working perfectly. The live stub
//    echoed the user's own text back, bubble() takes the INNERMOST element containing the
//    search text, and so "the user's bubble" resolved to the ASSISTANT's echo. The stub no
//    longer repeats the text. This is the measuring-the-wrong-box trap, and what exposed it
//    was [2c] reporting count=1 while [3c] insisted nothing was marked — two checks
//    disagreeing about the same screen is a much louder signal than either alone.
// 3. The helpers were installed with a one-off Runtime.evaluate, so a page reload wiped them
//    and the next check died with "Cannot read properties of undefined" — a harness failure
//    that reads exactly like an app failure. They are now re-installed on every document.
//
// ── [hole] MEASURED, NOT SUSPECTED: an undelivered mark does not survive a reload ────
// The flag lives in the client store; the reconnect snapshot has no field for it. Reload the
// page and a turn that was never delivered comes back looking delivered — the original bug,
// one refresh away. Observed directly (that is what made [2d] and [3c] red on the reload
// runs), not deduced. Whether that is worth fixing is a product call, not a test one, but it
// should be a known limitation rather than a surprise.
