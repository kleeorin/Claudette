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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readdirSync, symlinkSync } from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import path from 'path'
import { sandboxPathAccess, wrapCommand, wrapSandbox, sandboxAvailable } from '../server/src/claude/sandbox'
import { tokenFilePath } from '../server/src/auth'
import { dataDir } from '../server/src/util/dataDir'
import type { SandboxConfig } from '../shared/src/types'

import { check, passed as pass, failed as fail } from './assert.mjs'

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

  // --- 5. EVERY MOUNT MODE, EVERY STATE DIR ---------------------------------
  // Sections 1-3 mount $HOME rw only, and stayed green while a READ-ONLY $HOME mount exposed
  // the token: hiddenStateDests reused overlayDestFor, whose rw-only rule is right for the app
  // source (writing is the escape there) and wrong here (READING is). An ro mount hides nothing
  // from a reader. So every stateDirsToHide() entry — token dir AND a diverged data dir — is
  // checked under ro and rw, through both argv builders, and §3's "SOME protection" is
  // tightened to the actual one: bound FROM AN EMPTY DIR, not ro over the real contents.
  {
    process.env.CLAUDETTE_DATA_DIR = path.join(home, 'elsewhere', 'claudette')
    const tokenDir = path.dirname(tokenFile)
    const stateDirs = [tokenDir, process.env.CLAUDETTE_DATA_DIR]
    const roster = path.join(process.env.CLAUDETTE_DATA_DIR, 'sessions.json')
    const hidesFromEmpty = (args: string[], dest: string) => args.some((a, i) => {
      if (a !== '--ro-bind' || args[i + 2] !== dest || args[i + 1] === dest) return false
      try { return readdirSync(args[i + 1]).length === 0 } catch { return false }
    })
    for (const mode of ['ro', 'rw'] as const) {
      const box: SandboxConfig = { enabled: true, mounts: [{ path: home, mode }] }
      for (const [builder, args] of [
        ['wrapCommand', wrapCommand(box, home, '/bin/sh', ['-c', ':']).args],
        ['wrapSandbox', wrapSandbox(box, ['--version'], home).args],
      ] as const) {
        for (const d of stateDirs) {
          check(`5. ${builder}, ${mode} $HOME: ${path.relative(home, d)} is bound over from an EMPTY dir`,
            hidesFromEmpty(args, d), 'false means the box sees the real contents')
        }
      }
      const t = sandboxPathAccess(box, home, tokenFile)
      const r = sandboxPathAccess(box, home, roster)
      check(`5. sandboxPathAccess, ${mode} $HOME: neither the token nor the roster is readable`,
        !t.read && !r.read, `token=${JSON.stringify(t)} roster=${JSON.stringify(r)}`)
      // THE ACTUAL BOX. Asks only `test -r` — the file contents are never printed.
      if (sandboxAvailable()) {
        const { command, args } = wrapCommand(box, home, '/bin/sh',
          ['-c', 'for f; do if test -r "$f"; then echo READABLE; else echo hidden; fi; done', 'sh', tokenFile, roster])
        const out = spawnSync(command, args, { encoding: 'utf8' })
        check(`5. live bwrap, ${mode} $HOME: token and roster are NOT readable inside the box`,
          out.status === 0 && out.stdout.trim() === 'hidden\nhidden',
          `status=${out.status} stdout=${JSON.stringify(out.stdout.trim())} stderr=${JSON.stringify((out.stderr ?? '').trim().slice(0, 160))}`)
      } else {
        console.log(`⏭  5. live bwrap (${mode}) skipped — host cannot sandbox`)
      }
    }
    delete process.env.CLAUDETTE_DATA_DIR
  }

  // --- 5b. THE STATE DIR'S OWN SPELLING -------------------------------------
  // stateDirsToHide() is lexical (path.resolve). With ~/.config a symlink into a dotfiles tree
  // and the user mounting that tree by its REAL path, the lexical dir matches no mount spelling,
  // so nothing was hidden — even rw — while the box reads the token at its real path. The dest
  // must be computed from the dir's real path too.
  {
    const dot = path.join(home, 'dotfiles'); mkdirSync(path.join(dot, 'config'), { recursive: true })
    const cfgLink = path.join(home, 'cfg-link')
    symlinkSync(path.join(dot, 'config'), cfgLink)
    process.env.XDG_CONFIG_HOME = cfgLink
    const tok = tokenFilePath()
    mkdirSync(path.dirname(tok), { recursive: true })
    writeFileSync(tok, 'SECRET-LOOPBACK-TOKEN', { mode: 0o600 })
    for (const mode of ['ro', 'rw'] as const) {
      const box: SandboxConfig = { enabled: true, mounts: [{ path: dot, mode }] }
      if (sandboxAvailable()) {
        const { command, args } = wrapCommand(box, dot, '/bin/sh',
          ['-c', 'if test -r "$1"; then echo READABLE; else echo hidden; fi', 'sh', realpathSync(tok)])
        const out = spawnSync(command, args, { encoding: 'utf8' })
        check(`5b. live bwrap, ${mode} mount of the REAL dotfiles tree behind a symlinked config dir: token NOT readable`,
          out.status === 0 && out.stdout.trim() === 'hidden',
          `status=${out.status} stdout=${JSON.stringify(out.stdout.trim())} stderr=${JSON.stringify((out.stderr ?? '').trim().slice(0, 160))}`)
      } else {
        console.log(`⏭  5b. live bwrap (${mode}) skipped — host cannot sandbox`)
      }
      const t = sandboxPathAccess(box, dot, realpathSync(tok))
      check(`5b. sandboxPathAccess, ${mode} real dotfiles mount: the token is not readable`, !t.read, JSON.stringify(t))
    }
    process.env.XDG_CONFIG_HOME = home
  }

  // --- 5c. AN ABSENT STATE DIR UNDER AN RO MOUNT MUST NOT BREAK THE LAUNCH ---
  // Hiding under ro mounts must not emit a dest for a dir that does not exist: bwrap cannot
  // create a mountpoint inside a read-only bind, so the box would refuse to start — and a
  // missing dir has nothing to hide. Control for the existence check in hiddenStateDests.
  if (sandboxAvailable()) {
    process.env.CLAUDETTE_DATA_DIR = path.join(home, 'not-created-yet', 'claudette')
    const box: SandboxConfig = { enabled: true, mounts: [{ path: home, mode: 'ro' }] }
    const { command, args } = wrapCommand(box, home, '/bin/sh', ['-c', 'echo up'])
    const out = spawnSync(command, args, { encoding: 'utf8' })
    check('5c. live bwrap, ro $HOME with an ABSENT data dir: the box still launches',
      out.status === 0 && out.stdout.trim() === 'up',
      `status=${out.status} stderr=${JSON.stringify((out.stderr ?? '').trim().slice(0, 160))}`)
    delete process.env.CLAUDETTE_DATA_DIR
  } else {
    console.log('⏭  5c. skipped — host cannot sandbox')
  }

  // --- 5d. A MOUNT OF `/` ---------------------------------------------------
  // Nothing rejects a '/' mount, and the hide used `startsWith(root + sep)` = '//', so under `/`
  // — rw OR ro — no hide was emitted and the box read the token.
  // The fixture is NOT under tmpdir(): measured, a `/` box does not see this process's /tmp
  // when the caller is itself confined (its /tmp is a private mount the `/` bind does not
  // carry), so the token there reads "hidden" whether or not anything hides it — a live check
  // that cannot fail. Under scratchpad/ it is visible through `/`, as a real token would be.
  const rootFx = realpathSync(mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '.tok-root-')))
  try {
    process.env.XDG_CONFIG_HOME = rootFx
    const tokenFile = tokenFilePath()
    mkdirSync(path.dirname(tokenFile), { recursive: true })
    writeFileSync(tokenFile, 'SECRET-LOOPBACK-TOKEN', { mode: 0o600 })
    for (const mode of ['ro', 'rw'] as const) {
      const box: SandboxConfig = { enabled: true, mounts: [{ path: '/', mode }] }
      const tokenDir = path.dirname(tokenFile)
      check(`5d. wrapCommand + wrapSandbox, ${mode} \`/\`: the token dir is bound over from an EMPTY dir`,
        [wrapCommand(box, home, '/bin/sh', ['-c', ':']).args, wrapSandbox(box, ['--version'], home).args].every((args) =>
          args.some((a, i) => {
            if (a !== '--ro-bind' || args[i + 2] !== tokenDir || args[i + 1] === tokenDir) return false
            try { return readdirSync(args[i + 1]).length === 0 } catch { return false }
          })))
      if (sandboxAvailable()) {
        const { command, args } = wrapCommand(box, home, '/bin/sh',
          ['-c', 'if test -r "$1"; then echo READABLE; else echo hidden; fi', 'sh', tokenFile])
        const out = spawnSync(command, args, { encoding: 'utf8' })
        check(`5d. live bwrap, ${mode} \`/\`: the token is NOT readable inside the box`,
          out.status === 0 && out.stdout.trim() === 'hidden',
          `status=${out.status} stdout=${JSON.stringify(out.stdout.trim())} stderr=${JSON.stringify((out.stderr ?? '').trim().slice(0, 160))}`)
      } else {
        console.log(`⏭  5d. live bwrap (${mode}) skipped — host cannot sandbox`)
      }
      const t = sandboxPathAccess(box, home, tokenFile)
      check(`5d. sandboxPathAccess, ${mode} \`/\`: the token is not readable`, !t.read, JSON.stringify(t))
    }
  } finally {
    process.env.XDG_CONFIG_HOME = home
    rmSync(rootFx, { recursive: true, force: true })
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
