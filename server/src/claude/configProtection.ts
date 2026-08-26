import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, symlinkSync, rmSync,
  lstatSync, copyFileSync, chmodSync, statSync, renameSync, unlinkSync, watch,
  type FSWatcher,
} from 'fs'
import path from 'path'
import { claudeConfigDir } from './sandbox'
import { errMessage } from '../util/errMessage'
import { dataDir } from '../util/dataDir'

// Cross-session hook poisoning (SANDBOX.md): `settings.json` / `settings.local.json`
// at BOTH the user scope (~/.claude) and the project scope (<cwd>/.claude) can define
// `hooks` and `mcpServers` that Claude runs as HOST shell. Those files live in
// rw-mounted config dirs, so a confined session could write a malicious directive that
// a LATER unsandboxed ("host-mode") session executes outside any box.
//
// We can't simply ro-bind the whole config dir (Claude legitimately writes creds /
// history / .claude.json there, via atomic rename that EBUSYs onto a file bind — the
// reason the dir is bound rw as a unit). So the defense is two complementary layers:
//
//   Layer 1 (write side, in sandbox.ts): pin every settings.json READ-ONLY inside the
//     box, seeding an empty one first when absent so "create it after launch" is closed
//     too. settings.local.json stays writable so "allow always" keeps persisting.
//   Layer 2 (execution side, here + sessionManager): remember every config a confined
//     session was exposed to; when a HOST-MODE session later launches against such a
//     config, hand it a scrubbed mirror with `hooks`/`mcpServers` stripped — so even a
//     directive that slipped past Layer 1 (settings.local.json, or one predating this
//     fix) never executes on the host.
//
// This closes the settings.json vector completely and neutralizes the settings.local
// one at execution time. Residuals (documented, not silently ignored): a confined
// session can still create a PROJECT <cwd>/.claude/settings.json when no .claude dir
// existed at launch (user scope is always covered; project scope only once .claude
// exists) — Layer 2 does not scrub project scope in host mode, since Claude reads it
// relative to cwd with no redirect. Full closure there needs config isolation.

// Claudette's own state dir — see util/dataDir.ts. Holds the seed file, the exposed-config
// ledger, and the scrubbed host-mode config mirror.
//
// This comment used to claim the dir was "OUTSIDE every session mount by construction
// (nothing binds ~/.claude/claudette)". That was FALSE while the dir lived under
// ~/.claude: wrapSandbox rw-binds claudeConfigDir() and a bind carries the whole subtree,
// so every box could read and rewrite the ledger below — deleting its own taint entry to
// get the next host-mode session the REAL config instead of a scrubbed mirror, which is
// exactly the hook→host-exec path Layer 2 exists to close. The dir now lives under
// ~/.config (never bound), which is what actually makes the claim true.

// Close the user-scope create-after-launch hole deterministically: materialize a valid
// `{}` ~/.claude/settings.json when absent, so wrapSandbox can ro-bind a REAL file over
// it (bwrap can't ro-bind a path that doesn't exist, and binding a host-side seed onto
// the absent dest leaves a stray 0-byte mountpoint file behind in the rw-bound config
// dir). ~/.claude is Claude's OWN managed dir, so an empty settings.json there is benign
// and idempotent. We deliberately do NOT do this for a project's <cwd>/.claude — writing
// into the user's repo as a launch side effect would be surprising; that scope's
// create-after-launch stays a documented residual (see file header + SANDBOX.md).
export function ensureUserSettingsPinnable(): void {
  try {
    const p = path.join(claudeConfigDir(), 'settings.json')
    if (!existsSync(p)) {
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(p, '{}\n', 'utf8')
    }
  } catch { /* best-effort; if it fails the file just isn't pinnable this launch */ }
}

// The user- + project-scope settings.json paths. settings.local.json is deliberately
// NOT here: it stays box-writable (allow-always) and is handled by the Layer 2 scrub.
export function settingsJsonPaths(cwd: string): string[] {
  return [
    path.join(claudeConfigDir(), 'settings.json'),
    path.join(cwd, '.claude', 'settings.json'),
  ]
}

