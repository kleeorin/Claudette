import { execFileSync, spawnSync } from 'child_process'
import { existsSync, realpathSync, lstatSync, readlinkSync, copyFileSync, mkdirSync } from 'fs'
import { homedir, tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { SandboxConfig, SandboxMount } from '@claudette/shared'
import { ensureUserSettingsPinnable, settingsJsonPaths } from './configProtection'

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

// --- environment hygiene (SANDBOX.md "env isolation") ------------------------
// The child used to inherit the SERVER's whole environment (spawned with
// env: process.env, and bwrap never cleared it). That handed the sandboxed claude
// the app's own CLAUDETTE_TOKEN — with which it could authenticate to the loopback
// control API and create an UNSANDBOXED session, escaping the box. So we now
// --clearenv and re-set only a vetted allowlist.
//
// Vars claude legitimately needs from the environment (auth for API-key / Bedrock /
// Vertex setups, corporate proxy + CA config). Matched by prefix; passed through
// ONLY when present. Everything else — including CLAUDETTE_* and any unrelated host
// secret (DB URLs, GitHub tokens, …) — is dropped. `claude`'s normal OAuth creds
// live in ~/.claude (a bound mount), not env, so a plain login needs none of these.
const CLAUDE_ENV_ALLOW_PREFIXES = [
  'ANTHROPIC_', 'CLAUDE_CODE_', 'AWS_', 'GOOGLE_', 'GCLOUD_', 'CLOUDSDK_', 'VERTEX', 'BEDROCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
]

// Locale/term vars kept for ANY confined program (harmless, and their absence
// breaks UTF-8 output). Never secret.
const BASE_ENV_KEYS = ['TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'TZ']

// The standard system PATH inside the box. Callers prepend program-specific bin dirs
// (node, claude, a venv) so absolute-launched programs can still find sibling tools.
const BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

// Emit `--setenv K V` pairs for the process-env keys we choose to pass through:
// the always-kept locale set, plus any key matching an allowed prefix — but NEVER a
// CLAUDETTE_* var (our own secrets) even if a prefix would otherwise catch it.
function passthroughEnvArgs(allowPrefixes: string[]): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (k.startsWith('CLAUDETTE')) continue
    const keep = BASE_ENV_KEYS.includes(k) || allowPrefixes.some((p) => k.startsWith(p))
    if (keep) out.push('--setenv', k, v)
  }
  return out
}

// --- confinement policy (SANDBOX.md escape-vector fixes) ---------------------
// Two operator-only opt-outs. Both DEFAULT OFF so a (possibly in-box) request can
// never lower confinement by itself — only the person who launched the server can.
//
//   CLAUDETTE_ALLOW_UNSANDBOXED=1       — permit sessions with sandbox disabled.
//   CLAUDETTE_ALLOW_APP_SOURCE_MOUNT=1  — permit a box to have the server's own
//                                         source tree WRITABLE (re-enables the
//                                         self-modification escape; for dev-in-app).
export function unsandboxedAllowed(): boolean {
  return process.env.CLAUDETTE_ALLOW_UNSANDBOXED === '1'
}
export function appSourceMountAllowed(): boolean {
  return process.env.CLAUDETTE_ALLOW_APP_SOURCE_MOUNT === '1'
}

