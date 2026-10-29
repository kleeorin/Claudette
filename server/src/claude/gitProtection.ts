import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'

// --- .git exec-vector protection (SANDBOX.md "Git exec-vector escape") ---------------------
//
// A git dir inside a box-writable mount is a host code-execution channel: the operator runs
// `git` on the HOST, UNSANDBOXED, in the same repo, and git executes things the repo tells it
// to — hooks, core.hooksPath, core.fsmonitor, core.sshCommand, core.pager, filter/diff
// drivers, aliases, an included config file. So a confined session that can write
// <gitdir>/config or <gitdir>/hooks/* gets its payload run outside the box the next time the
// operator commits. Same shape as cross-session hook poisoning (hookSettingsProtections),
// same remedy: ro overlays layered over the rw bind.
//
// This module only DISCOVERS what to pin, as host paths. sandbox.ts maps each to the path the
// box writes through (overlayDestFor) and decides what is emitted; keeping the mount-space
// logic in one file is what stops the box and the authorizer drifting apart.
//
// Three kinds of pin, because ro overlays alone were measured to be bypassable:
//   ro    — read-only overlay: config, config.worktree, hooks/, commondir, a linked
//           worktree's `.git` pointer file, a core.hooksPath dir, an included config file.
//   self  — a rw bind of a dir ONTO ITSELF. Changes nothing about what the box can write; it
//           makes the dir a MOUNTPOINT, and a mountpoint cannot be renamed or removed (EBUSY).
//           Without it, `mv .git .gitx && mkdir .git` sheds every overlay below and plants a
//           fresh evil config (verified live: rename of a dir that merely CONTAINS mounts
//           succeeds). Applied to each gitdir, each common dir and each work-tree top.
//   (and before launch only) materialize — an ABSENT path cannot be pinned: bwrap would
//           create the mountpoint through the rw bind and leave it on the host. So the hooks
//           dir (and a core.hooksPath dir) is created first, empty, the same way
//           ensureUserSettingsPinnable materializes settings.json; git itself creates
//           hooks/ on init, so an empty one is indistinguishable from a normal repo.
//           `commondir` is the hard case — see PIN_MAIN_COMMONDIR.

// A MAIN gitdir honours `<gitdir>/commondir` exactly as a linked worktree's does (verified
// live, git 2.43: a commondir naming another repo whose config sets core.fsmonitor ran the
// payload on `git status`). It is normally absent, so it cannot be ro-pinned as-is, and an
// empty one makes git die. The fix pre-creates it containing "./" — git resolves that to the
// gitdir itself (status/commit/worktree add|list|remove/gc/fsck verified unchanged; only
// `rev-parse --git-common-dir` prints an absolute path) — and then pins it.
// "./", NOT ".": libgit2 1.9.7 (pygit2 1.20.1) REFUSES to open a repo whose commondir is "."
// ("Repository not found") while opening "./" normally — measured; git accepts both. So "."
// would have broken every libgit2-based client (GitKraken, …) on every protected repo.
// Operator decision (2026-10-27): on. Off ⇒ a box can redirect the whole common dir.
export const PIN_MAIN_COMMONDIR = true
export const COMMONDIR_PIN_CONTENT = './\n'

// Is an EXISTING `<g>/commondir` one git or this module could have written? Exactly two shapes:
// it resolves to g itself (our pin — "./", or a legacy "."), or g is a LINKED worktree's private
// gitdir <C>/worktrees/<name> and it resolves to C (git writes "../.."). Anything else — a main
// or submodule gitdir pointing somewhere else, or a commondir that is not a plain file — is how
// a box redirects the operator's git to a config it wrote, and launch refuses (see gitPins).
function commondirIsBenign(g: string): boolean {
  const f = path.join(g, 'commondir')
  if (lstatKind(f) !== 'file') return false
  const cd = readText(f)?.trim()
  if (!cd) return false
  const target = path.resolve(g, cd)
  if (target === g) return true
  return path.basename(path.dirname(g)) === 'worktrees' && target === path.dirname(path.dirname(g))
}

export interface GitPin {
  path: string            // host path (resolved, NOT realpath'd: sandbox.ts probes both spellings)
  kind: 'ro' | 'self'
}

// How far below a rw mount root to look for repos. The commonest layouts are covered (cwd =
// repo root, a projects dir of repos, .claude/worktrees/<slug>); a mount of $HOME or `/`
// is bounded instead of walked, and those are an escape anyway (dotfiles, ~/.gitconfig).
const SCAN_DEPTH = 3
const SCAN_DIR_CAP = 4000
const SKIP_DIRS = new Set(['node_modules', '.git'])

