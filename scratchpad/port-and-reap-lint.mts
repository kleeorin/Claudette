// LINT: every test that BINDS a port must reap on every exit path, no two tests may bind
// the same port, and no test may sit holding a port waiting on a socket that will never
// answer. Both rules are mechanically checkable; both were broken in ways that
// made a SECURITY test report false results.
//
// Why this exists rather than three one-off fixes. `auth-loopback-test.mjs` boots four
// servers on a fixed port, one of them with CLAUDETTE_NO_AUTH=1, and reaps only on the
// happy path. Any thrown check leaves an UNAUTHENTICATED server listening — and the next
// run of that same file connects to the survivor and reports 8 false failures, including
// "WS upgrade refused without token". A security alarm that cries wolf is worse than no
// alarm: it trains the reader to discount it. The same shape produced four other broken
// alarms in this directory.
//
// Run:  npx tsx scratchpad/port-and-reap-lint.mts
// Exit: 0 clean, 2 violations found.
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const DIR = path.dirname(fileURLToPath(import.meta.url))

// The four handlers a spawned, `detached` child needs to be reaped from. `exit` alone is
// not enough: it does not fire on a signal, which is exactly the Ctrl-C case that stranded
// the unauthenticated server.
const SIGNALS = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']

// A file BINDS a port when it starts something that listens on a FIXED one. Distinguished
// from merely FETCHING one: ~18 files point at :4321 expecting an operator-started dev
// server, and counting those as binders would drown the real collisions in noise.
// `listen(0)` is an ephemeral port the OS assigns — never a collision, always fine.
function boundPorts(src: string): Set<number> {
  const out = new Set<number>()
  // Resolve `const PORT = 4322` so `PORT: String(PORT)` can be followed.
  const consts = new Map<string, number>()
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(\d{2,5})\b/g)) {
    consts.set(m[1], Number(m[2]))
  }
  // 1. A spawned server's port: `PORT: '4327'` / `PORT: String(PORT)` / `PORT: \`${P}\``
  for (const m of src.matchAll(/PORT\s*:\s*(?:String\(\s*([A-Za-z_$][\w$]*)\s*\)|['"`](\d{2,5})['"`]|([A-Za-z_$][\w$]*))/g)) {
    if (m[2]) out.add(Number(m[2]))
    else {
      const name = m[1] ?? m[3]
      const v = name ? consts.get(name) : undefined
      if (v) out.add(v)
    }
  }
  // 2. An in-process listener on a fixed port: `.listen(4321, …)` or `{ port: 4321 }`.
  for (const m of src.matchAll(/\.listen\(\s*(\d{1,5})/g)) {
    const p = Number(m[1])
    if (p > 0) out.add(p)
  }
  for (const m of src.matchAll(/\bport\s*:\s*(\d{2,5})\b/g)) out.add(Number(m[1]))
  for (const m of src.matchAll(/\bport\s*:\s*([A-Za-z_$][\w$]*)\b/g)) {
    const v = consts.get(m[1])
    if (v) out.add(v)
  }
  return out
}

// Does this file spawn a long-lived child that outlives a crash? Only `detached` spawns of
// the server actually strand a port — an in-process listener dies with the node process,
// which is why `proxy.close()` living only in a `finally` is NOT a leak and must not be
// flagged.
function spawnsDetachedChild(src: string): boolean {
  return /spawn\(/.test(src) && /detached\s*:\s*true/.test(src)
}

// …and a file that spawns a child it bothers to REAP has a long-lived child too, detached
// or not. Reaping it at all is the author's own statement that it outlives the script.
function reapsAChild(src: string): boolean {
  const surface = reapSurface(src)
  return spawnedChildren(src).some((c) => aliasNames(src, c.name).some((n) => new RegExp(`\\b${n}\\b`).test(surface)))
}

// ── shared machinery for rules 2 and 3 ───────────────────────────────────────────────
// The text a reaper could plausibly execute: the `process.on(` lines themselves, PLUS the
// full brace-matched body of every reaper they name. Pulling only the definition LINE was
// not enough: a reaper that loops (`for (const p of [server, web])`) puts the names it
// covers on the NEXT line, so a correct file was reported as leaking both children. Two
// false positives out of three findings is a lint nobody reads.
function reapSurface(src: string): string {
  const onLines = src.split('\n').filter((l) => /process\.on\(/.test(l))
  let surface = onLines.join('\n')
  const named = new Set<string>()
  for (const l of onLines) for (const m of l.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) named.add(m[1])
  for (const n of named) {
    // Both declaration forms. Matching only `const foo = …` missed loose-ends-test.mts,
    // whose reaper is a hoisted `function killServer(p) { … }` — so its body never entered
    // the surface and the file was reported as leaking a child it correctly group-kills.
    const at = src.search(new RegExp(`(?:(?:const|let)\\s+${n}\\s*=|function\\s+${n}\\s*\\()`))
    if (at < 0) continue
    const open = src.indexOf('{', at)
    if (open < 0) { surface += '\n' + src.slice(at, src.indexOf('\n', at)); continue }
    let depth = 0, i = open
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') { depth--; if (depth === 0) break }
    }
    surface += '\n' + src.slice(at, i + 1)
  }
  return surface
}

// Every name a reaper might reach a given child by: the child itself, plus one level of
// aliasing. `const p = spawn(…); current = p` with a reaper that kills `current` IS
// covered; the child's own identifier never appears in the handler.
function aliasNames(src: string, v: string): string[] {
  const out = [v]
  for (const m of src.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*${v}\\b`, 'g'))) out.push(m[1])
  return out
}

// Slice out ONE spawn call's full argument list, so its options can be read PER CHILD
// rather than asking whether the word `detached` appears anywhere in the file. That
// distinction is the whole point of rule 3: layout-check.mjs spawns its server and its
// vite detached and its Chrome not, and any file-level test calls that file compliant.
function spawnCallSlice(src: string, openParen: number): string {
  let depth = 0, quote = '', i = openParen
  for (; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) break }
  }
  return src.slice(openParen, i + 1)
}

function spawnedChildren(src: string): { name: string; detached: boolean }[] {
  const out: { name: string; detached: boolean }[] = []
  for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?spawn\s*\(/g)) {
    const paren = src.indexOf('(', m.index! + m[0].length - 1)
    out.push({ name: m[1], detached: /detached\s*:\s*true/.test(spawnCallSlice(src, paren)) })
  }
  return out
}

// Which identifiers the reap surface kills BY PROCESS GROUP. Handles both spellings this
// repo uses: `process.kill(-chrome.pid, …)` directly, and the loop form
// `for (const p of [server, web, chrome]) process.kill(-p.pid, …)`, where the child names
// appear only in the array literal while the kill names the loop variable.
function groupKilledNames(surface: string): Set<string> {
  const out = new Set<string>()
  // The capture is the LAST identifier before `.pid`, so a pid reached through a member
  // path counts: auth-loopback-test.mjs group-kills `-s.child.pid`, and an identifier-only
  // pattern read that as a bare-pid kill and flagged a correct file.
  for (const m of surface.matchAll(/process\.kill\(\s*-\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*([A-Za-z_$][\w$]*)\s*\.pid/g)) {
    const id = m[1]
    out.add(id)
    for (const l of surface.matchAll(new RegExp(`for\\s*\\(\\s*const\\s+${id}\\s+of\\s*\\[([^\\]]*)\\]`, 'g'))) {
      for (const n of l[1].split(',')) { const t = n.trim(); if (/^[A-Za-z_$][\w$]*$/.test(t)) out.add(t) }
    }
  }
  return out
}

// ── RULE 2: WHICH children the reap paths actually cover ─────────────────────────────
// Rule 1 only asks whether the handlers EXIST — and terminal-ui-e2e.mjs satisfied that
// while reaping only Chrome, so its detached SERVER leaked on every failure. That made its
// own bug self-perpetuating: the test failed, orphaned a server on its fixed port, and the
// next run died with EADDRINUSE and reported a third, unrelated-looking symptom. Handlers
// that exist but do not cover everything spawned are the same lie as no handlers at all.
//
// Heuristic, and deliberately a shallow one: require every spawned variable to appear
// somewhere in the reap surface. It matches this repo's consistent
// `const reapX = () => …; process.on('exit', reapX)` shape and will not follow a reaper
// through an import — worth tightening the day someone writes one.
function unreapedChildren(src: string): string[] {
  const spawned = spawnedChildren(src).map((c) => c.name)
  if (!spawned.length) return []
  const surface = reapSurface(src)
  const covered = (v: string): boolean => aliasNames(src, v).some((n) => new RegExp(`\\b${n}\\b`).test(surface))
  return spawned.filter((v) => !covered(v))
}

// ── RULE 3: reap by process GROUP, never by pid ──────────────────────────────────────
// `child.kill()` signals ONE pid, and much of what this directory spawns is a WRAPPER:
// `npx tsx server/src/index.ts` is npx, which forks the real node; vite forks workers;
// Chrome forks a zygote, a gpu process, a network service and one renderer per tab.
// Killing the wrapper by pid can leave the process that actually holds the PORT running.
// A signal to the process GROUP reaches all of them, and a group only exists if the child
// was spawned `detached: true`. That is why every server spawn in this directory is
// already detached + group-killed: it is the fix for the EADDRINUSE saga rule 2 describes.
//
// ★ HOW STRONG THE EVIDENCE IS, PER CASE — READ THIS BEFORE TRUSTING A RED ★
// I have to state this precisely, because I first reported the Chrome case as a
// demonstrated 8-process leak and THAT WAS WRONG. It came from one `ps` snapshot taken
// ~2s after a harness exited, which caught Chrome mid-teardown and read it as a leak.
// Controlled re-measurement — layout-check.mjs run to completion with the bare-pid kill
// and with the group kill, sampling at t+1/2/4/8/15/30s — found **0 surviving Chrome
// processes in BOTH variants at every sample**. On the happy path and on the handled
// signal paths, killing Chrome's launcher does take its children with it; they notice the
// broken IPC channel and exit. And on an unhandled SIGKILL of the harness, NEITHER form
// helps, because no reaper runs at all.
//   • wrapper children (npx/shell → the real server): group kill is LOAD-BEARING, and the
//     historical EADDRINUSE failures are the evidence.
//   • Chrome: group kill is DEFENCE IN DEPTH ONLY. No scenario in this repo has been shown
//     where the bare kill actually orphans it.
// The rule still flags both, on the grounds that one uniform reaping discipline beats two,
// that the group form costs nothing, and that it stops depending on Chrome's self-exit
// behaviour — which is an implementation detail, not a contract. But a red on a Chrome
// spawn is a CONSISTENCY finding, not a proven leak, and anyone is entitled to weigh it
// that way. Do not let this comment drift back into claiming a leak that was measured not
// to happen.
//
// This rule was still worth adding for a reason independent of the above: rules 1 and 2
// ask whether a reaper EXISTS and whether it MENTIONS each child. A file can satisfy both
// and still kill the wrong process. That is rule 2's own origin — handlers that exist but
// do not cover — moved one level down: the reaper covers the right NAMES but not
// necessarily the right PROCESSES.
//
// ★ WHAT A NEW HARNESS MUST DO TO SATISFY THIS RULE ★
//   spawn(cmd, args, { …, detached: true })
//   process.kill(-child.pid, 'SIGKILL')        // note the MINUS — that is what means "group"
// or the loop form this repo also uses:
//   for (const p of [server, web, chrome]) { try { process.kill(-p.pid, 'SIGKILL') } catch { p.kill('SIGKILL') } }
// Both spellings are recognised, and a bare `.kill()` as a FALLBACK beside a group kill is
// fine — it is a bare kill ALONE that is flagged. So are a member path (`-s.child.pid`) and
// a reaper declared as `function foo()` rather than `const foo = …`: this rule's first
// draft missed both and reported two ALREADY-CORRECT files as leaking. That direction of
// error matters more than it looks — 31 reds of which 2 are wrong is how a lint gets
// discounted, which is the exact failure this whole file exists to prevent. A THIRD
// spelling will not be recognised, and that is the known weakness of a grep-level rule: it
// can only ever miss toward a false GREEN. If you invent one, teach it to
// groupKilledNames() in the same edit — a check that silently ignores a novel spelling is
// this lint's own founding bug, one level down.
//
// Scope: only children the file actually reaps. A spawn nobody reaps is either short-lived
// or already reported by unreapedChildren(), and repeating it here would say the wrong thing.
function groupKillGaps(src: string): string[] {
  const surface = reapSurface(src)
  const grouped = groupKilledNames(surface)
  const out: string[] = []
  for (const c of spawnedChildren(src)) {
    const names = aliasNames(src, c.name)
    if (!names.some((n) => new RegExp(`\\b${n}\\b`).test(surface))) continue   // unreaped → rule 2 owns it
    if (!names.some((n) => grouped.has(n))) {
      out.push(`child \`${c.name}\` is killed by pid, not by process group (wrapper/child processes may outlive it)`)
    } else if (!c.detached) {
      out.push(`child \`${c.name}\` is group-killed but NOT spawned detached — process.kill(-pid) has no group to hit`)
    }
  }
  return out
}

// ── RULE 4: a request/response socket must abort when it dies, not hang ──────────────
// The mechanism, and it is the one that produced the `:4331` squatter class. A CDP call is
// written as `send()` → `pend.set(id, resolve)` → await. That promise has exactly ONE thing
// that can resolve it: an inbound message on the socket. So if Chrome dies mid-run — crash,
// OOM, an external pkill, an operator's stray `pkill chrome` — the await never settles.
// Node does not exit either, because the spawned server's stdio pipes keep the event loop
// alive, so the harness parks in `ep_poll` FOREVER holding every port it bound.
//
// This is measured, not inferred: a stale `layout-check.mjs` sat in `ep_poll` squatting
// 4493/5293 for nine minutes, and the next run of an unrelated file died with "server did
// not start" and pointed the blame at an innocent edit. A silent squatter costs far more
// than a loud failure, because nothing in the output names the file that is holding the
// port — that is hours of misattribution per incident, and this team has paid it.
//
// Note the failure mode is NOT "the socket is closed so the next send throws". Calling
// `send()` on a CLOSED ws emits an `error` event, which these files already have a listener
// for (the `cdp.on('error', rej)` of the connect promise, long since settled) — so the throw
// is swallowed and the caller hangs exactly as before. Post-close sends hang too. The only
// fix is to notice the close itself.
//
// ★ WHAT SATISFIES THIS RULE ★
//   cdp.on('close', () => { console.error('…Chrome died…'); reap(); process.exit(1) })
// `process.exit` is REQUIRED and logging alone is not enough: a handler that prints and
// returns leaves the await pending and the port held, which is the bug. Reaping inside the
// handler is optional here and deliberately not required — `process.exit()` runs the
// `process.on('exit', …)` handlers that rules 1–3 already force to exist and to cover every
// child. Requiring it twice would let this rule pass a file whose reaper is wrong.
//
// ★ AND THE HAZARD THIS RULE INTRODUCES — READ BEFORE ADDING THE GUARD ★
// `ws` emits `close` for a LOCAL close too. So in a file that tears down deliberately —
// `cdp.close()`, or killing Chrome before the summary is printed — a bare guard fires on the
// happy path and exits 1 after the assertions all passed, turning a green run red. Every
// such file needs a `cdpDone = true` set BEFORE the first teardown statement, and "teardown"
// starts at the Chrome kill, not at `cdp.close()`. The rule cannot check that for you.
// Quote-aware, LENGTH-PRESERVING comment stripper: every comment byte becomes a space so
// indices into the result still address the original. Length preservation is the point —
// the rules below slice windows by index. Quote-awareness is not optional either: half the
// URLs in this directory are `ws://127.0.0.1:…`, and a naive `//` strip eats the rest of
// every one of those lines.
function stripComments(src: string): string {
  const out = src.split('')
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++ }
      out[i] = ' '; out[i + 1] = ' '; i += 2
      continue
    }
    i++
  }
  return out.join('')
}

