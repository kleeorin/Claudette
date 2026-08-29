// file-live-sync-client-guard — the CLIENT half of live file sync.
//
// The server half (fileWatchRegistry + the fs:watch/fs:unwatch/fs:changed/fs:removed
// messages) has `live-file-sync-test.mts`. This is the other side of the same wire:
// `web/src/api/client.ts`'s `watched` map / `sendLive` / reconnect re-arm, and
// `web/src/components/FileEditorView.tsx`'s subscription and its two banners.
// Until this file there were no client-side tests at all, and the feature's own author
// found a real bug in it by rereading it — which is the signal that rereading is not
// the tool.
//
// WHAT MAKES THIS FEATURE HARD TO TEST, AND WHY IT IS WORTH IT: every defect it can have
// is INVISIBLE. A watch that is not re-armed after a reconnect does not throw, does not
// log, and does not change one pixel — the editor simply stops following the file and
// looks exactly like an editor that is following a file nobody has touched. There is no
// symptom to notice in manual use, so a harness is not a convenience here, it is the only
// instrument that can see the failure at all.
//
// ── HOW TO RUN ────────────────────────────────────────────────────────────────────────
//   npx tsx scratchpad/file-live-sync-client-guard.mts
//
// This is a plain run as of 2026-08-28, and it is newly true: `jsdom ^29.1.1` was finally
// added to the root devDependencies that day, closing the gap the file was written against
// (approved 2026-08-21, declared a week later — until then EVERY setupDom caller took the
// no-DOM path on every machine, and the two DOM harnesses that existed could not run for
// anyone on a clean checkout). Verified here: 45/0 with no environment variable set.
//
// The CLAUDETTE_JSDOM escape hatch still matters for CONFINED sessions, which mount
// node_modules read-only and so cannot `npm i` even for a declared dependency. `/tmp` is
// per-sandbox private, so each such session needs its own copy, and it does not survive a
// context clear:
//
//   mkdir -p /tmp/qa-deps && (cd /tmp/qa-deps && npm i jsdom)
//   CLAUDETTE_JSDOM=/tmp/qa-deps/node_modules/jsdom/lib/api.js \
//     npx tsx scratchpad/file-live-sync-client-guard.mts
//
// With no DOM by either route this exits 77 (run-suite's runtime-skip code) and verifies
// NOTHING. 77 and not 0: 0 is how the runner spells PASS, and a test that reports PASS
// without running is the exact defect this file exists to catch elsewhere.
//
// ── TWO THINGS THIS HARNESS HAD TO SOLVE, WORTH COPYING ───────────────────────────────
// 1. A `.css` IMPORT KILLS THE MODULE GRAPH. FileEditorView pulls in CsvTableView, which
//    imports `react-data-grid/lib/styles.css`; Node's ESM loader has no idea what a `.css`
//    file is and the whole import throws before a single line of the component runs. Vite
//    handles this in the real app; `npx tsx` does not. The fix is a loader hook registered
//    from a `data:` URL (below) that answers every stylesheet with an empty module. Inline
//    rather than a separate hook file on purpose: a `.mjs` in scratchpad/ would have to be
//    declared a non-test in the registry to keep registration-lint quiet, which is a lot of
//    ceremony for six lines.
// 2. CODEMIRROR NEEDS MORE DOM THAN `dom-env.mts` PUBLISHES. It calls
//    `document.defaultView.requestAnimationFrame` in its constructor and `elt instanceof
//    Window` while measuring. Those are shimmed onto the jsdom window HERE rather than
//    added to DOM_GLOBALS, deliberately and against dom-env's own advice: `rAF` is not a
//    global jsdom omits, it is one jsdom only creates under `pretendToBeVisual`, so the
//    honest fix is an option on setupDom rather than a global — and changing setupDom's
//    constructor options changes behaviour for every existing DOM harness at a moment when
//    another session is writing the tree. Left as a local shim with this note. If a third
//    harness needs CodeMirror, promote it properly.
//
// ── MUTATION TESTING: WHAT WAS BROKEN, AND WHAT WENT RED ──────────────────────────────
// Every mutation below was applied to a COPY of the file under test, never to the file
// itself — a restore of a file another session is editing silently destroys their work
// (see `scratchpad/safe-mutate.sh` and the note on file-multiselect-guard). The copies
// live at repo-root dotfiles, invisible to registration-lint, and each copy was FIRST
// proven to reproduce the real file's result exactly before a single mutation was applied.
// Point the harness at a copy with:
//   QA_LS_CLIENT=../.qa-client-copy.ts   (implies part A only — see below)
//   QA_LS_EDITOR=../.qa-editor-copy.tsx
//
//   Measured, not predicted — every line below is a run. Baseline is 45/0 (16/0 for a
//   client-only run, which stops after part A).
//
//   ID   WHAT WAS BROKEN                                       RESULT       WENT RED
//   C1   the re-arm loop in sock.onopen, deleted               11/5   [1c][1d][1e][2c][3c]
//   C2   watch uses `send` (outboxed) instead of `sendLive`    15/1   [2c]
//   C3   the local refcount dropped; both sides send always    14/2   [3a][3b]
//   C4   `watched.delete(path)` dropped from unwatch           13/3   [3e][3f][3g]
//   C5   unwatch sends while another editor still holds it     15/1   [3b]
//   C6   the last unwatch never reaches the wire               15/1   [3d]
//   C7   sendLive's readyState check removed                   16/0   NOTHING — see [2a]
//   E1   the handler reads `dirty` state, not `dirtyRef`       38/7   [5a-f][7s]
//   E2   the handler reads `reviewing` state, not the ref      44/1   [6a]
//   E3   `if (p !== path) return` dropped (fs:changed)         44/1   [8a]
//   E4   the `p === path` guard dropped (fs:removed)           44/1   [8b]
//   E5   `api.fs.unwatch(path)` dropped from the cleanup       42/3   [8c][8d][8e]
//   E6   fs:removed also refreshes from disk                   42/3   [7a][7b][7d]
//   E7   `&& !goneFromDisk` dropped from the stale banner      44/1   [7d]
//   E8   the effect's deps `[path]` changed to `[]`            42/3   [8e][8f][8g]
//   E9   `refreshRef.current()` -> `doRefresh()`               45/0   NOTHING — see below
//   E10  the effect never takes the watch at all               43/2   [4a][8f]
//   XX   CONTROL: a patch matching no text in the file         REFUSED BEFORE RUNNING
//
//   ★ THE `XX` CONTROL IS NOT DECORATION. A mutation whose pattern silently matches nothing
//   runs the harness against the UNMUTATED file and comes back green, which reads as "this
//   assertion cannot be made to fail" — a false finding about the test rather than about the
//   code. The runner refuses when the patched text is byte-identical to the original, which
//   is the same check `safe-mutate.sh` makes.
//
//   ★ E1 IS THE MOST IMPORTANT ROW HERE, and 7 reds understates it. Reading `dirty` state
//   instead of the ref does not merely mis-route a banner: the handler falls to the CLEAN
//   branch, which refreshes from disk, which DISCARDS the user's unsaved buffer — silently,
//   on any background write to the file. [5e] and [5f] go red because the controls they
//   click no longer exist, and [7s] because a later fixture cannot get dirty either.
//
// ★ TWO MUTATIONS COULD NOT BE MADE TO RED, AND BOTH ARE FINDINGS RATHER THAN GAPS.
//   The first is C7, recorded at [2a] in the body: `sendLive`'s readyState check cannot be
//   observed, because `retry()` nulls `ws` before anything else can look at it.
//   The second is E9. `refreshRef.current = doRefresh` is described as necessary for the
//   same reason `dirtyRef` is — a subscription created once per path would otherwise hold
//   a stale callback. It is not: `doRefresh` is a `useCallback` keyed on `[path]` and the
//   effect is keyed on `[path]` too, so the captured value and the current one are the
//   same function by construction. Replacing `refreshRef.current()` with `doRefresh()`
//   leaves all 45 assertions green (row E9), and no assertion could be written that would
//   tell them apart. The ref is harmless and it is honest insurance against the deps changing later,
//   but it is NOT load-bearing today, and the comment above it implies it is. Recorded
//   rather than fixed, because it is a comment's claim rather than a defect.
//   A mutation that produces no red is not a passing mutation — it is either an uncovered
//   branch announcing itself (see file-multiselect-guard's MC3) or, as here, a line whose
//   stated justification does not hold. Both are findings. Neither is a green.
//
// ── AN OBSERVATION, NOT AN ASSERTION ──────────────────────────────────────────────────
// `unwatch(p)` for a path that was never watched computes `(watched.get(p) ?? 1) - 1 === 0`
// and sends a real `fs:unwatch` for it. Defensible (the `?? 1` reads as "assume one"), and
// no caller does it today — FileEditorView only unwatches what its own effect watched. Not
// asserted either way, because pinning behaviour nothing depends on is how a test becomes
// a reason not to change code. Flagged so the next person knows it was seen, not missed.
import { register } from 'node:module'

