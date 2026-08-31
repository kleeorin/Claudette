// Test for the host-mode scrubbed-config mirror's credential handling
// (server/src/claude/configProtection.ts) — the "Claude keeps asking me to log in" bug.
//
// A host-mode session run against an EXPOSED config gets CLAUDE_CONFIG_DIR pointed at a
// mirror: every entry symlinked back to the real ~/.claude, except settings.json /
// settings.local.json which become scrubbed copies. But Claude writes a refreshed OAuth
// token by ATOMIC RENAME, which REPLACES the symlink with a real file inside the mirror —
// so the fresh token lives in the mirror while the shared dir keeps the expired one.
//
// The salvage (reconcileCredsBack) used to run ONLY when the next host-mode session
// launched. Three holes fixed here:
//   1. exit    — salvage when the session ENDS (releaseHostConfigDir), not just at the
//                next launch, so a refresh isn't stranded when no further host-mode
//                session starts and every other reader keeps reading the stale token;
//   2. crash   — salvage at BOOT (reclaimStrandedHostConfigs) for mirrors a hard kill
//                left behind, incl. the LEGACY single-shared-dir layout;
//   3. clobber — one mirror PER SESSION, so launching a second host-mode session no
//                longer rmSync's the first one's live CLAUDE_CONFIG_DIR out from under it.
// Plus: the mirror must not symlink Claudette's own state dir (it lives INSIDE ~/.claude,
// so mirroring it makes mirror/claudette/host-scrubbed-config/claudette/… — a path cycle).
//
//   npx tsx scratchpad/host-config-mirror-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'

