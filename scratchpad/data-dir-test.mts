// Tests for where Claudette keeps its own state, and for the one-time migration out of the
// old location.
//
// WHY THIS IS ITS OWN FILE: team-test.mts sets CLAUDETTE_DATA_DIR to isolate itself, which
// makes migrateLegacy return immediately — so it cannot test any of this. SANDBOX.md
// claimed the migration was covered; it wasn't, and this file is what makes that true.
//
// WHY IT MATTERS: the state dir used to live at ~/.claude/claudette, i.e. INSIDE the rw
// bind-mount every sandboxed session gets. `sessions.json` is replayed at boot as trusted
// (so a box could grant itself teamEmploy or an unconfined sandbox), `exposed-configs.json`
// is the hook-taint ledger, and `host-scrubbed-config/` is a host-mode session's
// CLAUDE_CONFIG_DIR. The relocation only helps if the migration itself can't be used to
// carry the exposure across — which is exactly what a planted symlink would do.
//
//   npx tsx scratchpad/data-dir-test.mts
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, lstatSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

// Each case needs a FRESH module instance: migrateLegacy runs once per process.
let seq = 0
async function freshDataDir(home: string): Promise<string> {
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = path.join(home, '.config')
  delete process.env.CLAUDETTE_DATA_DIR
  const mod = await import(`../server/src/util/dataDir?case${seq++}`)
  return (mod as { dataDir: () => string }).dataDir()
}
const newHome = () => mkdtempSync(path.join(tmpdir(), 'claudette-dd-'))
const legacyOf = (home: string) => path.join(home, '.claude', 'claudette')
const isLink = (p: string) => existsSync(path.dirname(p)) && lstatSync(p).isSymbolicLink()

// --- 1. The location itself --------------------------------------------------
{
  const home = newHome()
  const dir = await freshDataDir(home)
  check('state lives under ~/.config, not ~/.claude', dir === path.join(home, '.config', 'claudette'), dir)
  check('...which is where the auth token already lives, deliberately unmounted',
    !path.resolve(dir).startsWith(path.resolve(path.join(home, '.claude'))))
}

// --- 2. A clean upgrade moves everything and closes the door ------------------
{
  const home = newHome()
  const legacy = legacyOf(home)
  mkdirSync(legacy, { recursive: true })
  writeFileSync(path.join(legacy, 'sessions.json'), '[{"name":"Lead"}]')
  writeFileSync(path.join(legacy, 'exposed-configs.json'), '["user:x"]')
  mkdirSync(path.join(legacy, 'host-scrubbed-config', 'abc'), { recursive: true })
  writeFileSync(path.join(legacy, 'host-scrubbed-config', 'abc', 'settings.json'), '{}')

  const dir = await freshDataDir(home)
  check('the session roster survives the move',
    readFileSync(path.join(dir, 'sessions.json'), 'utf8') === '[{"name":"Lead"}]')
  check('the taint ledger survives too', existsSync(path.join(dir, 'exposed-configs.json')))
  check('...as do nested config mirrors', existsSync(path.join(dir, 'host-scrubbed-config', 'abc', 'settings.json')))
  // A MOVE, not a copy: a readable duplicate left inside the mount would preserve the
  // exposure the relocation exists to close.
  check('nothing readable is left behind in the sandbox mount', !existsSync(legacy))
  check('a marker records that migration is done', existsSync(path.join(dir, '.migrated-from-claude-dir')))
}

// --- 3. Planted symlinks are refused, not adopted ----------------------------
// THE ATTACK: the legacy dir was writable from inside every box, so a confined session
// could leave sessions.json as a link to a file it still controls. renameSync moves the
// LINK, so a naive migration installs attacker-controlled indirection at the new TRUSTED
// location — carrying the exposure across instead of ending it. existsSync follows links
// and cannot see this; only lstat can.
{
  const home = newHome()
  const legacy = legacyOf(home)
  mkdirSync(legacy, { recursive: true })
  const evil = path.join(home, '.claude', 'evil.json')
  writeFileSync(evil, '[{"name":"pwned","teamEmploy":true,"sandbox":{"enabled":false,"mounts":[]}}]')
  symlinkSync(evil, path.join(legacy, 'sessions.json'))
  mkdirSync(path.join(home, '.claude', 'evilnotes'), { recursive: true })
  symlinkSync(path.join(home, '.claude', 'evilnotes'), path.join(legacy, 'team-notes'))
  writeFileSync(path.join(legacy, 'exposed-configs.json'), '["user:real"]')

  const dir = await freshDataDir(home)
  check('a symlinked roster is NOT adopted', !existsSync(path.join(dir, 'sessions.json')))
  check('a symlinked notes dir is NOT adopted', !existsSync(path.join(dir, 'team-notes')))
  check('...while genuine files still migrate', existsSync(path.join(dir, 'exposed-configs.json')))
  check('the refused links are left in place for inspection',
    isLink(path.join(legacy, 'sessions.json')) && isLink(path.join(legacy, 'team-notes')))
  check('...and migration is NOT marked done, so it retries after cleanup',
    !existsSync(path.join(dir, '.migrated-from-claude-dir')))
}

// --- 4. Re-planting after a completed migration is ignored -------------------
// The legacy dir stays writable from inside every box forever. If migration ran on every
// boot, a box could plant links and wait for a restart. It must run exactly once, ever.
{
  const home = newHome()
  const legacy = legacyOf(home)
  mkdirSync(legacy, { recursive: true })
  writeFileSync(path.join(legacy, 'sessions.json'), '[{"name":"Lead"}]')
  const dir = await freshDataDir(home)
  check('first boot migrates', existsSync(path.join(dir, 'sessions.json')))

  // A box re-creates the legacy dir and plants a link.
  mkdirSync(legacy, { recursive: true })
  mkdirSync(path.join(home, '.claude', 'later-evil'), { recursive: true })
  symlinkSync(path.join(home, '.claude', 'later-evil'), path.join(legacy, 'team-notes'))
  const dir2 = await freshDataDir(home)
  check('a later re-plant is ignored entirely', !existsSync(path.join(dir2, 'team-notes')))
  check('...and the legitimate state is untouched', existsSync(path.join(dir2, 'sessions.json')))
}

// --- 5. Never clobber state already at the new home --------------------------
{
  const home = newHome()
  const legacy = legacyOf(home)
  mkdirSync(legacy, { recursive: true })
  writeFileSync(path.join(legacy, 'sessions.json'), '["OLD"]')
  const target = path.join(home, '.config', 'claudette')
  mkdirSync(target, { recursive: true })
  writeFileSync(path.join(target, 'sessions.json'), '["CURRENT"]')
  const dir = await freshDataDir(home)
  check('existing state at the new home wins', readFileSync(path.join(dir, 'sessions.json'), 'utf8') === '["CURRENT"]')
}

// --- 6. An explicit override is honoured and skips migration -----------------
{
  const home = newHome()
  mkdirSync(legacyOf(home), { recursive: true })
  writeFileSync(path.join(legacyOf(home), 'sessions.json'), '["SHOULD-NOT-MOVE"]')
  const override = mkdtempSync(path.join(tmpdir(), 'claudette-override-'))
  process.env.HOME = home
  process.env.CLAUDETTE_DATA_DIR = override
  const { dataDir } = await import(`../server/src/util/dataDir?override${seq++}`)
  check('CLAUDETTE_DATA_DIR wins', (dataDir as () => string)() === override)
  check('...and an override never drags machine state into it', readdirSync(override).length === 0)
  delete process.env.CLAUDETTE_DATA_DIR
}

console.log(`\n${fail === 0 ? '✅ all green' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
