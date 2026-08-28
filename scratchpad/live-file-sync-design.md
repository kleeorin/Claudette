# Live file sync — md/code editors get what notebooks already have

_Written 2026-08-27 by the coordinator, from a read of the tree. Nothing here is built yet._
_Hand this file over intact; it needs no re-derivation._

## The ask

"Can we have changes to md files or code files be live, like we have with notebooks?"

Today they are not, and the asymmetry is stark:

| | `.ipynb` | `.md` / `.ts` / anything else |
|---|---|---|
| server holds the doc | yes (`NotebookDocManager`) | no — the client owns the buffer |
| watches the file | yes (`startWatch`) | **no** |
| external edit while clean | reparses, broadcasts, view follows | **nothing happens** |
| external edit while dirty | `doc.conflict = true`, user resolves | **nothing happens** |
| how you find out | you don't have to | you press ⟳, if you think to |

`FileEditorView` grew a manual ⟳ refresh in `de93f12` (with a discard-confirm when dirty).
That commit is most of the work already: **the live version is "call what the ⟳ button calls,
when the file changes and the buffer is clean."** What is missing is only the signal.

## The shape to copy

`server/src/notebook/notebookDocManager.ts` already solved every hard part of this, and the
solutions are non-obvious enough that they should be COPIED rather than re-derived:

1. **Watch the DIRECTORY, filter by basename** (`startWatch`). Watching the file inode loses
   the file the moment anything does a temp+rename swap — which is exactly what Claude's Write
   tool, `git checkout`, and most editors do. This is the difference between "works in my test"
   and "works on the thing the user actually hit".
2. **Attach an `error` listener to every `FSWatcher`.** The `try/catch` around `watch()` covers
   only the synchronous call. An `'error'` emitted later (inotify watch removed, EPERM, the dir
   unmounted) **with no listener is an uncaught exception that kills the process** — every
   session, pty and kernel with it. Degrade to "no external-change detection for this file".
   The notebook manager carries a five-line comment saying so; it was learned, not guessed.
3. **Debounce ~50ms per path.** One save fans out several inotify events.
4. **Clean → apply silently. Dirty → flag a conflict and let the user choose.** Never clobber
   an unsaved buffer, never silently discard disk. This is `onDiskChange` verbatim.

## Design

### 1. Wire protocol (`shared/src/types.ts`)

Client → server, on editor mount / unmount:
```ts
| { type: 'fs:watch';   path: string }
| { type: 'fs:unwatch'; path: string }
```
Server → client:
```ts
| { type: 'fs:changed'; path: string }
| { type: 'fs:removed'; path: string }
```

**`fs:changed` deliberately carries NO content.** The client re-reads through the existing
`GET /api/fs/read`, which already owns the kind/truncation/binary/data-url logic. Putting text
on the socket means a second implementation of `readPreview`, and the second one is the one that
drifts. The cost is one round trip per external change, which is nothing.

`WsHub.broadcast` fans out to every socket with no per-socket filtering (single-user app, and
the hub says so). That is fine here: a tab that is not showing `path` ignores the message.

### 2. `server/src/fs/fileWatchRegistry.ts` (new)

Refcounted, keyed by resolved absolute path:

- `watch(path)` / `unwatch(path)` — refcount up/down; the last `unwatch` closes the `FSWatcher`.
  Refcounting matters because the same file is routinely open in two tabs, and a naive map
  makes closing either tab go blind in the other.
- Per path: one dir watcher + basename filter + 50ms debounce + the `error` listener (§2 above).
- On fire: `stat` the path. Gone → `fs:removed`. Present → `fs:changed`.
- **Cap the number of live watchers** (suggest 128) and log a refusal when the cap is hit.
  inotify watches are a finite system resource; a file manager that walks a big tree should not
  be able to exhaust them silently. A cap that is never logged is a cap nobody can debug.
- Drop everything on socket close, or an abandoned tab leaks a watcher forever. **The hub does
  not currently track per-socket state** — this is the one piece with no existing precedent to
  copy, so it is the piece most likely to be got wrong. Either give `WsHub` an
  `onClose(ws, cb)`, or key the registry by socket. Pick one deliberately and say which.

### 3. Bridge (`server/src/fs/fsApi.ts` or wherever the `session:activePane` handler lives)

`hub.broadcast({ type: 'fs:changed', path })`. Mirrors `notebookApi.ts`'s five-line bridge.

### 4. `web/src/components/FileEditorView.tsx`

On mount / `path` change: `api.fs.watch(path)`; on unmount: `unwatch`. On `fs:changed` for
**this** path:

