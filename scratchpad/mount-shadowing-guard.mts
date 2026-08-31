// Pins the invariant that makes the SHADOWING fault unreachable — BEFORE the path layer makes
// it reachable.
//
// THE FAULT. A nested mount OVERMOUNTS its parent's subtree. With M1={dest:/a, src:/x} and
// M2={dest:/a/b, src:/y}, the box sees /a/b as /y, so host path /x/b/f is SHADOWED and
// unreachable — yet a containment test that matches on source roots says "reachable", because
// /x/b/f is inside M1's source. THAT FAILS OPEN: an out-of-band write authorized for a path
// the box itself cannot touch.
//
// WHY IT IS NOT LIVE, and both reasons matter because the second is the fragile one:
//   1. SandboxMount carries ONE path and bwrapBaseArgs emits `--bind m.path m.path`, so dest
//      and source are the same string BY CONSTRUCTION.
//   2. The only way to get dest≠source is a symlinked mount path — and isUnsafeSymlinkMount
//      refuses it. STRUCTURAL, not incidental: that guard probes the LOGICAL parent, and a
//      NESTED mount's logical parent IS the outer rw mount, so it fires for every nested case.
//
// WHY GUARD SOMETHING NOT LIVE. Reason 1 is an accident of a WEAK TYPE, and ResolvedMount
// deliberately removes it. Reason 2 is also the guard most likely to be relaxed for a good
// reason (dotfiles farms). THIS FILE IS THE NOTE THAT SAYS THE REFUSAL IS LOAD-BEARING FOR
// MORE THAN THE ESCAPE IT WAS WRITTEN FOR.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { sessionDataMounts, sandboxPathAccess, sandboxAvailable } from '../server/src/claude/sandbox'
import { viewOf, boxCanReach, resolveReach } from '../server/src/claude/sandboxPaths'
import type { ResolvedMount, LogicalPath, RealPath } from '../server/src/claude/sandboxPaths'
import type { SandboxConfig } from '../shared/src/types'