// The full argument list of a call whose `(` is at `open`, brace/quote aware.
function callArgs(src: string, open: number): string {
  let depth = 0, quote = '', i = open
  for (; i < src.length; i++) {
    const c = src[i]
    if (quote) { if (c === '\\') { i++; continue } if (c === quote) quote = ''; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) break }
  }
  return src.slice(open + 1, i)
}

// The brace-matched body of `const f = …` / `let f = …` / `function f(…)`.
function functionBody(src: string, name: string): string {
  const at = src.search(new RegExp(`(?:(?:const|let|var)\\s+${name}\\s*=|function\\s+${name}\\s*\\()`))
  if (at < 0) return ''
  const open = src.indexOf('{', at)
  if (open < 0) return src.slice(at, src.indexOf('\n', at))
  let depth = 0, i = open
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(at, i + 1)
}

// ── RULE 4: a request/response socket must abort when it dies, not hang ──────────────
// The mechanism, and it is the one that produced the `:4331` squatter class. A CDP call is
// written as `send()` → `pend.set(id, resolve)` → await. That promise has exactly ONE thing
// that can resolve it: an inbound message on the socket. So if Chrome dies mid-run — crash,
// OOM, an external pkill, an operator's stray `pkill chrome` — the await never settles.
// Node does not exit either, because the spawned server's stdio pipes keep the event loop
// alive, so the harness parks in `ep_poll` FOREVER holding every port it bound.
//
// This is measured, not inferred, in both directions: a stale `layout-check.mjs` sat in
// `ep_poll` squatting 4493/5293 for nine minutes, and the next run of an unrelated file
// died with "server did not start" and blamed an innocent edit. Reproduced in isolation
// (ws echo server, CDP-shaped pending map, a listening socket standing in for the spawned
// children): unguarded + peer death → still running and holding its port at 25s; guarded →
// exit 1 in 255ms. A silent squatter costs far more than a loud failure, because nothing in
// the output names the file holding the port.
//
// Note the failure mode is NOT "the socket is closed so the next send throws". Calling
// `send()` on a CLOSED ws emits an `error` event, which these files already have a listener
// for (the `cdp.on('error', rej)` of the connect promise, long since settled) — so the throw
// is swallowed and the caller hangs exactly as before. Post-close sends hang too. The only
// fix is to notice the close itself.
//
// ★ WHAT SATISFIES THIS RULE ★
//   cdp.on('close', () => { console.error('…Chrome died…'); process.exit(1) })
// `process.exit` is REQUIRED and logging alone is not enough: a handler that prints and
// returns leaves the await pending and the port held, which is the bug. Reaping inside the
// handler is optional and deliberately NOT required — `process.exit()` runs the
// `process.on('exit', …)` handlers that rules 1–3 already force to exist and to cover every
// child. Requiring it twice would let this rule pass a file whose reaper is wrong.
//
// ★ AND THE HAZARD THIS RULE INTRODUCES — READ BEFORE ADDING THE GUARD ★
// `ws` emits `close` for a LOCAL close too. So in a file that tears down deliberately —
// `cdp.close()`, or killing Chrome before the summary is printed — a bare guard fires on the
// happy path and exits 1 after the assertions all passed, turning a green run red. Measured:
// guard without the flag, clean teardown → exit 1. Every such file needs a `cdpDone = true`
// set BEFORE the first teardown statement, and "teardown" starts at the Chrome kill, not at
// `cdp.close()`. The rule cannot check that for you.
//
// ★ HOW THIS RULE FINDS SOCKETS, AND WHY NOT FROM `new WebSocket` ★
// The first draft keyed off `(?:const|let)\s+NAME\s*=\s*new WebSocket(`, which is the same
// false-negative shape rule 2 already documents for `unreapedChildren`: it misses `var`,
// `this.cdp =`, `let cdp; cdp = …`, and — most likely in practice — a socket built in a
// helper and returned (`const cdp = await connectCdp()`). So detection now starts from
// BEHAVIOUR instead of construction: anything that has a message listener AND an awaited
// send is a request/response socket however it came to exist. The `WebSocket` mention below
// is only a sanity gate to keep this off unrelated emitters.
//
// ★ KNOWN SCOPE LIMIT — a second hang path this rule will never see ★
// Excluding fire-and-forget sockets is what keeps the rule off interrupt-test.mts, and it is
// right for the CDP case. But `clear-race-test.mjs` and `super-editor-test.mjs` each run a
// WebSocketServer + upstream client as a PROXY to the app server, and those sockets are
// fire-and-forget by construction, so they are excluded here by design. If the app SERVER
// dies mid-run, those harnesses have no guard at all. They do not hang on a pending promise
// the way the CDP path does — they fail on their bounded waits — so this is a slower, milder
// version of the same class rather than a squatter. Unfixed and KNOWN, not overlooked.
// (Those two files also have THREE `new WebSocket` against one guard. That is the proxy pair
// plus the CDP socket, not two unguarded CDP sockets. Do not "fix" it.)
function cdpHangGaps(raw: string): string[] {
  const src = stripComments(raw)
  if (!/WebSocket/.test(src)) return []
  const out: string[] = []
  const seen = new Set<string>()
  // Both spellings of "listens for replies". `addEventListener` is what you get when the
  // code is ported from browser WebSocket, and `ws` supports it.
  const LISTEN = /\b((?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(?:on|addEventListener)\(\s*['"`]message['"`]/g
  for (const m of src.matchAll(LISTEN)) {
    const name = m[1]
    if (seen.has(name)) continue
    seen.add(name)
    const esc = name.replace(/[.$]/g, (c) => '\\' + c)
    // Only hangs if a send is AWAITED through a promise REGISTERED IN A PENDING MAP, which
    // is the thing only an inbound message can resolve. The window is wide because the two
    // halves are one line in most files here and four lines apart in layout-check.mjs.
    //
    // Both halves are required, and the registration half is not decoration. Testing for
    // `new Promise` alone made this rule flag interrupt-test.mts, whose `ws.send` is pure
    // fire-and-forget — the window had merely caught the unrelated
    // `await new Promise((res) => ws.on('open', res))` three lines above it. That file waits
    // on bounded polling loops and cannot hang, so the red was false, and a false red here
    // is the failure this whole lint exists to prevent (see rule 3's note on the same
    // mistake). Both `pend.set(id, res)` and the plain-object `pending[<anything>] = res`
    // count — the key is deliberately unconstrained, because the self-test's `pending[1]`
    // slipped through an earlier version that demanded an identifier there. The MAP half is
    // constrained instead (an identifier immediately before the bracket), which is what keeps
    // this off array destructuring `[a, b] = c` and out of the false-RED direction.
    let awaited = false
    for (const s of src.matchAll(new RegExp(`\\b${esc}\\.send\\s*\\(`, 'g'))) {
      const win = src.slice(Math.max(0, s.index! - 250), s.index! + 250)
      if (/new\s+Promise\s*\(/.test(win) && /\.set\s*\(|[A-Za-z_$][\w$]*\s*\[[^\]\n]{1,40}\]\s*=[^=]/.test(win)) { awaited = true; break }
    }
    if (!awaited) continue
    // The guard, checked in the HANDLER BODY rather than in a byte window after the call.
    // A window is wrong in both directions: it passes an empty handler that merely happens
    // to be followed by unrelated `process.exit` code, and it FAILS a delegating guard
    // (`cdp.on('close', abort)`) whose exit lives in the named function. Both are resolved
    // here — the handler argument is sliced out exactly, and a bare identifier is followed
    // to its declaration.
    let guarded = false
    for (const g of src.matchAll(new RegExp(`\\b${esc}\\.(?:on|addEventListener)\\(\\s*['"\`](?:close|error)['"\`]\\s*,`, 'g'))) {
      const open = src.indexOf('(', g.index!)
      const args = callArgs(src, open)
      const handler = args.slice(args.indexOf(',') + 1).trim()
      const body = /^[A-Za-z_$][\w$]*$/.test(handler) ? functionBody(src, handler) : handler
      if (/process\.exit/.test(body)) { guarded = true; break }
    }
    if (!guarded) {
      out.push(`socket \`${name}\` awaits replies it cannot get if the peer dies — no close handler that exits (hangs forever holding its ports)`)
    }
  }
  return out
}

// ── rule 4's own self-test, and why it runs on EVERY invocation ──────────────────────
// Rule 4 has now been wrong twice: its first draft produced a false red on interrupt-test.mts,
// and a review of that draft found five more shapes it mis-handled. A grep-level rule is a
// guess about spellings, so the only honest way to hold one is to pin the spellings it claims
// to know. Measured against the FIRST draft, these eight fixtures came out 7 WRONG — five
// false greens (member-path binding, addEventListener, plain-object pending map, an empty
// handler passing on a nearby unrelated process.exit, a socket built in a helper) and two
// false REDS (a commented-out socket, and a delegating `on('close', abort)` guard). The
// version below gets 8/8. That is the whole claim, and this is where it is kept true.
//
// It runs unconditionally rather than behind a flag: a self-test nobody invokes is the
// "alarm that is not wired up" failure registration-lint exists to prevent, one level down.
const RULE4_SELF_TEST: { name: string; red: boolean; src: string }[] = [
  { name: 'member-path binding (this.cdp =)', red: true, src: `import { WebSocket } from 'ws'
    this.cdp = new WebSocket(u)
    this.cdp.on('message', (d) => { if (this.pend.has(d.id)) this.pend.get(d.id)(d) })
    const send = (m) => { this.cdp.send(m); return new Promise((r) => this.pend.set(1, r)) }` },
  { name: 'socket built in a helper and returned', red: true, src: `import { WebSocket } from 'ws'
    async function connect(u) { const s = new WebSocket(u); return s }
    const cdp = await connect(u)
    cdp.on('message', (d) => { if (pend.has(d.id)) pend.get(d.id)(d) })
    const send = (m) => { cdp.send(m); return new Promise((r) => pend.set(1, r)) }` },
  { name: 'addEventListener spelling', red: true, src: `import { WebSocket } from 'ws'
    const cdp = new WebSocket(u)
    cdp.addEventListener('message', (d) => { if (pend.has(d.id)) pend.get(d.id)(d) })
    const send = (m) => { cdp.send(m); return new Promise((r) => pend.set(1, r)) }` },
  { name: 'plain-object pending map', red: true, src: `import { WebSocket } from 'ws'
    const cdp = new WebSocket(u)
    cdp.on('message', (d) => { if (pending[d.id]) pending[d.id](d) })
    const send = (m) => { cdp.send(m); return new Promise((r) => { pending[1] = r }) }` },
  { name: 'empty handler beside an unrelated process.exit', red: true, src: `import { WebSocket } from 'ws'
    const cdp = new WebSocket(u)
    cdp.on('close', () => { console.error('closed') })
    if (!process.env.HOME) { process.exit(1) }
    cdp.on('message', (d) => { if (pend.has(d.id)) pend.get(d.id)(d) })
    const send = (m) => { cdp.send(m); return new Promise((r) => pend.set(1, r)) }` },
  { name: 'delegating guard on(close, abort) — must NOT red', red: false, src: `import { WebSocket } from 'ws'
    const cdp = new WebSocket(u)
    function abort() { console.error('died'); process.exit(1) }
    cdp.on('close', abort)
    cdp.on('message', (d) => { if (pend.has(d.id)) pend.get(d.id)(d) })
    const send = (m) => { cdp.send(m); return new Promise((r) => pend.set(1, r)) }` },
  { name: 'commented-out socket — must NOT red', red: false, src: `import { WebSocket } from 'ws'
    // const cdp = new WebSocket(u)
    // cdp.on('message', (d) => { pend.get(d.id)(d) })
    // const send = (m) => { cdp.send(m); return new Promise((r) => pend.set(1, r)) }
    console.log('nothing live here')` },
  { name: 'fire-and-forget app WS — must NOT red', red: false, src: `import { WebSocket } from 'ws'
    const ws = new WebSocket(u)
    ws.on('message', (raw) => { state = JSON.parse(raw).state })
    await new Promise((res) => ws.on('open', res))
    const send = (msg) => ws.send(JSON.stringify(msg))` },
]

function runRule4SelfTest(): string[] {
  const bad: string[] = []
  for (const t of RULE4_SELF_TEST) {
    const got = cdpHangGaps(t.src).length > 0
    if (got !== t.red) bad.push(`rule 4 self-test: "${t.name}" should be ${t.red ? 'RED' : 'green'}, got ${got ? 'RED' : 'green'}`)
  }
  return bad
}

function reapGaps(src: string): string[] {
  const missing: string[] = []
  if (!/process\.on\(\s*['"`]exit['"`]/.test(src)) missing.push('exit')
  for (const sig of SIGNALS) {
    // Matches both `process.on('SIGINT', …)` and the `for (const sig of [...])` loop form.
    const named = new RegExp(`process\\.on\\(\\s*['"\`]${sig}['"\`]`).test(src)
    const looped = new RegExp(`['"\`]${sig}['"\`]`).test(src) && /for\s*\(\s*const\s+\w+\s+of\s*\[/.test(src) && /process\.on\(\s*\w+\s*,/.test(src)
    if (!named && !looped) missing.push(sig)
  }
  return missing
}

const files = readdirSync(DIR).filter((f) => (f.endsWith('.mjs') || f.endsWith('.mts')) && f !== path.basename(fileURLToPath(import.meta.url)))

// PARSE EVERY FILE FIRST, and fail loudly if one does not compile.
//
// This check exists because this lint told a lie about itself. Its reap rule is a grep for
// handler names, so when an automated edit spliced a block into the MIDDLE of an arrow
// function in loose-ends-test.mts, the handler names were all still present — and the lint
// printed "✅ every detached spawn is reaped" for a file that could not even be parsed.
// A syntactically dead test reaps nothing at all, so the green was worse than a red: it is
// the same "alarm that cries wolf" failure this lint was written to catch, reproduced by
// the lint. A grep-based rule must therefore never report on a file it has not first
// confirmed is real code.
const parseErrors: { file: string; error: string }[] = []
try {
  const esbuild = await import('esbuild')
  for (const f of files) {
    const src = readFileSync(path.join(DIR, f), 'utf8')
    try {
      await esbuild.transform(src, { loader: f.endsWith('.mts') ? 'ts' : 'js', format: 'esm' })
    } catch (e) {
      parseErrors.push({ file: f, error: (e as { message?: string }).message?.split('\n')[0] ?? String(e) })
    }
  }
} catch {
  console.log('  ⚠ esbuild unavailable — syntax not verified; the rules below are grep-level only')
}

const byPort = new Map<number, string[]>()
const gaps: { file: string; missing: string[] }[] = []

for (const f of files) {
  const src = readFileSync(path.join(DIR, f), 'utf8')
  for (const p of boundPorts(src)) {
    byPort.set(p, [...(byPort.get(p) ?? []), f])
  }
  // GATE. Was `spawnsDetachedChild` alone, which skipped every file whose only long-lived
  // child is a NON-detached one — i.e. exactly the ~15 Chrome-spawning harnesses rule 3 is
  // written to catch. Scoping a rule by the shape of the bug you already knew about is how
  // a lint stays green over a whole population of the bug you did not.
  const hang = cdpHangGaps(src)
  if (hang.length) gaps.push({ file: f, missing: hang })
  if (spawnsDetachedChild(src) || reapsAChild(src)) {
    const missing = reapGaps(src)
    if (missing.length) gaps.push({ file: f, missing })
    const unreaped = unreapedChildren(src)
    if (unreaped.length) gaps.push({ file: f, missing: unreaped.map((v) => `child \`${v}\` is spawned but never reaped`) })
    const byPid = groupKillGaps(src)
    if (byPid.length) gaps.push({ file: f, missing: byPid })
  }
}

let violations = 0
console.log('── rule 4 self-test ──')
const selfTestFailures = runRule4SelfTest()
if (selfTestFailures.length) {
  for (const b of selfTestFailures) { violations++; console.log(`  ❌ ${b}`) }
  console.log('  (rule 4 cannot be trusted on real files while it is wrong about these)')
} else {
  console.log(`  ✅ all ${RULE4_SELF_TEST.length} spelling fixtures classified correctly`)
}

console.log('\n── syntax ──')
if (parseErrors.length) {
  for (const p of parseErrors) { violations++; console.log(`  ❌ ${p.file} — DOES NOT PARSE: ${p.error}`) }
  console.log('  (a file that does not parse reaps nothing — treat every rule below as unproven for it)')
} else {
  console.log('  ✅ every file parses')
}

console.log('\n── port map (files that BIND a fixed port) ──')
for (const [p, fs] of [...byPort].sort((a, b) => a[0] - b[0])) {
  const clash = fs.length > 1
  if (clash) violations++
  console.log(`  ${clash ? '❌' : '  '} ${p}  ${fs.join(', ')}`)
}
if (![...byPort.values()].some((v) => v.length > 1)) console.log('  ✅ injective — no two files bind the same port')

console.log('\n── reap coverage + socket-death guards ──')
if (!gaps.length) {
  console.log('  ✅ every detached spawn is reaped on exit + all four signal paths, and every\n     request/response socket aborts instead of hanging when its peer dies')
} else {
  for (const g of gaps) {
    violations++
    console.log(`  ❌ ${g.file} — missing: ${g.missing.join(', ')}`)
  }
}

console.log(`\n${violations === 0 ? 'clean' : `${violations} violation(s)`}`)
process.exitCode = violations === 0 ? 0 : 2
