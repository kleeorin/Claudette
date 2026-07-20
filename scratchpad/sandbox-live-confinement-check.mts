// LIVE nested-bwrap check: actually RUN the boxes wrapCommand builds and confirm the
// filesystem firewall holds end-to-end (not just at the argv level).
//   - a CONFINED box writes only inside its rw mount, cannot write outside it, and cannot
//     READ an out-of-mount secret;
//   - a DENY-ALL box (the fail-closed default for an unresolved session) sees no user
//     data at all — not even the cwd it was pointed at.
//
//   npx tsx scratchpad/sandbox-live-confinement-check.mts
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { wrapCommand, sandboxAvailable } from '../server/src/claude/sandbox'
import { DENY_ALL_SANDBOX } from '../server/src/claude/sessionConfinement'
import type { SandboxConfig } from '../shared/src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

if (!sandboxAvailable()) {
  console.log('(host cannot sandbox — live confinement not exercised)')
  process.exit(0)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'))
const proj = path.join(root, 'proj'); fs.mkdirSync(proj, { recursive: true })
const secret = path.join(root, 'secret'); fs.mkdirSync(secret, { recursive: true })
fs.writeFileSync(path.join(secret, 'creds.txt'), 'TOP-SECRET')

const run = (spec: { command: string; args: string[] }) =>
  spawnSync(spec.command, spec.args, { encoding: 'utf8', timeout: 15_000 })

// --- CONFINED box: rw mount = proj only --------------------------------------
{
  const cfg: SandboxConfig = { enabled: true, mounts: [{ path: proj, mode: 'rw' }] }
  const script =
    `echo IN > ${proj}/marker; ` +                          // inside the mount → should persist
    `echo OUT > ${secret}/marker 2>/dev/null; ` +           // outside → should fail/vanish
    `cat ${secret}/creds.txt 2>/dev/null || echo NO_SECRET` // outside → should be unreadable
  const r = run(wrapCommand(cfg, proj, '/bin/sh', ['-c', script]))
  check('confined box WROTE inside its rw mount (visible on host)', fs.existsSync(path.join(proj, 'marker')))
  check('confined box could NOT write outside its mounts (nothing on host)', !fs.existsSync(path.join(secret, 'marker')))
  check('confined box could NOT read an out-of-mount secret', !(r.stdout ?? '').includes('TOP-SECRET') && (r.stdout ?? '').includes('NO_SECRET'), JSON.stringify(r.stdout))
}

// --- DENY-ALL box: the fail-closed default (no data mounts) -------------------
{
  fs.writeFileSync(path.join(proj, 'marker2'), 'hi')   // exists on host, inside proj
  const script = `cat ${proj}/marker2 2>/dev/null && echo SAW_MARKER || echo BLOCKED`
  // Pointed AT proj as cwd, but with NO data mounts — proj must be invisible.
  const r = run(wrapCommand(DENY_ALL_SANDBOX, proj, '/bin/sh', ['-c', script]))
  check('deny-all box canNOT see the project dir it was pointed at (fail closed)',
    (r.stdout ?? '').includes('BLOCKED') && !(r.stdout ?? '').includes('SAW_MARKER'), JSON.stringify(r.stdout))
}

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
