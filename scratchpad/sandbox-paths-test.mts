// Pure path logic against real symlinks in a tmpdir. No bwrap, no server, no argv.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  viewOf, real, boxCanReach, refuseIfBoxCouldHavePlaced, overlayPathFor,
  type RealPath,
} from '../server/src/claude/sandboxPaths'
import { pathInWritableMount, sandboxPathAccess, pathVisibleInSandbox } from '../server/src/claude/sandbox'
import type { SandboxConfig, SandboxMount } from '../shared/src/types'

import { check, passed as pass, failed as fail } from './assert.mjs'
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudette-paths-')))
const R = (p: string): RealPath => {
  const r = real(p)
  if (r === null) throw new Error(`fixture path unresolvable: ${p}`)
  return r
}
const view = (...mounts: SandboxMount[]) => viewOf(mounts)

try {
  const proj = path.join(root, 'proj')
  const inner = path.join(proj, 'inner')
  const f = path.join(proj, 'sub', 'f.txt')
  const realtarget = path.join(root, 'realtarget')
  const g = path.join(realtarget, 'deep', 'g.txt')
  const linkmount = path.join(root, 'linkmount')
  const planted = path.join(proj, 'planted')
  mkdirSync(path.join(proj, 'sub'), { recursive: true })
  mkdirSync(inner, { recursive: true })
  mkdirSync(path.join(realtarget, 'deep'), { recursive: true })
  writeFileSync(f, 'x'); writeFileSync(g, 'y')
  symlinkSync(realtarget, linkmount)
  symlinkSync(root, planted)

  // --- Q1 REACH -------------------------------------------------------------
  {
    const v = view({ path: proj, mode: 'rw' })
    check('1. a path inside an rw mount is readable and writable',
      boxCanReach(v, f, 'read') && boxCanReach(v, f, 'write'))
    check('2. a path outside every mount is unreachable',
      !boxCanReach(v, g, 'read'))
    const ro = view({ path: proj, mode: 'ro' })
    check('3. a ro mount is readable but not writable',
      boxCanReach(ro, f, 'read') && !boxCanReach(ro, f, 'write'))
    const pocket = view({ path: proj, mode: 'ro' }, { path: inner, mode: 'rw' })
    check('4. a rw pocket nested in a ro tree is writable…',
      boxCanReach(pocket, path.join(inner, 'x'), 'write'))
    check('   …while the surrounding ro tree is not',
      !boxCanReach(pocket, f, 'write'))
    const linked = view({ path: linkmount, mode: 'rw' })
    check('5. a symlinked mount source makes its REAL target reachable',
      boxCanReach(linked, g, 'write'), 'logical-only containment would say no')
    check('6. an unresolvable path fails closed',
      !boxCanReach(view({ path: proj, mode: 'rw' }), '/nonexistent-xyz-9/sub/file', 'read'))
  }

  // --- Q2 PROVENANCE (as a refusal) -----------------------------------------
  {
    const v = view({ path: proj, mode: 'rw' })
    check('7. a candidate inside an rw mount is refused',
      !!refuseIfBoxCouldHavePlaced(v, path.join(proj, '.venv', 'bin', 'python3')))
    check('8. a path outside every mount is NOT refused (sound negative)',
      refuseIfBoxCouldHavePlaced(v, path.join(root, 'elsewhere', 'python3')) === undefined)
    check('9. a RO mount does not make a path box-placeable',
      refuseIfBoxCouldHavePlaced(view({ path: proj, mode: 'ro' }), f) === undefined)
    const linked = view({ path: linkmount, mode: 'rw' })
    check('10. a candidate under the REAL target of a symlinked rw mount is refused',
      !!refuseIfBoxCouldHavePlaced(linked, g), 'this is the fourth instance the layer exists for')
    check('11. …and so is the same file addressed via the logical mount path',
      !!refuseIfBoxCouldHavePlaced(linked, path.join(linkmount, 'deep', 'g.txt')))
    check('12. a symlink planted in an rw mount is refused by its LEXICAL path',
      !!refuseIfBoxCouldHavePlaced(v, planted), 'even though it resolves outside the mount')
    check('13. the refusal carries a message naming the mount (for the console.warn)',
      (refuseIfBoxCouldHavePlaced(v, planted)?.message ?? '').includes(proj))
  }

  // --- Q3 EMISSION ----------------------------------------------------------
  {
    const plain = view({ path: proj, mode: 'rw' })
    check('14a. with no symlink, the overlay path is the target itself',
      overlayPathFor(plain, R(path.join(proj, 'sub'))) === path.join(proj, 'sub'))
    const linked = view({ path: linkmount, mode: 'rw' })
    const dest = overlayPathFor(linked, R(path.join(realtarget, 'deep')))
    check('14b. through a symlinked mount, the overlay binds where the BOX looks',
      dest === path.join(linkmount, 'deep'), `got ${dest}`)
    check('14c. …which is NOT the real path (the inert-overlay bug, stated as a fact)',
      dest !== path.join(realtarget, 'deep'))
    check('15. a target outside every mount has no overlay path',
      overlayPathFor(plain, R(path.join(root, 'realtarget'))) === null)
  }

  // --- the view itself ------------------------------------------------------
  {
    const v = view({ path: linkmount, mode: 'rw' }, { path: proj, mode: 'ro' })
    check('16. entries are sorted shallowest-first (bwrap emission order)',
      v.entries.length === 2 && v.entries.every((e) => e.exists))
    check('17. a symlinked mount is flagged, so a caller can warn instead of staying silent',
      v.entries.find((e) => e.logical === linkmount)?.symlinked === true)
    check('18. a plain mount is not flagged',
      v.entries.find((e) => e.logical === proj)?.symlinked === false)
    const missing = viewOf([{ path: path.join(root, 'gone'), mode: 'rw' }])
    check('19. a non-existent mount is marked, not silently dropped',
      missing.entries[0]?.exists === false)
    // RE-SPECIFIED at A2 (user decision 2026-10-05), not a regression: this used to assert
    // `=== undefined`. Provenance is about a FUTURE exec, and an rw mount absent now may be bound
    // at the next launch — skipping it ran a candidate under it on the HOST (fail-open).
    check('20. …and a non-existent RW mount STILL makes its subtree box-placeable',
      !!refuseIfBoxCouldHavePlaced(missing, path.join(root, 'gone', 'x')),
      'skipping it is fail-OPEN: the probe would run on the host')
    // Control, so "refuse everything" cannot pass #20.
    const missingRo = viewOf([{ path: path.join(root, 'gone'), mode: 'ro' }])
    check('20b. …while a non-existent RO mount does not',
      refuseIfBoxCouldHavePlaced(missingRo, path.join(root, 'gone', 'x')) === undefined)
  }

  // --- the wired callers in sandbox.ts (A2) ---------------------------------
  {
    const cfg = (...mounts: SandboxMount[]): SandboxConfig => ({ enabled: true, mounts })
    const gone = path.join(root, 'gone-rw')
    const cwd = path.join(root, 'cwd-elsewhere')
    mkdirSync(cwd, { recursive: true })
    check('21. pathInWritableMount: a NON-EXISTENT rw mount still refuses (probe stays in the box)',
      pathInWritableMount(cfg({ path: gone, mode: 'rw' }), cwd, path.join(gone, '.venv', 'bin', 'python3')),
      'false here means a planted interpreter would be executed on the HOST')
    check('21b. …while a path outside every mount is not refused',
      !pathInWritableMount(cfg({ path: gone, mode: 'rw' }), cwd, path.join(root, 'elsewhere', 'python3')))
    check('22. pathInWritableMount: a symlink planted in an rw mount is refused by its LEXICAL path',
      pathInWritableMount(cfg({ path: proj, mode: 'rw' }), cwd, planted))
    check('23. sandboxPathAccess grants write through an rw mount and read-only through a ro one',
      JSON.stringify(sandboxPathAccess(cfg({ path: proj, mode: 'rw' }), cwd, f)) === '{"read":true,"write":true}'
      && JSON.stringify(sandboxPathAccess(cfg({ path: proj, mode: 'ro' }), cwd, f)) === '{"read":true,"write":false}')
    check('24. pathVisibleInSandbox: an ancestor mount makes p visible, a descendant one does not',
      pathVisibleInSandbox([{ path: proj, mode: 'ro' }], f)
      && !pathVisibleInSandbox([{ path: path.join(proj, 'sub'), mode: 'ro' }], proj))
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