function lstatKind(p: string): 'dir' | 'file' | 'link' | null {
  try {
    const s = lstatSync(p)
    return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null
  } catch { return null }
}

function readText(p: string): string | null {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

function tryRealpath(p: string): string | null {
  try { return realpathSync(p) } catch { return null }
}

// Work-tree tops (dirs holding a `.git` entry) relevant to one rw mount root: the repo that
// ENCLOSES it (its gitdir may be reachable through this or another mount) and the repos
// below it, to SCAN_DEPTH. Never follows a symlinked dir while scanning.
export function repoTopsFor(mountRoot: string): string[] {
  const out = new Set<string>()
  const start = tryRealpath(mountRoot)
  if (!start || lstatKind(start) !== 'dir') return []
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (lstatKind(path.join(dir, '.git'))) { out.add(dir); break }
    if (path.dirname(dir) === dir) break
  }
  let visited = 0
  const walk = (dir: string, depth: number): void => {
    if (visited++ > SCAN_DIR_CAP) return
    if (lstatKind(path.join(dir, '.git'))) out.add(dir)
    if (depth >= SCAN_DEPTH) return
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      if (SKIP_DIRS.has(n)) continue
      const child = path.join(dir, n)
      if (lstatKind(child) === 'dir') walk(child, depth + 1)
    }
  }
  // A mount OF a git dir (an isolated session's rw common dir) has no work trees below it —
  // walking objects/ and refs/ would only spend the scan cap.
  const isGitdir = lstatKind(path.join(start, 'HEAD')) === 'file' && lstatKind(path.join(start, 'objects')) === 'dir'
  if (!isGitdir) walk(start, 0)
  return [...out]
}

// `gitdir: <path>` (relative to the file's dir) → absolute, or null.
function readGitdirPointer(file: string): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(file) ?? '')
  return m ? path.resolve(path.dirname(file), m[1]) : null
}

// Minimal git-config reader: just the keys that name OTHER files git will read or execute
// from. Not a full parser — a value it misses is a pin not added, never a pin wrongly added.
function configRefs(cfgFile: string): { hooksPath?: string; includes: string[]; worktree?: string } {
  const out: { hooksPath?: string; includes: string[]; worktree?: string } = { includes: [] }
  let section = ''
  for (const raw of (readText(cfgFile) ?? '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const sec = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]/.exec(line)
    if (sec) { section = sec[1].toLowerCase(); continue }
    const kv = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const val = kv[2].replace(/^"(.*)"$/, '$1')
    if (section === 'core' && key === 'hookspath') out.hooksPath = val
    else if (section === 'core' && key === 'worktree') out.worktree = val
    else if ((section === 'include' || section === 'includeif') && key === 'path') out.includes.push(val)
  }
  return out
}

function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p
}

