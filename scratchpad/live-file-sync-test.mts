// LIVE FILE SYNC — does the server actually notice a file moving on disk?
//
//   npx tsx scratchpad/live-file-sync-test.mts
//
// GROUP C: no browser, no server, no ports. Drives `FileWatchRegistry` directly against a
// real tmpdir, because the thing under test IS the filesystem interaction — a fake fs would
// test the mock, and the two assertions that earn this file ([2] and [6]) are precisely the
// ones a mock cannot pose.
//
// ── WHAT THIS COVERS THAT NOTHING ELSE DOES ──────────────────────────────────────────
// Before this, an .ipynb open in the app followed the file on disk and a .md or .ts did
// not — it sat frozen until someone thought to press ⟳. The registry is the missing signal.
// Two of the six checks are the reason the file exists at all:
//   [2] TEMP+RENAME. Watching the file inode passes every other check here and fails this
//       one — and temp+rename is not exotic, it is what Claude's own Write tool, `git
//       checkout` and most editors do. It is the difference between working in a test and
//       working on the thing the user actually hit.
//   [6] NEGATIVE CONTROL. A registry that broadcasts on EVERY event in the watched
//       directory passes [1]-[5] and is useless. Without [6] this file would be green for
//       an implementation that fires on every sibling save in the same folder.
//
// ── [hole] WHAT IT DOES NOT COVER ────────────────────────────────────────────────────
// The client half. Whether FileEditorView applies a change when clean, banners when dirty,
// and does NOTHING mid-review is scratchpad/editor-refresh-check.mjs's job. This file stops
// at "the right event was emitted for the right path"; it cannot see what the editor does
// with it. Also uncovered: the MAX_WATCHES cap (asserting it needs 128 real inotify
// watches, which costs more than it proves) and the hub/socket wiring — `release()` is
// exercised here directly, but that `hub.onClose` actually calls it is not.
import { mkdtemp, writeFile, rename, unlink, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { FileWatchRegistry, type WatchEvent } from '../server/src/fs/fileWatchRegistry'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, extra = ''): void => {
  cond ? pass++ : fail++
  console.log(`  ${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}`)
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Comfortably above the registry's 50ms debounce. inotify delivery is not instant and a
// tight budget here would make this file flaky for reasons that have nothing to do with the
// code — a flaky guard gets muted, and a muted guard is worse than none.
const SETTLE = 400

const events: WatchEvent[] = []
const reg = new FileWatchRegistry((e) => events.push(e))
const drain = (): WatchEvent[] => events.splice(0, events.length)

const dir = await mkdtemp(path.join(tmpdir(), 'live-sync-'))
const target = path.join(dir, 'doc.md')
const sibling = path.join(dir, 'other.md')
await writeFile(target, 'original\n')
await writeFile(sibling, 'sibling\n')

// Two stand-ins for sockets. The registry keys refcounts by holder identity, so these only
// have to be distinct objects.
const tabA = {}, tabB = {}

try {
  reg.watch(target, tabA)
  await wait(150)

  // ── [0] PRECONDITION ──────────────────────────────────────────────────────────────
  // If inotify is unavailable (some containers, some filesystems) NOTHING below can work,
  // and reporting six failures would be a probe blaming the app for a missing prerequisite.
  // Establish that the mechanism fires at all before asserting anything about its shape.
  drain()
  await writeFile(target, 'first change\n')
  await wait(SETTLE)
  const alive = drain()
  if (alive.length === 0) {
    console.log('\n[skip] the filesystem produced no watch events at all — inotify is unavailable here,')
    console.log('   so nothing below is measurable. This is a missing prerequisite, not a failure.')
    await rm(dir, { recursive: true, force: true })
    process.exit(77)
  }
  ok('[0] PRECONDITION: a plain write reaches the registry', alive.length > 0)
  // [1] and the debounce: ONE event, not one per inotify wakeup. A save fans out several.
  ok('[1] a single write produces exactly ONE fs:changed (the debounce coalesces)',
    alive.length === 1 && alive[0].kind === 'changed' && alive[0].path === target,
    `got ${JSON.stringify(alive.map((e) => e.kind))}`)

  // ── [2] ★ TEMP + RENAME — the assertion that earns this file ───────────────────────
  const tmp = path.join(dir, '.doc.md.tmp')
  await writeFile(tmp, 'replaced by swap\n')
  await rename(tmp, target)
  await wait(SETTLE)
  const swapped = drain()
  ok('[2a] a temp+rename swap reports fs:changed',
    swapped.some((e) => e.kind === 'changed' && e.path === target),
    `got ${JSON.stringify(swapped.map((e) => e.kind))}`)
  // ★ [2b] IS THE ONE THAT ACTUALLY CATCHES AN INODE WATCH, and [2a] is not — measured,
  // not assumed. This file originally claimed [2a] was the check that earned it. It is not:
  // an inode watcher STILL SEES the rename that replaces it (the event reaches the old
  // inode on its way out), so [2a] stays green under that mutation. What an inode watcher
  // loses is everything AFTERWARDS — it is left holding a replaced inode nothing will ever
  // write to again. So the honest assertion is not "the swap fired" but "the file is still
  // being watched once the swap is done", which is what a user experiences: their editor
  // goes quietly dead after the first `git checkout`.
  drain()
  await writeFile(target, 'written after the swap\n')
  await wait(SETTLE)
  const afterSwap = drain()
  ok('[2b] …and the file is STILL watched afterwards (a write after the swap fires)',
    afterSwap.some((e) => e.kind === 'changed' && e.path === target),
    afterSwap.length ? `got ${JSON.stringify(afterSwap.map((e) => e.kind))}`
      : '← stranded on the replaced inode: this is what watching the file instead of the directory costs, and it is silent')

  // ── [6] NEGATIVE CONTROL, run early so a broken filter cannot be masked ────────────
  // Deliberately NOT last: an implementation that fires on every directory event would
  // otherwise have its noise absorbed by the drains above and only show up at the end.
  await writeFile(sibling, 'sibling changed\n')
  await wait(SETTLE)
  const noise = drain()
  ok('[6] NEGATIVE CONTROL: a sibling file in the SAME directory emits nothing',
    noise.length === 0,
    noise.length ? `← fired ${JSON.stringify(noise.map((e) => path.basename(e.path)))}: the basename filter is not holding, so every save in the folder is a false change` : '')

  // ── [4] REFCOUNT: two holders, one releases, the other keeps its events ────────────
  reg.watch(target, tabB)
  ok('[4a] two holders on one path share ONE real watcher', reg.activeCount() === 1, `activeCount=${reg.activeCount()}`)
  reg.unwatch(target, tabA)
  await writeFile(target, 'after A left\n')
  await wait(SETTLE)
  ok('[4b] after one holder unwatches, the other still receives events',
    drain().some((e) => e.kind === 'changed'),
    '← a naive map makes closing either of two tabs go blind in the other')

  // ── The double-watch case: a remount or a reconnect re-subscribes the same path ────
  // Per-socket refcounting is what makes this releasable; a single shared integer would
  // leave a permanent +1 that no unwatch could ever cancel.
  reg.watch(target, tabB)          // tabB now holds it twice
  reg.unwatch(target, tabB)
  ok('[4c] a holder that watched twice still holds the path after ONE unwatch',
    reg.activeCount() === 1, `activeCount=${reg.activeCount()}`)

  // ── [3] REMOVED ───────────────────────────────────────────────────────────────────
  drain()
  await unlink(target)
  await wait(SETTLE)
  const removed = drain()
  ok('[3] deleting the file reports fs:removed, not fs:changed',
    removed.some((e) => e.kind === 'removed' && e.path === target),
    `got ${JSON.stringify(removed.map((e) => e.kind))}`)

  // ── [5] LAST UNWATCH CLOSES THE WATCHER ───────────────────────────────────────────
  reg.unwatch(target, tabB)        // second of tabB's two
  ok('[5a] the last unwatch disposes the real watcher', reg.activeCount() === 0, `activeCount=${reg.activeCount()}`)
  drain()
  await writeFile(target, 'nobody is listening\n')
  await wait(SETTLE)
  ok('[5b] …and no further events arrive for it (a closed tab stops costing)',
    drain().length === 0)

  // ── release(): every path a socket held, dropped at once ───────────────────────────
  reg.watch(target, tabA)
  reg.watch(sibling, tabA)
  const held = reg.activeCount()
  reg.release(tabA)
  ok('[7] release(holder) drops every path that holder was watching',
    held === 2 && reg.activeCount() === 0, `held=${held} after=${reg.activeCount()}`)
} finally {
  reg.release(tabA); reg.release(tabB)
  await rm(dir, { recursive: true, force: true })
}

console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
