// Verify the kernel cwd = the notebook's OWN directory (not Jupyter root '/').
//   npx tsx scratchpad/kernel-cwd-test.mts
import { mkdtemp, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager.ts'
import { SessionConfinement } from '../server/src/claude/sessionConfinement.ts'
import { KernelManager } from '../server/src/jupyter/kernelManager.ts'

let failed = 0
const ok = (c: unknown, m: string) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++ }
const streamText = (cell: any) =>
  (cell.outputs ?? []).filter((o: any) => o.output_type === 'stream').map((o: any) => o.text).join('')

// realpath so macOS/tmp symlink normalization matches what Python reports.
const dir = await realpath(await mkdtemp(join(tmpdir(), 'nbcwd-')))
const path = join(dir, 'run.ipynb')

const docs = new NotebookDocManager()
// KernelManager takes the confinement seam and refuses an UNOWNED notebook (fail closed,
// so a kernel can never land on the unconfined server by omission) — hence the claim below.
const SID = 'kernel-cwd'
const confinement = new SessionConfinement((id) => (id === SID ? { cwd: dir } : undefined))
const kernels = new KernelManager(docs, confinement)

const doc = await docs.createPath(path)
const nb = doc.notebookId
kernels.setOwner(nb, { session: SID })
const a = doc.cells[0].id
docs.applyOp({ op: 'editCell', notebookId: nb, cellId: a, source: 'import os; print(os.getcwd())' })

console.log('starting jupyter + kernel (may take a few seconds)…')
await kernels.runCell(nb, a)

const cwd = streamText(doc.cells.find((c: any) => c.id === a)).trim()
console.log(`   notebook dir: ${dir}`)
console.log(`   kernel  cwd : ${cwd}`)
ok(cwd === dir, 'kernel cwd equals the notebook directory (not "/")')
ok(cwd !== '/', 'kernel cwd is not Jupyter root "/"')

kernels.destroy()
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
