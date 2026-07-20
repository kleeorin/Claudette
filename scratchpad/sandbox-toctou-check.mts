// G1 — the notebook-write/read TOCTOU (SANDBOX.md). The access check canonicalizes the
// path (realpath of the PARENT for a not-yet-existing file), but the actual I/O re-resolves
// symlinks at syscall time. A confined box that swaps an intermediate dir for a symlink can
// redirect the write/read out of its mounts.
//
// The fix binds the containment decision and the write-guard to ONE realpath observation
// (SessionConfinement.authorizeResolved returns/uses the same canonical dir the tool then
// pins as the guard), and the writer refuses if that dir's realpath changed by write time.
// This test exercises BOTH race windows plus the legit path — the exact sequence the MCP
// gate() performs.
//
//   npx tsx scratchpad/sandbox-toctou-check.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SessionConfinement } from '../server/src/claude/sessionConfinement'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager'
import type { SandboxConfig } from '../shared/src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toctou-'))
const proj = path.join(root, 'proj'); fs.mkdirSync(proj, { recursive: true })
const secret = path.join(root, 'secret'); fs.mkdirSync(secret, { recursive: true })

const cfg: SandboxConfig = { enabled: true, mounts: [{ path: proj, mode: 'rw' }] }
const confinement = new SessionConfinement((id) => (id === 'S' ? { sandbox: cfg, cwd: proj } : undefined))
const docs = new NotebookDocManager()

// Reproduce what the MCP gate() does: one realpath(dirname) → both the containment decision
// and the guard passed to the write.
function gate(absPath: string, need: 'read' | 'write'): { ok: boolean; guard?: string } {
  let realDir: string | undefined
  try { realDir = fs.realpathSync(path.dirname(absPath)) } catch { realDir = undefined }
  const ok = confinement.authorizeResolved('S', realDir ?? null, path.basename(absPath), need)
  return { ok, guard: realDir }
}

await (async () => {
  // --- 1. Legit write, no swap: allowed and lands inside the mount ------------
  {
    const target = path.join(proj, 'ok.ipynb')
    const g = gate(target, 'write')
    check('legit in-mount write is authorized', g.ok)
    await docs.createPath(target, g.guard)
    check('legit write landed inside the mount', fs.existsSync(target))
  }

  // --- 2. Swap AFTER authorize (guard captured while parent was a real dir) ---
  {
    const d = path.join(proj, 'd1'); fs.mkdirSync(d)
    const target = path.join(d, 'x.ipynb')
    const g = gate(target, 'write')                 // parent real & in-mount → authorized, guard=/proj/d1
    check('parent-real: authorized', g.ok)
    fs.rmdirSync(d); fs.symlinkSync(secret, d)       // WIN the race: relink parent → out of mount
    let refused = false
    try { await docs.createPath(target, g.guard) } catch { refused = true }
    check('swap-after-authorize: write REFUSED (guard mismatch)', refused)
    check('swap-after-authorize: nothing escaped to the secret dir', !fs.existsSync(path.join(secret, 'x.ipynb')))
  }

  // --- 3. Swap BEFORE authorize (parent already a symlink out of the mount) ---
  {
    const d = path.join(proj, 'd2'); fs.mkdirSync(d); fs.rmdirSync(d)
    fs.symlinkSync(secret, d)                         // parent is a symlink to /secret BEFORE the check
    const target = path.join(d, 'y.ipynb')
    const g = gate(target, 'write')                  // realpath(parent)=/secret → NOT in mount → denied
    check('swap-before-authorize: DENIED (decision + guard from one realpath)', !g.ok)
  }

  // --- 4. Read TOCTOU: same protection on the open path ----------------------
  {
    fs.writeFileSync(path.join(secret, 'z.ipynb'), '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}')
    const d = path.join(proj, 'd3'); fs.mkdirSync(d)
    const target = path.join(d, 'z.ipynb')
    const g = gate(target, 'read')                   // parent real → authorized, guard=/proj/d3
    check('read: parent-real authorized', g.ok)
    fs.rmdirSync(d); fs.symlinkSync(secret, d)        // relink parent → out of mount
    let refused = false
    try { await docs.openPath(target, g.guard) } catch { refused = true }
    check('read swap-after-authorize: open REFUSED (no out-of-mount leak)', refused)
  }
})()

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
