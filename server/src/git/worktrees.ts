import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { existsSync, lstatSync, mkdirSync, readFileSync, appendFileSync, copyFileSync, readlinkSync, symlinkSync, realpathSync } from 'fs'
import path from 'path'
import type { WorktreeInfo } from '@claudette/shared'

// ISOLATED SESSIONS — a session in a project that runs in its OWN git worktree of the
// project's repo, so parallel sessions stop editing one checkout. Created here with plain
// `git worktree add` (never `claude --worktree`: the server owns the directory, the branch,
// the sandbox mounts and the cleanup, and the CLI's variant owns none of that for us).
//
// Layout: <repoRoot>/.claude/worktrees/<slug>, on a NEW branch from HEAD. `.claude/worktrees/`
// is added to <commonDir>/info/exclude so the main checkout never shows them as untracked.

const pexec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

// The message git printed, not Node's "Command failed: git …" wrapper.
function gitError(e: unknown): string {
  const err = e as { stderr?: string; message?: string }
  return (err.stderr?.trim() || err.message || String(e)).split('\n').filter(Boolean).slice(-3).join(' ')
}

function tryRealpath(p: string): string {
  try { return realpathSync(p) } catch { return path.resolve(p) }
}

export interface RepoInfo { root: string; commonDir: string; hasCommit: boolean }

// The repo `dir` is in, or null when it is not inside a work tree.
export async function repoInfo(dir: string): Promise<RepoInfo | null> {
  if (!dir || !existsSync(dir)) return null
  try {
    const [root, common] = (await git(dir, ['rev-parse', '--show-toplevel', '--git-common-dir'])).trim().split('\n')
    let hasCommit = true
    try { await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) } catch { hasCommit = false }
    return { root: tryRealpath(root), commonDir: tryRealpath(path.resolve(dir, common)), hasCommit }
  } catch { return null }
}

// Sync variant of the common dir alone, for the membership check (cwdFitsProject), which is
// synchronous and rare. null when `dir` is not in a repo.
export function gitCommonDirSync(dir: string): string | null {
  if (!dir || !existsSync(dir)) return null
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out ? tryRealpath(path.resolve(dir, out)) : null
  } catch { return null }
}

// A directory- and branch-safe slug of a session name: lowercase, [a-z0-9-], ≤ 40 chars.
export function slugify(name: string): string {
  const s = (name ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return s || 'session'
}

export function worktreeDirFor(repoRoot: string, slug: string): string {
  return path.join(repoRoot, '.claude', 'worktrees', slug)
}

const EXCLUDE_LINE = '.claude/worktrees/'

function ensureExcluded(commonDir: string): void {
  const f = path.join(commonDir, 'info', 'exclude')
  let cur = ''
  try { cur = readFileSync(f, 'utf8') } catch { mkdirSync(path.dirname(f), { recursive: true }) }
  if (cur.split('\n').some((l) => l.trim() === EXCLUDE_LINE || l.trim() === '/' + EXCLUDE_LINE)) return
  appendFileSync(f, `${cur && !cur.endsWith('\n') ? '\n' : ''}# Claudette isolated sessions\n${EXCLUDE_LINE}\n`)
}

// Copy the files <repoRoot>/.worktreeinclude matches (gitignore syntax) into the new worktree:
// the untracked/ignored files a checkout does not carry (.env, local config). Tracked files
// are already there. Listed by git itself, so the pattern semantics ARE gitignore's; git does
// not descend into nested repos, so other worktrees under .claude/worktrees are never copied.
// Regular files are copied, symlinks recreated as symlinks; nothing is installed or built.
async function copyWorktreeIncludes(repoRoot: string, dest: string): Promise<string[]> {
  const inc = path.join(repoRoot, '.worktreeinclude')
  if (!existsSync(inc)) return []
  const out = await git(repoRoot, ['ls-files', '-z', '--others', '--ignored', '--exclude-from=' + inc])
  const copied: string[] = []
  for (const rel of out.split('\0').filter(Boolean)) {
    if (rel.startsWith(EXCLUDE_LINE)) continue
    const src = path.join(repoRoot, rel)
    const to = path.join(dest, rel)
    try {
      const st = lstatSync(src)
      if (existsSync(to)) continue
      mkdirSync(path.dirname(to), { recursive: true })
      if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), to)
      else if (st.isFile()) copyFileSync(src, to)
      else continue
      copied.push(rel)
    } catch { /* one unreadable file does not fail the session */ }
  }
  return copied
}

