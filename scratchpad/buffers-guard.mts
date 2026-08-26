// UNSAVED-EDITOR-BUFFER GUARD — does a held buffer ever shadow a file that moved on disk?
//
//   npx tsx scratchpad/buffers-guard.mts
//
// GROUP C: no browser, no server, no ports, no CLI. Imports web/src/lib/buffers.ts directly
// and is fully interpretable regardless of what web/dist was built from.
//
// ── THE BUG THIS EXISTS FOR, and why it hid ──────────────────────────────────────────
// buffers.ts holds unsaved editor text keyed by PATH. On load the buffer was restored
// UNCONDITIONALLY, so once a path had a buffer it shadowed the real file for the rest of the
// app session. The operator reported it as "files open stale and don't record changes" — but
// nothing was ever failing to record: the new text was on disk the whole time and simply
// never displayed, which is why it read as a save bug rather than a load bug.
// Markdown made it fire WITH NO TYPING AT ALL. Milkdown re-normalizes on load and emits that
// document; dirty is `text !== disk`; so merely OPENING any .md file whose bytes were not
// already in Milkdown's normal form stored a buffer and poisoned that path. A plain-text file
// needed a real keystroke to reach the same state — which is the whole reason markdown looked
// like the broken format and everything else looked fine.
// FIXED by recording the disk text an edit was taken against (`base`) and restoring only
// while disk still equals it; when disk has moved, disk wins and the entry is dropped.
//
// ── WHY IT IS WORTH A REGISTERED SLOT (the registry is fail-closed; slots are not free) ──
//  · The failure is SILENT. A shadowed file throws nothing, logs nothing and renders happily.
//    There is no red anywhere else in the suite that this could ever produce.
//  · No other registered harness imports buffers.ts. `clearBuffers()` is exported with the
//    comment "for tests; nothing in the app needs it" — an export kept for a test that did
//    not exist is a promise nobody was keeping.
//  · It is the cheapest possible member: pure logic, ~0s, bucket 3.
//
// ── [hole] WHAT THIS DOES NOT COVER ──────────────────────────────────────────────────
// Everything above the module boundary. FileEditorView is what calls peekBuffer with fresh
// disk text (:66) and setBuffer with `loadedRef.current` as the base (:104); if a future edit
// passes the wrong baseline, or stops calling peek on load, buffers.ts stays correct and the
// editor breaks anyway. Nothing here can see a wrong baseline passed by a caller.
// The Milkdown normalize-on-load emit is SIMULATED here as "text !== disk on open"; nothing
// in this file runs Milkdown.
//
// ── FAILS-FIRST, and HOW it was taken (the method matters here) ──────────────────────
// Against the pre-fix implementation — a path-keyed buffer with no baseline, restored
// unconditionally — this file scores 5 passed / 3 failed: [3] and [4] red with their own
// predicted diagnostics ("the stale edit was restored on top of new disk content" and
// "peekBuffer compared but did not delete"), plus [6b]. Green as shipped: 8/0.
// (Both numbers were 9/0 and 5/4 until [7] was deleted along with the trap it documented —
// see the note where it stood. Re-measured after the deletion, not adjusted on paper.)
// ★ That mutation was run against a COPY of the module, not by editing web/src/lib/buffers.ts
//   in place, and deliberately so. The suite's bucket-1 banner is an MTIME comparison between
//   web/dist and every bundle input (all of web/ bar dist and node_modules, plus shared/src),
//   so touching any of them — even reverting byte-identically afterwards — flips eleven
//   harnesses to NO SIGNAL until someone rebuilds the bundle, and a rebuild is operator-gated.
//   A byte-identical revert does not restore an mtime. Note the asymmetry with the tree
//   fingerprint, which hashes CONTENT: the same revert is invisible to one and fatal to the
//   other, because they answer different questions ("did the tree move under the run?" vs
//   "was the bundle built after its inputs?").
//   Nothing is lost by using a copy: these assertions are pure functions of peekBuffer's
//   behaviour, and that this file is wired to the REAL module is proven by its green run.
import { peekBuffer, setBuffer, clearBuffers } from '../web/src/lib/buffers'

let passed = 0, failed = 0
const ok = (tag: string, name: string, cond: boolean, extra = ''): void => {
  cond ? passed++ : failed++
  console.log(`  ${cond ? '✅' : '❌'} [${tag}] ${name}${extra ? ` — ${extra}` : ''}`)
}

