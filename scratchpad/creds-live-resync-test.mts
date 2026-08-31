// The STILL-OPEN half of the "not logged in" bug (server/src/claude/configProtection.ts).
//
// host-config-mirror-test.mts covers the MIRROR → SHARED direction: a token a host-mode
// session refreshed is salvaged back at session exit and at boot. This file covers the
// direction that was never handled at all — SHARED → the LIVE session.
//
// The mechanism: a host-mode session against an exposed config gets CLAUDE_CONFIG_DIR
// pointed at a mirror whose entries are symlinks back to the real ~/.claude. Claude
// refreshes its OAuth token by ATOMIC RENAME, and a rename REPLACES THE SYMLINK WITH A
// REAL FILE. From that moment the session reads its own private copy and is divorced from
// the shared credentials. Salvage-at-exit does not help a session that is still running:
// a `claude login` in a terminal writes the shared file the session no longer reads, so
// the user logs in, sees it succeed, and the live session still says "Not logged in".
// For a long-running session — the normal case here — that window is the whole session.
//
// The fix: after salvaging, RESTORE THE SYMLINK, so the session shares the shared file
// again and any later login is visible with no further copying.
//
//   npx tsx scratchpad/creds-live-resync-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'credsresync-'))
const real = path.join(root, '.claude')
fs.mkdirSync(real, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = real
process.env.CLAUDETTE_DATA_DIR = path.join(real, 'claudette')

const { scrubbedHostConfigDir, releaseHostConfigDir, resyncMirrorCreds, watchedMirrorCount } =
  await import('../server/src/claude/configProtection')

import { check, passed as pass, failed as fail } from './assert.mjs'

const CREDS = '.credentials.json'
const realCreds = path.join(real, CREDS)
const readReal = () => JSON.parse(fs.readFileSync(realCreds, 'utf8')).token as string
// What the SESSION sees: always read through the mirror path, exactly as Claude does.
const readThroughMirror = (m: string) => JSON.parse(fs.readFileSync(path.join(m, CREDS), 'utf8')).token as string
const isLink = (m: string) => fs.lstatSync(path.join(m, CREDS)).isSymbolicLink()

fs.writeFileSync(realCreds, JSON.stringify({ token: 'SHARED-1' }), { mode: 0o600 })
fs.writeFileSync(path.join(real, 'settings.json'), JSON.stringify({ hooks: { Stop: 'curl evil' } }))
fs.mkdirSync(path.join(real, 'claudette'), { recursive: true })

// Claude's refresh: temp file + rename over the path. This is what breaks the symlink.
const refreshToken = (mirror: string, token: string) => {
  const tmp = path.join(mirror, `${CREDS}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify({ token }), { mode: 0o600 })
  fs.renameSync(tmp, path.join(mirror, CREDS))
}
// A login happening ELSEWHERE while the session is alive (terminal `claude login`, or
// another session salvaging its own refresh).
const loginElsewhere = (token: string) => {
  const tmp = `${realCreds}.login.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ token }), { mode: 0o600 })
  fs.renameSync(tmp, realCreds)
}

try {
  // --- 1. The divorce, and the deterministic resync -------------------------
  const mA = scrubbedHostConfigDir('session-A')!
  check('creds start as a symlink (session shares the real file)', isLink(mA))
  check('session reads the shared token through the mirror', readThroughMirror(mA) === 'SHARED-1')

  refreshToken(mA, 'FRESH-1')
  check('precondition: the refresh replaced the symlink with a REAL file (the divorce)',
    !isLink(mA) && fs.lstatSync(path.join(mA, CREDS)).isFile())

  resyncMirrorCreds('session-A')
  check('resync salvages the fresh token to the shared dir MID-SESSION (not at exit)',
    readReal() === 'FRESH-1', readReal())
  check('resync RESTORES the symlink — the session is re-shared', isLink(mA))
  check('salvaged creds keep mode 0600',
    (fs.statSync(realCreds).mode & 0o777) === 0o600, (fs.statSync(realCreds).mode & 0o777).toString(8))

  // --- 2. THE BUG ITSELF: a login during a live session ---------------------
  loginElsewhere('LOGIN-2')
  check('THE FIX: a login made while the session is ALIVE is visible to it',
    readThroughMirror(mA) === 'LOGIN-2', readThroughMirror(mA))

  // --- 3. The watcher does it without being asked ---------------------------
  // Section 1 drove resync directly to keep the assertions deterministic; this proves the
  // production trigger (an fs.watch on the mirror dir) actually fires on a real rename.
  check('a live mirror is being watched', watchedMirrorCount() >= 1, String(watchedMirrorCount()))
  refreshToken(mA, 'FRESH-3')
  let waited = 0
  while (waited < 5000 && !isLink(mA)) { await new Promise((r) => setTimeout(r, 50)); waited += 50 }
  check('watcher salvages a refresh with no explicit call', readReal() === 'FRESH-3', readReal())
  check('watcher re-links too, so the next login is visible', isLink(mA), `waited ${waited}ms`)

  // --- 4. Negative controls: the existing guarantees must survive -----------
  // 4a. A stale mirror token must still NOT clobber a newer shared one.
  const mB = scrubbedHostConfigDir('session-B')!
  refreshToken(mB, 'STALE-B')
  await new Promise((r) => setTimeout(r, 20))
  loginElsewhere('NEWER-SHARED')          // shared file is now strictly newer
  fs.utimesSync(path.join(mB, CREDS), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  resyncMirrorCreds('session-B')
  check('a STALE mirror token does not clobber a newer shared token',
    readReal() === 'NEWER-SHARED', readReal())
  check('…and that mirror is re-linked anyway, so it picks the newer token up',
    isLink(mB) && readThroughMirror(mB) === 'NEWER-SHARED', readThroughMirror(mB))

  // 4b. An untouched mirror is left completely alone.
  const mC = scrubbedHostConfigDir('session-C')!
  resyncMirrorCreds('session-C')
  check('an untouched mirror keeps its symlink and changes nothing',
    isLink(mC) && readReal() === 'NEWER-SHARED')

  // 4c. Lifecycle: release stops the watcher and still salvages.
  const before = watchedMirrorCount()
  refreshToken(mC, 'EXIT-TOKEN')
  releaseHostConfigDir('session-C')
  check('release stops the mirror watcher', watchedMirrorCount() === before - 1,
    `${before} → ${watchedMirrorCount()}`)
  check('release still salvages the token (exit path unbroken)', readReal() === 'EXIT-TOKEN', readReal())
  check('release still removes the mirror', !fs.existsSync(mC))

  // 4d. Resync on a session with no mirror is a safe no-op.
  let threw = false
  try { resyncMirrorCreds('no-such-session') } catch { threw = true }
  check('resync on a missing mirror is a safe no-op', !threw)

  releaseHostConfigDir('session-A')
  releaseHostConfigDir('session-B')
  check('every watcher is released at the end', watchedMirrorCount() === 0, String(watchedMirrorCount()))
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* temp dir */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
