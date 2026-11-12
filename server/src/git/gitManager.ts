import { execFile } from 'child_process'
import { lstat, readFile, readlink } from 'fs/promises'
import { isAbsolute, relative, resolve } from 'path'
import type { GitStatus, GitFileStatus, GitDiff, GitSides, GitResult, GitLog, GitBranches } from '@claudette/shared'
import { errMessage } from '../util/errMessage'

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


// Parse `git status --porcelain=v1 -b -z`. Records are NUL-terminated; the first
// is the branch header, and rename/copy entries are followed by their source
// path as a separate record.
function parseStatus(out: string): Omit<Extract<GitStatus, { repo: true }>, 'repo'> {
  const recs = out.split('\0')
  let branch = ''
  let upstream: string | null = null
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
      const dots = header.indexOf('...')
      if (dots >= 0) {
        branch = header.slice(0, dots).trim()
        // rest is "upstream [ahead N, behind M]"; the upstream ref is up to the space.
        upstream = header.slice(dots + 3).split(' ')[0].trim() || null
      } else {
        branch = header.split(' ')[0]
      }
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
  return { branch, upstream, ahead, behind, files }
}

export async function status(dir: string): Promise<GitStatus> {
  try {
    const out = await git(dir, ['status', '--porcelain=v1', '-b', '-z'])
    return { repo: true, ...parseStatus(out) }
  } catch (err) {
    if ((err as { gitCode?: number | string }).gitCode === 128) return { repo: false }
    return { repo: 'error', error: errMessage(err) }
  }
}

// Status paths (porcelain) are relative to the REPO ROOT whatever the cwd, so every
// op that takes one runs against the toplevel — from a subdirectory cwd, `-- <file>`
// would otherwise resolve against the subdirectory and match nothing.
async function toplevel(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
}

export async function diff(dir: string, file: string, staged: boolean, untracked: boolean): Promise<GitDiff> {
  try {
    const top = await toplevel(dir)
    // Untracked files have no git-tracked counterpart; diff against /dev/null so
    // the whole file shows as added. --no-index exits 1 with the diff on stdout.
    if (untracked && !staged) {
      const out = await git(top, ['diff', '--no-index', '--', '/dev/null', file]).catch((e: Error) => {
        const out = (e as Error & { stdout?: string }).stdout
        if (typeof out === 'string') return out
        return e.message
      })
      return { ok: true, diff: out }
    }
    const args = ['diff', ...(staged ? ['--cached'] : []), '--', file]
    return { ok: true, diff: await git(top, args) }
  } catch (err) {
    return { ok: false, error: errMessage(err) }
  }
}

// --- Full sides (for the merge view) ---------------------------------------
// `file` is a status-list path, which porcelain reports relative to the REPO ROOT
// regardless of cwd — so blobs use root-anchored specs (`:0:<path>`, `HEAD:<path>`)
// and the worktree read resolves against --show-toplevel, never against `dir`.

const SIDES_CAP = 5 * 1024 * 1024
const BINARY_PROBE = 8192
const TOO_LARGE = 'file too large for diff view'

// Like git(), but raw bytes — blob content must not be utf8-decoded before the
// binary check.
async function gitBuf(dir: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { maxBuffer: MAX_BUFFER, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) reject(wrap((stderr.toString() || err.message).trim(), (err as { code?: number | string }).code, ''))
      else resolve(stdout)
    })
  })
}

// A blob's bytes, or null when `spec` names nothing (not in the index, no HEAD yet).
async function blob(dir: string, spec: string): Promise<Buffer | null> {
  let sha: string
  try { sha = (await git(dir, ['rev-parse', '--verify', '--quiet', spec])).trim() } catch { return null }
  if (!sha) return null
  if (Number((await git(dir, ['cat-file', '-s', sha])).trim()) > SIDES_CAP) throw new Error(TOO_LARGE)
  return gitBuf(dir, ['cat-file', 'blob', sha])
}

// The worktree file's bytes, or null if it's gone. A symlink yields its target
// string, which is what git stores as the blob.
async function worktreeFile(top: string, file: string): Promise<Buffer | null> {
  const abs = resolve(top, file)
  const rel = relative(top, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('path is outside the repository')
  const st = await lstat(abs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  })
  if (!st) return null
  if (st.isSymbolicLink()) return Buffer.from(await readlink(abs))
  if (!st.isFile()) throw new Error('not a regular file')
  if (st.size > SIDES_CAP) throw new Error(TOO_LARGE)
  return readFile(abs)
}

const isBinary = (b: Buffer | null) => !!b && b.subarray(0, BINARY_PROBE).includes(0)

