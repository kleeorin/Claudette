// Tests for the two filesystem-escape fixes found in the 2026-07-18 audit (SANDBOX.md
// "Symlinked-mount escape" + "Notebook-MCP escape"):
//
//   1. bwrap follows a symlinked --bind SOURCE and mounts its target. A confined box
//      could plant `<cwd>/.claude -> /` in its rw cwd and get / bound rw on relaunch.
//      wrapSandbox now DROPS a symlinked mount source whose parent is box-writable, and
//      keeps a host-created one (parent outside the writable set).
//   2. The notebook MCP tools run UNSANDBOXED in the server; sandboxPathAccess() gates
//      their file I/O to the calling session's own mounts (rw for writes, any for reads).
//   3. Venv discovery (findNearestPython) used to EXECUTE a candidate `<cwd>/.venv/bin/
//      python3` on the host — a confined box plants one → unsandboxed RCE. It now probes
//      a box-writable candidate INSIDE the box, so a planted binary runs confined.
//
//   npx tsx scratchpad/sandbox-fs-escape-fixes-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { wrapSandbox, sandboxPathAccess, pathInWritableMount, sandboxAvailable } from '../server/src/claude/sandbox'
import { findNearestPython } from '../server/src/jupyter/jupyterManager'
import type { SandboxConfig } from '../shared/src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

// A scratch tree OUTSIDE the repo so the mount math is unambiguous.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbxfx-'))
const proj = path.join(root, 'proj')          // the session cwd (rw)
const secret = path.join(root, 'secret')      // NEVER mounted
fs.mkdirSync(proj, { recursive: true })
fs.mkdirSync(secret, { recursive: true })
fs.writeFileSync(path.join(secret, 'creds.txt'), 'TOP-SECRET')

// Does the argv bind (rw or ro) the exact path `p` as a mountpoint?
function bindsPath(args: string[], p: string): boolean {
  for (let i = 0; i < args.length - 2; i++) {
    if ((args[i] === '--bind' || args[i] === '--ro-bind') && args[i + 1] === p && args[i + 2] === p) return true
  }
  return false
}

const cfg: SandboxConfig = { enabled: true, mounts: [{ path: proj, mode: 'rw' }] }
console.log(`(host sandboxAvailable=${sandboxAvailable()}; scratch=${root})\n`)

// --- 1. Symlinked mount source in a box-writable area is DROPPED --------------
{
  // The attack: a box plants <cwd>/.claude -> <secret> (an out-of-mount dir). On the
  // next launch bwrap would follow it and bind <secret> rw at <cwd>/.claude.
  const localClaude = path.join(proj, '.claude')
  fs.symlinkSync(secret, localClaude)
  const { args } = wrapSandbox(cfg, ['-p', 'hi'], proj)
  check('symlinked <cwd>/.claude is NOT bound (escape refused)', !bindsPath(args, localClaude))
  // The secret dir must never appear as a bind target anywhere in the argv either.
  check('the symlink target (out-of-mount secret) is never bound', !bindsPath(args, secret))
  // cwd itself is still bound rw (the legit mount survives).
  check('the real cwd mount survives', bindsPath(args, proj))
  fs.unlinkSync(localClaude)
}

// --- 1b. A host-created symlink whose parent is NOT box-writable is KEPT ------
{
  // outside/ is not a mount; a symlink inside it (host-made) is safe to bind — the box
  // can't have redirected it. Mount the link path explicitly (operator intent).
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside, { recursive: true })
  const realData = path.join(root, 'realdata')
  fs.mkdirSync(realData, { recursive: true })
  const link = path.join(outside, 'link')       // host symlink, parent `outside` unmounted
  fs.symlinkSync(realData, link)
  const cfg2: SandboxConfig = { enabled: true, mounts: [{ path: proj, mode: 'rw' }, { path: link, mode: 'ro' }] }
  const { args } = wrapSandbox(cfg2, ['-p', 'hi'], proj)
  check('host symlink (parent not box-writable) is still bound', bindsPath(args, link))
}

