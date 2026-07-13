// Live E2E: real Jupyter kernel + doc output routing (P1.6 + P1.9). Run:
//   npx tsx scratchpad/kernel-e2e-test.mts
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager.ts'
import { JupyterManager } from '../server/src/jupyter/jupyterManager.ts'
import { KernelManager } from '../server/src/jupyter/kernelManager.ts'

let failed = 0
const ok = (c: unknown, m: string) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++ }
const streamText = (cell: any) =>
  (cell.outputs ?? []).filter((o: any) => o.output_type === 'stream').map((o: any) => o.text).join('')

const dir = await mkdtemp(join(tmpdir(), 'nbke2e-'))
const path = join(dir, 'run.ipynb')

const docs = new NotebookDocManager()
const jupyter = new JupyterManager()   // ambient python3 (has jupyter_server)
const kernels = new KernelManager(docs, jupyter)

const doc = await docs.createPath(path)
const nb = doc.notebookId

// two code cells: A prints "A", B prints "B"
const a = doc.cells[0].id
docs.applyOp({ op: 'editCell', notebookId: nb, cellId: a, source: 'print("A")' })
docs.applyOp({ op: 'addCell', notebookId: nb, cellType: 'code', source: 'print("B")' })
const b = doc.cells[1].id

console.log('starting jupyter + kernel (may take a few seconds)…')
await kernels.runCell(nb, a)
await kernels.runCell(nb, b)

ok(doc.kernelId != null, 'kernel bound to notebook')
ok(streamText(doc.cells.find((c) => c.id === a)).trim() === 'A', 'cell A output = "A"')
ok(streamText(doc.cells.find((c) => c.id === b)).trim() === 'B', 'cell B output = "B"')
ok(doc.cells.find((c) => c.id === a)!.executionCount != null, 'cell A got an execution_count')

// THE KEY TEST: reorder (B to front), then re-run A. Outputs must track cellId,
// not position — B keeps "B", A re-runs to "A".
docs.applyOp({ op: 'moveCell', notebookId: nb, cellId: b, toIndex: 0 })
ok(doc.cells[0].id === b, 'reordered: B now at index 0')
await kernels.runCell(nb, a)
ok(streamText(doc.cells.find((c) => c.id === b)).trim() === 'B', 'after reorder, B still has "B"')
ok(streamText(doc.cells.find((c) => c.id === a)).trim() === 'A', 'after reorder, A still has "A" (routed by cellId)')

// error output path
docs.applyOp({ op: 'editCell', notebookId: nb, cellId: a, source: 'raise ValueError("boom")' })
await kernels.runCell(nb, a)
const errs = (doc.cells.find((c) => c.id === a)!.outputs ?? []).filter((o: any) => o.output_type === 'error')
ok(errs.length === 1 && (errs[0] as any).ename === 'ValueError', 'error output captured (ename=ValueError)')

// editCell cleared the old outputs before the error run
ok(streamText(doc.cells.find((c) => c.id === a)) === '', 'edit cleared prior stream output before error run')

kernels.destroy()
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