// --- Layer 2: exposed-config ledger -----------------------------------------
// A config is "exposed" once any confined session ran against it. Persisted so the
// flag survives a restart (a box that poisoned settings yesterday still counts today).

interface Ledger { keys: string[] }

function ledgerPath(): string { return path.join(dataDir(), 'exposed-configs.json') }

let cachedLedger: Set<string> | undefined
function loadLedger(): Set<string> {
  if (cachedLedger) return cachedLedger
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(), 'utf8')) as Ledger
    cachedLedger = new Set(Array.isArray(raw.keys) ? raw.keys : [])
  } catch {
    cachedLedger = new Set()
  }
  return cachedLedger
}

function saveLedger(set: Set<string>): void {
  try {
    mkdirSync(dataDir(), { recursive: true })
    writeFileSync(ledgerPath(), JSON.stringify({ keys: [...set] }), 'utf8')
  } catch { /* best-effort; worst case a host-mode session isn't scrubbed until re-marked */ }
}

// Scope keys. The user scope (~/.claude) is SHARED across every session, so a single
// confined session taints it for all later host-mode sessions. Project scope is keyed
// by the resolved cwd.
function userKey(): string { return `user:${path.resolve(claudeConfigDir())}` }
function projectKey(cwd: string): string { return `project:${path.resolve(cwd)}` }

// Record that a confined session is running against (this cwd's) user + project config.
export function markConfigExposed(cwd: string): void {
  const set = loadLedger()
  const before = set.size
  set.add(userKey())
  set.add(projectKey(cwd))
  if (set.size !== before) saveLedger(set)
}

// Would a host-mode session at `cwd` read config a confined session could have written?
// True if the shared user scope was ever exposed (covers all host-mode sessions) or
// this specific project was.
export function isConfigExposed(cwd: string): boolean {
  const set = loadLedger()
  return set.has(userKey()) || set.has(projectKey(cwd))
}

// --- Layer 2: scrubbed host-mode config mirror ------------------------------

// Drop a settings key if it can drive host execution: `hooks`, `mcpServers`, and any
// vendor-prefixed variant (matched loosely on purpose — these are the exec vectors and
// a false-positive strip only loses a directive a host-mode-against-exposed session
// shouldn't be running unreviewed anyway).
function isExecKey(key: string): boolean {
  return /hook/i.test(key) || /mcpservers/i.test(key)
}

// Write a scrubbed copy of a settings file (exec keys removed). An unparseable source
// becomes `{}` — Claude would ignore it as invalid anyway, and this guarantees no raw
// hook text survives into the mirror.
function writeScrubbedSettings(src: string, dest: string): void {
  let text = '{}\n'
  try {
    const obj = JSON.parse(readFileSync(src, 'utf8')) as Record<string, unknown>
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) if (isExecKey(k)) delete obj[k]
      text = JSON.stringify(obj, null, 2) + '\n'
    }
  } catch { /* leave the safe `{}` default */ }
  writeFileSync(dest, text, 'utf8')
}

// Before the mirror is wiped, salvage a credentials file that a token refresh turned into
// a REAL file here (an atomic-rename write breaks the symlink, so the fresh token lives in
// the mirror rather than the shared dir). Copy it back to the real config dir so the
// refresh survives the rebuild. Only .credentials.json is reconciled: nothing else writes
// the real creds during a host-mode run, so copying back is always a strict improvement.
// .claude.json is deliberately NOT reconciled — the app writes trust/prefs straight to the
// real file, and clobbering it with a session's mirror copy could lose those edits.
const CREDS = '.credentials.json'

