// scratchpad/sandbox-symlink-argv-characterization.mts
//
// CHARACTERIZATION, not correctness. It records the argv sandbox.ts emits TODAY for
// symlinked layouts, so steps A3 (isUnsafeSymlinkMount) and A4 (appSourceProtections +
// overlay dest) show up as a REVIEWED DIFF to this file rather than as a silent change.
//
// Assertions are labelled:
//   INVARIANT:  must hold before AND after the path-resolution layer lands. If one of
//               these flips, something broke.
//   TODAY:      encodes current behaviour so a deliberate change is visible as a diff.
//   POST-A4:    recorded but not enforced — flip to a hard check when A4 lands.
//
// Devil's principle, carried over and driving the helper design: modeAtDest() keys on the
// bind's DEST, never its source. A helper keyed on source would hide the second half of
// Finding 3 entirely — an overlay emitted at the app dir's REAL path binds somewhere the
// box never looks, so the detection is fixed and the protection still absent. That is
// precisely how the broken fix would have passed a naive check.
//
//   npx tsx scratchpad/sandbox-symlink-argv-characterization.mts
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { wrapCommand, sandboxAvailable } from '../server/src/claude/sandbox'
import type { SandboxConfig } from '../shared/src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

if (!sandboxAvailable()) {
  console.log('SKIP — host cannot sandbox (bwrap/userns unavailable); no argv is produced here')
  process.exit(0)
}

// The mode bwrap would apply AT DEST: the LAST bind whose dest (args[i+2]) is exactly `p`.
// Keyed on dest, never source — see the header.
function modeAtDest(args: string[], p: string): 'rw' | 'ro' | 'none' {
  let mode: 'rw' | 'ro' | 'none' = 'none'
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i + 2] !== p) continue
    if (args[i] === '--bind') mode = 'rw'
    else if (args[i] === '--ro-bind') mode = 'ro'
  }
  return mode
}
const boundAtAll = (args: string[], p: string): boolean =>
  args.some((a, i) => (a === '--bind' || a === '--ro-bind') && args[i + 2] === p)

// realpath the fixture root immediately. On a host where tmpdir() is itself a symlink
// (some distros, and macOS), an un-resolved root would make realpath(parent) differ from
// the logical mount path for reasons that have nothing to do with what we are measuring —
// section 2 would then be silently exercising Finding 2 instead of the guard it targets.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudette-symlink-char-')))

// THE APP-ROOT FIXTURE AND ITS ENV OVERRIDE MUST BE ESTABLISHED BEFORE THE FIRST
// wrapCommand() CALL ANYWHERE IN THIS FILE. appSourceRoot() memoizes into a module-level
// `cachedAppRoot` (sandbox.ts:86-90), and that cache is populated by the first call —
// which is section 1's wrapCommand, NOT module import. Setting CLAUDETTE_APP_ROOT inside
// section 3, as this file originally did, was therefore too late: sections 1 and 2 had
// already pinned the cache to the REAL repo root, so section 3 measured a root with no
// relationship to its own fixture and reported `none` for both spellings — passing
// identically against patched and unpatched source, i.e. proving nothing.
//
// That is not a hypothetical: it was caught by running this file against a patched tree
// and against HEAD and getting byte-identical output. It is exactly the "silently measure
// the wrong root and pass for the wrong reason" hazard the section-3 comment warns about,
// arriving one section earlier than the warning expected. Hoisting is the whole fix.
// When A1 lands, a resetAppRoot() beside resetSandboxProbe() (sandbox.ts:195) would make
// the ordering irrelevant and this comment unnecessary.
const app = path.join(root, 'app')
const appLink = path.join(root, 'app-link')
mkdirSync(path.join(app, 'server'), { recursive: true })
mkdirSync(path.join(app, 'shared'), { recursive: true })
symlinkSync(app, appLink)
const prevRoot = process.env.CLAUDETTE_APP_ROOT
const prevAllow = process.env.CLAUDETTE_ALLOW_APP_SOURCE_MOUNT
process.env.CLAUDETTE_APP_ROOT = app
delete process.env.CLAUDETTE_ALLOW_APP_SOURCE_MOUNT