export type CreateWorktreeResult =
  | { ok: true; worktree: WorktreeInfo; copied: string[] }
  | { ok: false; error: string }

// Create <repoRoot>/.claude/worktrees/<slug> on a new branch from HEAD.
export async function createWorktree(projectDir: string, slug: string, branch: string): Promise<CreateWorktreeResult> {
  const repo = await repoInfo(projectDir)
  if (!repo) return { ok: false, error: `${projectDir} is not inside a git repository.` }
  if (!repo.hasCommit) return { ok: false, error: 'The repository has no commits yet — a worktree needs a commit to start from.' }
  const s = slugify(slug)
  const b = (branch ?? '').trim() || s
  try { await git(repo.root, ['check-ref-format', '--branch', b]) } catch { return { ok: false, error: `"${b}" is not a valid branch name.` } }
  try {
    await git(repo.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])
    return { ok: false, error: `A branch named "${b}" already exists — pick another name.` }
  } catch { /* free */ }
  const dir = worktreeDirFor(repo.root, s)
  if (existsSync(dir)) return { ok: false, error: `${dir} already exists — pick another session name or branch.` }
  try {
    ensureExcluded(repo.commonDir)
    mkdirSync(path.dirname(dir), { recursive: true })
    await git(repo.root, ['worktree', 'add', dir, '-b', b])
  } catch (e) {
    return { ok: false, error: `git worktree add failed: ${gitError(e)}` }
  }
  const copied = await copyWorktreeIncludes(repo.root, dir).catch(() => [])
  return { ok: true, worktree: { path: tryRealpath(dir), branch: b, repoRoot: repo.root, commonDir: repo.commonDir }, copied }
}

export interface WorktreeStatus { dirty: string[]; unmerged: string[] }

// What removing this worktree would lose: uncommitted changes, and commits on its branch that
// no other local branch and no remote-tracking ref contains (unpushed AND unmerged).
export async function worktreeStatus(wt: WorktreeInfo): Promise<WorktreeStatus> {
  if (!existsSync(wt.path)) return { dirty: [], unmerged: [] }
  const dirty = (await git(wt.path, ['status', '--porcelain'])).split('\n').filter(Boolean)
  let unmerged: string[] = []
  try {
    unmerged = (await git(wt.path, [
      'log', '--oneline', '-n', '50', 'HEAD', '--not',
      // --exclude patterns for --branches are matched WITHOUT the refs/heads/ prefix (git
      // rev-list docs); `refs/heads/<b>` silently excluded nothing, so every commit read as
      // already contained by its own branch and nothing was ever "unmerged".
      `--exclude=${wt.branch}`, '--branches', '--remotes',
    ])).split('\n').filter(Boolean)
  } catch { /* detached / unborn: nothing countable */ }
  return { dirty, unmerged }
}

// Remove the worktree DIRECTORY. The branch is always kept. `force` is required (and passed
// to git) when the caller has confirmed losing dirty files.
export async function removeWorktree(wt: WorktreeInfo, force: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!existsSync(wt.path)) {
    // Already gone: prune git's record of it so the branch is free to check out elsewhere.
    try { await git(wt.repoRoot, ['worktree', 'prune']) } catch { /* best effort */ }
    return { ok: true }
  }
  try {
    await git(wt.repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `git worktree remove failed: ${gitError(e)}` }
  }
}