const P = '/proj/notes.md'
const DISK_A = '# Notes\n\nfirst version on disk\n'
const DISK_B = '# Notes\n\nSOMETHING ELSE WROTE THIS\n'
const EDITED = '# Notes\n\nfirst version on disk, plus my unsaved sentence\n'

clearBuffers()

// [1] The baseline mechanism: an unsaved edit survives the unmount a tab/session switch
// causes. If this ever goes red the feature is gone entirely, and [3]/[4] below would then
// be passing for the wrong reason — a buffer that is never stored also never shadows.
setBuffer(P, EDITED, DISK_A)
ok('core', '[1] an unsaved edit is restored while disk is unchanged',
  peekBuffer(P, DISK_A) === EDITED, `got ${JSON.stringify(String(peekBuffer(P, DISK_A)).slice(0, 30))}`)

// [2] Nothing held for a path nobody edited.
ok('core', '[2] a path with no buffer restores nothing',
  peekBuffer('/proj/untouched.txt', DISK_A) === undefined)

// [3] ★ THE FIX. Disk moved underneath the edit; the buffer must NOT be handed back.
const shadowed = peekBuffer(P, DISK_B)
ok('core', '[3] a buffer does NOT shadow a file that changed on disk',
  shadowed === undefined,
  shadowed === EDITED ? '← the stale edit was restored on top of new disk content: this is the reported bug' : '')

// [4] ★ …and the entry is DROPPED, not merely skipped. This is the check that separates the
// two implementations that both pass [3]: one that only COMPARES leaves the entry in place,
// so if disk ever returns to its old bytes — a git checkout back, an undo, a revert — the
// stale buffer springs back to life long after the user stopped thinking about it.
ok('core', '[4] …and the stale entry is dropped, so it cannot come back if disk returns',
  peekBuffer(P, DISK_A) === undefined,
  peekBuffer(P, DISK_A) === EDITED ? '← still held: peekBuffer compared but did not delete' : '')

// [5] The explicit drop (save, or typing back to the saved text).
clearBuffers()
setBuffer(P, EDITED, DISK_A)
setBuffer(P, null)
ok('core', '[5] setBuffer(path, null) drops the buffer', peekBuffer(P, DISK_A) === undefined)

// [6] The MARKDOWN case end to end, which is how the operator actually met this. Opening the
// file normalizes it, so a buffer is stored with NO user edit; the same file opened again
// must still show what is on disk once disk has moved.
clearBuffers()
const NORMALIZED = '# Notes\n\nfirst version on disk\n'   // Milkdown's emit differs from the bytes
const RAW = '#   Notes\n\nfirst version on disk'          // …because the file was not in normal form
setBuffer(P, NORMALIZED, RAW)                             // stored by merely opening it
ok('core', '[6a] opening a .md file out of normal form does hold a buffer (the trigger)',
  peekBuffer(P, RAW) === NORMALIZED)
ok('core', '[6b] …and that no-op buffer still cannot shadow a file that changed since',
  peekBuffer(P, DISK_B) === undefined)

// ── [7] WAS HERE, AND WAS DELETED WHEN THE TRAP IT DOCUMENTED WAS REMOVED ───────────
// It pinned `setBuffer(path, text, base = '')`: the default baseline could never match a
// non-empty file, so an entry stored that way was silently discarded and the unsaved text
// was gone with no error — the same silent-loss shape the fix existed to remove. The default
// is gone (`base: string` is required as of 2026-08-26) and the check went with it, exactly
// as its own note instructed, rather than being "updated" into something that outlived its
// subject. ★ It could not simply have been left: tsx transpiles without typechecking, so the
// two-argument call would still RUN and still PASS, testing a call nobody can write any more
// — a green with no subject, which is the one thing this file exists to argue against.

// [8] clearBuffers really clears — everything above depends on it to isolate its cases, so
// an assertion that it works is load-bearing for the file rather than a courtesy.
setBuffer('/a', 'x', 'ax'); setBuffer('/b', 'y', 'by')
clearBuffers()
ok('core', '[8] clearBuffers drops every path',
  peekBuffer('/a', 'ax') === undefined && peekBuffer('/b', 'by') === undefined)

console.log(`\n${passed} passed / ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