- `reviewing` (a proposal diff is on screen) → **do nothing**. `de93f12` already disables ⟳
  mid-review because `applyDecision` decides hunks against `baseText`; swapping the file under
  that decides hunks against a document the user never saw. Live sync must obey the same rule —
  it is the same hazard arriving by a different door.
- clean → `void doRefresh()`. It already replaces the whole preview (not just `.text`, so a
  `truncated` flip is honest), drops the unsaved buffer, and keeps scroll position via
  `scrollKey`. Nothing new to write.
- dirty → set `staleOnDisk`, render the notebook's conflict affordance: *"Changed on disk"* +
  **Reload (discards your edits)** / **Keep mine**. Do NOT auto-open the existing confirm
  dialog — a modal that appears because a background process touched a file is a modal that
  appears while you are typing.

`fs:removed` → a banner, and keep the buffer. A deleted file with unsaved edits is the one case
where the buffer is the only surviving copy.

**Echo suppression needs no server flag.** The editor's own Save writes through
`/api/fs/write`, the watcher fires, the client re-reads and gets text identical to `loaded` →
`doRefresh` is a no-op and `dirty` was already false. Content comparison beats an mtime or a
`writing` flag here because it is correct even when someone else's write lands in the same
debounce window. (`FilePreview` carries no mtime, and this design deliberately does not add one.)

## Security

`/api/fs/*` is **operator-scoped, not session-scoped** — it is the operator's own file browser,
guarded by the auth cookie plus the `Sec-Fetch-Site` CSRF hook, with no per-session containment.
A watch is therefore exactly as privileged as the `GET /api/fs/read` next to it, and needs no new
containment layer. **State this in the code**: the next reader will assume a path-taking API must
be confined, and will either add a redundant check or, worse, conclude the missing one is a bug.

What a watch *does* add is an existence-and-timing oracle for paths the operator never opened —
`fs:watch` on a path is answerable even if reading it would fail. That is within the operator's
own authority, so it is not an escalation; it is worth one sentence in the header so the
judgement is on the record rather than merely implied.

## Verification

`scratchpad/` convention: own asserts, own exit code, SKIP over FAIL for a missing prerequisite.

- `live-file-sync-test.mts` — drive `fileWatchRegistry` against a real tmpdir:
  1. plain `writeFile` → one `fs:changed` (not three — proves the debounce)
  2. **temp + rename swap → `fs:changed`, AND a write after the swap still fires.**
     ⚠ CORRECTED 2026-08-28, after the mutation was actually run: this file originally said
     the swap itself is what catches a naive inode watch. **It is not.** An inode watcher
     still sees the rename that replaces it — the event reaches the old inode on its way
     out — so that assertion stays GREEN under an inode-watching mutation. What an inode
     watch loses is *everything afterwards*: it is left holding a replaced inode nothing
     will ever write to again. So the pair is the assertion, and the second half is the one
     that reds. It is also the truer description of the bug: the editor does not fail
     loudly at `git checkout`, it goes quietly dead after it.
  3. `unlink` → `fs:removed`
  4. refcount: two watchers, one unwatch, the other still gets events
  5. last unwatch → no further events (proves the close, and that a closed tab stops costing)
  6. **NEGATIVE CONTROL:** a sibling file in the same watched directory produces **nothing**.
     Without this, a registry that broadcasts on every directory event passes 1–5.
- Editor half: extend `scratchpad/editor-refresh-check.mjs` rather than starting a new file —
  it already models `FileEditorView`'s refresh states, and the live path is a new trigger for
  the transition it already checks. Add: clean+changed → text updates, no dialog; dirty+changed
  → banner, buffer intact, disk NOT applied; reviewing+changed → nothing at all.
- State the mutation result in the commit message, as `de93f12` did. A guard whose red has never
  been seen is a guard nobody has tested.

## Out of scope, deliberately

- **The file tree** (`FileManager`) reacting to creates/deletes/renames. Same registry, one
  directory-level message; a natural follow-on, but a different surface and a different test.
- **Diff/proposal review.** Excluded by §4 above, on purpose, and it should stay excluded.
- **Multi-writer merge.** "Clean → take disk, dirty → ask" is the whole conflict model, and it
  is the one notebooks already use. Anything cleverer needs a reason nobody has yet.

## Who can build it

`shared/src` and `server/src` are read-only to every session except **Landing** — verified by
`touch`, which returns `Read-only file system`. `web/src` is writable more widely. The client
half is **inert without the server half** (no `fs:changed` ever arrives, and the editor behaves
exactly as it does today), so the order is safe either way — but the `WsServerMessage` union
lives in `shared/src`, so the client cannot even typecheck its new case until Landing has landed
the types. **`shared/src` first, then either half.**