// Every pin for every repo reachable from the given rw mount roots. `materialize` creates the
// absent paths that must exist to be pinnable (launch only); `canCreate(p)` must return true
// only for a path the box could itself have created — that keeps a box-written `.git` pointer
// from steering an UNSANDBOXED host mkdir/write somewhere the box cannot reach.
export function gitPins(
  rwMountRoots: string[],
  opts: { materialize: boolean; canCreate: (p: string) => boolean },
): GitPin[] {
  const pins = new Map<string, GitPin['kind']>()
  const add = (p: string, kind: GitPin['kind']): void => {
    const r = path.resolve(p)
    if (pins.get(r) !== 'ro') pins.set(r, kind)   // ro beats self at the same path
  }
  const seenGitdirs = new Set<string>()

  const ensureDir = (d: string): void => {
    if (!opts.materialize || existsSync(d) || !opts.canCreate(d)) return
    try { mkdirSync(d) } catch { /* not pinnable this launch */ }
  }
  const ensureCommondir = (gitdir: string): void => {
    const f = path.join(gitdir, 'commondir')
    // Idempotent: an existing commondir is never rewritten (the suspicious-one refusal is in
    // pinGitdir). 'wx' = O_CREAT|O_EXCL also closes the race — nothing that appears at that
    // path between the check and the write is followed or overwritten.
    if (!PIN_MAIN_COMMONDIR || !opts.materialize || lstatKind(f) || !opts.canCreate(f)) return
    try { writeFileSync(f, COMMONDIR_PIN_CONTENT, { flag: 'wx' }) } catch { /* not pinnable this launch */ }
  }

  // Pins for ONE gitdir and everything hanging off it. `top` is its work tree, if known.
  const pinGitdir = (gitdir: string, top: string | null): void => {
    const g = path.resolve(gitdir)
    if (seenGitdirs.has(g) || lstatKind(g) !== 'dir') return
    seenGitdirs.add(g)
    add(g, 'self')
    add(path.join(g, 'config.worktree'), 'ro')
    const cdFile = path.join(g, 'commondir')
    // REFUSE, not flag (operator asked for one; refusing is the fail-closed choice this file
    // makes everywhere else). Only at launch — the authorizer path keeps pinning, so an
    // out-of-band write is still refused there. Refusing cannot protect a host `git` the
    // operator runs before reading the message; it does stop a confined session from running
    // on top of the redirect and makes the planted file impossible to miss.
    if (opts.materialize && lstatKind(cdFile) && !commondirIsBenign(g)) {
      const target = readText(cdFile)?.trim()
      throw new Error(`sandbox: refusing to launch — ${cdFile} redirects this repository's git dir${target ? ` to ${path.resolve(g, target)}` : ''}. A main git dir has no commondir unless something wrote one, and a confined session could have planted it so that the operator's UNSANDBOXED git runs another repository's config and hooks. Inspect it (cat ${cdFile}); if you did not create it, delete it, then relaunch.`)
    }
    const cd = readText(cdFile)?.trim()
    const common = cd ? path.resolve(g, cd) : g
    if (common === g) ensureCommondir(g)
    add(cdFile, 'ro')
    if (common !== g) pinGitdir(common, null)   // a linked worktree's common dir

    if (common === g) {
      // Things that live only in a common dir.
      add(path.join(g, 'config'), 'ro')
      ensureDir(path.join(g, 'hooks'))
      add(path.join(g, 'hooks'), 'ro')
      const refs = configRefs(path.join(g, 'config'))
      const wt = top ?? (refs.worktree ? path.resolve(g, refs.worktree) : null)
      if (refs.hooksPath) {
        const hp = path.resolve(wt ?? g, expandHome(refs.hooksPath))
        ensureDir(hp)
        add(hp, 'ro')
      }
      for (const inc of refs.includes) add(path.resolve(g, expandHome(inc)), 'ro')
      // Every linked worktree of this repo: its private gitdir AND the `.git` pointer file in
      // its work tree, which `gitdir` names. A rewritten pointer redirects the whole repo.
      let wts: string[] = []
      try { wts = readdirSync(path.join(g, 'worktrees')) } catch { /* none */ }
      for (const n of wts) {
        const wg = path.join(g, 'worktrees', n)
        pinGitdir(wg, null)
        const ptr = readText(path.join(wg, 'gitdir'))?.trim()
        if (ptr) add(path.resolve(wg, ptr), 'ro')
      }
      // Submodules: modules/<name>[/modules/<name>…], each a full gitdir of its own.
      const walkModules = (dir: string): void => {
        let names: string[] = []
        try { names = readdirSync(dir) } catch { return }
        for (const n of names) {
          const d = path.join(dir, n)
          if (lstatKind(d) !== 'dir') continue
          if (lstatKind(path.join(d, 'HEAD')) === 'file') {
            const mref = configRefs(path.join(d, 'config'))
            const mtop = mref.worktree ? path.resolve(d, mref.worktree) : null
            pinGitdir(d, mtop)
            if (mtop) { add(path.join(mtop, '.git'), 'ro'); add(mtop, 'self') }
          } else walkModules(d)   // a module name with a slash nests a plain dir
        }
      }
      walkModules(path.join(g, 'modules'))
    }
  }

  const tops = new Set<string>()
  for (const root of rwMountRoots) for (const t of repoTopsFor(root)) tops.add(t)
  for (const top of tops) {
    const dotgit = path.join(top, '.git')
    const kind = lstatKind(dotgit)
    add(top, 'self')
    if (kind === 'dir') {
      pinGitdir(dotgit, top)
    } else if (kind === 'file') {
      add(dotgit, 'ro')
      const g = readGitdirPointer(dotgit)
      if (g) pinGitdir(g, top)
    } else if (kind === 'link') {
      // A symlinked .git cannot itself be pinned (a bind follows the link); pin what it
      // names. A box that can rewrite the link still wins — documented residual.
      const g = tryRealpath(dotgit)
      if (g) pinGitdir(g, top)
    }
  }
  return [...pins].map(([p, kind]) => ({ path: p, kind }))
}