try {
  // --- 1. a mount whose SOURCE is a symlink, parent NOT box-writable ---------
  // isUnsafeSymlinkMount (sandbox.ts:477-485) should PERMIT this: the link's parent is the
  // fixture root, which no box can write, so the link was created by the host. This is the
  // dotfiles-farm / /srv-mounted-project shape, and it must keep working.
  {
    const real = path.join(root, 'real')
    const link = path.join(root, 'link')
    mkdirSync(path.join(real, 'sub'), { recursive: true })
    writeFileSync(path.join(real, 'sub', 'f.txt'), 'x')
    symlinkSync(real, link)

    const cfg: SandboxConfig = { enabled: true, mounts: [{ path: link, mode: 'rw' }] }
    const { args } = wrapCommand(cfg, link, '/bin/sh', ['-c', ':'])

    check('INVARIANT: a host-created symlinked mount is still bound (dotfiles farms keep working)',
      boundAtAll(args, link), `mode=${modeAtDest(args, link)}`)
    check('TODAY: it is bound at the LOGICAL dest, so the box sees it at the link path',
      modeAtDest(args, link) === 'rw', modeAtDest(args, link))
    // THE SINGLE MOST IMPORTANT LINE IN THIS FILE. The real target is NOT separately
    // bound — the box reaches those bytes only through the link path. That is the fact
    // which makes any protective overlay emitted at the REAL path inert, and it is what
    // the second half of Finding 3 turns on.
    check('TODAY: the real target is NOT bound at its own path (overlays there would be inert)',
      !boundAtAll(args, real), `real=${modeAtDest(args, real)}`)
  }

  // --- 2. a symlink the BOX could have planted -------------------------------
  // Parent is inside a box-writable mount, so isUnsafeSymlinkMount MUST refuse it. Without
  // the refusal a planted `<cwd>/x -> /` gets `/` bound rw inside the box (SANDBOX.md
  // "Symlinked-mount escape").
  {
    const proj = path.join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const planted = path.join(proj, 'planted')
    symlinkSync(root, planted)

    const cfg: SandboxConfig = {
      enabled: true,
      mounts: [{ path: proj, mode: 'rw' }, { path: planted, mode: 'rw' }],
    }
    const { args } = wrapCommand(cfg, proj, '/bin/sh', ['-c', ':'])

    check('INVARIANT: a symlink planted inside a box-writable mount is REFUSED',
      !boundAtAll(args, planted), `mode=${modeAtDest(args, planted)}`)
    check('INVARIANT: refusing the planted link does not disturb the project mount',
      modeAtDest(args, proj) === 'rw', modeAtDest(args, proj))
  }

  // --- 3. the app-source overlay DEST under a symlinked mount ----------------
  // Finding 3's second half. Point CLAUDETTE_APP_ROOT at the REAL app dir, mount it via
  // the LINK, and ask where the protective overlay actually lands. Note appSourceRoot()
  // uses path.resolve (sandbox.ts:90) — lexical, not realpath — so the two sides are
  // logical-vs-real here by construction rather than by accident.
  {
    // Fixture and env override are established at the top of the file — see the hoisting
    // comment there. Do not move them back into this block.
    {
      const cfg: SandboxConfig = { enabled: true, mounts: [{ path: appLink, mode: 'rw' }] }
      const { args } = wrapCommand(cfg, appLink, '/bin/sh', ['-c', ':'])

      const realServer = path.join(app, 'server')       // where the overlay is emitted today
      const seenServer = path.join(appLink, 'server')   // where the box actually looks

      check('INVARIANT: the box reaches the app source through the LINK path',
        modeAtDest(args, appLink) === 'rw', modeAtDest(args, appLink))

      console.log(`   overlay at REAL path (${realServer}): ${modeAtDest(args, realServer)}`)
      console.log(`   overlay at SEEN path (${seenServer}): ${modeAtDest(args, seenServer)}`)

      // Recorded, not enforced, so this file documents today without failing for it.
      // WHEN A4 LANDS: change this to a hard check that modeAtDest(args, seenServer) === 'ro'.
      // An assertion that merely counts overlays, or that checks the REAL path, would pass
      // against a fix that protects nothing — that is the whole point of this section.
      // Verified both ways in isolation before this assertion was written down:
      //   HEAD    → REAL=none  SEEN=none   (Finding 3: no protection is emitted at all)
      //   patched → REAL=none  SEEN=ro     (the overlay lands where the box looks)
      check('POST-A4 (recorded, not enforced): the overlay must land where the box looks',
        true, `seen=${modeAtDest(args, seenServer)} — must become 'ro' after A4`)
    }
  }
} finally {
  if (prevRoot === undefined) delete process.env.CLAUDETTE_APP_ROOT
  else process.env.CLAUDETTE_APP_ROOT = prevRoot
  if (prevAllow !== undefined) process.env.CLAUDETTE_ALLOW_APP_SOURCE_MOUNT = prevAllow
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
