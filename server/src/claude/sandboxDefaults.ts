import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, statSync } from 'fs'
import path from 'path'
import { dataDir } from '../util/dataDir'
import { errMessage } from '../util/errMessage'
import type { SandboxDefaultFolder } from '@claudette/shared'

// The operator's standing list of favourite folders: the shortcuts every session's sandbox
// editor offers as one-click mounts, so a folder they mount constantly is one tick rather
// than a walk through the picker.
//
// The list is INERT by design — nothing here is mounted into any session on its own, not on
// create and not on restore. An entry only ever becomes a mount when the operator ticks it
// in a specific session's editor, which still goes through the auth-gated setSandbox route
// and normalizeSandbox. See SandboxDefaultFolder in shared/src/types.ts.
//
// That claim is checkable by REACHABILITY, not by inspection, which is the form worth relying
// on: the only server-side importer of this module anywhere is index.ts, and it imports the
// route registrar. `sessionManager.ts` never imports it at all, so no create or restore path
// can consult the list whatever those functions do internally. State it that way — "I read
// restore() and it does not seed" goes stale the moment someone edits restore(), whereas a
// grep for importers of this file cannot go stale silently. If that grep ever returns
// sessionManager, this comment is the thing that was wrong, and the trust gate discussed in
// SandboxDefaultFolder becomes required.
//
// WHY IT LIVES IN dataDir(): dataDir() is ~/.config/claudette, which is never bind-mounted
// into a session sandbox (see util/dataDir.ts) — unlike ~/.claude, which every box binds rw.
// A confined session therefore cannot plant a path into the operator's own one-click menu
// and wait for it to be ticked. The list being inert means that would only be a suggestion
// rather than a grant, but a menu the box can write is still a menu the operator did not
// write, and there is no reason to accept it.
//
// Written 0600 and via tmp+rename, matching connectors/connectorStore.ts: a crash mid-write
// must not leave a truncated file behind.

interface Defaults {
  folders: SandboxDefaultFolder[]
}

// A list past this is not a shortcut menu any more, and unbounded growth is one bad client
// loop away. Refused loudly rather than silently trimmed.
const MAX_FOLDERS = 50

const file = (): string => path.join(dataDir(), 'sandbox-defaults.json')

let cache: Defaults | null = null

// The type guard the rest of this module's invariants rest on. Everything downstream — the
// `normalise()` calls in save/remove, and the UI's own prettyPath() — treats `path` as a
// string because the SAVE path guarantees it. Nothing guaranteed it on the LOAD path, so a
// hand edit or a half-written older schema put a row of any shape into circulation: save
// threw ERR_INVALID_ARG_TYPE out of path.resolve (a 500 whose message says "paths[0]" and
// never mentions this file), and list handed it to the client, where a .replace on a number
// throws inside React's render and white-screens the whole sandbox editor.
//
// It belongs HERE and not in those callers: "a row is well-formed" is a property of the
// list, so it is checked once at the edge where untrusted bytes become rows, rather than
// re-defended at every place that reads one.
//
// It must restore EVERY invariant the save path establishes, not just the one whose absence
// happened to throw. saveDefaultFolder guarantees three things — a string, non-empty after
// trim, and absolute — and an earlier version of this guard checked only string-ness, which
// left the other two silently reachable by exactly the hand edit this guard exists for:
//   * `{path:""}`   — `path.resolve('')` returns the SERVER'S OWN CWD, so the row compared
//                     equal to the install directory in the upsert scan below.
//   * `{path:"docs"}` — renders in the UI as `docs` but names `<server cwd>/docs`, a
//                     different directory from the one displayed.
// A guard that restores a subset of the invariants its callers assume is worse than no guard,
// because the survivors look validated.
function isFolder(x: unknown): x is SandboxDefaultFolder {
  if (!x || typeof x !== 'object') return false
  const r = x as { path?: unknown; mode?: unknown }
  if (typeof r.path !== 'string' || !r.path.trim()) return false
  if (!path.isAbsolute(r.path.trim())) return false
  return r.mode === 'rw' || r.mode === 'ro'
}