// Both full texts of `file`. Unstaged: index → worktree. Staged: HEAD → index.
// Untracked: '' → worktree. `orig` (a rename's source path) is the fallback for
// the original side when `file` itself isn't there.
export async function sides(dir: string, file: string, staged: boolean, untracked: boolean, orig?: string): Promise<GitSides> {
  try {
    const top = await toplevel(dir)
    const before = async (rev: string) =>
      (await blob(top, `${rev}:${file}`)) ?? (orig ? await blob(top, `${rev}:${orig}`) : null)
    let original: Buffer | null
    let modified: Buffer | null
    if (untracked && !staged) {
      original = null
      modified = await worktreeFile(top, file)
    } else if (staged) {
      original = await before('HEAD')
      modified = await blob(top, `:0:${file}`)
    } else {
      original = await before(':0')
      modified = await worktreeFile(top, file)
    }
    if (isBinary(original) || isBinary(modified)) return { ok: true, original: '', modified: '', binary: true }
    return { ok: true, original: original?.toString('utf8') ?? '', modified: modified?.toString('utf8') ?? '' }
  } catch (err) {
    return { ok: false, error: errMessage(err) }
  }
}

export async function stage(dir: string, file: string): Promise<GitResult> {
  try { await git(await toplevel(dir), ['add', '--', file]); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

export async function unstage(dir: string, file: string): Promise<GitResult> {
  try { await git(await toplevel(dir), ['reset', '-q', 'HEAD', '--', file]); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

export async function stageAll(dir: string): Promise<GitResult> {
  try { await git(dir, ['add', '-A']); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

// Stage modifications and deletions of already-tracked files only (`add -u`),
// leaving untracked files alone — unlike stageAll (`add -A`).
export async function stageTracked(dir: string): Promise<GitResult> {
  try { await git(dir, ['add', '-u']); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

export async function unstageAll(dir: string): Promise<GitResult> {
  try { await git(dir, ['reset', '-q', 'HEAD']); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

export async function commit(dir: string, message: string): Promise<GitResult> {
  if (!message.trim()) return { ok: false, error: 'Empty commit message' }
  try { await git(dir, ['commit', '-m', message]); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
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
    return { ok: false, error: errMessage(err) }
  }
}

// The patch for a single commit (message header + diff).
export async function show(dir: string, hash: string): Promise<GitDiff> {
  try { return { ok: true, diff: await git(dir, ['show', '--no-color', hash]) } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

// --- Branches ----------------------------------------------------------------

// Local branches plus the checked-out one (empty when HEAD is detached).
export async function branches(dir: string): Promise<GitBranches> {
  try {
    // Independent reads — run them together rather than back-to-back.
    const [out, currentRaw] = await Promise.all([
      git(dir, ['branch', '--format=%(refname:short)']),
      git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ])
    const branches = out.split('\n').map((s) => s.trim()).filter(Boolean)
    const current = currentRaw.trim()
    return { ok: true, current: current === 'HEAD' ? '' : current, branches }
  } catch (err) { return { ok: false, error: errMessage(err) } }
}

// Create `name` off the current HEAD and switch to it.
export async function createBranch(dir: string, name: string): Promise<GitResult> {
  if (!name.trim()) return { ok: false, error: 'Empty branch name' }
  try { await git(dir, ['switch', '-c', name.trim()]); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

// Switch to an existing branch (fails if uncommitted changes would be overwritten).
export async function checkoutBranch(dir: string, name: string): Promise<GitResult> {
  try { await git(dir, ['switch', name]); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

// Delete a local branch. `force` (-D) drops the merged-only safety check.
export async function deleteBranch(dir: string, name: string, force: boolean): Promise<GitResult> {
  try { await git(dir, ['branch', force ? '-D' : '-d', name]); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

// Merge `name` into the current branch. Conflicts surface as ok:false with git's
// message; the user resolves them in the terminal.
export async function mergeBranch(dir: string, name: string): Promise<GitResult> {
  try { await git(dir, ['merge', '--no-edit', name]); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

// --- Remote ------------------------------------------------------------------
// These reach the network, so they can be slow or hang on auth prompts. We rely
// on git's own credential handling (helpers/SSH agent); anything interactive
// fails fast because there's no TTY, surfacing as ok:false with git's message.

// Fetch remote refs without touching the working tree — updates ahead/behind.
export async function fetch(dir: string): Promise<GitResult> {
  try { await git(dir, ['fetch']); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

// Pull with fast-forward-only by default so we never spawn a merge editor; a
// divergent history surfaces as ok:false and the user resolves it in the terminal.
export async function pull(dir: string): Promise<GitResult> {
  try { await git(dir, ['pull', '--ff-only']); return { ok: true } }
  catch (err) { return { ok: false, error: errMessage(err) } }
}

// Push the current branch. `setUpstream` publishes an unpushed branch
// (`push -u origin HEAD`) so it gains a tracking ref; otherwise a plain push.
export async function push(dir: string, setUpstream: boolean): Promise<GitResult> {
  try {
    await git(dir, setUpstream ? ['push', '-u', 'origin', 'HEAD'] : ['push'])
    return { ok: true }
  } catch (err) { return { ok: false, error: errMessage(err) } }
}
