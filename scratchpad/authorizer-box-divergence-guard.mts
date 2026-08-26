// STANDING GUARD — the out-of-band authorizer must not disagree with the real box.
//
// STATUS 2026-08-25: EXPECTED RED. It documents UNBUILT WORK (the ordering-fault fix, step (i)
// of the sandboxPaths migration), NOT a live escape and NOT a regression. It goes green when
// boxCanReach/sandboxPathAccess resolve in BOX space instead of host space.
//
// WHAT IT PROVES, AND HOW IT DIFFERS FROM EVERY OTHER GUARD ON THIS STRAND. The others reason
// about mount arithmetic. This one RUNS THE REAL BWRAP BOX, performs an actual write inside it,
// and compares the outcome against what `sandboxPathAccess` predicted. Ground truth, not
// argument — which matters because this defect was first derived by hand and explicitly flagged
// by its author as "reasoning, not probed". It reproduced on the first run.
//
// THE DEFECT ("Defect A"). `sandboxPathAccess` sorts `sessionDataMounts` by the depth of the
// mount's LOGICAL path (sortShallowFirst counts separators in the raw `m.path`), matches on the
// CANONICAL path (canonicalizeForAccess realpaths), and takes the LAST match. Two UNRELATED
// mounts can expose the same real bytes without shadowing each other — both are live in the box
// at once — so the correct aggregation is "ANY mount that reaches it grants", not "the last one
// decides". Here a shallow rw mount and a deeper ro mount both reach one tree; last-match picks
// the ro one and the authorizer refuses a write the box performs happily.
//
// DIRECTION: fails CLOSED. It DENIES an out-of-band write the box itself can do, so it surfaces
// as an inexplicable permission error on a legitimate write — wrong, but NOT a breach. Do not
// let it be reported as a sandbox escape. The shadowing defect ("Defect B") recorded in
// mount-shadowing-guard is the one that fails OPEN; they share a root cause and one fix.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { sandboxPathAccess, wrapCommand } from '../server/src/claude/sandbox'

let fail = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail++
}

// A missing bwrap is a MISSING PREREQUISITE, not a failure. The suite must never go red for one.
try { execFileSync('bwrap', ['--version'], { stdio: 'pipe' }) } catch {
  console.log('⏭  bwrap not present — skipping (prerequisite, not a failure)')
  process.exit(0)
}

const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'authz-divergence-')))
mkdirSync(path.join(base, 'x', 'inner'), { recursive: true })
writeFileSync(path.join(base, 'x', 'inner', 'f'), 'ORIGINAL')
mkdirSync(path.join(base, 'd1', 'd2'), { recursive: true })
// A plain rw mount overlapping nothing — the positive control. It must be a real directory and
// must NOT resolve into the `x` tree, or the very defect under test would swallow the control.
mkdirSync(path.join(base, 'plain'), { recursive: true })
// NOTE: the cwd is deliberately NOT used as the positive control. `obligatoryMounts` supplies
// `~/.claude`, not the cwd — a session's own directory arrives via `cfg.mounts` from its caller —
// so `sandboxPathAccess(cfg, cwd, <cwd>/x)` is correctly {read:false,write:false} here. That is
// fixture semantics, not a finding; it was checked.
const cwd = path.join(base, 'work'); mkdirSync(cwd)
// Shallow LOGICAL path, rw, resolving to the INNER dir.
symlinkSync(path.join(base, 'x', 'inner'), path.join(base, 'p'))
// Deeper LOGICAL path, ro, resolving to the OUTER dir. Same tree, neither shadows the other.
symlinkSync(path.join(base, 'x'), path.join(base, 'd1', 'd2', 'c'))

const cfg: any = { enabled: true, mounts: [
  { path: path.join(base, 'p'), mode: 'rw' },
  { path: path.join(base, 'd1', 'd2', 'c'), mode: 'ro' },
  { path: path.join(base, 'plain'), mode: 'rw' },
]}
const target = path.join(base, 'x', 'inner', 'f')
const boxPath = path.join(base, 'p', 'f')

const spawn: any = wrapCommand(cfg, cwd, '/bin/sh', ['-c', `printf MUTATED > ${boxPath}`])
let boxWrote = false
try { execFileSync(spawn.program ?? spawn.cmd ?? 'bwrap', spawn.argv ?? spawn.args ?? [], { stdio: 'pipe' }); boxWrote = true } catch { /* box refused */ }
const boxDidWrite = readFileSync(target, 'utf8') === 'MUTATED'
const authorizer = sandboxPathAccess(cfg, cwd, target)

// The premise. If this ever fails the fixture has stopped exercising the defect, and the
// headline assertion below would then pass for the WRONG REASON — the failure mode this
// codebase keeps producing. Assert it rather than assume it.
check('PREMISE: the real box CAN write the target through the rw mount',
  boxWrote && boxDidWrite, `spawned=${boxWrote} mutated=${boxDidWrite}`)

// The actual claim. RED until step (i) lands.
check('the authorizer AGREES with the box: write is permitted',
  authorizer.write === true, `sandboxPathAccess=${JSON.stringify(authorizer)}`)

// NEGATIVE CONTROL. Without it, "return {read:true,write:true} for everything" passes the
// assertion above. It must be a path in NO mount — note `<base>/x/...` would NOT do, despite
// reading like an outside path: `<base>/x` is exactly what the ro mount resolves to, so it is
// inside a mount and refused for the wrong reason. `<base>/d1/other` is genuinely outside both
// mounts (the ro mount is `<base>/d1/d2/c`, not `<base>/d1`) and outside the obligatory rw cwd.
const outside = sandboxPathAccess(cfg, cwd, path.join(base, 'd1', 'other'))
check('CONTROL: a path in NO mount is refused for both read and write',
  outside.read === false && outside.write === false, JSON.stringify(outside))
// And the control must be able to FAIL: a blanket "refuse everything" would satisfy the line
// above, so assert something is still granted. `<base>/plain` is rw and overlaps no other mount,
// so it is unaffected by the defect under test.
const inside = sandboxPathAccess(cfg, cwd, path.join(base, 'plain', 'g'))
check('CONTROL: a non-overlapping rw mount is still granted (so refuse-everything cannot pass)',
  inside.write === true, JSON.stringify(inside))

console.log(`\n${fail === 0 ? 'all passed' : `${fail} failed`}`)
process.exit(fail === 0 ? 0 : 1)
