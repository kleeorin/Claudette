// Undo/redo + clearAllOutputs history (server-owned). Run:
//   npx tsx scratchpad/undo-redo-test.mts
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager.ts'

let failed = 0
const ok = (c: unknown, m: string) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++ }

const dir = await mkdtemp(join(tmpdir(), 'undo-'))
const docs = new NotebookDocManager()
const nid = (await docs.createPath(join(dir, 'n.ipynb'))).notebookId
const doc = () => docs.get(nid)!
const cells = () => doc().cells
const orig0 = cells()[0].source

ok(doc().canUndo === false && doc().canRedo === false, 'fresh: no undo/redo')

const c0 = cells()[0].id
docs.applyOp({ op: 'editCell', notebookId: nid, cellId: c0, source: 'A' }, 'human')
ok(cells()[0].source === 'A' && doc().canUndo === true, 'edit applied, canUndo=true')

docs.applyOp({ op: 'addCell', notebookId: nid, cellType: 'code', source: 'B' }, 'human')
ok(cells().length === 2, 'addCell → 2 cells')

ok(docs.undo(nid) === true && cells().length === 1, 'undo reverts the add')
ok(doc().canRedo === true, 'canRedo=true after undo')

ok(docs.undo(nid) === true && cells()[0].source === orig0, 'undo reverts the edit to original')
ok(doc().canUndo === false, 'undo stack exhausted')

ok(docs.redo(nid) === true && cells()[0].source === 'A', 'redo re-applies the edit')
ok(docs.redo(nid) === true && cells().length === 2, 'redo re-applies the add')
ok(doc().canRedo === false, 'redo stack exhausted')

// A fresh edit after an undo drops the redo branch.
docs.undo(nid)
ok(doc().canRedo === true, 'canRedo=true after undo')
docs.applyOp({ op: 'editCell', notebookId: nid, cellId: cells()[0].id, source: 'C' }, 'human')
ok(doc().canRedo === false, 'new edit cleared the redo branch')

// clearAllOutputs is undoable and restores outputs.
const cc = cells()[0].id
docs.appendCellOutput(nid, cc, { output_type: 'stream', name: 'stdout', text: 'hi' })
docs.setCellExecutionCount(nid, cc, 5)
ok((cells()[0].outputs?.length ?? 0) === 1, 'output present before clear')
docs.clearAllOutputs(nid)
ok((cells()[0].outputs?.length ?? 0) === 0 && cells()[0].executionCount == null, 'clearAllOutputs cleared it')
ok(docs.undo(nid) === true && (cells()[0].outputs?.length ?? 0) === 1, 'undo restored the outputs')

// undo on an empty stack is a no-op false.
while (docs.undo(nid)) { /* drain */ }
ok(docs.undo(nid) === false, 'undo on empty history → false')

// A wholesale reload from disk drops history.
docs.applyOp({ op: 'editCell', notebookId: nid, cellId: cells()[0].id, source: 'Z' }, 'human')
ok(doc().canUndo === true, 'canUndo=true before reload')
await docs.reloadFromDisk(nid)
ok(doc().canUndo === false && doc().canRedo === false, 'reload from disk cleared history')

docs.close(nid)
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
process.exit(failed ? 1 : 0)
