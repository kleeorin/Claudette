import { execFile } from 'child_process'
import { unlink } from 'fs/promises'
import { join, relative, resolve, dirname, basename, isAbsolute, sep } from 'path'
import { lstatSync, realpathSync, type Stats } from 'fs'
import { errMessage } from '../util/errMessage'
import { tmpdir } from 'os'
import crypto from 'crypto'

// Per-turn working-tree snapshots that back /rewind's code-restore (Phase 2). A
// snapshot is a real git commit object created WITHOUT touching the user's index,
// HEAD, staging, or branch: we stage the whole working tree into a throwaway temp
// index (GIT_INDEX_FILE), write-tree it, and commit-tree that — then protect it
// from gc with a ref under refs/claudette/rewind/<uuid>. Because snapshots are
// ordinary refs they persist across server restarts with no separate ledger.
//
// Restoring re-materialises snapshot content for a SCOPED set of paths — the files the
// rewinding session edited (see THE RESTORE IS SCOPED below) — again via a temp index so the
// real index/branch are untouched, and optionally deletes the set's files created since. It
// never rewrites history or the current branch, and never touches a path outside the set.

const REF_PREFIX = 'refs/claudette/rewind'

// Every git call below is best-effort — a failure just means "no code rewind here", which
// the UI renders as a greyed-out Code option with no explanation. That silence is fine for
// the EXPECTED miss (cwd isn't a repo) and terrible for the machine-level faults that look
// identical from the UI: no committer identity for commit-tree, `safe.directory` ownership
// refusal, an unreadable file breaking `add -A`, a read-only ref store. Those get one warn
// per distinct message so a broken machine says so in the log without spamming per turn.
const warned = new Set<string>()
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[rewind] ${msg}`)
}

// execFile git with an optional GIT_INDEX_FILE override. Rejects with the trimmed
// stderr on failure; `.gitCode === 128` marks "not a repo" for callers to swallow.
function git(dir: string, args: string[], indexFile?: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env
    const child = execFile('git', ['-C', dir, ...args], { env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || err.message).trim())
        ;(e as { gitCode?: number | string }).gitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code
        reject(e)
      } else resolve(stdout)
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

// The absolute repo root containing `cwd`, or null when cwd isn't inside a git repo
// (code-rewind is git-only; callers treat null as "snapshots unavailable here").
export async function repoRoot(cwd: string): Promise<string | null> {
  try { return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim() || null }
  catch (e) {
    // "not a git repository" is the ordinary, expected miss — stay quiet. Anything else
    // (dubious ownership, git not on PATH, an unreadable dir) is a fault the user can fix.
    const msg = errMessage(e)
    if (!/not a git repository/i.test(msg)) warnOnce(`root:${cwd}:${msg}`, `git unusable in ${cwd} — code rewind is off here: ${msg}`)
    return null
  }
}

// NUL-delimited `-z` output → string[] (drops the trailing empty field).
function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0)
}

// Snapshot the current working tree of the repo containing `cwd`. Returns the new
// commit sha (its tree is the snapshot), or null if cwd isn't a git repo. Does not
// touch the real index/HEAD/branch. Ignored files (.gitignore) are excluded.
export async function snapshot(cwd: string): Promise<string | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  const idx = join(tmpdir(), `claudette-idx-${crypto.randomUUID()}`)
  try {
    // Empty temp index + `add -A` = stage every working-tree file (tracked +
    // untracked, ignored excluded) as it currently is on disk.
    await git(root, ['add', '-A'], idx)
    const tree = (await git(root, ['write-tree'], idx)).trim()
    // Parent it on HEAD when there is one (for context in `git show`); a repo with no
    // commits yet has no HEAD, so commit parentless.
    let head: string | null = null
    try { head = (await git(root, ['rev-parse', 'HEAD'])).trim() } catch { /* unborn branch */ }
    const commitArgs = ['commit-tree', tree, '-m', 'claudette rewind snapshot']
    if (head) commitArgs.push('-p', head)
    return (await git(root, commitArgs, idx)).trim()
  } catch (e) {
    // The single most common machine-level cause lands here: commit-tree with no committer
    // identity configured ("unable to auto-detect email address"), which disables code
    // rewind on that machine for every turn, forever, with nothing else to show for it.
    const msg = errMessage(e)
    warnOnce(`snap:${root}:${msg}`, `could not snapshot the working tree in ${root} — code rewind is off here: ${msg}`)
    return null
  } finally {
    await unlink(idx).catch(() => {})
  }
}

// How many rewind snapshots to keep per repo. Each ref pins a whole tree plus a fresh
// blob for every modified or untracked file at that moment, and it is gc-proof by
// construction — that is the point of the ref. One is written per user turn, so without
// a ceiling a busy repo with large untracked artifacts grows a full working-tree copy per
// turn, forever. The rewind picker only ever offers recent turns, so the deep tail is
// storage nobody can reach from the UI.
const KEEP_REFS = 200

// Protect a snapshot commit from gc and key it to a turn's message uuid.
export async function saveRef(cwd: string, uuid: string, commit: string): Promise<void> {
  const root = await repoRoot(cwd)
  if (!root) return
  try { await git(root, ['update-ref', `${REF_PREFIX}/${uuid}`, commit]) }
  catch (e) {
    // Snapshots are being taken but can't be pinned (read-only ref store) — they'll be gc'd
    // and every turn will show "No snapshot", so this is worth saying out loud.
    const msg = errMessage(e)
    warnOnce(`ref:${root}:${msg}`, `could not pin a snapshot ref in ${root} — code rewind is off here: ${msg}`)
    return
  }
  await pruneRefs(root, `${REF_PREFIX}/${uuid}`)
}

// Drop all but the newest KEEP_REFS snapshot refs, ordered by the snapshot commit's own
// committer date — a good approximation of turn order, but only an approximation, which
// is why the ref just written is held out explicitly below rather than trusted to sort
// first. Best-effort: a repo we can write refs into but not delete them from is unusual,
// and failing to prune must never fail the turn.
async function pruneRefs(root: string, keep: string): Promise<void> {
  try {
    const out = await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', REF_PREFIX])
    const refs = out.split('\n').map((r) => r.trim()).filter(Boolean)
    if (refs.length <= KEEP_REFS) return
    // The ref we have just written is held out of the candidate list ENTIRELY rather than
    // trusted to sort first. commit-tree stamps only to the second, so two turns in the
    // same second tie, and git then falls back to refname ASCENDING — over random uuids.
    // The newest ref is therefore not reliably at the head of this list, while the tail is
    // exactly what gets deleted. Whatever else goes, the turn that just happened has to
    // stay rewindable. Holding it out before the slice (rather than skipping it during
    // one) keeps the total at KEEP_REFS instead of overshooting by one.
    const others = refs.filter((r) => r !== keep)
    for (const ref of others.slice(KEEP_REFS - 1)) await git(root, ['update-ref', '-d', ref])
  } catch (e) {
    const msg = errMessage(e)
    warnOnce(`prune:${root}:${msg}`, `could not prune old snapshot refs in ${root}: ${msg}`)
  }
}

// The snapshot commit saved for a turn uuid, or null if none exists.
async function commitFor(cwd: string, uuid: string): Promise<string | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  try { return (await git(root, ['rev-parse', '--verify', '--quiet', `${REF_PREFIX}/${uuid}`])).trim() || null }
  catch { return null }
}

// The turn uuids that have a snapshot in this repo — a batch check so listRewindPoints
// can mark all its points in one call rather than one rev-parse per point.
export async function snapshottedUuids(cwd: string): Promise<Set<string>> {
  const root = await repoRoot(cwd)
  if (!root) return new Set()
  try {
    const out = await git(root, ['for-each-ref', '--format=%(refname)', REF_PREFIX])
    const prefix = `${REF_PREFIX}/`
    return new Set(out.split('\n').map((r) => r.trim()).filter(Boolean).map((r) => r.slice(prefix.length)))
  } catch { return new Set() }
}

// ── THE RESTORE IS SCOPED ─────────────────────────────────────────────────────────────
// Snapshots stay WHOLE-TREE (storage above is unchanged), but a restore touches only the
// paths the caller names: the files the rewinding session itself edited from the target turn
// on (conversations.ts fileEditsFrom). It used to `read-tree` + `checkout-index -a -f` the
// entire snapshot and, with deleteNewer, unlink every untracked file created since — so a
// rewind in one session reverted every OTHER session's edits in the same repo, and the
// operator's own. Per path in the set:
//   in the snapshot      → rewritten to the snapshot's content iff it differs now
//   absent from it       → deleted iff deleteNewer (created after the snapshot)
//   outside the repo     → skipped — a snapshot cannot contain it
//   gitignored + absent  → skipped — ignored files are never snapshotted, so "absent" says
//                          nothing about when it was created and deleting it would be a guess
// Nothing outside the set is read for writing, let alone touched.
export interface Skipped { path: string; reason: string }
export interface RestorePreview {
  reverted: string[]   // repo-relative paths that will be rewritten to the snapshot's content
  deleted: string[]    // repo-relative paths created since → removed iff deleteNewer
  skipped: Skipped[]   // paths in the set that cannot be restored, and why
}

// `abs` as a repo-relative path, or null when it lies outside `root`. `root` comes from
// `rev-parse --show-toplevel` and is canonical, while an edit tool's path can be spelled
// through a symlink, so a miss is retried with the parent realpath'd.
export function repoRel(root: string, abs: string): string | null {
  const inside = (p: string): string | null => {
    const r = relative(root, p)
    return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : null
  }
  const direct = inside(resolve(abs))
  if (direct) return direct
  try { return inside(join(realpathSync(dirname(resolve(abs))), basename(abs))) } catch { return null }
}

interface Plan { root: string; commit: string; revert: string[]; remove: string[]; skipped: Skipped[] }

async function plan(cwd: string, uuid: string, paths: string[]): Promise<Plan | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  const commit = await commitFor(cwd, uuid)
  if (!commit) return null
  const skipped: Skipped[] = []
  const rels = new Set<string>()
  for (const p of paths) {
    const r = repoRel(root, p)
    if (r) rels.add(r)
    else if (!skipped.some((s) => s.path === p)) skipped.push({ path: p, reason: 'outside the repository' })
  }
  const list = [...rels].sort()
  if (!list.length) return { root, commit, revert: [], remove: [], skipped }
  // Mode + blob of each listed path that IS in the snapshot (`ls-tree` with pathspecs; a
  // path absent from the snapshot simply produces no line).
  const inSnap = new Map<string, { mode: string; sha: string }>()
  for (const rec of splitZ(await git(root, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...list]).catch(() => ''))) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(rec)
    if (m) inSnap.set(m[3], { mode: m[1], sha: m[2] })
  }
  const absent = list.filter((r) => !inSnap.has(r))
  // `-z` is valid ONLY with `--stdin` ("fatal: -z only makes sense with --stdin"); passing
  // paths as arguments with -z fails outright, and a swallowed failure here reads as
  // "nothing is ignored" — which plans an ignored, pre-existing file (.env) for DELETION.
  // check-ignore exits 1 when nothing matches, which is the one failure that means "none";
  // any other failure refuses the delete for every absent path rather than guessing.
  let ignored: Set<string>
  let ignoreUnknown = false
  try {
    ignored = new Set(absent.length ? splitZ(await git(root, ['check-ignore', '--stdin', '-z'], undefined, absent.join('\0') + '\0')) : [])
  } catch (e) {
    const code = (e as { gitCode?: number | string }).gitCode
    ignored = code === 1 ? new Set() : new Set(absent)
    ignoreUnknown = code !== 1
  }
  const revert: string[] = [], remove: string[] = []
  for (const r of list) {
    const full = join(root, r)
    let st: Stats | null = null
    try { st = lstatSync(full) } catch { /* not on disk */ }
    const snap = inSnap.get(r)
    if (snap) {
      // Rewrite only what differs. A symlink is always rewritten (hashing would follow it),
      // and anything we cannot hash is treated as differing — a no-op checkout is harmless.
      if (!st || st.isDirectory() || snap.mode === '120000') { revert.push(r); continue }
      const now = (await git(root, ['hash-object', '--', r]).catch(() => '')).trim()
      if (now !== snap.sha) revert.push(r)
    } else if (ignored.has(r)) {
      skipped.push({ path: r, reason: ignoreUnknown
        ? 'could not check .gitignore — not deleted on a guess'
        : 'gitignored — not part of any snapshot' })
    } else if (st && !st.isDirectory()) {
      remove.push(r)
    }
  }
  return { root, commit, revert, remove, skipped }
}

// What restoring this turn's snapshot would change for `paths`, for the confirm dialog.
// Null if the turn has no snapshot (or cwd is not a repo).
export async function previewRestore(cwd: string, uuid: string, paths: string[]): Promise<RestorePreview | null> {
  const p = await plan(cwd, uuid, paths)
  return p && { reverted: p.revert, deleted: p.remove, skipped: p.skipped }
}

export interface RestoreResult { ok: boolean; error?: string; reverted?: number; deleted?: number }

// Restore `paths` to a turn's snapshot (see THE RESTORE IS SCOPED). Rewrites through a temp
// index, so the real index / HEAD / branch are untouched; deletes only listed paths absent
// from the snapshot, and only when `deleteNewer`. Returns counts for the toast.
export async function restore(cwd: string, uuid: string, deleteNewer: boolean, paths: string[]): Promise<RestoreResult> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, error: 'not a git repository' }
  const p = await plan(cwd, uuid, paths)
  if (!p) return { ok: false, error: 'no snapshot for this turn' }
  const idx = join(tmpdir(), `claudette-idx-${crypto.randomUUID()}`)
  try {
    if (p.revert.length) {
      await git(root, ['read-tree', p.commit], idx)
      // Batched so a large set cannot overflow argv; `--` keeps a path that starts with '-'
      // from being read as an option.
      for (let i = 0; i < p.revert.length; i += 200) {
        await git(root, ['checkout-index', '-f', '--', ...p.revert.slice(i, i + 200)], idx)
      }
    }
    const toDelete = deleteNewer ? p.remove : []
    for (const rel of toDelete) await unlink(join(root, rel)).catch(() => {})
    return { ok: true, reverted: p.revert.length, deleted: toDelete.length }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'restore failed' }
  } finally {
    await unlink(idx).catch(() => {})
  }
}
