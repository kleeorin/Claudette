// A STANDING GUARD for the caller-chain precondition, converted from the analysis in
// venv-probe-coincidence-probe.mts. It fires the day someone adds a realpathSync to
// notebookDocManager.openPath.
//
// THE CONTRACT IT PINS. pathInWritableMount documents its own logical-only rule explicitly
// and correctly: it must NOT realpath the target, because a symlink the box planted at
// <cwd>/x is inside the rw cwd lexically even though it resolves elsewhere, and following it
// would both lose that fact and open a TOCTOU window before the exec. THE PREDICATE IS NOT
// THE DEFECT. What is undocumented — and unenforced — is the CALLER CHAIN's obligation to
// hand it a LOGICAL target:
//
//     openPath stores doc.path = resolve(p)            [logical]
//       -> KernelManager.serverFor: dirname(doc.path)  [lexical, preserves it]
//         -> findNearestPython: join(d, v, 'bin', …)   [lexical, preserves it]
//           -> canImportJupyter -> pathInWritableMount [requires logical]
//
// openPath is where that obligation can be violated, because it ALREADY MIXES BOTH POLICIES
// IN ONE SIGNATURE: it takes a realpath-derived `guardRealDir` and stores a logical `abs`.
// Adding one realpathSync there — which reads like a hardening — makes the discovered
// interpreter's path REAL, the logical rw root no longer prefixes it, the guard returns
// false, and THE PLANTED INTERPRETER IS EXECUTED ON THE HOST, unsandboxed, with the server's
// environment. That is the venv-probe escape, reopened by a hardening.
//
// WHY THIS IS A TEST AND NOT A COMMENT: a comment is evidence you understood a hazard, not
// that you avoided it.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, chmodSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager'
import { emptyNotebookText } from '../server/src/notebook/ipynb'
import { findNearestPython } from '../server/src/jupyter/jupyterManager'
import { pathInWritableMount, sandboxAvailable } from '../server/src/claude/sandbox'
import type { SandboxConfig } from '../shared/src/types'

import { check, passed as pass, failed as fail } from './assert.mjs'

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudette-chain-')))
try {
  const proj = path.join(root, 'proj')
  const link = path.join(root, 'link')
  const venvBin = path.join(proj, '.venv', 'bin')
  const outside = path.join(root, 'outside')
  mkdirSync(venvBin, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(path.join(outside, 'marker'), 'host-visible')
  symlinkSync(proj, link)

  // The verdict must be written through the MOUNTED spelling. `proj` is the mount's
  // realpath but only `link` is bound as a DEST, so a write to proj/ inside the box hits
  // the private tmpfs root, silently succeeds and vanishes — the exact write-decoy the
  // sandbox system prompt warns about. Writing to link/ lands at proj/ on the host.
  const verdict = path.join(proj, 'verdict.txt')          // where the TEST reads it (host)
  const verdictInBox = path.join(link, 'verdict.txt')     // where the SCRIPT writes it (box)
  writeFileSync(path.join(venvBin, 'python3'),
    `#!/bin/sh\nif [ -e '${path.join(outside, 'marker')}' ]; then echo HOST > '${verdictInBox}'; else echo CONFINED > '${verdictInBox}'; fi\nexit 0\n`)
  chmodSync(path.join(venvBin, 'python3'), 0o755)

  const nb = path.join(link, 'nb.ipynb')
  writeFileSync(nb, emptyNotebookText())
  const cfg: SandboxConfig = { enabled: true, mounts: [{ path: link, mode: 'rw' }] }

  // --- 1. THE CONTRACT ITSELF -----------------------------------------------
  {
    const docs = new NotebookDocManager()
    const doc = await docs.openPath(nb)
    check('openPath stores a LOGICAL path — the precondition pathInWritableMount depends on',
      doc.path === nb, `stored ${doc.path}, expected ${nb}`)
    check('…i.e. it is NOT canonicalized to the symlink target',
      doc.path !== path.join(proj, 'nb.ipynb'),
      'if this fails, the venv-probe escape is reopened — see the header')
  }

  // --- 2. THE CHAIN END TO END ----------------------------------------------
  {
    const docs = new NotebookDocManager()
    const doc = await docs.openPath(nb)
    const startDir = path.dirname(doc.path)
    const found = await findNearestPython(startDir, sandboxAvailable() ? { cfg, cwd: link } : undefined)
    check('discovery finds the planted interpreter', found === path.join(link, '.venv', 'bin', 'python3'),
      String(found))
    check('pathInWritableMount recognises it as box-placeable (⇒ probe must be confined)',
      found !== null && pathInWritableMount(cfg, link, found),
      'false here means the probe would have run on the HOST')
  }

  // --- 3. WHERE IT ACTUALLY RAN ---------------------------------------------
  if (sandboxAvailable()) {
    const where = existsSync(verdict) ? readFileSync(verdict, 'utf8').trim() : '(never ran)'
    check('the planted interpreter executed INSIDE the box', where === 'CONFINED',
      `verdict=${where}`)
  } else {
    console.log('⏭  3. skipped — host cannot sandbox, so nothing can be confined here')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

// A NOTE FOR WHOEVER MAINTAINS THIS. Section 1 is the guard; sections 2 and 3 are the
// consequence. If section 1 ever has to be relaxed — because openPath legitimately needs to
// canonicalize — then pathInWritableMount's callers must be given a logical target some
// OTHER way (branding its parameter with LogicalPath and making logical() the only
// constructor is the designed answer, see sandboxPaths.ts). Relaxing section 1 without doing
// that is the escape, not a test failure.
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
