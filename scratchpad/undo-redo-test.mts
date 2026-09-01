// Undo/redo + clearAllOutputs history (server-owned). Run:
//   npx tsx scratchpad/undo-redo-test.mts
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager.ts'

import { check as ok, failed } from './assert.mjs'

const dir = await mkdtemp(join(tmpdir(), 'undo-'))
const docs = new NotebookDocManager()
const nid = (await docs.createPath(join(dir, 'n.ipynb'))).notebookId
const doc = () => docs.get(nid)!
const cells = () => doc().cells
const orig0 = cells()[0].source

ok('fresh: no undo/redo', doc().canUndo === false && doc().canRedo === false)

const c0 = cells()[0].id
docs.applyOp({ op: 'editCell', notebookId: nid, cellId: c0, source: 'A' }, 'human')
ok('edit applied, canUndo=true', cells()[0].source === 'A' && doc().canUndo === true)

docs.applyOp({ op: 'addCell', notebookId: nid, cellType: 'code', source: 'B' }, 'human')
ok('addCell → 2 cells', cells().length === 2)

ok('undo reverts the add', docs.undo(nid) === true && cells().length === 1)
ok('canRedo=true after undo', doc().canRedo === true)

ok('undo reverts the edit to original', docs.undo(nid) === true && cells()[0].source === orig0)
ok('undo stack exhausted', doc().canUndo === false)

ok('redo re-applies the edit', docs.redo(nid) === true && cells()[0].source === 'A')
ok('redo re-applies the add', docs.redo(nid) === true && cells().length === 2)
ok('redo stack exhausted', doc().canRedo === false)

// A fresh edit after an undo drops the redo branch.
docs.undo(nid)
ok('canRedo=true after undo', doc().canRedo === true)
docs.applyOp({ op: 'editCell', notebookId: nid, cellId: cells()[0].id, source: 'C' }, 'human')
ok('new edit cleared the redo branch', doc().canRedo === false)

// clearAllOutputs is undoable and restores outputs.
const cc = cells()[0].id
docs.appendCellOutput(nid, cc, { output_type: 'stream', name: 'stdout', text: 'hi' })
docs.setCellExecutionCount(nid, cc, 5)
ok('output present before clear', (cells()[0].outputs?.length ?? 0) === 1)
docs.clearAllOutputs(nid)
ok('clearAllOutputs cleared it', (cells()[0].outputs?.length ?? 0) === 0 && cells()[0].executionCount == null)
ok('undo restored the outputs', docs.undo(nid) === true && (cells()[0].outputs?.length ?? 0) === 1)

// undo on an empty stack is a no-op false.
while (docs.undo(nid)) { /* drain */ }
ok('undo on empty history → false', docs.undo(nid) === false)

// A wholesale reload from disk drops history.
docs.applyOp({ op: 'editCell', notebookId: nid, cellId: cells()[0].id, source: 'Z' }, 'human')
ok('canUndo=true before reload', doc().canUndo === true)
await docs.reloadFromDisk(nid)
ok('reload from disk cleared history', doc().canUndo === false && doc().canRedo === false)

docs.close(nid)
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
process.exit(failed ? 1 : 0)