function load(): Defaults {
  if (cache) return cache
  try {
    const p = file()
    if (!existsSync(p)) return (cache = { folders: [] })
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<Defaults>
    const raw: unknown[] = Array.isArray(parsed.folders) ? parsed.folders : []
    // VALIDATE, THEN CANONICALISE. isFolder only checks a row is well-formed; a well-formed
    // `/a/b/` or `/a/c/../b` passes every one of its tests and used to reach the client raw,
    // where the editor unions it against canonical MOUNT paths by string equality — the
    // phantom-duplicate-row bug, arriving through the load path instead of the save path.
    // The save path has always normalised, so this is the same rule applied at the other door,
    // which is the one isFolder's own comment identifies as where a hand edit lands.
    const folders = raw.filter(isFolder).map((f) => ({ ...f, path: normalise(f.path) }))
    // Drop the BAD ROWS, not the whole list. Losing one shortcut beats losing all fifty to a
    // single mistyped entry, and it self-heals: the next persist() writes back only the rows
    // that survived here. Loud about the count, for the same reason the catch below is loud —
    // this is where a hand edit actually lands, and a silently shorter menu reads as a bug in
    // the UI rather than as a file that needs looking at.
    if (folders.length !== raw.length) {
      console.warn(`[sandbox-defaults] dropped ${raw.length - folders.length} malformed row(s) from `
        + 'sandbox-defaults.json — each needs a string `path` and a `mode` of "rw" or "ro". '
        + 'The remaining folders are unaffected, and saving anything will rewrite the file without them.')
    }
    cache = { folders }
    return cache
  } catch (e) {
    // A corrupt list must not take the server down. Starting empty here is genuinely
    // recoverable, unlike the connector catalog: nothing is granted or revoked by this file,
    // so the whole cost is that the operator's shortcut buttons are missing.
    //
    // But "recoverable" was a claim the code did not honour, and the two remedies this comment
    // used to offer were mutually exclusive. Starting empty caches `{folders: []}`, so the very
    // next saveDefaultFolder — the reflex of someone whose buttons have just vanished — loads
    // that empty list and persist()s it straight over the corrupt file. The first remedy
    // destroyed the bytes the second one needed, before anyone had read the log. So MOVE the
    // file aside first: recovery stops depending on the operator reacting faster than their own
    // next click.
    //
    // Note the contrast with the malformed-ROW path above, which is deliberately self-healing
    // and says so. That is a considered choice about rows we can prove are junk. This branch
    // inherited the same overwrite without ever asking for it — here the file is not junk, it
    // is unparseable, which is exactly the case where the bytes are worth keeping.
    //
    // NB this catch only fires when the file will not PARSE. A file that parses fine but holds
    // a row of the wrong shape — much the likelier corruption — never reaches here; it is
    // handled by the isFolder filter above.
    const p = file()
    let kept = ''
    try {
      if (existsSync(p)) {
        // A UNIQUE name per corruption. `${p}.corrupt` alone would have the second corruption
        // silently discard the copy the first one preserved — which is precisely the failure
        // this branch exists to prevent, reintroduced one level along. mtime-based rather than
        // Date.now() so the suffix describes the FILE being saved rather than the moment it
        // happened to be noticed, and a counter breaks the tie if two land in the same second.
        let dest = `${p}.${Math.floor(statSync(p).mtimeMs)}.corrupt`
        for (let n = 2; existsSync(dest); n++) dest = `${p}.${Math.floor(statSync(p).mtimeMs)}-${n}.corrupt`
        renameSync(p, dest)
        kept = ` The unreadable file has been kept as ${dest}.`
      }
    } catch (moveErr) {
      // Best-effort. If it cannot be moved we still start empty rather than failing to boot —
      // but say so, because in that case the next save DOES overwrite it and the operator has
      // only until then to copy it by hand.
      kept = ` It could NOT be moved aside (${errMessage(moveErr)}), so the next save will overwrite it — copy it now if you want it.`
    }
    console.error(`[sandbox-defaults] could not read the folder list, starting empty: ${errMessage(e)}.${kept}`)
    return (cache = { folders: [] })
  }
}

function persist(d: Defaults): void {
  const p = file()
  const tmp = `${p}.tmp`
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)   // explicit: a pre-existing tmp would keep its old mode
  renameSync(tmp, p)
  cache = d
}

// THE canonical form for a stored path — the single RULE, applied at every door rather than
// at a single door. path.resolve strips a trailing slash and collapses `..`, so `/a/b`,
// `/a/b/` and `/a/c/../b` are one entry rather than three, which matters because the
// dedupe/upsert below is a string equality test on the result.
//
// It used to say "the one place a path becomes comparable", and that stopped being true the
// moment load() started canonicalising too — which it must, because a hand-edited file is a
// second entrance for paths that then meet canonical mount paths in the editor's union. Every
// path this module hands out or compares goes through here: saveDefaultFolder, load(), and
// removeDefaultFolder. A comment claiming a single choke point invites the next reader to add
// a fourth entrance without one.
function normalise(p: string): string {
  return path.resolve(p)
}

export function listDefaultFolders(): SandboxDefaultFolder[] {
  return [...load().folders]
}

export type SaveDefaultFolderResult =
  | { ok: true; folders: SandboxDefaultFolder[] }
  | { ok: false; error: string }

// Create or update. UPSERT by normalised path: saving a path that is already listed rewrites
// its mode IN PLACE and keeps its position, rather than appending a second row for the same
// folder — two rows for one path would leave the UI showing a mode the next save contradicts.
export function saveDefaultFolder(f: SandboxDefaultFolder): SaveDefaultFolderResult {
  if (typeof f?.path !== 'string' || !f.path.trim()) return { ok: false, error: 'A folder path is required.' }
  if (!path.isAbsolute(f.path.trim())) return { ok: false, error: 'That must be an absolute path.' }
  if (f.mode !== 'rw' && f.mode !== 'ro') return { ok: false, error: 'Mode must be "rw" or "ro".' }

  const p = normalise(f.path.trim())
  const d = load()
  const i = d.folders.findIndex((x) => normalise(x.path) === p)
  if (i >= 0) {
    const folders = d.folders.map((x, n) => (n === i ? { path: p, mode: f.mode } : x))
    persist({ folders })
    return { ok: true, folders: [...folders] }
  }
  if (d.folders.length >= MAX_FOLDERS) {
    return { ok: false, error: `That is more than ${MAX_FOLDERS} default folders — remove one first.` }
  }
  const folders = [...d.folders, { path: p, mode: f.mode }]
  persist({ folders })
  return { ok: true, folders: [...folders] }
}

// Removing an unknown path is a NO-OP, not an error: the caller's intent ("this must not be
// in the list") is already satisfied, and two browser tabs deleting the same row should not
// leave the second one holding a failure.
export function removeDefaultFolder(p: string): SandboxDefaultFolder[] {
  const d = load()
  if (typeof p !== 'string' || !p.trim()) return [...d.folders]
  const target = normalise(p.trim())
  const folders = d.folders.filter((x) => normalise(x.path) !== target)
  if (folders.length !== d.folders.length) persist({ folders })
  return [...folders]
}

// Test seam: drop the in-memory cache so a test (or a manual edit of the file) is seen.
export function resetSandboxDefaultsCache(): void {
  cache = null
}
