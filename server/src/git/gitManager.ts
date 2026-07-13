import { execFile } from 'child_process'
import type { GitStatus, GitFileStatus, GitDiff, GitResult, GitLog, GitBranches } from '@claudette/shared'

// Local git operations for the Git panel (Phase 2). Ported from ClaudeMaster's
// gitManager, with its remote/SSH branch dropped — Claudette is local-only until
// Phase 3. execFile (not exec) so paths/messages pass as argv, never through a
// shell (no injection). `.gitCode === 128` distinguishes "not a repo" from real
// failures; `.stdout` is preserved for `diff --no-index` (which exits 1 *with* the
// diff on stdout).

const MAX_BUFFER = 64 * 1024 * 1024

async function git(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: number | string }
        reject(wrap((stderr || err.message).trim(), e.code, stdout))
      } else {
        resolve(stdout)
      }
    })
  })
}

function wrap(message: string, code: number | string | undefined, stdout: string): Error {
  const e = new Error(message)
  ;(e as { gitCode?: number | string }).gitCode = code
  ;(e as { stdout?: string }).stdout = stdout
  return e
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Parse `git status --porcelain=v1 -b -z`. Records are NUL-terminated; the first
// is the branch header, and rename/copy entries are followed by their source
// path as a separate record.
function parseStatus(out: string): { branch: string; ahead: number; behind: number; files: GitFileStatus[] } {
  const recs = out.split('\0')
  let branch = ''
  let ahead = 0
  let behind = 0
  const files: GitFileStatus[] = []

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    if (!rec) continue

    if (rec.startsWith('## ')) {
      const header = rec.slice(3)
      // "branch...upstream [ahead N, behind M]" or "No commits yet on branch"
      const noCommits = header.match(/No commits yet on (.+)/)
      if (noCommits) { branch = noCommits[1].trim(); continue }
      branch = header.split('...')[0].split(' ')[0]
      ahead = Number(header.match(/ahead (\d+)/)?.[1] ?? 0)
      behind = Number(header.match(/behind (\d+)/)?.[1] ?? 0)
      continue
    }

    const index = rec[0]
    const worktree = rec[1]
    const path = rec.slice(3)
    let orig: string | undefined
    // Rename/copy in either side consumes the next record (the source path).
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      orig = recs[++i]
    }
    const untracked = index === '?' && worktree === '?'
    files.push({
      path,
      orig,
      index,
      worktree,
      staged: !untracked && index !== ' ',
      unstaged: untracked || worktree !== ' ',
      untracked,
    })
  }
  return { branch, ahead, behind, files }
}

export async function status(dir: string): Promise<GitStatus> {
  try {
    const out = await git(dir, ['status', '--porcelain=v1', '-b', '-z'])
    return { repo: true, ...parseStatus(out) }
  } catch (err) {
    if ((err as { gitCode?: number | string }).gitCode === 128) return { repo: false }
    return { repo: 'error', error: errMsg(err) }
  }
}

export async function diff(dir: string, file: string, staged: boolean, untracked: boolean): Promise<GitDiff> {
  try {
    // Untracked files have no git-tracked counterpart; diff against /dev/null so
    // the whole file shows as added. --no-index exits 1 with the diff on stdout.
    if (untracked && !staged) {
      const out = await git(dir, ['diff', '--no-index', '--', '/dev/null', file]).catch((e: Error) => {
        const out = (e as Error & { stdout?: string }).stdout
        if (typeof out === 'string') return out
        return e.message
      })
      return { ok: true, diff: out }
    }
    const args = ['diff', ...(staged ? ['--cached'] : []), '--', file]
    return { ok: true, diff: await git(dir, args) }
  } catch (err) {
    return { ok: false, error: errMsg(err) }
  }
}

export async function stage(dir: string, file: string): Promise<GitResult> {
  try { await git(dir, ['add', '--', file]); return { ok: true } }
  catch (err) { return { ok: false, error: errMsg(err) } }
}

export async function unstage(dir: string, file: string): Promise<GitResult> {
  try { await git(dir, ['reset', '-q', 'HEAD', '--', file]); return { ok: true } }
  catch (err) { return { ok: false, error: errMsg(err) } }
}

