import { watch, type FSWatcher } from 'fs'
import { stat } from 'fs/promises'
import path from 'path'

// Watches files the operator has open in an editor, so an external change (Claude's own
// Write tool, a `git checkout`, another device) reaches the view instead of sitting on disk
// until someone thinks to press ⟳. Notebooks have had this since NotebookDocManager;
// everything else did not, and the asymmetry was the whole of the user's request.
//
// ── SCOPE: OPERATOR, NOT SESSION. Read this before adding a containment check. ────────
// The `/api/fs/*` routes this shadows are the operator's own file browser — auth cookie
// plus the Sec-Fetch-Site CSRF hook, no per-session confinement anywhere. A watch is
// exactly as privileged as the `GET /api/fs/read` beside it, so it needs no new layer.
// Stated here because the next reader will assume a path-taking API must be confined and
// will otherwise add a redundant check, or conclude the missing one is a bug.
// What a watch DOES add is an existence-and-timing oracle: `fs:watch` on a path is
// answerable even when reading it would fail. That is within the operator's own authority
// so it is not an escalation — recorded so the judgement is on the record, not implied.
//
// ── THREE THINGS COPIED FROM NotebookDocManager.startWatch, NOT RE-DERIVED ────────────
// 1. Watch the DIRECTORY and filter by basename. Watching the file inode loses the file
//    the instant anything does a temp+rename swap — which is what Claude's Write tool,
//    `git checkout` and most editors actually do. This is the difference between working
//    in a test and working on the thing the user hit.
// 2. Attach an 'error' listener to EVERY FSWatcher. The try/catch covers only the
//    synchronous watch() call; an 'error' emitted later (inotify watch removed, EPERM,
//    directory unmounted) with no listener is an uncaught exception that takes the whole
//    process down — every session, pty and kernel with it. Degrade to "no external-change
//    detection for this path" instead. That comment is scar tissue over there; it is
//    cheaper to inherit it than to re-learn it.
// 3. Debounce ~50ms per path: one save fans out several inotify events.
const DEBOUNCE_MS = 50

// inotify watches are a finite system resource. A file manager walking a big tree must not
// be able to exhaust them silently, so refuse past a cap AND SAY SO — a cap that is never
// logged is a cap nobody can debug, and the symptom (some files quietly stop being live)
// is indistinguishable from the feature being broken.
const MAX_WATCHES = 128

export type WatchEvent = { kind: 'changed' | 'removed'; path: string }

interface Entry {
  watcher: FSWatcher | undefined
  debounce: NodeJS.Timeout | undefined
  // Refcount PER SOCKET, not a single total. See the cleanup note below.
  holders: Map<object, number>
}

export class FileWatchRegistry {
  private entries = new Map<string, Entry>()

  constructor(private readonly emit: (e: WatchEvent) => void) {}

  // ── CLEANUP ON SOCKET CLOSE — the one piece with no precedent to copy ───────────────
  // The design offered two options: give WsHub an onClose hook, or key the registry by
  // socket. They are not alternatives, and picking only one is why this is the piece most
  // likely to be got wrong: to release a socket's watches you need BOTH the set of paths
  // it holds (so you know what to release) AND a close notification (so you know when).
  // Option B supplies only the first. So: WsHub gained a minimal onClose, and the refcount
  // here is keyed by socket rather than being a single integer.
  //
  // Keying by socket also fixes a case neither option names on its own: a tab that sends
  // `fs:watch` twice for one path — a remount, a re-subscribe after reconnect — must not
  // leave a permanent +1 that no `fs:unwatch` can ever cancel. With a per-socket count,
  // release(socket) drops exactly what that socket held, whatever it did to get there.
  watch(p: string, holder: object): void {
    const key = path.resolve(p)
    const existing = this.entries.get(key)
    if (existing) {
      existing.holders.set(holder, (existing.holders.get(holder) ?? 0) + 1)
      return
    }
    if (this.entries.size >= MAX_WATCHES) {
      console.warn(`[fs-watch] refusing to watch ${key}: at the ${MAX_WATCHES}-watch cap. `
        + 'External-change detection is off for this file; close some editors or raise MAX_WATCHES.')
      return
    }
    const entry: Entry = { watcher: undefined, debounce: undefined, holders: new Map([[holder, 1]]) }
    this.entries.set(key, entry)
    this.start(key, entry)
  }

  unwatch(p: string, holder: object): void {
    const key = path.resolve(p)
    const entry = this.entries.get(key)
    if (!entry) return
    const n = entry.holders.get(holder)
    if (n === undefined) return
    if (n > 1) { entry.holders.set(holder, n - 1); return }
    entry.holders.delete(holder)
    if (entry.holders.size === 0) this.dispose(key, entry)
  }

  // Every path a socket held, released at once. Without this an abandoned tab leaks its
  // inotify watch for the life of the process.
  release(holder: object): void {
    for (const [key, entry] of [...this.entries]) {
      if (!entry.holders.delete(holder)) continue
      if (entry.holders.size === 0) this.dispose(key, entry)
    }
  }

  // Exposed for the harness: how many real watchers are live. A refcount bug is invisible
  // from the outside otherwise — the events keep arriving either way, and the leak only
  // shows up as an inotify exhaustion hours later on someone else's machine.
  activeCount(): number { return this.entries.size }

  private start(key: string, entry: Entry): void {
    const dir = path.dirname(key)
    const base = path.basename(key)
    try {
      entry.watcher = watch(dir, (_event, filename) => {
        // A directory watch sees every sibling. Filtering by basename here is what stops
        // this from broadcasting on unrelated files — the negative control in
        // scratchpad/live-file-sync-test.mts exists precisely to keep this line honest.
        if (filename && filename.toString() !== base) return
        clearTimeout(entry.debounce)
        entry.debounce = setTimeout(() => { void this.fire(key) }, DEBOUNCE_MS)
      })
      entry.watcher.on('error', () => { entry.watcher?.close(); entry.watcher = undefined })
    } catch {
      // Best effort, exactly as the notebook manager treats it: a missing or unreadable
      // directory means no external-change detection for this path, not a failed request.
    }
  }

  private async fire(key: string): Promise<void> {
    if (!this.entries.has(key)) return          // unwatched while the debounce was pending
    // stat rather than trusting the event: a rename swap arrives as 'rename' whether the
    // file appeared or vanished, so the event name cannot tell changed from removed.
    let gone = false
    try { await stat(key) } catch { gone = true }
    this.emit({ kind: gone ? 'removed' : 'changed', path: key })
  }

  private dispose(key: string, entry: Entry): void {
    entry.watcher?.close()
    if (entry.debounce) clearTimeout(entry.debounce)   // a pending fire would emit for a path nobody holds
    this.entries.delete(key)
  }
}
