import { execFile } from 'child_process'
import { unlink } from 'fs/promises'
import { join } from 'path'
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
// Restoring re-materialises the snapshot's files into the working tree (again via a
// temp index, so the real index/branch are untouched) and, optionally, deletes
// untracked files created since — so a rewind can faithfully undo Claude's edits
// without ever rewriting history or the current branch.

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
function git(dir: string, args: string[], indexFile?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env
    execFile('git', ['-C', dir, ...args], { env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || err.message).trim())
        ;(e as { gitCode?: number | string }).gitCode = (err as NodeJS.ErrnoException & { code?: number | string }).code
        reject(e)
      } else resolve(stdout)
    })
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

export interface RestorePreview {
  reverted: string[]   // tracked/known files whose contents differ → will be rewritten
  deleted: string[]    // untracked files created since the snapshot → removed iff deleteNewer
}

// What restoring a turn's snapshot would change, for the confirm dialog. Null if the
// turn has no snapshot. `reverted` = files differing from the snapshot (relative to
// repo root); `deleted` = untracked files absent from the snapshot.
export async function previewRestore(cwd: string, uuid: string): Promise<RestorePreview | null> {
  const root = await repoRoot(cwd)
  if (!root) return null
  const commit = await commitFor(cwd, uuid)
  if (!commit) return null
  // Files differing between the snapshot and the current working tree.
  const reverted = splitZ(await git(root, ['diff', '--name-only', '-z', commit, '--']).catch(() => ''))
  const deleted = await untrackedNotIn(root, commit)
  return { reverted, deleted }
}

// Untracked (gitignore-respecting) files that are NOT part of the snapshot tree —
// i.e. created since. These are the delete-newer candidates.
async function untrackedNotIn(root: string, commit: string): Promise<string[]> {
  const untracked = splitZ(await git(root, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => ''))
  if (untracked.length === 0) return []
  const inSnap = new Set(splitZ(await git(root, ['ls-tree', '-r', '--name-only', '-z', commit]).catch(() => '')))
  return untracked.filter((f) => !inSnap.has(f))
}

export interface RestoreResult { ok: boolean; error?: string; reverted?: number; deleted?: number }

// Restore the working tree to a turn's snapshot. Rewrites every snapshot file into
// the working tree via a temp index (real index/HEAD/branch untouched); when
// `deleteNewer`, also removes untracked files created since the snapshot. Never
// deletes tracked files. Returns counts for the toast.
export async function restore(cwd: string, uuid: string, deleteNewer: boolean): Promise<RestoreResult> {
  const root = await repoRoot(cwd)
  if (!root) return { ok: false, error: 'not a git repository' }
  const commit = await commitFor(cwd, uuid)
  if (!commit) return { ok: false, error: 'no snapshot for this turn' }
  // Compute the delete set BEFORE we touch the tree (checkout-index would recreate
  // snapshot files, but the untracked-since set is defined against the live tree).
  const toDelete = deleteNewer ? await untrackedNotIn(root, commit) : []
  const preview = await git(root, ['diff', '--name-only', '-z', commit, '--']).then(splitZ).catch(() => [])
  const idx = join(tmpdir(), `claudette-idx-${crypto.randomUUID()}`)
  try {
    // Load the snapshot tree into a temp index, then materialise all of it into the
    // working tree, overwriting whatever's there (-f), recreating deletions.
    await git(root, ['read-tree', commit], idx)
    await git(root, ['checkout-index', '-a', '-f'], idx)
    for (const rel of toDelete) await unlink(join(root, rel)).catch(() => {})
    return { ok: true, reverted: preview.length, deleted: toDelete.length }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'restore failed' }
  } finally {
    await unlink(idx).catch(() => {})
  }
}
