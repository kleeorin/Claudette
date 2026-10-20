// Pure path logic against real symlinks in a tmpdir. No bwrap, no server, no argv.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import {
  viewOf, real, boxCanReach, refuseIfBoxCouldHavePlaced, overlayPathFor,
  type RealPath,
} from '../server/src/claude/sandboxPaths'
import { pathInWritableMount, sandboxPathAccess, pathVisibleInSandbox, sessionDataMountPlan, wrapCommand, wrapSandbox, appSourceRoot } from '../server/src/claude/sandbox'
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
    // The CANDIDATE is symlinked, not the mount. Its logical path is outside every mount; its
    // REAL path is inside an rw one, so the box could have written the interpreter it resolves
    // to. Matching only logical(p) against the mount roots misses it and runs the probe on the
    // HOST. #25 is the plain-mount form, #25b the QC scenario (rw /proj -> /srv/app, candidate
    // via /elsewhere/link -> /srv/app/x). Fixtures under realtarget/linkmount exist on disk so
    // real() can resolve the candidate.
    const elsewhere = path.join(root, 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    mkdirSync(path.join(proj, 'x', '.venv', 'bin'), { recursive: true })
    mkdirSync(path.join(realtarget, 'x', '.venv', 'bin'), { recursive: true })
    symlinkSync(path.join(proj, 'x'), path.join(elsewhere, 'plainlink'))
    symlinkSync(path.join(realtarget, 'x'), path.join(elsewhere, 'link'))
    check('25. pathInWritableMount: a candidate whose REAL path is inside an rw mount is refused',
      pathInWritableMount(cfg({ path: proj, mode: 'rw' }), cwd, path.join(elsewhere, 'plainlink', '.venv', 'bin', 'python3')),
      'false here means the venv probe execs a box-written interpreter on the HOST')
    check('25b. …also when the rw mount itself is symlinked (rw linkmount -> realtarget, candidate via elsewhere/link -> realtarget/x)',
      pathInWritableMount(cfg({ path: linkmount, mode: 'rw' }), cwd, path.join(elsewhere, 'link', '.venv', 'bin', 'python3')))
    // Control, so "refuse everything" cannot pass #25: a symlink pointing OUTSIDE every mount.
    mkdirSync(path.join(root, 'outside', '.venv', 'bin'), { recursive: true })
    symlinkSync(path.join(root, 'outside'), path.join(elsewhere, 'outlink'))
    check('25c. …while a symlinked candidate that resolves outside every mount is not refused',
      !pathInWritableMount(cfg({ path: proj, mode: 'rw' }), cwd, path.join(elsewhere, 'outlink', '.venv', 'bin', 'python3')))
  }

  // --- A3: the symlinked-mount escape guard through the layer ---------------
  // The link NODE sits under the REAL root of a symlinked rw mount (rw linkmount -> realtarget,
  // mount realtarget/escape -> root). The box writes realtarget through linkmount, so it can
  // plant that link — yet its parent, logical or realpath'd, lies under no LOGICAL rw root, so
  // the pre-A3 guard bound it and bwrap followed it out of the box. #26b is the ordinary form:
  // the user mounts the project by its link and opens the session at its real spelling, so the
  // obligatory rw <cwd>/.claude is a box-plantable link.
  {
    const cfg = (...mounts: SandboxMount[]): SandboxConfig => ({ enabled: true, mounts })
    const escape = path.join(realtarget, 'escape')
    symlinkSync(root, escape)
    const excludedFrom = (c: SandboxConfig, cwd: string, p: string) =>
      sessionDataMountPlan(c, cwd).excluded.some((e) => path.resolve(e.mount.path) === p)
    const argvBinds = (c: SandboxConfig, cwd: string, p: string) =>
      wrapCommand(c, cwd, '/bin/sh', ['-c', ':']).args.some((a, i, all) => (a === '--bind' || a === '--ro-bind') && all[i + 1] === p)
    const c26 = cfg({ path: linkmount, mode: 'rw' }, { path: escape, mode: 'rw' })
    check('26. a symlinked mount whose link sits under the REAL root of a symlinked rw mount is EXCLUDED',
      excludedFrom(c26, linkmount, escape), 'false here means the box can plant <rw mount>/escape -> / and get / bound rw')
    check('26a. …and is not emitted into the box argv',
      !argvBinds(c26, linkmount, escape))
    const realCwd = path.join(realtarget, 'deep')
    symlinkSync(root, path.join(realCwd, '.claude'))
    check('26b. the obligatory <cwd>/.claude is excluded when cwd is the REAL spelling of a symlinked rw mount',
      excludedFrom(cfg({ path: linkmount, mode: 'rw' }), realCwd, path.join(realCwd, '.claude')))
    // Control, so "refuse every symlink" cannot pass #26: a host-created link (parent writable
    // by no box spelling) is still bound — the dotfiles-farm case.
    const farm = path.join(root, 'farm')
    symlinkSync(realtarget, farm)
    // --- F2: a mount of `/` -------------------------------------------------
    // Nothing rejects it (UI picker, normalizeSandbox, defaults store all accept '/'). Every
    // containment test spelled `t.startsWith(root + sep)`, which for root '/' is '//' and
    // matches nothing but '/' itself: the venv probe ran on the HOST, the authorizer denied
    // everything, and argv bound `/` rw with NO app-source overlay.
    {
      const rootRw = cfg({ path: '/', mode: 'rw' }), rootRo = cfg({ path: '/', mode: 'ro' })
      check('27. pathInWritableMount: anything under an rw `/` mount is refused (probe stays in the box)',
        pathInWritableMount(rootRw, proj, path.join(proj, '.venv', 'bin', 'python3')))
      check('27a. …while an ro `/` mount refuses nothing',
        !pathInWritableMount(rootRo, proj, path.join(proj, '.venv', 'bin', 'python3')))
      check('27b. sandboxPathAccess: an rw `/` mount reaches a file read+write, an ro one read-only',
        JSON.stringify(sandboxPathAccess(rootRw, proj, f)) === '{"read":true,"write":true}'
        && JSON.stringify(sandboxPathAccess(rootRo, proj, f)) === '{"read":true,"write":false}',
        `rw=${JSON.stringify(sandboxPathAccess(rootRw, proj, f))} ro=${JSON.stringify(sandboxPathAccess(rootRo, proj, f))}`)
      const src = path.join(appSourceRoot(), 'server')
      const roAt = (a: string[], p: string) => a.some((x, i) => x === '--ro-bind' && a[i + 1] === p && a[i + 2] === p)
      check('27c. argv: an rw `/` mount pins the server source read-only (self-modification overlay)',
        roAt(wrapCommand(rootRw, proj, '/bin/sh', ['-c', ':']).args, src)
        && roAt(wrapSandbox(rootRw, ['--version'], proj).args, src), `no --ro-bind ${src}`)
      check('27d. pathVisibleInSandbox: everything is visible under an ro `/` mount',
        pathVisibleInSandbox([{ path: '/', mode: 'ro' }], f))
      // bwrapBaseArgs's cwd-lineage test had the same '//' prefix, so under a `/` mount it
      // judged cwd unreachable and bound an EMPTY dir over the project — hiding the very tree
      // the session was opened on.
      const emptyOver = (a: string[], p: string) => a.some((x, i) => x === '--ro-bind' && a[i + 2] === p && a[i + 1] !== p)
      // The relative path under `/` was `slice(root.length + 1)`, which for '/' eats the first
      // character. A lone `/` mount hid that (the mangled box path is still under '/'); a deeper
      // mount that SHADOWS it does not: the mangled path escapes the ro pocket, `/` stays the
      // owner, and an rw `/` granted a write the box cannot perform — authorizer fail-OPEN.
      check('27f. sandboxPathAccess: an ro pocket inside an rw `/` mount is NOT writable',
        JSON.stringify(sandboxPathAccess(cfg({ path: '/', mode: 'rw' }, { path: proj, mode: 'ro' }), proj, f)) === '{"read":true,"write":false}',
        JSON.stringify(sandboxPathAccess(cfg({ path: '/', mode: 'rw' }, { path: proj, mode: 'ro' }), proj, f)))
      check('27g. overlayPathFor: under a `/` mount the overlay lands at the target itself',
        overlayPathFor(viewOf([{ path: '/', mode: 'rw' }]), R(path.join(proj, 'sub'))) === path.join(proj, 'sub'),
        `got ${overlayPathFor(viewOf([{ path: '/', mode: 'rw' }]), R(path.join(proj, 'sub')))}`)
      check('27e. argv: under a `/` mount, cwd is NOT replaced by an empty dir',
        !emptyOver(wrapCommand(rootRw, proj, '/bin/sh', ['-c', ':']).args, proj)
        && !emptyOver(wrapCommand(rootRo, proj, '/bin/sh', ['-c', ':']).args, proj))
    }
    check('26c. …while a host-created symlinked mount next to it is still active and bound',
      !excludedFrom(cfg({ path: proj, mode: 'rw' }, { path: farm, mode: 'rw' }), proj, farm)
      && argvBinds(cfg({ path: proj, mode: 'rw' }, { path: farm, mode: 'rw' }), proj, farm))
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