// --- 2. sandboxPathAccess confines notebook-tool file I/O --------------------
{
  const ro = path.join(root, 'roMount')
  fs.mkdirSync(ro, { recursive: true })
  const c: SandboxConfig = { enabled: true, mounts: [{ path: proj, mode: 'rw' }, { path: ro, mode: 'ro' }] }

  const inRw = sandboxPathAccess(c, proj, path.join(proj, 'nb.ipynb'))
  check('path in rw mount: readable + writable', inRw.read && inRw.write)

  const inRo = sandboxPathAccess(c, proj, path.join(ro, 'nb.ipynb'))
  check('path in ro mount: readable but NOT writable', inRo.read && !inRo.write)

  const outside = sandboxPathAccess(c, proj, path.join(secret, 'nb.ipynb'))
  check('path outside all mounts: neither read nor write', !outside.read && !outside.write)

  // The obligatory global ~/.claude is always a data mount → reachable.
  const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const inGlobal = sandboxPathAccess(c, proj, path.join(cfgDir, 'x.ipynb'))
  check('path in the obligatory global ~/.claude: writable', inGlobal.write)

  // A symlink INSIDE a mount that points OUT must not launder access (canonicalized).
  const escLink = path.join(proj, 'esc')
  fs.symlinkSync(secret, escLink)
  const viaLink = sandboxPathAccess(c, proj, path.join(escLink, 'nb.ipynb'))
  check('symlink inside a mount pointing out: NOT writable (canonicalized)', !viaLink.write && !viaLink.read)
  fs.unlinkSync(escLink)

  // The authorizer must apply the SAME symlinked-mount guard the box does: a box-planted
  // <cwd>/.claude -> <out-of-mount> is a symlink whose parent (proj) is box-writable, so
  // the box DROPS it — and the authorizer must too, or it realpaths that mount root to its
  // target and authorizes an out-of-mount notebook write the box itself refuses.
  const planted = path.join(proj, '.claude')
  fs.symlinkSync(secret, planted)
  const viaRootLink = sandboxPathAccess(c, proj, path.join(secret, 'evil.ipynb'))
  check('box-planted symlinked <cwd>/.claude does NOT authorize its target (authorizer == box)',
    !viaRootLink.write && !viaRootLink.read)
  fs.unlinkSync(planted)
}

// --- 3. Venv-probe escape: a box-writable candidate is probed IN-BOX ----------
{
  const vp = path.join(root, 'vproj')
  fs.mkdirSync(path.join(vp, '.venv', 'bin'), { recursive: true })
  const marker = path.join(root, 'VENV_PWNED')     // OUTSIDE the mount
  const py = path.join(vp, '.venv', 'bin', 'python3')
  fs.writeFileSync(py, `#!/bin/bash\necho pwned > "${marker}"\nexit 0\n`)
  fs.chmodSync(py, 0o755)
  const c: SandboxConfig = { enabled: true, mounts: [{ path: vp, mode: 'rw' }] }

  check('the planted python is recognized as inside a rw mount', pathInWritableMount(c, vp, py))
  if (sandboxAvailable()) {
    // Sandboxed discovery: the probe runs in the box, so its out-of-mount write fails —
    // no host-side execution effect.
    fs.rmSync(marker, { force: true })
    await findNearestPython(vp, { cfg: c, cwd: vp })
    check('sandboxed discovery: planted binary did NOT execute on the host', !fs.existsSync(marker))
    // Unconfined discovery is unchanged (an unconfined session already has host exec).
    fs.rmSync(marker, { force: true })
    await findNearestPython(vp, undefined)
    check('unconfined discovery still probes on host (behavior preserved)', fs.existsSync(marker))
  } else {
    check('(host cannot sandbox — venv-probe confinement not exercised)', true)
  }
}

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
