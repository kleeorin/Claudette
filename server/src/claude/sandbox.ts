import { execFileSync, spawnSync } from 'child_process'
import { existsSync, realpathSync, lstatSync, readlinkSync, copyFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import type { SandboxConfig, SandboxMount } from '@claudette/shared'

// Wraps a `claude …` invocation in a bubblewrap sandbox that confines the process
// to a set of mounts (see SANDBOX.md). We do NOT --unshare-net, so the shared
// network keeps the loopback app-control MCP server and the internet reachable;
// this is a FILESYSTEM firewall only. The recipe here was validated on Ubuntu
// 24.04 / bwrap 0.9.0 (usrmerge symlinks, resolv.conf-into-/run, dynamic claude/
// node/config-dir resolution).
//
// Everything is resolved from the CURRENT process environment (the same env the
// child runs with), never hardcoded, so the mount set follows the machine — local
// or remote, whatever $HOME / CLAUDE_CONFIG_DIR / install paths are.

const BWRAP = 'bwrap'

export interface SandboxSpawn {
  command: string
  args: string[]
}

// --- availability probe ------------------------------------------------------
// `bwrap` can be installed yet unable to create a namespace (e.g. Ubuntu's
// AppArmor userns clamp). The only reliable test is to actually build a throwaway
// sandbox. Bind the whole root ro so the test binary's dynamic loader is present —
// a partial bind fails execvp with a misleading ENOENT and would false-negative.
// Probed once and cached; call resetSandboxProbe() after the host is reconfigured.
let cachedAvailable: boolean | undefined

export function sandboxAvailable(): boolean {
  if (cachedAvailable === undefined) cachedAvailable = probe()
  return cachedAvailable
}

export function resetSandboxProbe(): void { cachedAvailable = undefined }

function probe(): boolean {
  try {
    const r = spawnSync(BWRAP, [
      '--ro-bind', '/', '/',
      '--dev', '/dev', '--proc', '/proc',
      '--unshare-user', '--die-with-parent',
      '/usr/bin/true',
    ], { stdio: 'ignore', timeout: 5000 })
    return r.status === 0
  } catch {
    return false  // bwrap not on PATH, or spawn failed
  }
}

// --- mount recipe ------------------------------------------------------------

// The claude launcher + its versioned install dir, and the node root — all under
// $HOME and versioned, so resolved dynamically. Returns the ro binds claude needs
// to execute. Best-effort: if a path can't be resolved we skip it (claude just
// won't have it, surfaced as a normal startup failure).
function runtimeInstallMounts(): SandboxMount[] {
  const mounts: SandboxMount[] = []
  const claude = which('claude')
  if (claude) {
    mounts.push({ path: claude, mode: 'ro' })                 // ~/.local/bin/claude launcher
    const real = tryRealpath(claude)
    if (real) mounts.push({ path: path.dirname(real), mode: 'ro' })  // …/versions/<v> (the ELF)
  }
  const node = which('node')
  if (node) {
    const real = tryRealpath(node) ?? node
    // node lives at <root>/bin/node — bind <root> so its libs/npm come along.
    mounts.push({ path: real.replace(/\/bin\/node$/, ''), mode: 'ro' })
  }
  return mounts
}

// The global claude config dir (creds/history/session state). RESOLVED like claude
// itself does — CLAUDE_CONFIG_DIR else $HOME/.claude — and bound READ-WRITE (claude
// writes here at runtime; a ro bind breaks startup). Bound at the identical path so
// resolution inside == outside.
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
}

// DNS plumbing so the shared network actually resolves names: /etc/resolv.conf is
// commonly a symlink into /run (systemd-resolved). Bind the symlink's real target
// (and the resolved dir) or DNS silently fails inside the sandbox.
function dnsMounts(): SandboxMount[] {
  const mounts: SandboxMount[] = []
  if (existsSync('/run/systemd/resolve')) mounts.push({ path: '/run/systemd/resolve', mode: 'ro' })
  const real = tryRealpath('/etc/resolv.conf')
  if (real && existsSync(real)) mounts.push({ path: real, mode: 'ro' })
  return mounts
}

