// The session roster must not be writable from inside ANY box, whatever the mounts are.
//
// dataDir.ts:9-26 rests the whole restore-is-trusted premise on ~/.config never being
// bind-mounted. That is true of the OBLIGATORY mounts. It is not true of user-chosen ones,
// and there is no ro overlay covering dataDir() the way appSourceProtections covers the app
// source and hookSettingsProtections covers settings.json. This file tests the CONTAINMENT
// property rather than the LOCATION property that data-dir-test.mts already pins — they are
// different claims and only the second one is guarded today.
//
// CLAUDETTE_DATA_DIR is set throughout, which (a) is the documented test-isolation override
// and (b) makes migrateLegacy return early, so this file never touches the operator's real
// ~/.claude or ~/.config.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { sandboxPathAccess, wrapCommand, sandboxAvailable } from '../server/src/claude/sandbox'
import type { SandboxConfig } from '../shared/src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}
function modeAtDest(args: string[], p: string): 'rw' | 'ro' | 'none' {
  let mode: 'rw' | 'ro' | 'none' = 'none'
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i + 2] !== p) continue
    if (args[i] === '--bind') mode = 'rw'
    else if (args[i] === '--ro-bind') mode = 'ro'
  }
  return mode
}

const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudette-ddc-')))
const prev = process.env.CLAUDETTE_DATA_DIR
try {
  const data = path.join(home, '.config', 'claudette')
  const roster = path.join(data, 'sessions.json')
  const ledger = path.join(data, 'exposed-configs.json')
  const notes = path.join(data, 'team-notes')
  mkdirSync(notes, { recursive: true })
  writeFileSync(roster, '[]'); writeFileSync(ledger, '{}')
  process.env.CLAUDETTE_DATA_DIR = data

  const homeBox: SandboxConfig = { enabled: true, mounts: [{ path: home, mode: 'rw' }] }

  // --- 1. THE AUTHORIZER ----------------------------------------------------
  {
    const r = sandboxPathAccess(homeBox, home, roster)
    check('the session ROSTER is not writable from a $HOME-mounted box', !r.write, JSON.stringify(r))
    const l = sandboxPathAccess(homeBox, home, ledger)
    check('the hook-poisoning LEDGER is not writable either', !l.write, JSON.stringify(l))
    const n = sandboxPathAccess(homeBox, home, path.join(notes, 'reviewer.md'))
    check("TEAM NOTES are not writable either (injected into a new teammate's first turn)",
      !n.write, JSON.stringify(n))
  }

  // --- 2. THE ACTUAL BOX ----------------------------------------------------
  if (sandboxAvailable()) {
    const { args } = wrapCommand(homeBox, home, '/bin/sh', ['-c', ':'])
    check('bwrap pins the data dir READ-ONLY on top of the broader rw mount',
      modeAtDest(args, data) === 'ro', `mode=${modeAtDest(args, data)}`)
  } else {
    console.log('⏭  2. skipped — host cannot sandbox')
  }

  // --- 3. NEGATIVE CONTROL --------------------------------------------------
  {
    const proj = path.join(home, 'proj')
    mkdirSync(proj, { recursive: true })
    const ordinary = sandboxPathAccess(homeBox, home, path.join(proj, 'main.ts'))
    check('ordinary files under the same rw mount are STILL writable', ordinary.write,
      JSON.stringify(ordinary))
    const elsewhere: SandboxConfig = { enabled: true, mounts: [{ path: proj, mode: 'rw' }] }
    const outside = sandboxPathAccess(elsewhere, proj, roster)
    check('a project box that never mounts the data dir cannot reach it', !outside.read,
      JSON.stringify(outside))
  }
} finally {
  if (prev === undefined) delete process.env.CLAUDETTE_DATA_DIR
  else process.env.CLAUDETTE_DATA_DIR = prev
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