// Returns true when the SHARED dir is known to hold a token at least as fresh as the
// mirror's (salvaged, or deliberately skipped because the shared one was newer/unchanged),
// and false only when the salvage actually errored. Callers that go on to re-point the
// mirror at the shared file must gate on this: relinking after a FAILED salvage would
// discard the very token that was rescued. Nothing else reads the result.
function reconcileCredsBack(mirror: string, real: string): boolean {
  const name = CREDS
  const dest = path.join(real, name)
  const tmp = `${dest}.claudette-${process.pid}.tmp`
  try {
    const m = path.join(mirror, name)
    // An intact symlink means no refresh happened; only a real file is a salvaged token.
    if (!existsSync(m) || lstatSync(m).isSymbolicLink()) return true
    // ONLY MOVE A TOKEN FORWARD IN TIME. Several mirrors can hold salvaged tokens at once
    // (one per host-mode session, plus whatever a crash stranded), and nothing orders the
    // reconciles — session A can exit after B and carry an older token. An unconditional
    // copy therefore lets a STALE token overwrite a fresh one, which is the "Not logged in"
    // loop this whole mechanism exists to prevent. The same guard protects a token the user
    // obtained via `claude login` in a terminal while the server was down.
    // Ties SALVAGE. mtime has millisecond granularity, so a mirror refresh and a shared-dir
    // write in the same tick compare equal — and refusing there would strand a token the
    // salvage exists to rescue. A genuinely stale mirror is stale by seconds-to-days (the
    // failure is "session A refreshed on Monday, exits after B refreshed on Tuesday"), so
    // the guard bites where it matters while back-to-back operations still work. Equal
    // timestamps fall back to the old copy-anyway behaviour: no regression, just no fix.
    const mirrorMtime = statSync(m).mtimeMs
    let destMtime = -Infinity
    try { destMtime = statSync(dest).mtimeMs } catch { /* absent: any salvaged token is an improvement */ }
    if (mirrorMtime < destMtime) return true
    // Atomically. Readers of the shared creds (a sandboxed session, `claude` in a terminal,
    // usageApi) must never observe a half-written file, and a crash mid-copy must not leave
    // the shared token truncated. Stage beside the destination, then rename over it — the
    // same atomic-rename discipline Claude itself uses for this file.
    copyFileSync(m, tmp)
    chmodSync(tmp, 0o600)   // creds are 0600; keep it that way even if dest was freshly created
    renameSync(tmp, dest)
    return true
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* nothing else to try */ }
    console.warn(`[sandbox] could not reconcile ${name} back to the config dir (${errMessage(e)}); a refreshed token may be lost`)
    return false
  }
}

// --- keeping a LIVE mirror shared ------------------------------------------
//
// THE RESIDUAL THIS CLOSES. Everything above moves a token MIRROR → SHARED, and only at
// session exit or at boot. The reverse direction was never handled at all: once a refresh
// has replaced the mirror's symlink with a real file, the session is DIVORCED from the
// shared credentials for the rest of its life. A `claude login` in a terminal — or any
// other session's refresh — writes the shared file that this session no longer reads, so
// the user logs in, sees it succeed, and the live session still says "Not logged in".
// For a long-running session, which is the normal case for this app, that window is the
// entire session.
//
// WHY THE FIX IS TO RESTORE THE SYMLINK rather than to keep copying. Copying in either
// direction makes two independent files that must be kept in agreement forever, and every
// copy needs a freshness rule to decide which wins (the mtime guard above exists precisely
// because that ordering is unknowable across sessions). Re-pointing the mirror entry back
// at the shared file removes the second copy entirely: the session reads the same inode as
// everyone else, so a later login is visible with no further machinery. The divorce is the
// bug; re-linking is the annulment.
//
// Ordering is load-bearing: SALVAGE FIRST, then relink. The real file in the mirror holds
// the newest token; relinking before salvaging would unlink it and lose exactly what we
// were trying to keep. Hence the `ok` gate.