// See note 1 in the header. Answers any stylesheet import with an empty module so the
// FileEditorView module graph can be loaded outside Vite.
const CSS_STUB_HOOK = `
export async function load(url, context, nextLoad) {
  if (/\\.(css|scss|sass|less)(\\?|$)/.test(url)) {
    return { format: 'module', shortCircuit: true, source: 'export default {}' }
  }
  return nextLoad(url, context)
}
`
register('data:text/javascript,' + encodeURIComponent(CSS_STUB_HOOK), import.meta.url)

import { setupDom, NO_DOM_NOTE } from './dom-env.mts'

let passed = 0, failed = 0
const ok = (tag: string, name: string, cond: boolean, extra = ''): void => {
  cond ? passed++ : failed++
  console.log(`  ${cond ? '✅' : '❌'} [${tag}] ${name}${extra ? ` — ${extra}` : ''}`)
}
const done = (): never => {
  console.log(`\n${passed} passed / ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

const dom = await setupDom()
if (!dom) {
  console.log('[skip] no DOM: jsdom could not be imported, so nothing here was verified.')
  for (const line of NO_DOM_NOTE) console.log('  ' + line)
  process.exit(77)
}

const g = globalThis as any
const w: any = dom.window
g.IS_REACT_ACT_ENVIRONMENT = true

// See note 2 in the header.
w.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(1), 0)
w.cancelAnimationFrame = (id: any) => clearTimeout(id)
g.requestAnimationFrame = w.requestAnimationFrame
g.cancelAnimationFrame = w.cancelAnimationFrame
for (const k of ['Window', 'Range', 'DOMRect', 'Selection', 'HTMLCollection', 'DOMTokenList',
                 'ShadowRoot', 'StaticRange', 'ClipboardEvent', 'DragEvent', 'CompositionEvent',
                 'UIEvent']) {
  if (w[k] !== undefined) g[k] = w[k]
}
w.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
g.ResizeObserver = w.ResizeObserver
// jsdom has no layout, so CodeMirror's measure pass throws on every animation frame and
// logs a wall of stack traces that would bury the assertion output. It CATCHES them itself
// — the editor keeps working, which is why [5b] can still read the document — so these
// stubs only quieten the noise. Returning an empty rect list is honest: there is no layout.
const EMPTY_RECTS = { length: 0, item: () => null, [Symbol.iterator]: function* () {} }
const ZERO_RECT = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
w.Range.prototype.getClientRects = () => EMPTY_RECTS
w.Range.prototype.getBoundingClientRect = () => ZERO_RECT

// ── the fixture ───────────────────────────────────────────────────────────────────────
const PATH = '/root/a.txt'
const OTHER = '/root/b.txt'
let DISK = 'hello from disk'
let reads = 0                       // GET /api/fs/read calls, so "did it refresh?" is measurable

const sockets: StubWS[] = []
const sent: string[] = []           // every frame this page put on the wire, across all sockets

// A WebSocket the test drives by hand. `open()` and `deliver()` are the two levers: nothing
// here reconnects or delivers on its own, so every reconnect in this file is a deliberate
// step rather than a race the test hopes to win.
class StubWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
  readyState = StubWS.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) { sockets.push(this) }
  send(s: string): void { sent.push(s) }
  close(): void { this.readyState = StubWS.CLOSED; this.onclose?.() }
  open(): void { this.readyState = StubWS.OPEN; this.onopen?.() }
  deliver(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }) }
}
g.WebSocket = StubWS

g.fetch = async (u: unknown, init?: { body?: string }): Promise<unknown> => {
  const url = String((u as { url?: string })?.url ?? u)
  const json = async (): Promise<unknown> => {
    if (url.startsWith('/api/fs/read')) { reads++; return { kind: 'text', text: DISK, path: PATH } }
    if (url.startsWith('/api/fs/write')) { DISK = String(JSON.parse(init?.body ?? '{}').text); return { ok: true } }
    return { ok: true }
  }
  return { ok: true, status: 200, json }
}

const React = await import('react')
// The repo ships `jsx: "react-jsx"` but has no root tsconfig, so `npx tsx` (how run-suite
// invokes every .mts) falls back to the classic transform and emits bare `React.createElement`.
// A compile shim, not a behaviour change. Must precede the component import.
g.React = React
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')

// Point either half at a mutated COPY without touching the real file. See the header.
const CLIENT_MOD = process.env.QA_LS_CLIENT ?? '../web/src/api/client.ts'
const EDITOR_MOD = process.env.QA_LS_EDITOR ?? '../web/src/components/FileEditorView.tsx'
const client: any = await import(CLIENT_MOD)

// ── wire helpers ──────────────────────────────────────────────────────────────────────
type Frame = { type: string; path?: string }
const wire = (): Frame[] => sent.map((s) => JSON.parse(s) as Frame)
const count = (type: string, path?: string): number =>
  wire().filter((m) => m.type === type && (path === undefined || m.path === path)).length
const clearWire = (): void => { sent.length = 0 }
const live = (): StubWS => sockets[sockets.length - 1]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Drop the current socket and drive the reconnect the client schedules. The client's own
// backoff resets to 500ms on every successful open, so this is ~600ms each time; polling
// for the new socket rather than sleeping a fixed amount keeps it honest if that changes.
const reconnect = async (): Promise<StubWS> => {
  const before = sockets.length
  live().close()
  for (let i = 0; i < 60 && sockets.length === before; i++) await sleep(50)
  if (sockets.length === before) throw new Error('client never reconnected')
  const sock = live()
  sock.open()
  return sock
}

console.log('\n── part A: the transport (web/src/api/client.ts) ───────────────────────────')

client.ensureWs()
ok('setup', '[0a] the client opened exactly one socket', sockets.length === 1, `sockets=${sockets.length}`)
live().open()
clearWire()

// ── [1] THE RECONNECT RE-ARM ──────────────────────────────────────────────────────────
// The reason this file exists. The server keys watches PER SOCKET and releases everything a
// socket held when it closes, so a watch that was delivered successfully is nonetheless gone
// after a drop — and nothing retains it, because it was never a queued message. Before the
// fix the editor never re-subscribed and live sync silently stopped working: no error, no
// banner, no visible difference from a file nobody has touched.
client.api.fs.watch(PATH)
client.api.fs.watch(OTHER)
ok('setup', '[1a] a watch on a live socket goes straight out', count('fs:watch', PATH) === 1)
ok('setup', '[1b] …and so does a second, different path', count('fs:watch', OTHER) === 1)

clearWire()
await reconnect()
ok('core', '[1c] after a reconnect the first path is re-armed', count('fs:watch', PATH) === 1,
   'nothing retained this message: it was DELIVERED. Only `watched` can bring it back')
ok('core', '[1d] …and so is the second', count('fs:watch', OTHER) === 1)
// Counts EVERY frame, not just the watches: the re-arm is a state re-SYNC, so two watches
// and nothing else is the whole of what a reconnect may put on the wire. An earlier version
// also asserted `count('fs:unwatch') === 0` separately; that is this assertion's remainder.
ok('core', '[1e] …exactly once each and nothing else — two frames, no more',
   wire().length === 2, `frames=${JSON.stringify(wire())}`)

// ── [2] WATCHES MUST NEVER BE QUEUED ──────────────────────────────────────────────────
// `send` outboxes anything it cannot deliver and flushes on connect. `sendLive` drops it.
// For a watch, dropping is correct and queuing is a LEAK: the outboxed fs:watch would be
// flushed on open AND the same path re-armed a moment later in the same handler — two
// watches against a socket that will only ever send one fs:unwatch, so the server's count
// never reaches zero and the watch outlives every editor that asked for it. Nothing on the
// client can cancel it.
const DOWN = '/root/queued.txt'
live().close()                                   // down: `ws` is null until the retry lands
clearWire()
client.api.fs.watch(DOWN)
// ★ [2a]/[2b] ARE TAGGED `setup`, NOT `core`, AND THE REASON IS MEASURED RATHER THAN
// ASSUMED. No mutation to `sendLive` can make them fail: `retry()` sets `ws = null` before
// anything else, so with no socket at all there is nothing for a broken send to send.
// Removing sendLive's readyState check entirely leaves both green (mutation C7, 17/0). They
// pin the state [2c] is measured FROM; they do not test the code that produces it. Calling
// that `core` would be claiming coverage this file does not have.
ok('setup', '[2a] a watch taken while the socket is DOWN puts nothing on the wire',
   count('fs:watch', DOWN) === 0)
ok('setup', '[2b] …and nothing else either', sent.length === 0, `frames=${JSON.stringify(wire())}`)

for (let i = 0; i < 60 && sockets[sockets.length - 1].readyState !== StubWS.CONNECTING; i++) await sleep(50)
live().open()
ok('core', '[2c] …and on reconnect it arrives EXACTLY ONCE, not once queued + once re-armed',
   count('fs:watch', DOWN) === 1, `count=${count('fs:watch', DOWN)}`)

// ── [3] ONE WATCH PER PATH PER SOCKET ─────────────────────────────────────────────────
// Two editors on one file each call watch/unwatch. The wire contract is one watch and one
// unwatch per path; the local refcount is what collapses the pair. Without it the re-arm
// (which can only send one per path) leaves the server's count below the unwatches that
// will follow.
const SHARED = '/root/shared.txt'
clearWire()
client.api.fs.watch(SHARED)
client.api.fs.watch(SHARED)
ok('core', '[3a] two editors on one path produce ONE fs:watch', count('fs:watch', SHARED) === 1,
   `count=${count('fs:watch', SHARED)}`)
client.api.fs.unwatch(SHARED)
ok('core', '[3b] the first editor closing sends NO unwatch — someone is still looking',
   count('fs:unwatch', SHARED) === 0)
clearWire()
await reconnect()
ok('core', '[3c] a reconnect while both hold it re-arms it once, not twice',
   count('fs:watch', SHARED) === 1, `count=${count('fs:watch', SHARED)}`)
clearWire()
client.api.fs.unwatch(SHARED)
ok('core', '[3d] the last editor closing sends the one fs:unwatch',
   count('fs:unwatch', SHARED) === 1)

// The mirror of [1c], and the one that catches a leak rather than a loss: once the count
// reaches zero the path must leave `watched` entirely, or every future reconnect re-arms a
// watch nobody holds and no unwatch will ever follow.
clearWire()
await reconnect()
ok('core', '[3e] a fully-unwatched path is NOT re-armed on the next reconnect',
   count('fs:watch', SHARED) === 0,
   'a path left in `watched` after its last unwatch is re-armed forever')

// An unwatch taken while the socket is down is moot for the same reason the re-arm is
// needed — the server released everything when the socket closed — but it must still
// clear `watched`, or the drop resurrects the watch on reconnect.
const DROPPED = '/root/dropped.txt'
client.api.fs.watch(DROPPED)
live().close()
client.api.fs.unwatch(DROPPED)                   // dropped on the floor, by design
for (let i = 0; i < 60 && sockets[sockets.length - 1].readyState !== StubWS.CONNECTING; i++) await sleep(50)
clearWire()
live().open()
ok('core', '[3f] a path unwatched DURING an outage is not resurrected by the reconnect',
   count('fs:watch', DROPPED) === 0, `frames=${JSON.stringify(wire())}`)

// Leave the client in a known state for part B: only the paths part A still holds.
client.api.fs.unwatch(PATH)
client.api.fs.unwatch(OTHER)
client.api.fs.unwatch(DOWN)
clearWire()
await reconnect()
ok('setup', '[3g] part A leaves no watches behind', count('fs:watch') === 0,
   `frames=${JSON.stringify(wire())}`)

if (process.env.QA_LS_CLIENT) {
  console.log('\n[note] QA_LS_CLIENT is set, so part B is SKIPPED: FileEditorView imports the')
  console.log('       real client module, not the copy, and would be watching a different')
  console.log('       socket than this harness drives. Client mutations are part-A-only.')
  done()
}

console.log('\n── part B: the editor (web/src/components/FileEditorView.tsx) ──────────────')

const chat: any = await import('../web/src/store/chat.tsx')
const editor: any = await import(EDITOR_MOD)
const { EditorView } = await import('@codemirror/view')

let host: any = null
let root: any = null

const settle = async (ms = 60): Promise<void> => { await act(async () => { await sleep(ms) }) }

const mount = async (path = PATH, sessionId?: string): Promise<void> => {
  host = w.document.createElement('div')
  w.document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(chat.ChatProvider, null,
      React.createElement(editor.FileEditorView, { path, sessionId })))
  })
  await settle()
}
const unmount = async (): Promise<void> => {
  await act(async () => { root.unmount() })
  host.remove()
}
const txt = (): string => host.textContent ?? ''
// ConfirmDialog renders through `createPortal` into document.body, OUTSIDE the mount host.
// A check scoped to `host` cannot see it — [5f] failed on exactly that before this existed,
// which is the good outcome: the trap cost one debug cycle rather than a false green.
const docTxt = (): string => w.document.body.textContent ?? ''
const cm = (): any => EditorView.findFromDOM(host.querySelector('.cm-editor'))
// Type into the real CodeMirror instance, so `dirty` is set the way a keystroke sets it
// rather than by reaching into the component's state.
const typeInto = async (text: string): Promise<void> => {
  const view = cm()
  await act(async () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }) })
  await settle()
}
const deliver = async (msg: unknown, ms = 60): Promise<void> => {
  await act(async () => { live().deliver(msg) })
  await settle(ms)
}
// Tolerates a missing target on purpose. Mutation E1 makes the editor silently discard the
// unsaved buffer, which REMOVES the banner these clicks aim at — and a `click(undefined)`
// that throws aborts the run, so the mutation would report a crash instead of the four reds
// it actually earns. A no-op here turns that into an ordinary failed assertion.
const click = async (el: any): Promise<void> => {
  if (!el) return
  await act(async () => { el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })) })
  await settle()
}
const byText = (s: string): any =>
  Array.from(host.querySelectorAll('button')).find((b: any) => (b.textContent ?? '').includes(s))
const staleBanner = (): boolean => txt().includes('Changed on disk since you started editing')
const goneBanner = (): boolean => txt().includes('was deleted on disk')
const dirtyDot = (): boolean => !!host.querySelector('[title="Unsaved changes"]')

// ── [4] CLEAN + fs:changed → take disk silently ───────────────────────────────────────
await mount()
ok('setup', '[4s] the editor mounted on the disk text', cm()?.state.doc.toString() === DISK)
ok('core', '[4a] mounting sends exactly one fs:watch for the open path',
   count('fs:watch', PATH) === 1 && count('fs:watch') === 1, `frames=${JSON.stringify(wire())}`)
DISK = 'someone else wrote this'
await deliver({ type: 'fs:changed', path: PATH })
ok('core', '[4b] a clean buffer takes the new disk text silently',
   cm()?.state.doc.toString() === DISK, `doc=${JSON.stringify(cm()?.state.doc.toString())}`)
ok('core', '[4c] …with no banner: nothing was at risk, so there is nothing to ask',
   !staleBanner() && !goneBanner())
ok('core', '[4d] …and the buffer is clean afterwards, not falsely dirty', !dirtyDot())
await unmount()

// ── [5] DIRTY + fs:changed → flag it, never clobber ───────────────────────────────────
// ★ THIS IS THE `dirtyRef` ASSERTION. The subscription is created once per path, so a
// handler that read the `dirty` STATE would capture `false` — the value at the moment the
// file was opened, which for the dirty flag is always false — and would take the "clean"
// branch forever. That is not a cosmetic difference: the clean branch REFRESHES, so
// reading state instead of the ref silently discards the user's unsaved work the moment
// anything touches the file on disk. [5a]-[5d] all redden under that mutation, and they
// are the reason the ref must not be "tidied" back into state.
DISK = 'baseline before editing'
await mount()
await typeInto('MY UNSAVED EDIT')
ok('setup', '[5s] the buffer is dirty', dirtyDot() && cm()?.state.doc.toString() === 'MY UNSAVED EDIT')
DISK = 'A RIVAL WROTE THIS'
const readsBefore5 = reads
await deliver({ type: 'fs:changed', path: PATH })
ok('core', '[5a] a dirty buffer gets the "changed on disk" banner', staleBanner())
ok('core', '[5b] …and the unsaved buffer is INTACT',
   cm()?.state.doc.toString() === 'MY UNSAVED EDIT', `doc=${JSON.stringify(cm()?.state.doc.toString())}`)
ok('core', '[5c] …the disk text was NOT applied', !txt().includes('A RIVAL WROTE THIS'))
ok('core', '[5d] …and no read was issued at all: it did not even try',
   reads === readsBefore5, `reads +${reads - readsBefore5}`)
await click(byText('Keep mine'))
ok('core', '[5e] "Keep mine" dismisses the banner and keeps the buffer',
   !staleBanner() && cm()?.state.doc.toString() === 'MY UNSAVED EDIT')
await deliver({ type: 'fs:changed', path: PATH })
await click(byText('Reload…'))
ok('core', '[5f] "Reload…" asks before discarding — it is not a one-click data loss',
   docTxt().includes('Discard unsaved changes?') && cm()?.state.doc.toString() === 'MY UNSAVED EDIT',
   `dialog=${docTxt().includes('Discard unsaved changes?')}`)
await unmount()

// ── [6] REVIEWING + fs:changed → do nothing at all ────────────────────────────────────
// ★ THIS IS THE `reviewingRef` ASSERTION, and the hazard is the same one that disables the
// ⟳ button: `applyDecision` reconstructs the accepted hunks against `baseText`, so swapping
// the file underneath a live diff decides hunks against a document the user never saw.
// A handler reading the `reviewing` state would capture `false` at subscribe time — review
// mode is never live on the first render, because it needs a proposal that has not arrived
// yet — so the mutation is not a corner case, it fails on every review.
DISK = 'hello disk'
await mount(PATH, 's1')
await deliver({
  type: 'session:permission', id: 's1',
  request: {
    requestId: 'r1', toolName: 'Edit', displayName: 'Edit', toolUseId: 't1', suggestions: [],
    input: { file_path: PATH, old_string: 'hello', new_string: 'HOWDY' },
  },
}, 140)
const reloadBtn = host.querySelector('[aria-label="Reload from disk"]')
ok('setup', '[6s] review mode is live — the ⟳ button is disabled for the same reason',
   reloadBtn?.disabled === true && txt().includes('Claude proposes changes'))
DISK = 'CHANGED UNDER REVIEW'
const readsBefore6 = reads
await deliver({ type: 'fs:changed', path: PATH })
ok('core', '[6a] mid-review, a disk change is IGNORED — no read is issued',
   reads === readsBefore6, `reads +${reads - readsBefore6}`)
ok('core', '[6b] …the diff still shows the base the user is deciding against',
   !txt().includes('CHANGED UNDER REVIEW'))
// ★ [6c] WAS INVERTED ON 2026-08-28, AND THE OLD VERSION WAS PINNING A BUG.
// It asserted `!staleBanner()` — that mid-review a disk change produces no banner at all.
// That encoded the brief this file was written from, and the brief was wrong: "do not
// refresh" and "do not remember" are different decisions, and only the first was ever
// argued for. Dropping the event outright means the review resolves, `reviewing` goes
// false, and nothing recalls that disk moved — so applyDecision reconstructs against a
// baseText disk has already passed, and the Save silently overwrites someone else's write.
// The tell that it was an oversight rather than a decision: `fs:removed` was never gated on
// `reviewing`, so a deletion notified mid-review while a modification did not.
// Now: the banner DOES appear (informing decides nothing), the refresh still does not
// (that is what [6a]/[6b] pin), and the Reload control is WITHHELD — offering it would hand
// the user the exact action the suppression exists to prevent.
ok('core', '[6c] …but the banner DOES appear: the change is recorded, not discarded',
   staleBanner() && !goneBanner())
ok('core', "[6d] …with Reload withheld — informing is safe mid-review, acting is not",
   !host.querySelector('button:not([aria-label])') || !txt().includes('Reload…'))
await unmount()

// ── [7] fs:removed → the in-memory copy is now the ONLY copy ──────────────────────────
DISK = 'about to be deleted'
await mount()
await typeInto('THE ONLY SURVIVING COPY')
DISK = ''                                        // as a read of a deleted file would come back
await deliver({ type: 'fs:removed', path: PATH })
ok('core', '[7a] a removal gets its own banner', goneBanner())
ok('core', '[7b] …and the buffer is KEPT — it is the only copy left',
   cm()?.state.doc.toString() === 'THE ONLY SURVIVING COPY',
   `doc=${JSON.stringify(cm()?.state.doc.toString())}`)
ok('core', '[7c] …nothing was re-read from a file that is gone',
   !txt().includes('about to be deleted'))
await unmount()

DISK = 'both banners fixture'
await mount()
await typeInto('EDITED THEN DELETED')
await deliver({ type: 'fs:changed', path: PATH })
ok('setup', '[7s] the stale banner is up', staleBanner())
await deliver({ type: 'fs:removed', path: PATH })
ok('core', '[7d] a removal SUPERSEDES the stale banner rather than stacking with it',
   goneBanner() && !staleBanner(),
   '"changed on disk" is not news once the file is gone, and two banners is not a choice')
await unmount()

// ── [8] NEGATIVE CONTROLS ─────────────────────────────────────────────────────────────
// `fs:changed` is broadcast to EVERY socket with no per-socket filtering — that is the
// hub's design, not an oversight — so the path comparison in the handler is the only thing
// standing between an unrelated file's write and this editor's buffer. It is load-bearing,
// not defensive, and deleting it must go red or nothing is guarding the door.
DISK = 'my own content'
await mount()
DISK = 'A DIFFERENT FILE CHANGED'
const readsBefore8 = reads
await deliver({ type: 'fs:changed', path: OTHER })
ok('core', '[8a] an fs:changed for a DIFFERENT path is ignored completely',
   reads === readsBefore8 && !txt().includes('A DIFFERENT FILE CHANGED'),
   `reads +${reads - readsBefore8}`)
await deliver({ type: 'fs:removed', path: OTHER })
ok('core', '[8b] …and so is an fs:removed for a different path', !goneBanner())

clearWire()
await unmount()
ok('core', '[8c] unmounting releases the watch', count('fs:unwatch', PATH) === 1,
   `frames=${JSON.stringify(wire())}`)
clearWire()
await reconnect()
ok('core', '[8d] …and the released path is not re-armed by a later reconnect',
   count('fs:watch') === 0, `frames=${JSON.stringify(wire())}`)

// The effect is keyed on `path`, so switching files inside one mounted tab has to swap the
// subscription. A `[]` dep list would leave the tab watching the file it opened with and
// listening for a path it no longer shows — live sync silently attached to the wrong file,
// which is the invisible failure again.
DISK = 'first file'
await mount()
clearWire()
await act(async () => {
  root.render(React.createElement(chat.ChatProvider, null,
    React.createElement(editor.FileEditorView, { path: OTHER })))
})
await settle()
ok('core', '[8e] switching the open path releases the old watch', count('fs:unwatch', PATH) === 1,
   `frames=${JSON.stringify(wire())}`)
ok('core', '[8f] …and takes one on the new path', count('fs:watch', OTHER) === 1)
DISK = 'THE NEW FILE CHANGED'
await deliver({ type: 'fs:changed', path: OTHER })
ok('core', '[8g] …and it is the NEW path the editor now follows',
   cm()?.state.doc.toString() === 'THE NEW FILE CHANGED',
   `doc=${JSON.stringify(cm()?.state.doc.toString())}`)
await unmount()

// A frame the client cannot parse must not take the socket down with it — every message
// after it would be lost, including the fs:changed this feature rides on.
await mount()
await act(async () => { live().onmessage?.({ data: 'not json {' }) })
await settle()
DISK = 'STILL LISTENING'
await deliver({ type: 'fs:changed', path: PATH })
ok('core', '[8h] a malformed frame does not deafen the socket to the next one',
   cm()?.state.doc.toString() === 'STILL LISTENING')
await unmount()

done()
