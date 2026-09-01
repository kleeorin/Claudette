// Live E2E: real Jupyter kernel + doc output routing (P1.6 + P1.9). Run:
//   npx tsx scratchpad/kernel-e2e-test.mts
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager.ts'
import { KernelManager } from '../server/src/jupyter/kernelManager.ts'
import { SessionConfinement } from '../server/src/claude/sessionConfinement.ts'

import { check as ok, failed } from './assert.mjs'
const streamText = (cell: any) =>
  (cell.outputs ?? []).filter((o: any) => o.output_type === 'stream').map((o: any) => o.text).join('')

const dir = await mkdtemp(join(tmpdir(), 'nbke2e-'))
const path = join(dir, 'run.ipynb')

// KernelManager takes the CONFINEMENT seam, not a JupyterManager — it pools a Jupyter
// server per sandbox key and resolves the notebook's owning session to pick one. An
// unowned notebook fails CLOSED (the kernel is refused rather than dropped onto the
// unconfined server), so the notebook must be claimed before anything will run.
const SID = 'kernel-e2e'
const confinement = new SessionConfinement((id) => (id === SID ? { cwd: dir } : undefined))

const docs = new NotebookDocManager()
const kernels = new KernelManager(docs, confinement)

const doc = await docs.createPath(path)
const nb = doc.notebookId
kernels.setOwner(nb, { session: SID })

// two code cells: A prints "A", B prints "B"
const a = doc.cells[0].id
docs.applyOp({ op: 'editCell', notebookId: nb, cellId: a, source: 'print("A")' })
docs.applyOp({ op: 'addCell', notebookId: nb, cellType: 'code', source: 'print("B")' })
const b = doc.cells[1].id

console.log('starting jupyter + kernel (may take a few seconds)…')
await kernels.runCell(nb, a)
await kernels.runCell(nb, b)

ok('kernel bound to notebook', doc.kernelId != null)
ok('cell A output = "A"', streamText(doc.cells.find((c) => c.id === a)).trim() === 'A')
ok('cell B output = "B"', streamText(doc.cells.find((c) => c.id === b)).trim() === 'B')
ok('cell A got an execution_count', doc.cells.find((c) => c.id === a)!.executionCount != null)

// THE KEY TEST: reorder (B to front), then re-run A. Outputs must track cellId,
// not position — B keeps "B", A re-runs to "A".
docs.applyOp({ op: 'moveCell', notebookId: nb, cellId: b, toIndex: 0 })
ok('reordered: B now at index 0', doc.cells[0].id === b)
await kernels.runCell(nb, a)
ok('after reorder, B still has "B"', streamText(doc.cells.find((c) => c.id === b)).trim() === 'B')
ok('after reorder, A still has "A" (routed by cellId)', streamText(doc.cells.find((c) => c.id === a)).trim() === 'A')

// error output path
docs.applyOp({ op: 'editCell', notebookId: nb, cellId: a, source: 'raise ValueError("boom")' })
await kernels.runCell(nb, a)
const errs = (doc.cells.find((c) => c.id === a)!.outputs ?? []).filter((o: any) => o.output_type === 'error')
ok('error output captured (ename=ValueError)', errs.length === 1 && (errs[0] as any).ename === 'ValueError')

// editCell cleared the old outputs before the error run
ok('edit cleared prior stream output before error run', streamText(doc.cells.find((c) => c.id === a)) === '')

kernels.destroy()
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