// Point `<mirror>/.credentials.json` back at the shared file. Atomic: stage a temp symlink
// beside it and rename over, so a reader never sees the entry missing.
function relinkCredsToShared(mirror: string, real: string): void {
  const link = path.join(mirror, CREDS)
  const tmp = `${link}.claudette-relink-${process.pid}.tmp`
  try {
    if (!existsSync(mirror)) return
    // Already a symlink (or gone): nothing was replaced, so there is nothing to restore.
    try { if (lstatSync(link).isSymbolicLink()) return } catch { /* absent → (re)create it */ }
    try { unlinkSync(tmp) } catch { /* no stale temp */ }
    symlinkSync(path.join(real, CREDS), tmp)
    renameSync(tmp, link)
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* nothing else to try */ }
    console.warn(`[sandbox] could not re-link ${CREDS} in the host-mode mirror (${errMessage(e)}); this session may not see a later login until it exits`)
  }
}

// Salvage a token the mirror just took by atomic rename, then re-share the entry. Safe to
// call at any time and on a mirror that was never written to — both paths are no-ops.
// Exported so a test can drive the exact sequence the watcher drives, without racing inotify.
export function resyncMirrorCreds(sessionId: string): void {
  const mirror = mirrorFor(sessionId)
  if (!existsSync(mirror)) return
  const real = path.resolve(claudeConfigDir())
  if (reconcileCredsBack(mirror, real)) relinkCredsToShared(mirror, real)
}

// One watcher per live host-mode mirror.
const credsWatchers = new Map<string, FSWatcher>()

// Watch the mirror DIRECTORY, not the creds file: an atomic rename swaps the inode, and a
// file watch follows the old inode into oblivion — it would fire once, for the write we
// already handle at exit, and never again. A directory watch reports the entry being
// replaced, which is the event that matters.
function startCredsWatch(sessionId: string, mirror: string): void {
  stopCredsWatch(sessionId)
  try {
    let timer: NodeJS.Timeout | undefined
    const w = watch(mirror, (_event, filename) => {
      if (filename && path.basename(String(filename)) !== CREDS) return
      // Debounce: a rename lands as several inotify events, and our own relink re-enters
      // the watcher. Coalescing keeps one refresh to one resync.
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { try { resyncMirrorCreds(sessionId) } catch { /* logged inside */ } }, 150)
      timer.unref?.()
    })
    w.on('error', () => stopCredsWatch(sessionId))   // watch died; exit/boot salvage still covers us
    w.unref?.()                                      // never hold the process open
    credsWatchers.set(sessionId, w)
  } catch {
    // No watch (fd limits, an exotic FS). Degrade to the pre-existing exit + boot salvage
    // rather than failing the launch — strictly no worse than before this fix.
  }
}

function stopCredsWatch(sessionId: string): void {
  const w = credsWatchers.get(sessionId)
  if (!w) return
  credsWatchers.delete(sessionId)
  try { w.close() } catch { /* already closed */ }
}

// Test hook: how many mirrors are being watched right now.
export function watchedMirrorCount(): number { return credsWatchers.size }

// Root holding the per-session mirrors (one subdir per host-mode session).
function mirrorRoot(): string { return path.join(dataDir(), 'host-scrubbed-config') }

// A session id is used as a directory name — keep it to a safe charset so it can't
// escape the root (ids are UUIDs today; this only guards a future format).
function mirrorFor(sessionId: string): string {
  return path.join(mirrorRoot(), sessionId.replace(/[^A-Za-z0-9._-]/g, '_'))
}

// Would mirroring `entry` (an absolute path under the real config dir) swallow our own
// state dir? The mirror lives at <dataDir>/host-scrubbed-config and dataDir() defaults to
// ~/.claude/claudette — i.e. INSIDE the dir being mirrored. Symlinking `claudette` into
// the mirror therefore creates a cycle (mirror/claudette/host-scrubbed-config/claudette/…)
// that any recursive walk of CLAUDE_CONFIG_DIR can spin on. Claude has no reason to read
// Claudette's state, so the entry containing it is skipped entirely.
function containsDataDir(entry: string): boolean {
  const data = path.resolve(dataDir())
  return data === entry || data.startsWith(entry + path.sep)
}

