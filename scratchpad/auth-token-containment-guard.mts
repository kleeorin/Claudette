// The loopback auth token must not be READABLE from inside any box.
//
// auth.ts:39-45 rests on "~/.config is never bind-mounted into a session sandbox, so the box
// can't just read it" — the same assumption dataDir.ts makes, which
// data-dir-containment-guard.mts has already measured as FALSE for a $HOME-mounted box. The
// token is a sibling file under the same parent.
//
// WHY THIS IS A SEPARATE FILE FROM THE DATA-DIR GUARD: the FIX IS DIFFERENT IN KIND. An ro
// overlay closes the roster hole (writing is the escape there) and does nothing here
// (reading is the escape). Keeping them apart stops one fix being credited with both.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { sandboxPathAccess, wrapCommand, sandboxAvailable } from '../server/src/claude/sandbox'
import { tokenFilePath } from '../server/src/auth'
import { dataDir } from '../server/src/util/dataDir'
import type { SandboxConfig } from '../shared/src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudette-tok-')))
const prevXdg = process.env.XDG_CONFIG_HOME
const prevData = process.env.CLAUDETTE_DATA_DIR
try {
  process.env.XDG_CONFIG_HOME = home
  delete process.env.CLAUDETTE_DATA_DIR
  const tokenFile = tokenFilePath()
  mkdirSync(path.dirname(tokenFile), { recursive: true })
  writeFileSync(tokenFile, 'SECRET-LOOPBACK-TOKEN', { mode: 0o600 })

  const homeBox: SandboxConfig = { enabled: true, mounts: [{ path: home, mode: 'rw' }] }

  // --- 1. THE ESCAPE --------------------------------------------------------
  {
    const t = sandboxPathAccess(homeBox, home, tokenFile)
    check('the loopback auth token is NOT readable from a $HOME-mounted box', !t.read,
      JSON.stringify(t))
  }

  // --- 2. THE TWO PATHS CAN DIVERGE ----------------------------------------
  {
    const together = path.dirname(tokenFile) === dataDir()
    console.log(`   (default layout: token dir === data dir ? ${together})`)
    process.env.CLAUDETTE_DATA_DIR = path.join(home, 'elsewhere', 'claudette')
    mkdirSync(process.env.CLAUDETTE_DATA_DIR, { recursive: true })
    writeFileSync(path.join(process.env.CLAUDETTE_DATA_DIR, 'sessions.json'), '[]')
    check('with CLAUDETTE_DATA_DIR set, the two live in different places',
      path.dirname(tokenFile) !== dataDir(), `${path.dirname(tokenFile)} vs ${dataDir()}`)
    const r = sandboxPathAccess(homeBox, home, path.join(dataDir(), 'sessions.json'))
    const t = sandboxPathAccess(homeBox, home, tokenFile)
    check('BOTH are protected when they diverge (one fix must not cover only one)',
      !r.write && !t.read, `roster=${JSON.stringify(r)} token=${JSON.stringify(t)}`)
    delete process.env.CLAUDETTE_DATA_DIR
  }

  // --- 3. THE ACTUAL BOX ----------------------------------------------------
  if (sandboxAvailable()) {
    const { args } = wrapCommand(homeBox, home, '/bin/sh', ['-c', ':'])
    const dir = path.dirname(tokenFile)
    const bindsAt = (p: string) => args.some((a, i) => (a === '--bind' || a === '--ro-bind') && args[i + 2] === p)
    check('bwrap emits SOME protection over the token directory', bindsAt(dir),
      'mode=none means the broad rw mount exposes it unmodified')
    console.log('   NOTE: read-only is NOT sufficient here — the fix must make it unreadable.')
  } else {
    console.log('⏭  3. skipped — host cannot sandbox')
  }

  // --- 4. NEGATIVE CONTROLS -------------------------------------------------
  {
    const proj = path.join(home, 'proj'); mkdirSync(proj, { recursive: true })
    const ordinary = sandboxPathAccess(homeBox, home, path.join(proj, 'main.ts'))
    check('ordinary files under the same rw mount are still readable AND writable',
      ordinary.read && ordinary.write, JSON.stringify(ordinary))
    const elsewhere: SandboxConfig = { enabled: true, mounts: [{ path: proj, mode: 'rw' }] }
    const outside = sandboxPathAccess(elsewhere, proj, tokenFile)
    check('a project box that never mounts ~/.config cannot reach the token', !outside.read,
      JSON.stringify(outside))
  }
} finally {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg
  if (prevData === undefined) delete process.env.CLAUDETTE_DATA_DIR; else process.env.CLAUDETTE_DATA_DIR = prevData
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
