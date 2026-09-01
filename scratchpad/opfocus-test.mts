// opFocus signal: every applyOp emits (notebookId, cellId, reveal) naming the cell
// the op left the user's attention on. Proves the cellId is right per op type and
// that `reveal` is true for Claude edits + structural ops but false for a human text
// edit (typing/undo). Run:  npx tsx scratchpad/opfocus-test.mts
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager.ts'

import { check as ok, failed } from './assert.mjs'

const dir = await mkdtemp(join(tmpdir(), 'opfocus-'))
const docs = new NotebookDocManager()
const nid = (await docs.createPath(join(dir, 'n.ipynb'))).notebookId
const cells = () => docs.get(nid)!.cells

const seen: Array<{ cid: string; reveal: boolean }> = []
docs.on('opFocus', (_n: string, cid: string, reveal: boolean) => seen.push({ cid, reveal }))
const last = () => seen[seen.length - 1]

// addCell (human) → focus the NEW last cell, reveal (structural)
docs.applyOp({ op: 'addCell', notebookId: nid, cellType: 'code', source: 'a' }, 'human')
ok('addCell → new cell, reveal=true', last().cid === cells()[cells().length - 1].id && last().reveal === true)

const c0 = cells()[0].id
// editCell (human) → that cell, NO reveal (typing/undo must not yank scroll)
docs.applyOp({ op: 'editCell', notebookId: nid, cellId: c0, source: 'x' }, 'human')
ok('human editCell → cell, reveal=false', last().cid === c0 && last().reveal === false)

// editCell (claude) → that cell, reveal (show the user Claude's change)
docs.applyOp({ op: 'editCell', notebookId: nid, cellId: c0, source: 'y' }, 'claude')
ok('claude editCell → cell, reveal=true', last().cid === c0 && last().reveal === true)

// insertCell (human) at index 1 → focus the inserted cell, reveal
docs.applyOp({ op: 'insertCell', notebookId: nid, index: 1, cellType: 'markdown' }, 'human')
ok('insertCell → inserted cell, reveal=true', last().cid === cells()[1].id && last().reveal === true)

// moveCell → follow the moved cell, reveal
const moved = cells()[0].id
docs.applyOp({ op: 'moveCell', notebookId: nid, cellId: moved, toIndex: 2 }, 'human')
ok('moveCell → moved cell, reveal=true', last().cid === moved && last().reveal === true)

// setCellType → that cell, reveal
docs.applyOp({ op: 'setCellType', notebookId: nid, cellId: moved, cellType: 'markdown' }, 'human')
ok('setCellType → cell, reveal=true', last().cid === moved && last().reveal === true)

// deleteCell → focus the cell that slid into the deleted slot, reveal
const before = cells().map((c) => c.id)
docs.applyOp({ op: 'deleteCell', notebookId: nid, cellId: before[0] }, 'human')
ok('deleteCell → neighbor in the slot, reveal=true', last().cid === before[1] && last().reveal === true)

// A locked cell (Claude edit refused) must NOT emit a focus.
const target = cells()[0].id
docs.claimCell(nid, target, 'pin')
const n = seen.length
const r = docs.applyOp({ op: 'editCell', notebookId: nid, cellId: target, source: 'z' }, 'claude')
ok('refused (locked) edit emits no opFocus', !r.ok && seen.length === n)

docs.close(nid)
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
process.exit(failed ? 1 : 0)
