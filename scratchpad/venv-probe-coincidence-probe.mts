// PROBE (analysis only — fixes nothing): is the venv-probe guard correct by DESIGN or by
// COINCIDENCE? Architect claims the latter — that `pathInWritableMount` compares a LOGICAL
// target against LOGICAL roots, and the chain feeding it keeps the target logical only by
// accident, so adding a single realpathSync to notebookDocManager.openPath (which would
// read as hardening) reopens the venv-probe escape.
//
// Layout: a symlinked project root (`link/proj` -> `real/proj`), the ordinary dotfiles-farm
// / two-volume shape. The session's rw mount is declared with the LOGICAL path, which is
// what the operator typed and what SessionInfo carries.
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { dirname, resolve } from 'path'
import { pathInWritableMount } from '../server/src/claude/sandbox.ts'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager.ts'
import type { SandboxConfig } from '../shared/src/index.ts'

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'venv-coin-')))
let bad = 0
const check = (ok: boolean, label: string, detail = ''): void => {
  console.log(`${ok ? '✅' : '⚠️ '} ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) bad++
}

try {
  const real = path.join(root, 'real')
  const link = path.join(root, 'link')
  mkdirSync(path.join(real, 'proj'), { recursive: true })
  symlinkSync(real, link)

  const projLogical = path.join(link, 'proj')   // what the operator mounts
  const projReal = path.join(real, 'proj')      // where it actually lives
  const cfg: SandboxConfig = { enabled: true, mounts: [{ path: projLogical, mode: 'rw' }] }

  // The interpreter a confined session could PLANT inside its own rw mount.
  const candidateLogical = path.join(projLogical, '.venv', 'bin', 'python3')
  const candidateReal = path.join(projReal, '.venv', 'bin', 'python3')

  console.log(`rw mount (logical): ${projLogical}`)
  console.log(`      realpath    : ${projReal}\n`)

  const logicalGuarded = pathInWritableMount(cfg, projLogical, candidateLogical)
  const realGuarded = pathInWritableMount(cfg, projLogical, candidateReal)
  console.log(`pathInWritableMount(LOGICAL candidate) = ${logicalGuarded}`)
  console.log(`pathInWritableMount(REAL    candidate) = ${realGuarded}\n`)

  // The guard's whole job: a planted interpreter must be recognised as box-writable, so
  // canImportJupyter runs the probe INSIDE the box instead of on the host.
  check(logicalGuarded, 'guard holds for a LOGICAL candidate (today\'s chain)',
    logicalGuarded ? 'recognised as box-writable → probed inside the box' : 'FAILED OPEN')
  check(!realGuarded, 'guard would FAIL OPEN for a REAL candidate',
    realGuarded ? 'still recognised' : 'NOT recognised as box-writable → probe would run UNSANDBOXED on the host')

  // Does the chain actually keep the path logical today? doc.path is what
  // KernelManager.serverFor feeds to pythonFor via dirname().
  const docs = new NotebookDocManager()
  const nbLogical = path.join(projLogical, 'n.ipynb')
  writeFileSync(nbLogical, JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }))
  const doc = await docs.openPath(nbLogical)
  const startDir = dirname(doc.path)   // exactly what serverFor computes
  console.log(`\nopenPath("${nbLogical}")\n  doc.path  = ${doc.path}\n  dirname   = ${startDir}`)
  check(doc.path === resolve(nbLogical) && startDir === projLogical,
    'doc.path is LOGICAL today, so the chain feeds the guard a logical target',
    'openPath stores resolve(path), never realpath')

  // …and one realpathSync in openPath is all it takes to flip it.
  const hypothetical = realpathSync(nbLogical)
  console.log(`\nIF openPath stored realpathSync(path) instead:\n  doc.path  = ${hypothetical}\n  dirname   = ${dirname(hypothetical)}`)
  check(!pathInWritableMount(cfg, projLogical, path.join(dirname(hypothetical), '.venv', 'bin', 'python3')),
    'that one change reopens the escape', 'candidate no longer matches the logical rw root')
  docs.close(doc.notebookId)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\nVERDICT: the guard is load-bearing on an UNSTATED precondition (target must be`)
console.log(`logical). ${bad === 0 ? 'All four observations hold.' : `${bad} observation(s) did not hold.`}`)
process.exitCode = bad === 0 ? 0 : 2
