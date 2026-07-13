// Focused E2E for the notebook doc engine (P1.7 + P1.8). Run:
//   npx tsx scratchpad/notebook-doc-test.mts
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager.ts'

let failed = 0
function ok(cond: unknown, msg: string) {
  console.log(`${cond ? '✅' : '❌'} ${msg}`)
  if (!cond) failed++
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const dir = await mkdtemp(join(tmpdir(), 'nbtest-'))
const path = join(dir, 'test.ipynb')

const nbs = new NotebookDocManager()
let updates = 0
nbs.on('update', () => updates++)

// 1. create → one empty code cell, stable id, persisted to disk
const doc = await nbs.createPath(path)
ok(doc.cells.length === 1 && doc.cells[0].cellType === 'code', 'create → 1 empty code cell')
ok(typeof doc.cells[0].id === 'string' && doc.cells[0].id.length > 0, 'cell has a stable id')
const onDisk = JSON.parse(await readFile(path, 'utf8'))
ok(onDisk.cells[0].id === doc.cells[0].id, 'cell id persisted to .ipynb (nbformat 4.5)')
ok(onDisk.nbformat_minor >= 5, 'nbformat_minor >= 5')

// 2. editCell → source set, version bumps, dirty
const c0 = doc.cells[0].id
let r = nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: c0, source: 'print("a")' })
ok(r.ok && doc.cells[0].source === 'print("a")', 'editCell sets source')
ok(doc.version === 1 && doc.dirty, 'version bumped + dirty after edit')

// 3. addCell + insertCell → distinct ids, ordering
nbs.applyOp({ op: 'addCell', notebookId: doc.notebookId, cellType: 'code', source: 'print("b")' })
nbs.applyOp({ op: 'addCell', notebookId: doc.notebookId, cellType: 'markdown', source: '# c' })
ok(doc.cells.length === 3, 'addCell appends')
const ids = new Set(doc.cells.map((c) => c.id))
ok(ids.size === 3, 'all cell ids distinct')
const c1 = doc.cells[1].id  // print("b")

// 4. THE KEY TEST: route an output to a cell, THEN reorder, output stays with the cell
nbs.appendCellOutput(doc.notebookId, c1, { output_type: 'stream', name: 'stdout', text: 'b\n' })
nbs.setCellExecutionCount(doc.notebookId, c1, 1)
ok(doc.cells[1].outputs?.length === 1, 'output routed to c1 by cellId')
// move c1 (index 1) to the front
nbs.applyOp({ op: 'moveCell', notebookId: doc.notebookId, cellId: c1, toIndex: 0 })
const moved = doc.cells.find((c) => c.id === c1)!
ok(doc.cells[0].id === c1, 'moveCell reordered c1 to front')
ok(moved.outputs?.length === 1 && moved.executionCount === 1, 'output STAYS with c1 after reorder (cellId routing)')

// 5. editCell clears outputs
nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: c1, source: 'print("b2")' })
ok((doc.cells.find((c) => c.id === c1)!.outputs?.length ?? 0) === 0, 'editCell clears outputs')

// 6. cell lock hard-denies Claude, allows human
nbs.claimCell(doc.notebookId, c0, 'focus')
const denied = nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: c0, source: 'x' }, 'claude')
ok(!denied.ok && denied.code === 'locked', 'Claude edit to locked cell hard-denied')
const humanOk = nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: c0, source: 'y' }, 'human')
ok(humanOk.ok, 'human edit to same cell allowed')
nbs.releaseCell(doc.notebookId, c0)
const afterRelease = nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: c0, source: 'z' }, 'claude')
ok(afterRelease.ok, 'Claude edit allowed after release')

// 7. save → dirty cleared, round-trips through disk with same ids
await nbs.save(doc.notebookId)
ok(!doc.dirty, 'save clears dirty')
const reparsed = JSON.parse(await readFile(path, 'utf8'))
ok(reparsed.cells.map((c: any) => c.id).join() === doc.cells.map((c) => c.id).join(), 'ids round-trip through save')

// 8. external change → clean reload (not dirty)
const beforeVersion = doc.version
const externalText = JSON.stringify({
  cells: [{ cell_type: 'code', id: 'ext-1', metadata: {}, source: ['print("external")'], execution_count: null, outputs: [] }],
  metadata: {}, nbformat: 4, nbformat_minor: 5,
}, null, 1) + '\n'
await writeFile(path, externalText, 'utf8')
await wait(200)
ok(doc.cells.length === 1 && doc.cells[0].id === 'ext-1', 'external edit reloaded (not dirty → take disk)')
ok(doc.version > beforeVersion, 'reload bumped version')

// 9. conflict: local unsaved edit + external change → conflict flag
nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: 'ext-1', source: 'local' })
ok(doc.dirty, 'local edit → dirty')
await writeFile(path, externalText.replace('external', 'external2'), 'utf8')
await wait(200)
ok(doc.conflict === true, 'external change while dirty → conflict flag')

nbs.close(doc.notebookId)
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