// Which server process owns a mirror. Written at build time so the boot sweep can tell
// "stranded by a crash" (owner gone) from "in active use by another Claudette" (owner
// alive) — a dev `tsx watch` restart overlaps the old process by design, and the two
// share CLAUDETTE_DATA_DIR.
const OWNER_FILE = '.claudette-owner'

function markMirrorOwner(mirror: string): void {
  try { writeFileSync(path.join(mirror, OWNER_FILE), String(process.pid), 'utf8') } catch { /* sweep just falls back to reclaiming it */ }
}

// Is this mirror owned by a still-running process? `kill(pid, 0)` only probes existence.
// OUR OWN pid counts as live too: the sweep runs at boot, when this process owns no
// mirrors yet, so nothing is wrongly protected — but if it is ever called later, deleting
// the config dir of one of our own running sessions is precisely the bug being fixed here.
// Pid reuse could in principle make a dead owner look alive; the cost is a mirror left on
// disk until the next boot, versus deleting a live session's config dir — so this
// deliberately errs toward keeping. A mirror is normally removed by releaseHostConfigDir
// at session exit; the sweep is only the crash backstop.
function mirrorHeldByLiveProcess(mirror: string): boolean {
  try {
    const pid = Number(readFileSync(path.join(mirror, OWNER_FILE), 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false   // no owner file, unparseable, or ESRCH → free to reclaim
  }
}

// Salvage a refreshed token out of a mirror and remove it. Called when a host-mode session
// exits (the stranding window this closes) and at boot for anything a crash left behind.
//
// Fully guarded: this runs from the engine's `exit` listener, BEFORE the relaunch and
// cleanup branches. An escaping throw (EPERM/EBUSY/ENOTEMPTY from a just-SIGKILLed child
// still writing into the mirror) would skip the relaunch, skip cleanup(), leave the
// session wedged at state 'running' with a dead engine — and an unhandled throw inside an
// EventEmitter callback takes the process down with it. The boot sweep is the backstop for
// anything we fail to remove here.
export function releaseHostConfigDir(sessionId: string): void {
  // Before anything else: the mirror is about to be reconciled and deleted, so a watcher
  // still firing on it would resync a directory that no longer exists.
  stopCredsWatch(sessionId)
  try {
    const mirror = mirrorFor(sessionId)
    if (!existsSync(mirror)) return
    reconcileCredsBack(mirror, path.resolve(claudeConfigDir()))
    rmSync(mirror, { recursive: true, force: true })
  } catch (e) {
    console.warn(`[sandbox] could not release the host-mode config mirror for ${sessionId} (${errMessage(e)}); the boot sweep will retry`)
  }
}

// Boot sweep: reconcile + clear every mirror left over from a previous run. Without this a
// hard kill (crash, reboot, `pkill node`) strands a refreshed token in a mirror that no
// session will ever reopen — the "Not logged in" failure returns and cannot self-heal.
// Also migrates the LEGACY single shared mirror (the root itself was the mirror before
// mirrors became per-session), salvaging its creds before the layout changes underneath it.
export function reclaimStrandedHostConfigs(): void {
  const root = mirrorRoot()
  if (!existsSync(root)) return
  const real = path.resolve(claudeConfigDir())
  try {
    // Legacy layout: the root held the symlinks directly instead of session subdirs.
    if (existsSync(path.join(root, '.credentials.json'))) reconcileCredsBack(root, real)
    for (const name of readdirSync(root)) {
      const dir = path.join(root, name)
      try {
        if (!lstatSync(dir).isDirectory()) continue
        // Reclaim PER MIRROR, and never touch one another live process still has mounted.
        // This used to rmSync the whole root: on a `tsx watch` restart (or any second
        // instance sharing CLAUDETTE_DATA_DIR) that deleted the live CLAUDE_CONFIG_DIR out
        // from under host-mode sessions in the old process — the cross-process form of the
        // very clobber per-session mirrors were introduced to eliminate.
        if (mirrorHeldByLiveProcess(dir)) continue
        reconcileCredsBack(dir, real)
        rmSync(dir, { recursive: true, force: true })
      } catch { /* skip this mirror; the next boot retries it */ }
    }
  } catch (e) {
    console.warn(`[sandbox] could not reclaim stranded host-mode config mirrors (${errMessage(e)})`)
  }
}

// Build (fresh each call) a mirror of the user config dir for a host-mode session:
// every entry symlinked back to the real dir so creds/history/.claude.json stay SHARED,
// except settings.json / settings.local.json, which become scrubbed real copies. Point
// the host-mode child's CLAUDE_CONFIG_DIR here. Returns the mirror path, or null on any
// failure (caller logs and falls back to the real dir rather than bricking the launch).
//
// PER SESSION (`<root>/<sessionId>`), deliberately. It used to be ONE shared dir that every
// host-mode launch rmSync'd and rebuilt — so starting a second unsandboxed session deleted
// the first one's live CLAUDE_CONFIG_DIR out from under it, and a token that session then
// refreshed landed in a directory already scheduled for deletion.
//
// Caveat (documented): a top-level file Claude rewrites by atomic rename (.claude.json,
// possibly refreshed creds) replaces its symlink with a real file in the mirror, so
// THOSE writes may not flow back to the shared dir for the duration of a host-mode
// session run against an exposed config. Directory state (projects/, todos/, history)
// is symlinked at the dir level, so files created within persist normally. This only
// affects the opt-in host-mode-vs-exposed-config path; every other launch is untouched.
//
// For CREDENTIALS specifically that caveat manifested as "Not logged in": an OAuth token
// refresh atomic-renames a real .credentials.json into the mirror, so the fresh token lives
// there and the shared dir keeps an expired one. reconcileCredsBack salvages it back — now
// at session EXIT (releaseHostConfigDir) and at BOOT (reclaimStrandedHostConfigs), not only
// on the next host-mode launch as before. That last-launch-only timing was the residual
// hole: refresh, then no further host-mode session, and every OTHER reader (sandboxed
// sessions, a plain `claude` in a terminal) went on reading the stale token.
export function scrubbedHostConfigDir(sessionId: string): string | null {
  const real = path.resolve(claudeConfigDir())
  const mirror = mirrorFor(sessionId)
  try {
    // Belt-and-braces: a mirror for this id should already have been released at exit and
    // swept at boot, but if one survived (same id relaunched in-process) its token is
    // salvaged before the rebuild. Safe to run unconditionally now that reconcileCredsBack
    // only moves a token forward in time.
    if (existsSync(mirror)) reconcileCredsBack(mirror, real)
    rmSync(mirror, { recursive: true, force: true })
    mkdirSync(mirror, { recursive: true })
    markMirrorOwner(mirror)
    const scrubbed = new Set(['settings.json', 'settings.local.json'])
    for (const name of readdirSync(real)) {
      const from = path.join(real, name)
      const to = path.join(mirror, name)
      if (containsDataDir(from)) continue          // never mirror our own state dir (cycle)
      if (scrubbed.has(name)) writeScrubbedSettings(from, to)
      else symlinkSync(from, to)
    }
    // Also materialize a scrubbed settings file even if the real one is absent, so a
    // hook can't hide in a scope Claude would otherwise read as empty. (No-op if the
    // real file existed and was already written above.)
    for (const name of scrubbed) {
      const to = path.join(mirror, name)
      if (!existsSync(to)) writeFileSync(to, '{}\n', 'utf8')
    }
    // Watch from here on: a refresh during the session is salvaged and re-shared within
    // the session's lifetime, instead of stranding it until exit (see relinkCredsToShared).
    startCredsWatch(sessionId, mirror)
    return mirror
  } catch (e) {
    console.warn(`[sandbox] host-mode config scrub failed (${errMessage(e)}); falling back to the real config dir — hooks in an exposed config could run. Prefer keeping sessions sandboxed.`)
    return null
  }
}

// Reset the in-memory ledger cache (tests).
export function resetConfigProtectionCache(): void { cachedLedger = undefined }