// Build the full bwrap argv wrapping `claudeArgv` (the `claude …` args). `cwd` is
// the session's working dir (chdir target + default writable mount from the caller).
export function wrapSandbox(cfg: SandboxConfig, claudeArgv: string[], cwd: string): SandboxSpawn {
  const home = homedir()
  const args: string[] = [
    '--unshare-ipc', '--unshare-pid', '--unshare-uts',
    // NB: deliberately NO --unshare-net (shared network → loopback MCP + internet).
    '--die-with-parent',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/etc', '/etc',
  ]
  // usrmerge: recreate /bin /sbin /lib /lib64 as symlinks when the host has them as
  // symlinks (so the dynamic loader resolves); ro-bind them if they're real dirs.
  for (const d of ['/bin', '/sbin', '/lib', '/lib64', '/libx32']) {
    if (!existsSync(d)) continue
    if (isSymlink(d)) args.push('--symlink', readlinkSafe(d), d)
    else args.push('--ro-bind', d, d)
  }

  // Runtime baseline: DNS, claude/node installs, the (rw) global config dir.
  const baseline: SandboxMount[] = [
    ...dnsMounts(),
    ...runtimeInstallMounts(),
    { path: claudeConfigDir(), mode: 'rw' },
  ]

  // User mounts on top, with cwd (rw) as the default writable mount if the caller's
  // config didn't already cover it. De-dupe by path (last wins), drop non-existent.
  const userMounts = dedupeMounts([...cfg.mounts, { path: cwd, mode: 'rw' as const }])

  // Emit ALL binds shallowest-path-first so a rw pocket nested in a ro tree layers
  // correctly (bwrap applies binds in argv order; a later, deeper bind wins).
  const allMounts = sortShallowFirst([...baseline, ...userMounts])
  for (const m of allMounts) {
    if (!existsSync(m.path)) continue
    args.push(m.mode === 'rw' ? '--bind' : '--ro-bind', m.path, m.path)
  }

  // Claude's main config lives at $HOME/.claude.json — a FILE next to the config
  // dir, NOT inside it. We can't bind that file directly (it's saved via write-tmp
  // + atomic rename, which fails EBUSY onto a bind-mounted file), and we don't mount
  // $HOME. Instead point CLAUDE_CONFIG_DIR at the (already rw-mounted) config dir, so
  // Claude keeps .claude.json at <configDir>/.claude.json — a real file in a bound
  // dir, where atomic saves work. Seed it once from the host's ~/.claude.json so the
  // sandbox starts with the user's prefs/trust instead of a blank config.
  const configDir = claudeConfigDir()
  ensureSandboxConfigJson(configDir, home)
  args.push('--chdir', cwd, '--setenv', 'HOME', home, '--setenv', 'CLAUDE_CONFIG_DIR', configDir)
  // Finally the program: `claude …`. Resolve to an absolute path (PATH inside the
  // sandbox is minimal); fall back to the bare name if resolution fails.
  const claudeBin = which('claude') ?? 'claude'
  args.push(claudeBin, ...claudeArgv)
  return { command: BWRAP, args }
}

// Seed <configDir>/.claude.json from the host's ~/.claude.json if the former doesn't
// exist yet, so a first sandboxed run inherits the user's config (trust, prefs,
// onboarding) rather than starting blank + emitting a "config not found" warning.
// Only copies when absent — never clobbers a config the sandbox has since evolved.
function ensureSandboxConfigJson(configDir: string, home: string): void {
  try {
    const dest = path.join(configDir, '.claude.json')
    const src = path.join(home, '.claude.json')
    if (!existsSync(dest) && existsSync(src)) copyFileSync(src, dest)
  } catch { /* best-effort; claude will just create a fresh one */ }
}

// A system-prompt note that makes a sandboxed session AWARE of its confinement, so
// it explains the boundary instead of treating a hidden path as missing and hunting
// for it. Lists the same user mounts the wrap exposes (baseline runtime dirs omitted
// as noise). See SANDBOX.md ("Sandbox-awareness").
export function sandboxSystemPrompt(cfg: SandboxConfig, cwd: string): string {
  const mounts = sortShallowFirst(dedupeMounts([...cfg.mounts, { path: cwd, mode: 'rw' as const }]))
  const list = mounts.map((m) => `  - ${m.path} (${m.mode === 'rw' ? 'read-write' : 'read-only'})`).join('\n')
  return [
    'FILESYSTEM SANDBOX: you are running inside a bubblewrap sandbox. You can ONLY',
    'read/write these paths (plus your own Claude runtime/config dirs):',
    list,
    'Everything else on the host is INVISIBLE — any path outside that list returns',
    '"No such file or directory" EVEN IF IT EXISTS on the host. So if the user refers',
    'to a file or folder you cannot find, do NOT conclude it is missing and do NOT go',
    'hunting for it elsewhere. It is almost certainly outside your sandbox. Say so, and',
    'ask the user to add it as a mount via the sandbox control (the lock chip in the',
    'session header) and relaunch. Network access is unrestricted.',
  ].join('\n')
}

// --- helpers -----------------------------------------------------------------

// De-dupe mounts by path, later entries winning (so an explicit rw cwd overrides a
// broader ro of the same path). Preserves the winning entry's mode.
function dedupeMounts(mounts: SandboxMount[]): SandboxMount[] {
  const byPath = new Map<string, SandboxMount>()
  for (const m of mounts) {
    const p = path.resolve(m.path)
    byPath.set(p, { path: p, mode: m.mode })
  }
  return [...byPath.values()]
}

// Sort by path depth (fewer separators first), then lexically, so nested binds are
// emitted after their parents.
function sortShallowFirst(mounts: SandboxMount[]): SandboxMount[] {
  return [...mounts].sort((a, b) => {
    const da = a.path.split(path.sep).length
    const db = b.path.split(path.sep).length
    return da - db || a.path.localeCompare(b.path)
  })
}

function which(bin: string): string | null {
  try {
    return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

function tryRealpath(p: string): string | null {
  try { return realpathSync(p) } catch { return null }
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}

function readlinkSafe(p: string): string {
  // Return the symlink TARGET as bwrap wants it (e.g. 'usr/bin' for /bin). Fall back
  // to a best guess if the read fails.
  try { return readlinkSync(p) } catch { return p.replace(/^\//, 'usr/') }
}