export async function stageAll(dir: string): Promise<GitResult> {
  try { await git(dir, ['add', '-A']); return { ok: true } }
  catch (err) { return { ok: false, error: errMsg(err) } }
}

// Stage modifications and deletions of already-tracked files only (`add -u`),
// leaving untracked files alone — unlike stageAll (`add -A`).
export async function stageTracked(dir: string): Promise<GitResult> {
  try { await git(dir, ['add', '-u']); return { ok: true } }
  catch (err) { return { ok: false, error: errMsg(err) } }
}

export async function unstageAll(dir: string): Promise<GitResult> {
  try { await git(dir, ['reset', '-q', 'HEAD']); return { ok: true } }
  catch (err) { return { ok: false, error: errMsg(err) } }
}

export async function commit(dir: string, message: string): Promise<GitResult> {
  if (!message.trim()) return { ok: false, error: 'Empty commit message' }
  try { await git(dir, ['commit', '-m', message]); return { ok: true } }
  catch (err) { return { ok: false, error: errMsg(err) } }
}

// Field/record separators that can't occur in commit metadata, so we can split
// the log without ambiguity.
const FS = '\x1f'
const RS = '\x1e'

export async function log(dir: string, limit = 100): Promise<GitLog> {
  try {
    const fmt = ['%H', '%h', '%s', '%an', '%ar'].join(FS) + RS
    const out = await git(dir, ['log', `--max-count=${limit}`, `--pretty=format:${fmt}`])
    const commits = out
      .split(RS)
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [hash, short, subject, author, date] = r.split(FS)
        return { hash, short, subject, author, date }
      })
    return { ok: true, commits }
  } catch (err) {
    // A repo with no commits yet exits 128 — treat as an empty log, not an error.
    if ((err as { gitCode?: number | string }).gitCode === 128) return { ok: true, commits: [] }
    return { ok: false, error: errMsg(err) }
  }
}

// The patch for a single commit (message header + diff).
export async function show(dir: string, hash: string): Promise<GitDiff> {
  try { return { ok: true, diff: await git(dir, ['show', '--no-color', hash]) } }
  catch (err) { return { ok: false, error: errMsg(err) } }
}

// --- Branches ----------------------------------------------------------------

// Local branches plus the checked-out one (empty when HEAD is detached).
export async function branches(dir: string): Promise<GitBranches> {
  try {
    const out = await git(dir, ['branch', '--format=%(refname:short)'])
    const branches = out.split('\n').map((s) => s.trim()).filter(Boolean)
    const current = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    return { ok: true, current: current === 'HEAD' ? '' : current, branches }
  } catch (err) { return { ok: false, error: errMsg(err) } }
}

// Create `name` off the current HEAD and switch to it.
export async function createBranch(dir: string, name: string): Promise<GitResult> {
  if (!name.trim()) return { ok: false, error: 'Empty branch name' }
  try { await git(dir, ['switch', '-c', name.trim()]); return { ok: true } }
  catch (err) { return { ok: false, error: errMsg(err) } }
}

// Switch to an existing branch (fails if uncommitted changes would be overwritten).
export async function checkoutBranch(dir: string, name: string): Promise<GitResult> {
  try { await git(dir, ['switch', name]); return { ok: true } }
  catch (err) { return { ok: false, error: errMsg(err) } }
}

// Delete a local branch. `force` (-D) drops the merged-only safety check.
export async function deleteBranch(dir: string, name: string, force: boolean): Promise<GitResult> {
  try { await git(dir, ['branch', force ? '-D' : '-d', name]); return { ok: true } }
  catch (err) { return { ok: false, error: errMsg(err) } }
}

// Merge `name` into the current branch. Conflicts surface as ok:false with git's
// message; the user resolves them in the terminal.
export async function mergeBranch(dir: string, name: string): Promise<GitResult> {
  try { await git(dir, ['merge', '--no-edit', name]); return { ok: true } }
  catch (err) { return { ok: false, error: errMsg(err) } }
}