// The repo/install root of THIS running server — the tree whose code a restart (or a
// `tsx watch` hot-reload) would execute in the unsandboxed host process. Found by
// walking up from this module to the dir that holds both `server/` and `shared/`;
// overridable with CLAUDETTE_APP_ROOT. Cached.
let cachedAppRoot: string | undefined
export function appSourceRoot(): string {
  if (cachedAppRoot) return cachedAppRoot
  const override = process.env.CLAUDETTE_APP_ROOT
  if (override) return (cachedAppRoot = path.resolve(override))
  let dir = path.dirname(fileURLToPath(import.meta.url))   // …/server/src/claude
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'server')) && existsSync(path.join(dir, 'shared'))) return (cachedAppRoot = dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Fallback: server/src/claude → repo root is three levels up.
  return (cachedAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'))
}

// Repo paths that end up EXECUTED on the host — what the self-modification escape
// needs writable (edit one → a reload/restart, host shell invocation, or operator
// browser runs it unsandboxed). Beyond the server process's own source this covers
// runtime-imported node_modules, the built web assets served to the operator's
// browser, the launch/utility scripts run from the operator's host shell, and the
// package manifests that drive host npm builds. Files bind fine: bwrap --ro-bind
// works on files as well as dirs.
function appSourceDirs(): string[] {
  const root = appSourceRoot()
  return [
    'server', 'shared',                        // executed by the server process
    'node_modules',                            // imported at runtime by the unsandboxed server
    'web/dist',                                // served from disk to the authenticated operator browser
    'launch.sh', 'rc_launch.sh', 'scripts',    // run on the HOST by the operator's shell
    'package.json', 'package-lock.json',       // drive host npm build/workspace scripts
  ].map((p) => path.join(root, p)).filter((d) => existsSync(d))
}

// Read-only overlays that keep the server's own source read-only inside a box that
// would OTHERWISE expose it writable (SANDBOX.md "Self-modification escape"). Emitted
// only when some rw mount is an ancestor-or-equal of a source dir — so we never REVEAL
// source to a session that didn't already mount it, and (because they're deeper paths)
// bwrap layers them ON TOP of the broader rw bind, making just that subtree ro. The
// rest of a rw project (web/, docs, scratchpad, …) stays writable. Opt out to keep the
// source rw (dev-in-app) with CLAUDETTE_ALLOW_APP_SOURCE_MOUNT=1.
function appSourceProtections(dataMounts: SandboxMount[]): SandboxMount[] {
  if (appSourceMountAllowed()) return []
  const out: SandboxMount[] = []
  for (const dir of appSourceDirs()) {
    const rd = path.resolve(dir)
    const exposedRw = dataMounts.some((m) => {
      if (m.mode !== 'rw') return false
      const mp = path.resolve(m.path)
      return mp === rd || rd.startsWith(mp + path.sep)
    })
    if (exposedRw) out.push({ path: rd, mode: 'ro' })
  }
  return out
}

// `~/.claude/settings.json` and a project `<cwd>/.claude/settings.json` can define
// hooks + MCP servers that Claude runs as shell. Both sit in rw-mounted config dirs,
// so a confined session could write a malicious hook that later runs on the HOST when
// an unsandboxed session reads it (SANDBOX.md "cross-session hook poisoning"). Pin them
// read-only over the rw config binds — same trick as appSourceProtections. Existing
// hooks still FIRE (ro blocks writes, not reads); only writing NEW hooks from the box
// is stopped. Allow-always still persists to the local scope (settings.local.json, rw).
// The user-scope create-after-launch gap (a ~/.claude/settings.json that did NOT exist
// at launch) is closed by ensureUserSettingsPinnable() (called in wrapSandbox), which
// materializes a valid `{}` so the ro-bind below has a real file to pin. The
// neutralization of anything that still slips through (settings.local.json, a project
// settings.json created from scratch, pre-existing hooks) is Layer 2 (configProtection.ts).
function hookSettingsProtections(cwd: string): SandboxMount[] {
  return [
    path.join(claudeConfigDir(), 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
  ].filter((f) => existsSync(f)).map((f) => ({ path: path.resolve(f), mode: 'ro' as const }))
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

export function resetSandboxProbe(): void { cachedAvailable = undefined; whichCache.clear() }

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
// Build the bwrap argv up to (but not including) the program: the system baseline,
// the given data mounts (bound rw/ro, shallowest-first), the dropped-cwd guard, and
// `--chdir cwd --setenv HOME`. Shared by wrapSandbox (claude) and wrapCommand (any
// program, e.g. the Jupyter server) so both confine identically. Callers append their
// own extra --setenv and the program+argv.
function bwrapBaseArgs(cwd: string, dataMounts: SandboxMount[]): string[] {
  const home = homedir()
  const args: string[] = [
    // Start from an EMPTY environment (see CLAUDE_ENV_ALLOW_PREFIXES): the child must
    // not inherit the server's env, which carries CLAUDETTE_TOKEN. Everything the
    // program needs is re-set explicitly below / by the caller. --clearenv must come
    // before every --setenv, since it wipes the env at the point it appears.
    '--clearenv',
    '--unshare-ipc', '--unshare-pid', '--unshare-uts',
    // NB: deliberately NO --unshare-net (shared network → loopback MCP + internet).
    '--die-with-parent',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/etc', '/etc',
    // Re-seed a safe baseline env. A caller that needs node/claude/venv on PATH
    // overrides PATH with a fuller value AFTER this (last --setenv for a key wins).
    '--setenv', 'PATH', BASE_PATH,
    ...passthroughEnvArgs([]),   // locale/TZ only at the base; program creds added per-caller
  ]
  // usrmerge: recreate /bin /sbin /lib /lib64 as symlinks when the host has them as
  // symlinks (so the dynamic loader resolves); ro-bind them if they're real dirs.
  for (const d of ['/bin', '/sbin', '/lib', '/lib64', '/libx32']) {
    if (!existsSync(d)) continue
    if (isSymlink(d)) args.push('--symlink', readlinkSafe(d), d)
    else args.push('--ro-bind', d, d)
  }

  // Emit ALL binds shallowest-path-first so a rw pocket nested in a ro tree layers
  // correctly (bwrap applies binds in argv order; a later, deeper bind wins). Fold in
  // the app-source ro overlays (self-modification fix): being deeper than the rw mount
  // that exposes them, they sort AFTER it and win, pinning the server's own source ro.
  const allMounts = sortShallowFirst([...dataMounts, ...appSourceProtections(dataMounts)])
  // The box-WRITABLE mountpoints (by their logical/dest path — that's where the box
  // writes, regardless of where a symlink source points). Used to catch a dangerous
  // symlinked mount source below.
  const rwRoots = allMounts
    .filter((m) => m.mode === 'rw' && existsSync(m.path))
    .map((m) => path.resolve(m.path))
  for (const m of allMounts) {
    if (!existsSync(m.path)) continue
    if (isUnsafeSymlinkMount(m.path, rwRoots)) continue   // escape guard (see fn)
    args.push(m.mode === 'rw' ? '--bind' : '--ro-bind', m.path, m.path)
  }

  // `--chdir cwd` (below) needs cwd to EXIST inside the sandbox. It does whenever a
  // mount lies on cwd's lineage: cwd itself, an ancestor (cwd sits inside it), or a
  // descendant like <cwd>/.claude (whose bind auto-creates the parent cwd). Only if
  // NOTHING touches that lineage do we present cwd as an empty READ-ONLY mountpoint
  // (an ro-bound empty dir, NOT a writable `--dir`): chdir still resolves and the
  // project stays invisible, but writes to cwd fail HARD (EROFS) instead of silently
  // landing in throwaway tmpfs and being lost.
  const c = path.resolve(cwd)
  const cwdReachable = allMounts.some((m) => {
    if (!existsSync(m.path)) return false
    const mp = path.resolve(m.path)
    return mp === c || c.startsWith(mp + path.sep) || mp.startsWith(c + path.sep)
  })
  if (cwd && !cwdReachable) {
    const empty = emptyMountpoint()
    // Refuse to fall back to a writable `--dir`: that would silently swallow any write
    // to the dropped cwd. Fail the launch loudly instead (surfaced as an exited session).
    if (!empty) throw new Error(`sandbox: could not create a read-only mountpoint for the dropped cwd (${cwd}); refusing to bind a writable one that would silently lose writes`)
    args.push('--ro-bind', empty, cwd)
  }

  args.push('--chdir', cwd, '--setenv', 'HOME', home)
  return args
}

export function wrapSandbox(cfg: SandboxConfig, claudeArgv: string[], cwd: string): SandboxSpawn {
  const home = homedir()
  // Runtime baseline. Two kinds: the dirs claude needs to EXECUTE (DNS, claude/node
  // installs), and the OBLIGATORY data mounts — the global config dir (~/.claude,
  // where creds + memory live) and the project-local .claude — both rw. These are the
  // only enforced data mounts: they're always present so Claude keeps its config and
  // memory even when the caller makes cwd read-only or drops it entirely.
  const baseline: SandboxMount[] = [
    ...dnsMounts(),
    ...runtimeInstallMounts(),
    { path: claudeConfigDir(), mode: 'rw' },
    { path: path.join(cwd, '.claude'), mode: 'rw' },   // local .claude (skipped below if absent)
  ]
  // User mounts as-is. cwd is NO LONGER force-added, so it's fully optional — rw (the
  // default a new session seeds), ro, or removed. De-dupe baseline+user TOGETHER by path
  // (rw wins over ro for the same folder, see dedupeMounts): this keeps the obligatory
  // rw config dirs writable even if the user also lists them ro, and — crucially — makes
  // the emitted box identical to what sessionDataMounts()/sandboxPathAccess() authorize
  // (that path also dedupes baseline+user together), so the out-of-band authorizer never
  // diverges from the real mount set.
  // Layer 1: make the user-scope settings.json a real `{}` when absent so the ro-bind
  // below actually pins it (closes create-after-launch for ~/.claude). Must run BEFORE
  // hookSettingsProtections, which only ro-binds files that exist.
  ensureUserSettingsPinnable()
  const args = bwrapBaseArgs(cwd, [...dedupeMounts([...baseline, ...cfg.mounts]), ...hookSettingsProtections(cwd)])

  // Claude's main config lives at $HOME/.claude.json — a FILE next to the config
  // dir, NOT inside it. We can't bind that file directly (it's saved via write-tmp
  // + atomic rename, which fails EBUSY onto a bind-mounted file), and we don't mount
  // $HOME. Instead point CLAUDE_CONFIG_DIR at the (already rw-mounted) config dir, so
  // Claude keeps .claude.json at <configDir>/.claude.json — a real file in a bound
  // dir, where atomic saves work. Seed it once from the host's ~/.claude.json so the
  // sandbox starts with the user's prefs/trust instead of a blank config.
  const configDir = claudeConfigDir()
  ensureSandboxConfigJson(configDir, home)
  args.push('--setenv', 'CLAUDE_CONFIG_DIR', configDir)
  // Under --clearenv the child starts with only BASE_PATH. Put node + the claude
  // launcher's dir on PATH so claude (and any tool/subprocess it spawns) resolves —
  // this --setenv PATH comes after the base one, so it wins.
  const claudeBin = which('claude') ?? 'claude'
  const binDirs = [nodeBinDir(), path.dirname(claudeBin)].filter(Boolean) as string[]
  if (binDirs.length) args.push('--setenv', 'PATH', `${binDirs.join(':')}:${BASE_PATH}`)
  // Pass through claude's own auth/proxy/CA env (API-key/Bedrock/Vertex/corp setups),
  // never CLAUDETTE_TOKEN. A plain OAuth login needs none of these (creds live in the
  // bound ~/.claude), so this is a no-op for the common case.
  args.push(...passthroughEnvArgs(CLAUDE_ENV_ALLOW_PREFIXES))
  // Finally the program: `claude …`. Resolve to an absolute path (PATH inside the
  // sandbox is minimal); fall back to the bare name if resolution fails.
  args.push(claudeBin, ...claudeArgv)
  return { command: BWRAP, args }
}

// Confine an ARBITRARY program (not claude) with the SAME box as a session — used to
// run the Jupyter server (and thus its kernels) inside the session's sandbox so
// notebook execution can't reach outside the mounts (SANDBOX.md "known limitation").
// Unlike wrapSandbox this mounts ONLY the caller's data mounts (no ~/.claude — the
// kernel must NOT see Claude's credentials), plus any `extraMounts`/`extraEnv` the
// program needs (Jupyter: its data dir ro for kernelspecs, a writable runtime dir).
export function wrapCommand(
  cfg: SandboxConfig,
  cwd: string,
  program: string,
  argv: string[],
  opts: { extraMounts?: SandboxMount[]; extraEnv?: Record<string, string> } = {},
): SandboxSpawn {
  const args = bwrapBaseArgs(cwd, [...dedupeMounts(cfg.mounts), ...(opts.extraMounts ?? [])])
  const bin = which(program) ?? program
  // Under --clearenv, put the program's own bin dir on PATH (a venv/conda python, or
  // node) so it finds its sibling tools. Deliberately NO claude auth passthrough here
  // — a confined Jupyter/kernel must not inherit Claude's credentials (or the app's).
  args.push('--setenv', 'PATH', `${path.dirname(bin)}:${BASE_PATH}`)
  for (const [k, v] of Object.entries(opts.extraEnv ?? {})) args.push('--setenv', k, v)
  args.push(bin, ...argv)
  return { command: BWRAP, args }
}

// Is `p` visible (with its real contents) inside the box built from `mounts`? True
// when some mount IS p or an ANCESTOR of p — its bind brings p in. A descendant mount
// does NOT count: it only auto-creates empty ancestor dirs, so a binary living at p
// wouldn't actually appear. Used to decide whether a venv interpreter chosen for a
// confined Jupyter server needs its prefix ro-bound so the box can exec it.
export function pathVisibleInSandbox(mounts: SandboxMount[], p: string): boolean {
  const t = path.resolve(p)
  return mounts.some((m) => {
    if (!existsSync(m.path)) return false
    const mp = path.resolve(m.path)
    return mp === t || t.startsWith(mp + path.sep)
  })
}

// bwrap's `--bind SRC DEST` FOLLOWS a symlink at SRC and mounts its target. So a mount
// whose source is a symlink hands the choice of bound target to whoever created that
// link. When the link node lives in a box-WRITABLE area, that "whoever" can be a
// confined session: it plants `<cwd>/.claude -> /` in its rw cwd and, on the next
// launch, gets `/` bound rw at that mountpoint — a full filesystem escape (SANDBOX.md
// "Symlinked-mount escape"; verified live). Refuse such a mount. A symlink whose PARENT
// is NOT box-writable was created by the host (e.g. ~/.claude on a dotfiles symlink
// farm) and is safe — bwrap binds its realpath as intended. `rwRoots` are the LOGICAL
// dest paths of the rw mounts (where the box writes), never a symlink's target, so a
// malicious link can't launder itself into the writable set.
function isUnsafeSymlinkMount(p: string, rwRoots: string[]): boolean {
  if (!isSymlink(p)) return false
  const parent = tryRealpath(path.dirname(path.resolve(p))) ?? path.dirname(path.resolve(p))
  const boxWritable = rwRoots.some((r) => parent === r || parent.startsWith(r + path.sep))
  if (boxWritable) {
    console.warn(`[sandbox] refusing symlinked mount source ${p} → ${tryRealpath(p) ?? '?'}: its parent is writable inside the box, so binding it would follow the link out of the sandbox (potential escape). Mount the real path instead.`)
  }
  return boxWritable
}

// The DATA mounts a session's box actually exposes: the obligatory rw config dirs
// (global ~/.claude + the local <cwd>/.claude when present) plus the caller's mounts.
// Excludes the runtime/DNS baseline (node/claude/resolv.conf — no user files there).
// Mirrors wrapSandbox's data-mount set so an OUT-OF-BAND file operation done on a
// session's behalf (e.g. the notebook MCP tools, which run UNSANDBOXED in the server
// process) can be authorized against exactly what the box itself could reach.
export function sessionDataMounts(cfg: SandboxConfig, cwd: string): SandboxMount[] {
  const baseline: SandboxMount[] = [
    { path: claudeConfigDir(), mode: 'rw' },
    ...(existsSync(path.join(cwd, '.claude')) ? [{ path: path.join(cwd, '.claude'), mode: 'rw' as const }] : []),
  ]
  const mounts = dedupeMounts([...baseline, ...cfg.mounts])
  // Include the same ro overlays the box gets (app source + settings.json), or the
  // out-of-band path would authorize writes the box itself refuses. settings.json is
  // pinned ro UNCONDITIONALLY (even when absent) so an in-process actor can't create
  // one where the box's seed bind stops its own tools — matching Layer 1's effect.
  const settingsRo: SandboxMount[] = settingsJsonPaths(cwd).map((p) => ({ path: path.resolve(p), mode: 'ro' as const }))
  const full = [...mounts, ...appSourceProtections(mounts), ...settingsRo]
  // Apply the SAME symlinked-mount escape guard the box does (bwrapBaseArgs), or the two
  // diverge: bwrap drops a box-writable symlinked mount source (e.g. a planted
  // <cwd>/.claude -> /outside) via isUnsafeSymlinkMount, but this authorizer would
  // otherwise realpath that mount ROOT to its target and trust it — authorizing an
  // out-of-band notebook write to a path the box itself refuses to bind. rwRoots are the
  // LOGICAL rw dest paths (never a link's target), exactly as the box computes them.
  const rwRoots = full.filter((m) => m.mode === 'rw' && existsSync(m.path)).map((m) => path.resolve(m.path))
  return full.filter((m) => !isUnsafeSymlinkMount(m.path, rwRoots))
}

// Canonicalize a path for containment testing: realpath if it exists, else the
// realpath of its parent + the basename (so a not-yet-created file is judged by the
// real directory it would land in). Resolving symlinks here is what stops a symlink
// under a mount from redirecting the write/read outside it.
function canonicalizeForAccess(p: string): string {
  const abs = path.resolve(p)
  const real = tryRealpath(abs)
  if (real) return real
  const parentReal = tryRealpath(path.dirname(abs))
  return parentReal ? path.join(parentReal, path.basename(abs)) : abs
}

// Can the box built for (cfg, cwd) READ / WRITE the host path `p`? A path is readable
// when it lies inside ANY data mount, writable only inside a `rw` one; the DEEPEST
// containing mount decides (matching bwrap's shallow-first layering, where a nested
// mount wins). Both the target and the mount roots are canonicalized (symlinks
// resolved) so neither side can be spoofed with a link. Used to confine server-side
// file operations acting for a session to the same paths the session's own tools have.
export function sandboxPathAccess(cfg: SandboxConfig, cwd: string, p: string): { read: boolean; write: boolean } {
  const target = canonicalizeForAccess(p)
  // Resolve precedence with the SAME rule bwrap uses — shallowest-first emission, last
  // containing bind wins — so this out-of-band authorizer can't diverge from the box
  // (a "deepest-wins" variant drifts on same-path rw/ro ties, where bwrap appends the
  // ro overlay last ⇒ it wins; iterating in emission order and taking the last match
  // reproduces that for ties and any future overlay alike).
  let match: SandboxMount | undefined
  for (const m of sortShallowFirst(sessionDataMounts(cfg, cwd))) {
    const root = canonicalizeForAccess(m.path)
    if (target === root || target.startsWith(root + path.sep)) match = m
  }
  return { read: !!match, write: match?.mode === 'rw' }
}

// Is `p` inside a box-WRITABLE (rw) mount, judged by LOGICAL path (path.resolve, NOT
// realpath)? Deliberately does NOT follow symlinks — it answers "could a confined
// session have PLACED or redirected something at this path", which is what decides
// whether e.g. an interpreter discovered there must be probed/run INSIDE the box rather
// than executed on the host (SANDBOX.md "Venv-probe escape"). A symlink the box planted
// at <cwd>/x still has its logical path inside the rw cwd, so it's caught here even
// though its target resolves elsewhere.
export function pathInWritableMount(cfg: SandboxConfig, cwd: string, p: string): boolean {
  const target = path.resolve(p)
  return sessionDataMounts(cfg, cwd).some((m) => {
    if (m.mode !== 'rw') return false
    const mp = path.resolve(m.path)
    return target === mp || target.startsWith(mp + path.sep)
  })
}

// A stable key for a sandbox config at a cwd: same key ⇒ same effective box. Drives
// both the per-session relaunch-on-change detection and the KernelManager's Jupyter
// pool (one confined server per distinct box). 'off' when confinement isn't in force.
export function sandboxKey(cfg: SandboxConfig | undefined, cwd: string): string {
  if (!cfg?.enabled || !sandboxAvailable()) return 'off'
  // Fold in whether the obligatory local <cwd>/.claude currently EXISTS: wrapSandbox
  // binds it only when present, so its appearance/removal changes the real mount set.
  const localClaude = existsSync(path.join(cwd, '.claude')) ? '1' : '0'
  return `on|lc${localClaude}|` + cfg.mounts.map((m) => `${m.mode}:${m.path}`).sort().join(',')
}

// A stable, empty directory to ro-bind onto cwd when the caller dropped cwd and there
// is no local .claude. Read-only so writes to cwd fail EROFS — a plain `--dir` would be
// writable tmpfs that silently swallows writes. Preferred location is the host tmp dir:
// it is NOT itself mounted into the sandbox (the box gets its own tmpfs /tmp), so nothing
// inside can pollute it and cwd stays genuinely empty; the config dir is a fallback.
// Returns null only if NEITHER is writable — a broken host — in which case the caller
// refuses to bind a writable dir and fails the launch loudly.
function emptyMountpoint(): string | null {
  for (const base of [tmpdir(), claudeConfigDir()]) {
    try {
      const dir = path.join(base, '.claudette-sandbox-empty')
      mkdirSync(dir, { recursive: true })
      return dir
    } catch { /* try the next base */ }
  }
  return null
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
  // The obligatory data mounts (global + local .claude) plus the caller's mounts. cwd
  // is NOT assumed — it's listed only if the config actually mounts it, so a session
  // with cwd removed/ro is described honestly.
  const localClaude = path.join(cwd, '.claude')
  const obligatory: SandboxMount[] = [
    { path: claudeConfigDir(), mode: 'rw' },
    ...(existsSync(localClaude) ? [{ path: localClaude, mode: 'rw' as const }] : []),
  ]
  const mounts = sortShallowFirst(dedupeMounts([...cfg.mounts, ...obligatory]))
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

// De-dupe mounts by path. When the SAME path is mounted more than once, the MORE
// PERMISSIVE mode wins — rw beats ro — regardless of list order, so a folder mounted
// both read-only and read-write ends up WRITABLE (a union over the request). This is a
// deliberate "most-permissive" rule, NOT positional: adding an ro then an rw mount of
// one folder (or the reverse) always yields rw, so the box behaves the same however the
// mounts accumulate across a session. It reconciles only entries in THIS list; the
// security ro overlays (appSourceProtections / hookSettingsProtections) are applied
// separately at emission and are NOT weakened by this — they still layer ro on top of
// the broader rw bind (bwrap's deeper/later bind wins there).
function dedupeMounts(mounts: SandboxMount[]): SandboxMount[] {
  const byPath = new Map<string, SandboxMount>()
  for (const m of mounts) {
    const p = path.resolve(m.path)
    const mode: SandboxMount['mode'] = byPath.get(p)?.mode === 'rw' || m.mode === 'rw' ? 'rw' : 'ro'
    byPath.set(p, { path: p, mode })
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

// The directory holding the real `node` binary (following symlinks), or null. Put on
// the sandbox PATH so a confined claude can spawn node/tools under --clearenv.
function nodeBinDir(): string | null {
  const node = which('node')
  if (!node) return null
  return path.dirname(tryRealpath(node) ?? node)
}

// Resolved binary paths (claude/node) don't move within a run; memoize so a launch
// doesn't spawn `sh` ~4× to re-resolve them. Cleared alongside the sandbox probe.
const whichCache = new Map<string, string | null>()
function which(bin: string): string | null {
  const hit = whichCache.get(bin)
  if (hit !== undefined) return hit
  let result: string | null
  try {
    result = execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() || null
  } catch {
    result = null
  }
  whichCache.set(bin, result)
  return result
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
