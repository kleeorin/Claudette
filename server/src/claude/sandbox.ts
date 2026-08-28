import { execFileSync, spawnSync } from 'child_process'
import { existsSync, realpathSync, lstatSync, readlinkSync, copyFileSync, mkdirSync, readdirSync } from 'fs'
import { homedir, tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { SandboxConfig, SandboxMount } from '@claudette/shared'
import { ensureUserSettingsPinnable, settingsJsonPaths } from './configProtection'
import { dataDir } from '../util/dataDir'
import { tokenFilePath } from '../auth'

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
// An overlay has to be emitted at the path the BOX WRITES THROUGH — the dest under the rw
// mount — not at the source dir's realpath. bwrap creates a mountpoint at the LITERAL dest,
// so an overlay at a path nothing else binds just materializes an unrelated empty dir inside
// the box and protects nothing, while the real subtree stays writable through the rw mount.
// Returns that dest when `rd` is inside the mount by either spelling, else null.
function overlayDestFor(mount: SandboxMount, rd: string): string | null {
  if (mount.mode !== 'rw') return null
  const logical = path.resolve(mount.path)
  // Same both-ways probe as isUnsafeSymlinkMount, for the same reason and the same bug.
  for (const root of [logical, tryRealpath(logical)]) {
    if (root === null) continue
    if (root === rd) return logical
    if (rd.startsWith(root + path.sep)) return path.join(logical, rd.slice(root.length + 1))
  }
  return null
}

// The dirs that must be INVISIBLE inside every box, whatever the caller mounted.
//
// DIFFERENT IN KIND FROM appSourceProtections, and the difference is the whole point: there,
// `ro` suffices because WRITING the app source is the escape and reading it is harmless.
// Here READING IS THE ESCAPE. `~/.config/claudette/token` is the loopback auth token; a box
// that reads it can authenticate to the control API (we deliberately do not --unshare-net,
// see the header) and POST /api/session/create — which is auth-gated and therefore passes
// `trusted: true` — creating an UNSANDBOXED session immediately, with no restart. An
// --ro-bind would still permit that read and would look like a protection. So these are
// bound over with an EMPTY directory instead: present, read-only, and containing nothing.
//
// The same dir also holds sessions.json, which restore() replays as trusted, so a writable
// copy lets a box grant itself teamEmploy/sandbox:{enabled:false} across a restart; plus the
// hook-poisoning ledger and team-notes, which are read-then-influence channels.
//
// BOTH PATHS, INDEPENDENTLY: dataDir() honours CLAUDETTE_DATA_DIR and tokenFilePath() does
// not, so an override splits them and a protection covering only one re-opens the other.
//
// dataDir.ts and auth.ts each justify their location with "~/.config is never bind-mounted
// into a session sandbox". That is true of the OBLIGATORY mounts only — a user who mounts
// $HOME, a parent of it, or / defeats it with no symlink and no bug. A rationale copied
// between two files is a fact nobody owns; this function is the owner.
function stateDirsToHide(): string[] {
  const dirs = [path.resolve(dataDir()), path.resolve(path.dirname(tokenFilePath()))]
  return [...new Set(dirs)]
}

// Where the BOX sees each hidden dir, given the mounts. Reuses overlayDestFor for the same
// reason appSourceProtections does: an overlay bound at the canonical path binds a path
// nothing else binds, and (Critic proved live) sorts first under shallow-first ordering and
// LOSES the last-match-wins race — actively defeated while appearing present.
function hiddenStateDests(dataMounts: SandboxMount[]): string[] {
  const out: string[] = []
  for (const dir of stateDirsToHide()) {
    for (const m of dataMounts) {
      const dest = overlayDestFor(m, dir)
      if (dest && !out.includes(dest)) out.push(dest)
    }
  }
  return out
}

function appSourceProtections(dataMounts: SandboxMount[]): SandboxMount[] {
  if (appSourceMountAllowed()) return []
  const out: SandboxMount[] = []
  for (const dir of appSourceDirs()) {
    // `rd` is a REALPATH: appSourceRoot() derives it from import.meta.url, which Node has
    // already resolved through symlinks. It used to be compared only against the LOGICAL
    // mount path, so a checkout whose ancestor is a symlink — Claudette at
    // /mnt/data/work/Claudette with `~/work` → /mnt/data/work mounted rw — matched nothing,
    // NO overlay was emitted, and the box could write the server's own source. The next
    // `tsx watch` reload then executes attacker code in the UNSANDBOXED server process.
    // Same root cause as the symlink-guard bug above, different consequence. (Verified live.)
    const rd = path.resolve(dir)
    for (const m of dataMounts) {
      const dest = overlayDestFor(m, rd)
      // Deduped by path at emission (dedupeMounts) — but note the overlay is keyed on the
      // DEST, so two rw mounts reaching the same source dir correctly pin both spellings.
      if (dest && !out.some((o) => o.path === dest)) out.push({ path: dest, mode: 'ro' })
    }
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
  // settingsJsonPaths, not a second copy of the same list: this and configProtection are
  // two layers of ONE defence, and a scope that appears in one but not the other is a
  // hole. They were written out separately here.
  return settingsJsonPaths(cwd)
    .filter((f) => existsSync(f)).map((f) => ({ path: path.resolve(f), mode: 'ro' as const }))
}

// The OBLIGATORY data mounts every confined session gets, whatever the caller asked for:
// the global config dir (creds + memory) and the project-local .claude, both rw. They are
// always present so Claude keeps its config and memory even when the caller makes cwd
// read-only or drops it entirely.
//
// One spelling, because three had already drifted: wrapSandbox added <cwd>/.claude
// unconditionally (relying on a later existsSync filter at bind time) while
// sessionDataMounts and sandboxSystemPrompt each gated it inline — and the whole design
// here rests on the box, the out-of-band authorizer and the prompt describing the SAME
// set. `existing` is for the two callers that need the list to be true right now rather
// than filtered later.
function obligatoryMounts(cwd: string, existing = true): SandboxMount[] {
  const local = path.join(cwd, '.claude')
  return [
    { path: claudeConfigDir(), mode: 'rw' as const },
    ...(!existing || existsSync(local) ? [{ path: local, mode: 'rw' as const }] : []),
  ]
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
  // Resolve the test binary rather than hardcoding /usr/bin/true, which everything else
  // in this file already refuses to do (see the header). On a layout without it — a
  // busybox userland, a non-usrmerge host — the probe failed for a reason that has
  // nothing to do with whether bwrap works, `sandboxAvailable()` latched false, and every
  // session the operator had explicitly configured `enabled: true` then ran UNCONFINED on
  // the host with only the `sandboxed` flag in the UI to say so. A capability probe that
  // can't run its own test must not be read as "confinement is unavailable".
  // `command -v true` reports the shell BUILTIN as the bare word "true" on most shells,
  // which is not something bwrap can exec — so only an absolute path counts as a hit.
  const trueBin = which('true')
  const argv = trueBin?.startsWith('/')
    ? [trueBin]
    : ['/bin/sh', '-c', ':']   // POSIX-guaranteed fallback; exits 0 and needs no coreutils
  try {
    const r = spawnSync(BWRAP, [
      '--ro-bind', '/', '/',
      '--dev', '/dev', '--proc', '/proc',
      '--unshare-user', '--die-with-parent',
      ...argv,
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

// The NVIDIA control nodes a CUDA context needs alongside the per-card nvidia<N>.
// `nvidiactl` and `nvidia-uvm` are NOT optional — without them CUDA init fails even
// when /dev/nvidia0 is present; the other two cover profiling and graphics.
const NVIDIA_CONTROL_NODES = new Set(['nvidiactl', 'nvidia-modeset', 'nvidia-uvm', 'nvidia-uvm-tools'])

// The host GPU device nodes handed to a `gpu: true` box — DISCOVERED from /dev, never
// configured. The set varies by driver and card count (nvidia0..N, the MIG capability
// nodes under nvidia-caps, /dev/dri for the DRM stack that AMD/Intel compute and any
// GL/Vulkan work goes through, /dev/kfd for ROCm), and letting the operator type a path
// would reintroduce exactly the arbitrary-bind surface this flag exists to bound.
// Returns [] on a GPU-less host, which makes the toggle an honest no-op there.
export function gpuDevicePaths(): string[] {
  let entries: string[] = []
  try { entries = readdirSync('/dev') } catch { return [] }
  const out = entries
    .filter((n) => /^nvidia\d+$/.test(n) || NVIDIA_CONTROL_NODES.has(n))
    .map((n) => `/dev/${n}`)
  // Bound whole (they're directories, not char devices, but --dev-bind is still what
  // carries the device nodes inside them).
  for (const d of ['/dev/nvidia-caps', '/dev/dri', '/dev/kfd']) if (existsSync(d)) out.push(d)
  return out.sort()
}

// Build the full bwrap argv wrapping `claudeArgv` (the `claude …` args). `cwd` is
// the session's working dir (chdir target + default writable mount from the caller).
// Build the bwrap argv up to (but not including) the program: the system baseline,
// the given data mounts (bound rw/ro, shallowest-first), the dropped-cwd guard, and
// `--chdir cwd --setenv HOME`. Shared by wrapSandbox (claude) and wrapCommand (any
// program, e.g. the Jupyter server) so both confine identically. Callers append their
// own extra --setenv and the program+argv.
function bwrapBaseArgs(cwd: string, dataMounts: SandboxMount[], gpu = false): string[] {
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

  // HIDE THE STATE DIR. Emitted AFTER every data mount so it layers on top (bwrap: later
  // and deeper binds win), and bound from an EMPTY directory rather than ro over the real
  // one — see stateDirsToHide: reading is the escape here, so read-only is not a fix.
  // Refusing loudly beats binding nothing: a silent skip would leave the token exposed while
  // the code reads as though it were protected, which is the failure shape this whole file
  // keeps re-learning.
  for (const dest of hiddenStateDests(allMounts)) {
    const empty = emptyMountpoint()
    if (!empty) throw new Error(`sandbox: could not create an empty mountpoint to hide ${dest}; refusing to launch with the state dir (auth token, session roster) exposed to the box`)
    args.push('--ro-bind', empty, dest)
  }

  // GPU passthrough (SandboxConfig.gpu). MUST be --dev-bind: an ordinary --bind carries
  // MS_NODEV, which leaves the node present but DEAD — nvidia-smi reports "Insufficient
  // Permissions" and CUDA sees no device, a failure that looks like a driver problem
  // rather than a mount one. Emitted AFTER `--dev /dev` above so these layer on top of
  // the minimal devtmpfs bwrap puts there (argv order decides); /dev is never a data
  // mount, so nothing in between can shadow them. The userspace half needs no work —
  // libcuda/libnvidia live under the already ro-bound /usr.
  if (gpu) for (const dev of gpuDevicePaths()) args.push('--dev-bind', dev, dev)

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
    ...obligatoryMounts(cwd, /* existing */ false),   // local .claude skipped below if absent
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
  const args = bwrapBaseArgs(cwd, [...dedupeMounts([...baseline, ...cfg.mounts]), ...hookSettingsProtections(cwd)], cfg.gpu)

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
  // GPU rides along from the session's config, so a confined notebook kernel gets the
  // same devices Claude does — that (not the CLI) is where most GPU work actually runs.
  const args = bwrapBaseArgs(cwd, [...dedupeMounts(cfg.mounts), ...(opts.extraMounts ?? [])], cfg.gpu)
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
  return symlinkMountRefusal(p, rwRoots) !== undefined
}

// The same computation as isUnsafeSymlinkMount, returning WHY rather than merely whether.
// It is the primitive and the boolean above is the thin wrapper, not the other way round:
// two copies of this rule would be free to drift, and the one that drifted would be the one
// nobody was watching. See sessionDataMountPlan for what consumes the reason.
function symlinkMountRefusal(p: string, rwRoots: string[]): MountExclusionReason | undefined {
  if (!isSymlink(p)) return undefined
  // Test the parent BOTH WAYS — logical and realpath'd — and refuse if EITHER lands in a
  // box-writable root. Only the realpath'd form used to be probed, against roots that are
  // deliberately LOGICAL (see the note above). Those two agree only while no ancestor of
  // any mount is itself a symlink; the moment one is — `~/work` → `/mnt/data/work`, an
  // ordinary two-volume layout — the realpath'd parent matches no logical root, the guard
  // silently permits the mount, and the escape it exists to stop is back. It is not a
  // contrived setup, and nothing about the failure is visible: the refusal warning below
  // simply never prints. (Verified live: `/` bound rw into the box.)
  //
  // Keep the roots logical — that is what stops a malicious link laundering itself into
  // the writable set — and make the PROBE the thing that covers both spellings. OR-ing is
  // strictly more restrictive than either test alone, so this can only refuse more, never
  // less.
  const logicalParent = path.dirname(path.resolve(p))
  const realParent = tryRealpath(logicalParent)
  const under = (dir: string): boolean => rwRoots.some((r) => dir === r || dir.startsWith(r + path.sep))
  const boxWritable = under(logicalParent) || (realParent !== null && under(realParent))
  if (!boxWritable) return undefined
  const message = `refusing symlinked mount source ${p} → ${tryRealpath(p) ?? '?'}: its parent is writable inside the box, so binding it would follow the link out of the sandbox (potential escape). Mount the real path instead.`
  // Still warned, unchanged, so nothing that greps logs for this line loses it. The message
  // is now ALSO returned — which is the whole of step (ii): the refusal, its subject and its
  // justification were already computed here and then thrown at a console.
  console.warn(`[sandbox] ${message}`)
  return { code: 'box-writable-mount', message }
}

// The DATA mounts a session's box actually exposes: the obligatory rw config dirs
// (global ~/.claude + the local <cwd>/.claude when present) plus the caller's mounts.
// Excludes the runtime/DNS baseline (node/claude/resolv.conf — no user files there).
// Mirrors wrapSandbox's data-mount set so an OUT-OF-BAND file operation done on a
// session's behalf (e.g. the notebook MCP tools, which run UNSANDBOXED in the server
// process) can be authorized against exactly what the box itself could reach.
// Why a refused mount was refused. The `code` deliberately MATCHES the one in
// sandboxPaths.ts, but this does NOT import that module's RefusalReason type, and that is a
// decision rather than an oversight: sandboxPaths.ts is the unfinished path layer that
// scratchpad/layer-not-wired-guard.mts exists to keep unwired, so importing from it here
// would wire production code to it in the same change that was only asked to stop discarding
// a reason. Unifying the two shapes is A2's job, done deliberately and in one place. Sharing
// a five-character string costs nothing and commits to nothing.
export interface MountExclusionReason {
  code: 'box-writable-mount'
  message: string
}

// A session's data mounts, plus the ones that were REFUSED and why.
//
// `sessionDataMounts` used to end `return full.filter((m) => !isUnsafeSymlinkMount(...))`, so
// a refused mount simply vanished. Two consequences, and the second is the one that matters:
// a caller could not tell "never requested" from "refused", and — the reason this API is a
// precondition for wiring the path layer at all — OVER-REFUSAL BECAME UNMEASURABLE. A refusal
// that drops its subject leaves nothing to count, so a rule that refuses too much looks
// exactly like a rule that refuses correctly.
//
// ★ sessionDataMounts is now DERIVED from this (it returns `.active`) rather than computing
//   the filter a second time. That is what stops the list and the plan from disagreeing —
//   two implementations of one rule is how a guard ends up watching the copy that is right
//   while the copy in use is wrong.
export function sessionDataMountPlan(cfg: SandboxConfig, cwd: string): {
  active: SandboxMount[]
  excluded: { mount: SandboxMount; reason: MountExclusionReason }[]
} {
  const full = sessionDataMountCandidates(cfg, cwd)
  // rwRoots are the LOGICAL rw dest paths (never a link's target), exactly as the box
  // computes them — see isUnsafeSymlinkMount's note.
  const rwRoots = full.filter((m) => m.mode === 'rw' && existsSync(m.path)).map((m) => path.resolve(m.path))
  const active: SandboxMount[] = []
  const excluded: { mount: SandboxMount; reason: MountExclusionReason }[] = []
  for (const m of full) {
    const reason = symlinkMountRefusal(m.path, rwRoots)
    if (reason) excluded.push({ mount: m, reason })
    else active.push(m)
  }
  return { active, excluded }
}

export function sessionDataMounts(cfg: SandboxConfig, cwd: string): SandboxMount[] {
  return sessionDataMountPlan(cfg, cwd).active
}

// The full candidate set before any refusal is applied — everything sessionDataMounts used
// to assemble inline. Split out only so the plan and the list share one assembly as well as
// one filter.
function sessionDataMountCandidates(cfg: SandboxConfig, cwd: string): SandboxMount[] {
  const baseline: SandboxMount[] = obligatoryMounts(cwd)
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
  return full
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
  // …unless the target is inside a hidden state dir, which the box sees as an empty
  // directory. The authorizer must agree with the box or an unsandboxed MCP tool would be
  // authorized to read the auth token on a session's behalf — the same divergence
  // sessionDataMounts exists to prevent.
  for (const dir of stateDirsToHide()) {
    const root = canonicalizeForAccess(dir)
    if (target === root || target.startsWith(root + path.sep)) return { read: false, write: false }
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
  // `gpu` changes the emitted argv (the --dev-bind block), so it must be part of the key
  // or toggling it would leave the running engine on its old devices with no pending mark.
  return `on|lc${localClaude}|gpu${cfg.gpu ? '1' : '0'}|` + cfg.mounts.map((m) => `${m.mode}:${m.path}`).sort().join(',')
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
  const obligatory: SandboxMount[] = obligatoryMounts(cwd)
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
    // Reads outside the box fail honestly (ENOENT); WRITES do not. The box root is a
    // private tmpfs, so `mkdir -p` at a hidden path fabricates a RAM-only directory
    // shadowing the host one, and the write into it then succeeds — a false "done" the
    // ENOENT note above does not cover. Observed: an agent asked to write into an
    // unmounted folder hit ENOENT, ran mkdir -p, and reported a clean success that
    // reached no disk — it had fabricated the folder it was writing into.
    'Writing outside that list can still LOOK like it worked. The sandbox root is a',
    'private tmpfs: creating a missing parent directory (e.g. mkdir -p) at a hidden path',
    'silently fabricates a RAM-only directory shadowing the host path, and the write into',
    'it then reports success. It reached no disk and vanishes when the session ends. So',
    'never create a parent directory to make a write succeed — if the directory was not',
    'already visible to you, the path is outside the sandbox and the write did NOT happen.',
    // This note rides --append-system-prompt, which reaches the session's main loop only;
    // subagents get their own system prompt and are otherwise blind to the confinement.
    'Subagents you spawn do NOT inherit this note. When you delegate work that touches the',
    'filesystem, state these limits in the subagent prompt yourself.',
    // Told explicitly because the box's /dev is otherwise minimal enough that a GPU
    // failure reads as "this machine has no GPU" — the same misdiagnosis the mount note
    // above prevents for files.
    ...(cfg.gpu && gpuDevicePaths().length
      ? ['The host GPU IS passed through to you: ' + gpuDevicePaths().join(', ') + ' are',
         'available, so CUDA/ROCm work runs here normally.']
      : ['You have NO GPU access: /dev holds only the basic nodes, so CUDA/ROCm find no',
         'device even if the host has a card. Do not report this as a broken driver — ask',
         'the user to tick "Pass through the GPU" in the sandbox control and relaunch.']),
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
  // Depth computed ONCE per mount, not twice per comparison: this list is re-sorted on
  // every sandboxPathAccess call, which runs per authorized file operation.
  const depth = (p: string): number => {
    let n = 0
    for (let i = 0; i < p.length; i++) if (p[i] === path.sep) n++
    return n
  }
  return mounts
    .map((m) => ({ m, d: depth(m.path) }))
    .sort((a, b) => a.d - b.d || a.m.path.localeCompare(b.m.path))
    .map((x) => x.m)
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
    // `bin` rides as a POSITIONAL ARGUMENT ($1) — never interpolated into the script. It
    // used to be spliced straight into the command string, and this function is reached
    // with an ATTACKER-CHOSEN path: canImportJupyter (jupyterManager.ts) routes a
    // box-writable interpreter candidate through wrapCommand precisely so a planted binary
    // executes CONFINED — but wrapCommand resolves the program through here BEFORE it
    // builds the box. So a confined session that created
    // `<cwd>/p$(payload)/.venv/bin/python3` inside its own legitimate rw mount and then ran
    // a notebook cell got the substitution executed on the HOST, unsandboxed, with the
    // server's full env including CLAUDETTE_TOKEN. The mitigation contained the
    // vulnerability. (Verified live; note which() memoizes, so it fires once per distinct
    // path per server run.)
    //
    // `--` so a leading-dash path can't be read as an option either, and "$1" is quoted so
    // word-splitting and globbing can't reach it. The SHELL STAYS on purpose: `command -v`
    // resolves a bare name the way the child will, and probe() depends on it reporting a
    // BUILTIN as a bare word (see the trueBin check there) — a Node-side PATH walk would
    // return null for `true` and silently change what the capability probe tests.
    result = execFileSync('sh', ['-c', 'command -v -- "$1"', 'sh', bin], { encoding: 'utf8' }).trim() || null
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