// Point both the config dir and Claudette's data dir at a throwaway tree BEFORE importing
// the module (claudeConfigDir()/dataDir() read these at call time, but be explicit).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hostcfg-'))
const real = path.join(root, '.claude')
fs.mkdirSync(real, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = real
process.env.CLAUDETTE_DATA_DIR = path.join(real, 'claudette')   // mirrors the real layout

const { scrubbedHostConfigDir, releaseHostConfigDir, reclaimStrandedHostConfigs } =
  await import('../server/src/claude/configProtection')

import { check, passed as pass, failed as fail } from './assert.mjs'

const CREDS = '.credentials.json'
const realCreds = path.join(real, CREDS)
const readReal = () => JSON.parse(fs.readFileSync(realCreds, 'utf8')).token as string

// Seed a realistic config dir: creds, .claude.json, a hook-bearing settings.json, state.
const seed = () => {
  fs.writeFileSync(realCreds, JSON.stringify({ token: 'STALE' }), { mode: 0o600 })
  fs.writeFileSync(path.join(real, '.claude.json'), JSON.stringify({ oauthAccount: { id: 'u1' } }))
  fs.writeFileSync(path.join(real, 'settings.json'), JSON.stringify({ hooks: { Stop: 'curl evil' }, theme: 'dark' }))
  fs.mkdirSync(path.join(real, 'projects'), { recursive: true })
  fs.mkdirSync(path.join(real, 'claudette'), { recursive: true })   // our own state dir
}
seed()

// What Claude does on token refresh: write a temp file then rename it over the path. The
// rename REPLACES the symlink in the mirror with a real file (this is the whole bug).
const refreshToken = (mirror: string, token: string) => {
  const tmp = path.join(mirror, `${CREDS}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify({ token }), { mode: 0o600 })
  fs.renameSync(tmp, path.join(mirror, CREDS))
}

// --- 0. The mirror is built correctly ---------------------------------------
const m1 = scrubbedHostConfigDir('session-A')!
check('mirror is created', !!m1 && fs.existsSync(m1))
check('mirror is per-session (path contains the session id)', m1.includes('session-A'), m1)
check('creds start as a SYMLINK back to the shared dir',
  fs.lstatSync(path.join(m1, CREDS)).isSymbolicLink())
check('settings.json is a scrubbed REAL copy (hooks stripped, prefs kept)', (() => {
  const s = JSON.parse(fs.readFileSync(path.join(m1, 'settings.json'), 'utf8'))
  return !fs.lstatSync(path.join(m1, 'settings.json')).isSymbolicLink() && !s.hooks && s.theme === 'dark'
})())
check('mirror does NOT contain Claudette\'s own state dir (no path cycle)',
  !fs.existsSync(path.join(m1, 'claudette')),
  fs.readdirSync(m1).join(','))
check('a normal state dir IS still symlinked (only our own dir is skipped)',
  fs.lstatSync(path.join(m1, 'projects')).isSymbolicLink())

// --- 1. Salvage at session EXIT ---------------------------------------------
refreshToken(m1, 'FRESH-1')
check('precondition: refresh replaced the symlink with a real file in the mirror',
  !fs.lstatSync(path.join(m1, CREDS)).isSymbolicLink() && readReal() === 'STALE')
releaseHostConfigDir('session-A')
check('exit: the refreshed token is salvaged back to the shared dir', readReal() === 'FRESH-1', readReal())
check('exit: the mirror is removed', !fs.existsSync(m1))
check('exit: salvaged creds keep mode 0600',
  (fs.statSync(realCreds).mode & 0o777) === 0o600, (fs.statSync(realCreds).mode & 0o777).toString(8))
// Releasing a session that never had a mirror (a sandboxed one) must be a no-op, not a throw.
let threw = false
try { releaseHostConfigDir('session-NEVER-EXISTED') } catch { threw = true }
check('exit: releasing a session with no mirror is a safe no-op', !threw)

// --- 2. Salvage at BOOT after a crash ---------------------------------------
const m2 = scrubbedHostConfigDir('session-B')!
refreshToken(m2, 'FRESH-2')
// Simulate a hard kill: no release runs, the mirror survives with the fresh token. The
// owner file must name a DEAD pid — a crashed process is exactly what the sweep reclaims,
// and a mirror still owned by a LIVE process is deliberately left alone (section 7).
// Without this the mirror carries THIS process's pid and is correctly protected.
fs.writeFileSync(path.join(m2, '.claudette-owner'), '2147483646', 'utf8')
check('crash: token is stranded in the mirror before the sweep', readReal() === 'FRESH-1')
reclaimStrandedHostConfigs()
check('boot sweep: stranded token is reclaimed', readReal() === 'FRESH-2', readReal())
check('boot sweep: leftover mirrors are cleared', !fs.existsSync(m2))

// --- 3. LEGACY layout (root itself was the single shared mirror) ------------
// Rebuild the pre-fix shape by hand: <dataDir>/host-scrubbed-config with the symlinks
// directly inside it, holding a refreshed real creds file.
const legacy = path.join(process.env.CLAUDETTE_DATA_DIR!, 'host-scrubbed-config')
fs.mkdirSync(legacy, { recursive: true })
fs.symlinkSync(path.join(real, '.claude.json'), path.join(legacy, '.claude.json'))
fs.writeFileSync(path.join(legacy, CREDS), JSON.stringify({ token: 'FRESH-LEGACY' }), { mode: 0o600 })
reclaimStrandedHostConfigs()
check('legacy: a token stranded in the OLD shared-root mirror is reclaimed too',
  readReal() === 'FRESH-LEGACY', readReal())

// --- 4. Concurrent host-mode sessions don't clobber each other --------------
// The pre-fix bug: both sessions shared ONE mirror dir, so building B's wiped A's live
// CLAUDE_CONFIG_DIR (and any token A had refreshed into it).
const a = scrubbedHostConfigDir('session-A2')!
const b = scrubbedHostConfigDir('session-B2')!
check('concurrent: the two sessions get DIFFERENT mirrors', a !== b, `${a} vs ${b}`)
refreshToken(a, 'FRESH-A2')
const c = scrubbedHostConfigDir('session-C2')!   // a third launch must not disturb A's
check("concurrent: a later launch leaves the earlier session's mirror intact",
  fs.existsSync(a) && JSON.parse(fs.readFileSync(path.join(a, CREDS), 'utf8')).token === 'FRESH-A2')
check('concurrent: A\'s refreshed token still survives its own exit', (() => {
  releaseHostConfigDir('session-A2')
  return readReal() === 'FRESH-A2'
})(), readReal())
releaseHostConfigDir('session-B2'); releaseHostConfigDir('session-C2')
void b; void c

// --- 5. An UNrefreshed mirror must not clobber the shared dir ---------------
// If no refresh happened the mirror's creds is still a symlink — salvaging then would copy
// the file onto itself (harmless) but a bug here could overwrite a NEWER shared token with
// a stale mirror copy. Assert the shared token is untouched.
fs.writeFileSync(realCreds, JSON.stringify({ token: 'NEWEST' }), { mode: 0o600 })
const m5 = scrubbedHostConfigDir('session-D')!
releaseHostConfigDir('session-D')
check('no-refresh: an untouched mirror leaves the shared token alone', readReal() === 'NEWEST', readReal())
void m5

// --- 6. A STALE mirror must never overwrite a NEWER shared token ------------
// The ordering hole. Per-session mirrors mean several can hold salvaged tokens at once,
// and nothing orders the reconciles: session A can launch first, refresh T1, and exit
// AFTER session B refreshed T2 and wrote it back. An unconditional copy then puts the
// OLD token back and every reader is logged out again — the exact failure this file is
// about. reconcileCredsBack only moves a token forward in time.
const older = scrubbedHostConfigDir('session-E-old')!
refreshToken(older, 'OLD-TOKEN')
// Backdate the mirror's creds so it is unambiguously older than what lands in the shared
// dir next (mtime granularity would otherwise make this racy on a fast filesystem).
const oldTime = new Date(Date.now() - 60_000)
fs.utimesSync(path.join(older, CREDS), oldTime, oldTime)
fs.writeFileSync(realCreds, JSON.stringify({ token: 'NEWER-TOKEN' }), { mode: 0o600 })
releaseHostConfigDir('session-E-old')
check('stale mirror does NOT clobber a newer shared token', readReal() === 'NEWER-TOKEN', readReal())

// ...and the converse still works: a genuinely newer mirror token IS salvaged.
const newer = scrubbedHostConfigDir('session-E-new')!
refreshToken(newer, 'NEWEST-TOKEN')
releaseHostConfigDir('session-E-new')
check('a newer mirror token is still salvaged', readReal() === 'NEWEST-TOKEN', readReal())

// --- 7. The boot sweep must not delete a LIVE process's mirror --------------
// reclaimStrandedHostConfigs used to rmSync the whole mirror root, so a `tsx watch`
// restart (or any second instance sharing CLAUDETTE_DATA_DIR) deleted the live
// CLAUDE_CONFIG_DIR of host-mode sessions still running in the old process.
const mine = scrubbedHostConfigDir('session-F-live')!        // owner = this pid (alive)
const strandedDir = scrubbedHostConfigDir('session-F-dead')!
fs.writeFileSync(path.join(strandedDir, '.claudette-owner'), '2147483646', 'utf8')  // a pid that isn't running
refreshToken(strandedDir, 'STRANDED-TOKEN')
reclaimStrandedHostConfigs()
check('boot sweep reclaims a mirror whose owner is gone', !fs.existsSync(strandedDir))
check('boot sweep salvages that stranded token', readReal() === 'STRANDED-TOKEN', readReal())
check("boot sweep leaves a LIVE process's mirror alone", fs.existsSync(mine))
releaseHostConfigDir('session-F-live')

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
