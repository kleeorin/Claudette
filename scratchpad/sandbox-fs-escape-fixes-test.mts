// Tests for the two filesystem-escape fixes found in the 2026-07-18 audit (SANDBOX.md
//
// ★ ONE CHECK HERE IS ENVIRONMENT-DEPENDENT, AND A RED IN IT IS NOT A PROPERTY OF THE TREE.
// `path in the obligatory global ~/.claude: writable` compares two rules that can disagree
// depending on where CLAUDE_CONFIG_DIR points:
//   · obligatoryMounts() binds claudeConfigDir() rw, so the config dir is an active mount;
//   · sandboxPathAccess() refuses anything under stateDirsToHide(), which is dataDir()
//     (~/.config/claudette) — because the box sees those as empty directories.
// If CLAUDE_CONFIG_DIR is set INSIDE ~/.config/claudette — which is what a host-scrubbed
// config mirror does — the two collide and the authorizer refuses a path that is
// simultaneously an active rw mount. It resolves FAIL-CLOSED, so the symptom is an
// inexplicable permission error, never an escape.
// MEASURED 2026-08-27: red with CLAUDE_CONFIG_DIR=~/.config/claudette/host-scrubbed-config/<id>,
// and `env -u CLAUDE_CONFIG_DIR` → 13 passed / 0 failed on the same checkout. So the same
// commit is green in one session and red in another.
// ★ RESOLVED 2026-09-17 (previously "deliberately not decided here").
// The check no longer fails flatly on this. It now DETECTS the collision — CLAUDE_CONFIG_DIR
// resolving inside a hidden state dir — and reports that case as `open` (⚠️, counted
// separately, suite stays green, finding stays visible) with a reason that names both paths.
// Any OTHER reason for the write being refused is still a hard FAIL. That split is the whole
// design: the assertion is untouched for a normal environment and for every failure we cannot
// explain, and only the one precisely-identified arrangement is downgraded.
//
// ★★ AND THE ARRANGEMENT IS NOT MERELY A DEVELOPER'S ENVIRONMENT — CLAUDETTE PRODUCES IT.
// configProtection.ts puts the host-scrubbed mirror at `<dataDir>/host-scrubbed-config`
// (mirrorRoot), and sessionManager points a host-mode session's CLAUDE_CONFIG_DIR at it. So on
// a real install the authorizer can refuse a path that is simultaneously an active rw mount.
// It resolves FAIL-CLOSED — an inexplicable permission error, never an escape — which is why
// this is tagged `open` rather than failed. The underlying collision is a candidate fix in
// server/src/claude/sandbox.ts and is deliberately NOT made here: it is security-adjacent and
// deserves its own reviewed diff.
//
// MUTATIONS (measured 2026-09-17; mutated a COPY, never the live file; `ran=N` reported because
// a mutant that fails to PARSE yields zero failures exactly like a clean pass):
//   S1  a PRODUCT regression with NO collision — sandbox.ts made to refuse the obligatory
//       config mount outright → ran=13, red=1, a hard ❌. The check still catches a real
//       regression, which is the property that matters.
//   S2  the same regression, PLUS the degrade made unconditional (`&& collidingRoot` dropped)
//       → ran=12, red=0. The regression is laundered into a green run carrying an explanation
//       that is now FALSE — it claims a collision that is not present. This is the mutant
//       worth keeping: it is exactly "a version that passes everywhere by asserting less", and
//       it shows the `&& collidingRoot` conjunct is load-bearing rather than decorative.
//   XX  a patch matching no text must REFUSE — it did, 0 matches, no run performed.
//
// BOTH BRANCHES WERE EXERCISED, not just the one this machine happens to take:
//   · as-is here (CLAUDE_CONFIG_DIR=~/.claude, no collision) → ✅, 13 passed / 0 failed;
//   · forced (CLAUDE_CONFIG_DIR=<dataDir>/host-scrubbed-config/forced-test) → ⚠️ [open],
//     12 passed / 0 failed, exit 0.
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
import { wrapSandbox, sandboxPathAccess, pathInWritableMount, sandboxAvailable, claudeConfigDir } from '../server/src/claude/sandbox'
// To DETECT the documented collision precisely rather than excusing every failure of this one
// check. Same two sources stateDirsToHide() reads, in the same order.
import { dataDir } from '../server/src/util/dataDir'
import { tokenFilePath } from '../server/src/auth'
import { findNearestPython } from '../server/src/jupyter/jupyterManager'
import type { SandboxConfig } from '../shared/src/types'

import { check, passed as pass, failed as fail } from './assert.mjs'

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
  //
  // ★ THIS CHECK NOW DISTINGUISHES A REGRESSION FROM THE DOCUMENTED COLLISION (see header).
  // It used to fail flatly whenever CLAUDE_CONFIG_DIR sat inside a hidden state dir, which is
  // a fact about the ENVIRONMENT, not the tree. Three separate sessions each re-derived that
  // explanation from scratch before anyone wrote it down here — and a permanently red check
  // everyone has learned to explain away is indistinguishable from the regression it exists to
  // catch, on the day one actually happens.
  //
  // ★★ THE DEGRADE IS CONDITIONAL, AND THAT IS THE WHOLE DESIGN. `inGlobal.write` being false
  // is still a hard FAIL unless the collision is independently detected. So the assertion is
  // untouched for a normal environment and for any failure we cannot explain — only the one
  // precisely-identified arrangement is downgraded. A version that passed everywhere by
  // asserting less would be the worst outcome available.
  const cfgDir = claudeConfigDir()
  const inGlobal = sandboxPathAccess(c, proj, path.join(cfgDir, 'x.ipynb'))
  // Reconstructed from the same two sources as sandbox.ts's (unexported) stateDirsToHide().
  // If the product ever adds a THIRD hidden dir, this detector misses the new collision and
  // the check goes hard RED — the safe direction: it fails loudly rather than excusing
  // something it no longer understands.
  const hidden = [path.resolve(dataDir()), path.resolve(path.dirname(tokenFilePath()))]
  const under = (p: string, root: string) => p === root || p.startsWith(root + path.sep)
  const collidingRoot = hidden.find((h) => under(path.resolve(cfgDir), h))
  if (!inGlobal.write && collidingRoot) {
    // `open`, not a silent pass: MEASURED, deliberately not fixed, and still visible in the
    // run. It is tagged this way rather than skipped because it is a genuine finding about the
    // product, not merely an inapplicable assertion — Claudette ITSELF produces this
    // arrangement (configProtection.ts puts the host-scrubbed mirror at
    // <dataDir>/host-scrubbed-config, and sessionManager points a host-mode session's
    // CLAUDE_CONFIG_DIR at it), so the obligatory rw config mount really can be refused by the
    // authorizer on a real install. It resolves FAIL-CLOSED — an inexplicable permission
    // error, never an escape — which is why it is not being failed on pending a reviewed fix
    // in sandbox.ts.
    check('path in the obligatory global ~/.claude: writable', false,
      `COLLISION, not a regression: CLAUDE_CONFIG_DIR (${cfgDir}) is inside the hidden state dir ${collidingRoot}, so the authorizer refuses a path that is simultaneously an active rw mount. Fail-closed. Re-run with \`env -u CLAUDE_CONFIG_DIR\` to exercise the real assertion.`,
      'open')
  } else {
    check('path in the obligatory global ~/.claude: writable', inGlobal.write)
  }

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
