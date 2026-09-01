// PROBE for three verified sandbox escapes (Critic's findings 1-3). Each check is
// written to FAIL against the vulnerable code and PASS once fixed, so this file is the
// before/after evidence for the point fixes in server/src/claude/sandbox.ts.
//
//   1. which() interpolated its argument into `sh -c` UNQUOTED  → host RCE, unsandboxed.
//   2. isUnsafeSymlinkMount compared a REALPATH'd parent against LOGICAL rw roots, so a
//      symlinked ancestor on any mount made the guard match nothing and permit the mount.
//   3. appSourceProtections compared a REALPATH'd app dir against LOGICAL mount paths,
//      so the same layout emitted NO read-only overlay over the server's own source.
//
// (2) and (3) share a root cause and are checked separately because the consequence
// differs: (2) is a full filesystem bind, (3) is write-access to code the HOST executes.
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import type { SandboxConfig } from '../shared/src/index.ts'

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sbx-three-')))

// A two-volume layout: `link/` is a symlink to `real/`, so every mount declared through
// `link/` has a symlinked ancestor. This is an ordinary setup (a home dir on one volume,
// work on another), NOT a contrived one — which is what makes 2 and 3 reachable.
const real = path.join(root, 'real')
const link = path.join(root, 'link')
mkdirSync(real, { recursive: true })
symlinkSync(real, link)

// Point appSourceRoot at the REAL path while the mount is declared via the LOGICAL one —
// exactly the mismatch a checkout under a symlinked ancestor produces. Set before the
// module is imported, since appSourceRoot() caches on first call.
const appRootReal = path.join(real, 'Claudette')
for (const d of ['server', 'shared']) mkdirSync(path.join(appRootReal, d), { recursive: true })
process.env.CLAUDETTE_APP_ROOT = appRootReal

const { wrapCommand, wrapSandbox, sandboxAvailable } = await import('../server/src/claude/sandbox.ts')

import { withMarks, failed as failures } from './assert.mjs'
const check = withMarks({ sep: '  — ' })

try {
  console.log(`(sandboxAvailable=${sandboxAvailable()}; appSourceRoot=${appRootReal})\n`)

  // ── 1. which() shell injection ───────────────────────────────────────────────
  // A confined session plants an interpreter under a path carrying a command
  // substitution, inside its own legitimate rw mount. wrapCommand resolves the program
  // through which() BEFORE it builds the box, so the substitution runs on the host.
  const marker = path.join(root, 'RCE-MARKER')
  const proj1 = path.join(real, 'work', 'proj')
  mkdirSync(proj1, { recursive: true })
  const planted = path.join(proj1, `p$(touch ${marker})x`, '.venv', 'bin', 'python3')
  const cfg1: SandboxConfig = { enabled: true, mounts: [{ path: proj1, mode: 'rw' }] }
  try { wrapCommand(cfg1, proj1, planted, ['-c', 'import jupyter_server']) } catch { /* resolution failure is fine */ }
  check('1. which(): command substitution did NOT execute on the host', !existsSync(marker), existsSync(marker) ? 'MARKER CREATED — unsandboxed RCE' : 'no marker')

  // ── 2. symlinked-mount escape guard ──────────────────────────────────────────
  // The operator mounts <link>/work/proj rw (a symlinked ancestor). The box plants
  // <cwd>/.claude -> / and, on the next relaunch, bwrap follows it and binds / rw.
  const proj2Logical = path.join(link, 'work', 'proj2')
  const proj2Real = path.join(real, 'work', 'proj2')
  mkdirSync(proj2Real, { recursive: true })
  symlinkSync('/', path.join(proj2Real, '.claude'))
  const cfg2: SandboxConfig = { enabled: true, mounts: [{ path: proj2Logical, mode: 'rw' }] }
  const args2 = wrapSandbox(cfg2, ['--dummy'], proj2Logical).args
  // The escape signature: the planted <cwd>/.claude appears as a WRITABLE bind. bwrap
  // resolves the source symlink, so this is `--bind <cwd>/.claude <cwd>/.claude` → / rw.
  const boundPlanted = args2.some((a, i) =>
    a === '--bind' && args2[i + 1] === path.join(proj2Logical, '.claude'))
  check('2. symlink guard: box-planted <cwd>/.claude was REFUSED as a mount source', !boundPlanted, boundPlanted ? 'bound rw — this binds / into the box' : 'not bound')

  // ── 3. app-source read-only pinning ──────────────────────────────────────────
  // <link>/ is mounted rw and the Claudette checkout lives under its realpath, so the
  // box can write the server's own source; the next tsx-watch reload executes it.
  const cfg3: SandboxConfig = { enabled: true, mounts: [{ path: link, mode: 'rw' }] }
  const args3 = wrapSandbox(cfg3, ['--dummy'], link).args
  // The overlay has to land on the path the BOX WRITES THROUGH (under the logical
  // mount), not on the app dir's realpath — an overlay at a path nothing binds
  // protects nothing.
  const serverLogical = path.join(link, 'Claudette', 'server')
  const pinnedRo = args3.some((a, i) => a === '--ro-bind' && args3[i + 2] === serverLogical)
  check('3. app-source: server/ pinned READ-ONLY at the box-visible path', pinnedRo, pinnedRo ? serverLogical : `no --ro-bind dest ${serverLogical} — source is WRITABLE`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'all three closed' : `${failures} of 3 still open`}`)
process.exitCode = failures === 0 ? 0 : 2