import { check, passed as pass, failed as fail } from './assert.mjs'

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudette-shadow-')))
try {
  const x = path.join(root, 'x')
  const y = path.join(root, 'y')
  mkdirSync(path.join(x, 'plain'), { recursive: true })
  mkdirSync(y, { recursive: true })
  writeFileSync(path.join(x, 'plain', 'f'), 'outer')
  writeFileSync(path.join(y, 'f'), 'inner')
  symlinkSync('../y', path.join(x, 'b'))
  const a = path.join(root, 'a'); symlinkSync(x, a)
  const farm = path.join(root, 'farm'); symlinkSync(x, farm)

  const nested: SandboxConfig = { enabled: true, mounts: [{ path: a, mode: 'rw' }, { path: path.join(a, 'b'), mode: 'rw' }] }

  // --- 1. THE STRUCTURAL REFUSAL --------------------------------------------
  {
    const kept = sessionDataMounts(nested, a).map((m) => path.resolve(m.path))
    check('the OUTER symlinked mount is kept', kept.includes(path.resolve(a)))
    check('the NESTED symlinked mount is REFUSED — this is what makes shadowing unreachable',
      !kept.includes(path.resolve(path.join(a, 'b'))),
      'if this ever fails, the fail-open shadowing fault is live; see the header')
  }

  // --- 2. BOTH SPELLINGS DENY ------------------------------------------------
  {
    const viaSource = sandboxPathAccess(nested, a, path.join(y, 'f'))
    check("authorizer denies the inner mount's SOURCE spelling", !viaSource.read && !viaSource.write,
      JSON.stringify(viaSource))
    const viaDest = sandboxPathAccess(nested, a, path.join(a, 'b', 'f'))
    check("authorizer denies the inner mount's DEST spelling", !viaDest.read && !viaDest.write,
      JSON.stringify(viaDest))
    const outer = sandboxPathAccess(nested, a, path.join(a, 'plain', 'f'))
    check('…and the OUTER mount still grants (not a deny-everything guard)', outer.read && outer.write,
      JSON.stringify(outer))
  }

  // --- 3. NEGATIVE CONTROL: dotfiles farms must keep working -----------------
  {
    const cfg: SandboxConfig = { enabled: true, mounts: [{ path: farm, mode: 'rw' }] }
    const kept = sessionDataMounts(cfg, farm).map((m) => path.resolve(m.path))
    check('a host-created symlinked mount (dotfiles farm) is still PERMITTED',
      kept.includes(path.resolve(farm)))
    const acc = sandboxPathAccess(cfg, farm, path.join(farm, 'plain', 'f'))
    check('…and is genuinely usable through it', acc.read && acc.write, JSON.stringify(acc))
  }

  // --- 4. BOX-SPACE RESOLUTION: resolveReach, on HAND-BUILT fixtures ---------
  // This section used to be a CHARACTERIZATION driven through viewOf, recording that
  // boxCanReach over-approximated a shadowed path. It was replaced in the same change that
  // extracted resolveReach, deliberately and not by flipping its expectation: once the
  // precondition work refuses M2, /x/b/f becomes genuinely reachable through /a, so the old
  // recorded `true` would have become the CORRECT answer and the only fails-first evidence
  // for the ordering fault would have evaporated with nothing going red.
  //
  // The fixtures are BUILT BY HAND, with no filesystem at all. That is not a workaround —
  // the order-not-depth case CANNOT be produced through viewOf, because viewOf sorts
  // shallow-first, so in production a deeper mount is always emitted later and depth and
  // order coincide. That coincidence is precisely what hid this fault.
  {
    const M = (logical: string, realPath: string, mode: 'rw' | 'ro'): ResolvedMount => ({
      mode,
      logical: logical as LogicalPath,
      real: realPath as RealPath,
      exists: true,
      symlinked: realPath !== logical,
    })
    const T = (p: string): RealPath => p as RealPath

    // 4a. ORDER, NOT DEPTH. The SAME two mounts, at the SAME depths, in the two possible
    // emission orders. Depth cannot distinguish them; only argv position can. bwrap applies
    // binds in argv order and a bind covers its dest and everything beneath it, so a LATER
    // SHALLOWER bind covers an EARLIER DEEPER one.
    const inner = () => M('/a/b', '/src/inner', 'rw')
    const outer = () => M('/a', '/src/outer', 'rw')
    const innerOwnBytes = T('/src/inner/f')

    // Deeper FIRST, shallower LATER → /a covers /a/b, so the inner mount's bytes are gone.
    const covered = resolveReach([inner(), outer()], innerOwnBytes)
    check('4a ORDER-NOT-DEPTH: a later SHALLOWER bind covers an earlier deeper one',
      covered.length === 0, `survivors=${covered.length}`)

    // Same two mounts, order reversed (this is what viewOf actually emits) → /a/b wins.
    const survives = resolveReach([outer(), inner()], innerOwnBytes)
    check('4a …and with the emission order reversed the SAME pair resolves the other way',
      survives.length === 1 && survives[0].logical === '/a/b', `survivors=${survives.length}`)

    // 4b. ANY-GRANTS, NOT LAST-WINS. Two unrelated mountpoints expose the SAME real tree and
    // NEITHER shadows the other — both are live in the box at once. The rw one must grant
    // even though it is not last. Measured against real bwrap: the box wrote the file while
    // the old last-wins code returned write:false.
    //
    // This case is also the guard against a "return nothing when unsure" implementation,
    // which would pass 4a and then deny every legitimate write.
    const rwFirst = M('/m_rw', '/data', 'rw')
    const roLast = M('/m_ro', '/data', 'ro')
    const both = resolveReach([rwFirst, roLast], T('/data/f'))
    check('4b ANY-GRANTS: two unrelated mounts over one tree both survive',
      both.length === 2, `survivors=${both.length}`)
    check('4b …and the rw one grants WRITE even though the ro one is last',
      both.some((m) => m.mode === 'rw'),
      both.map((m) => `${m.logical}:${m.mode}`).join(','))

    // 4c. A mount bwrap will not bind contributes nothing — it can neither expose nor shadow.
    const absent: ResolvedMount = { ...outer(), exists: false }
    const withAbsent = resolveReach([inner(), absent], innerOwnBytes)
    check('4c a non-existent mount cannot shadow (bwrap never binds it)',
      withAbsent.length === 1 && withAbsent[0].logical === '/a/b', `survivors=${withAbsent.length}`)

    // 4d. The end-to-end predicate still agrees on the real-filesystem fixture: the inner
    // mount's own bytes remain reachable through it.
    const v = viewOf(nested.mounts)
    check("4d INVARIANT: the inner mount's own bytes stay reachable through it",
      boxCanReach(v, path.join(y, 'f'), 'read'))
  }

  if (!sandboxAvailable()) {
    console.log('   (note: host cannot sandbox — these are all argv/authorizer-level, so they still hold)')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
