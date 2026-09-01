// Focused E2E for the notebook doc engine (P1.7 + P1.8). Run:
//   npx tsx scratchpad/notebook-doc-test.mts
import { mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager.ts'

import { check as ok, failed } from './assert.mjs'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const dir = await mkdtemp(join(tmpdir(), 'nbtest-'))
const path = join(dir, 'test.ipynb')

const nbs = new NotebookDocManager()
let updates = 0
nbs.on('update', () => updates++)

// 1. create → one empty code cell, stable id, persisted to disk
const doc = await nbs.createPath(path)
ok('create → 1 empty code cell', doc.cells.length === 1 && doc.cells[0].cellType === 'code')
ok('cell has a stable id', typeof doc.cells[0].id === 'string' && doc.cells[0].id.length > 0)
const onDisk = JSON.parse(await readFile(path, 'utf8'))
ok('cell id persisted to .ipynb (nbformat 4.5)', onDisk.cells[0].id === doc.cells[0].id)
ok('nbformat_minor >= 5', onDisk.nbformat_minor >= 5)

// 2. editCell → source set, version bumps, dirty
const c0 = doc.cells[0].id
let r = nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: c0, source: 'print("a")' })
ok('editCell sets source', r.ok && doc.cells[0].source === 'print("a")')
ok('version bumped + dirty after edit', doc.version === 1 && doc.dirty)

// 3. addCell + insertCell → distinct ids, ordering
nbs.applyOp({ op: 'addCell', notebookId: doc.notebookId, cellType: 'code', source: 'print("b")' })
nbs.applyOp({ op: 'addCell', notebookId: doc.notebookId, cellType: 'markdown', source: '# c' })
ok('addCell appends', doc.cells.length === 3)
const ids = new Set(doc.cells.map((c) => c.id))
ok('all cell ids distinct', ids.size === 3)
const c1 = doc.cells[1].id  // print("b")

// 4. THE KEY TEST: route an output to a cell, THEN reorder, output stays with the cell
nbs.appendCellOutput(doc.notebookId, c1, { output_type: 'stream', name: 'stdout', text: 'b\n' })
nbs.setCellExecutionCount(doc.notebookId, c1, 1)
ok('output routed to c1 by cellId', doc.cells[1].outputs?.length === 1)
// move c1 (index 1) to the front
nbs.applyOp({ op: 'moveCell', notebookId: doc.notebookId, cellId: c1, toIndex: 0 })
const moved = doc.cells.find((c) => c.id === c1)!
ok('moveCell reordered c1 to front', doc.cells[0].id === c1)
ok('output STAYS with c1 after reorder (cellId routing)', moved.outputs?.length === 1 && moved.executionCount === 1)

// 5. editCell PRESERVES outputs (Jupyter's behaviour, see applyOp's editCell case):
// they are the record of the last run, and wiping them on every keystroke threw away a
// plot or a traceback the user was editing against. A stale [n] beside changed source is
// the signal that the output predates it; only a re-run replaces them.
nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: c1, source: 'print("b2")' })
const edited = doc.cells.find((c) => c.id === c1)!
ok('editCell updated the source', edited.source === 'print("b2")')
ok('editCell KEEPS the last run\'s output and count', (edited.outputs?.length ?? 0) === 1 && edited.executionCount === 1)

// 6. cell lock hard-denies Claude, allows human
nbs.claimCell(doc.notebookId, c0, 'focus')
const denied = nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: c0, source: 'x' }, 'claude')
ok('Claude edit to locked cell hard-denied', !denied.ok && denied.code === 'locked')
const humanOk = nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: c0, source: 'y' }, 'human')
ok('human edit to same cell allowed', humanOk.ok)
nbs.releaseCell(doc.notebookId, c0)
const afterRelease = nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: c0, source: 'z' }, 'claude')
ok('Claude edit allowed after release', afterRelease.ok)

// 7. save → dirty cleared, round-trips through disk with same ids
await nbs.save(doc.notebookId)
ok('save clears dirty', !doc.dirty)
const reparsed = JSON.parse(await readFile(path, 'utf8'))
ok('ids round-trip through save', reparsed.cells.map((c: any) => c.id).join() === doc.cells.map((c) => c.id).join())

// 8. external change → clean reload (not dirty)
const beforeVersion = doc.version
const externalText = JSON.stringify({
  cells: [{ cell_type: 'code', id: 'ext-1', metadata: {}, source: ['print("external")'], execution_count: null, outputs: [] }],
  metadata: {}, nbformat: 4, nbformat_minor: 5,
}, null, 1) + '\n'
await writeFile(path, externalText, 'utf8')
await wait(200)
ok('external edit reloaded (not dirty → take disk)', doc.cells.length === 1 && doc.cells[0].id === 'ext-1')
ok('reload bumped version', doc.version > beforeVersion)

// 9. conflict: local unsaved edit + external change → conflict flag
nbs.applyOp({ op: 'editCell', notebookId: doc.notebookId, cellId: 'ext-1', source: 'local' })
ok('local edit → dirty', doc.dirty)
await writeFile(path, externalText.replace('external', 'external2'), 'utf8')
await wait(200)
ok('external change while dirty → conflict flag', doc.conflict === true)

nbs.close(doc.notebookId)
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
