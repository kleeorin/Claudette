import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, symlinkSync, rmSync,
  lstatSync, copyFileSync, chmodSync,
} from 'fs'
import { homedir } from 'os'
import path from 'path'
import { claudeConfigDir } from './sandbox'
import { errMessage } from '../util/errMessage'

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

// Claudette's own state dir (mirrors sessionPersistence.ts). Holds the seed file, the
// exposed-config ledger, and the scrubbed host-mode config mirror — all OUTSIDE every
// session mount by construction (nothing binds ~/.claude/claudette).
function dataDir(): string {
  return process.env.CLAUDETTE_DATA_DIR || path.join(homedir(), '.claude', 'claudette')
}

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
function reconcileCredsBack(mirror: string, real: string): void {
  const name = '.credentials.json'
  try {
    const m = path.join(mirror, name)
    // An intact symlink means no refresh happened; only a real file is a salvaged token.
    if (!existsSync(m) || lstatSync(m).isSymbolicLink()) return
    const dest = path.join(real, name)
    copyFileSync(m, dest)
    chmodSync(dest, 0o600)   // creds are 0600; keep it that way even if dest was freshly created
  } catch (e) {
    console.warn(`[sandbox] could not reconcile ${name} back to the config dir (${errMessage(e)}); a refreshed token may be lost`)
  }
}

// Build (fresh each call) a mirror of the user config dir for a host-mode session:
// every entry symlinked back to the real dir so creds/history/.claude.json stay SHARED,
// except settings.json / settings.local.json, which become scrubbed real copies. Point
// the host-mode child's CLAUDE_CONFIG_DIR here. Returns the mirror path, or null on any
// failure (caller logs and falls back to the real dir rather than bricking the launch).
//
// Caveat (documented): a top-level file Claude rewrites by atomic rename (.claude.json,
// possibly refreshed creds) replaces its symlink with a real file in the mirror, so
// THOSE writes may not flow back to the shared dir for the duration of a host-mode
// session run against an exposed config. Directory state (projects/, todos/, history)
// is symlinked at the dir level, so files created within persist normally. This only
// affects the opt-in host-mode-vs-exposed-config path; every other launch is untouched.
//
// For CREDENTIALS specifically that caveat manifested as "Not logged in": an OAuth token
// refresh atomic-renames a real .credentials.json into the mirror, then the NEXT launch's
// rmSync below deleted it and re-symlinked to a now-stale real file — so sessions reverted
// to an expired token and could never self-heal. reconcileCredsBack (called before the
// wipe) salvages a refreshed creds file back to the shared dir so refreshes persist.
export function scrubbedHostConfigDir(): string | null {
  const real = path.resolve(claudeConfigDir())
  const mirror = path.join(dataDir(), 'host-scrubbed-config')
  try {
    if (existsSync(mirror)) reconcileCredsBack(mirror, real)
    rmSync(mirror, { recursive: true, force: true })
    mkdirSync(mirror, { recursive: true })
    const scrubbed = new Set(['settings.json', 'settings.local.json'])
    for (const name of readdirSync(real)) {
      const from = path.join(real, name)
      const to = path.join(mirror, name)
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
    return mirror
  } catch (e) {
    console.warn(`[sandbox] host-mode config scrub failed (${errMessage(e)}); falling back to the real config dir — hooks in an exposed config could run. Prefer keeping sessions sandboxed.`)
    return null
  }
}

// Reset the in-memory ledger cache (tests).
export function resetConfigProtectionCache(): void { cachedLedger = undefined }
