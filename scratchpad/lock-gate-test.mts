// Verifies the cell-lock gate in NotebookDocManager.applyOp covers the MULTI-cell ops
// (deleteCells / moveCells / mergeCells), not just the single-cell ones. Before the fix
// the gate read `'cellId' in op ? op.cellId : undefined`, so a bulk op naming a pinned
// cell sailed through and deleted it silently.
//
// The human path must stay unaffected: locks are held BY the human, so origin:'human'
// is always allowed — that's what makes the user's own bulk delete of their pinned cell
// work normally.
//
// Run: npx tsx scratchpad/lock-gate-test.mts
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager'
import { emptyNotebookText } from '../server/src/notebook/ipynb'

let failed = 0
const ok = (c: unknown, m: string) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++ }

const dir = await mkdtemp(join(tmpdir(), 'claudette-lock-'))
const path = join(dir, 'n.ipynb')

// A fresh 4-cell notebook with the SECOND cell pinned by the human.
async function fixture() {
  await writeFile(path, emptyNotebookText())
  const docs = new NotebookDocManager()
  const doc = await docs.openPath(path)
  for (let i = 0; i < 3; i++) docs.applyOp({ op: 'addCell', notebookId: doc.notebookId, cellType: 'code', source: `c${i}` }, 'human')
  const ids = doc.cells.map((c) => c.id)
  docs.claimCell(doc.notebookId, ids[1], 'pin')
  return { docs, id: doc.notebookId, ids, doc }
}

// --- Claude is refused on every op that names the pinned cell -----------------
for (const [label, mk] of [
  ['deleteCells', (ids: string[]) => ({ op: 'deleteCells' as const, cellIds: [ids[1], ids[2]] })],
  ['moveCells', (ids: string[]) => ({ op: 'moveCells' as const, cellIds: [ids[1]], toIndex: 3 })],
  ['mergeCells', (ids: string[]) => ({ op: 'mergeCells' as const, cellIds: [ids[0], ids[1]] })],
  ['deleteCell', (ids: string[]) => ({ op: 'deleteCell' as const, cellId: ids[1] })],
] as const) {
  const { docs, id, ids, doc } = await fixture()
  const before = doc.cells.length
  const r = docs.applyOp({ ...mk(ids), notebookId: id } as never, 'claude')
  ok(!r.ok && r.code === 'locked', `claude ${label} naming a pinned cell is REFUSED (${r.ok ? 'allowed!' : r.error})`)
  ok(doc.cells.length === before && doc.cells.some((c) => c.id === ids[1]), `claude ${label}: pinned cell still present, doc untouched`)
  docs.close(id)
}

// --- Claude is still allowed when the op touches only unlocked cells ----------
{
  const { docs, id, ids, doc } = await fixture()
  const r = docs.applyOp({ op: 'deleteCells', notebookId: id, cellIds: [ids[2], ids[3]] }, 'claude')
  ok(r.ok, `claude deleteCells over UNLOCKED cells still succeeds (${r.ok ? 'ok' : r.error})`)
  ok(!doc.cells.some((c) => c.id === ids[2] || c.id === ids[3]), 'the unlocked cells were actually removed')
  docs.close(id)
}

// --- The human is never gated by their own lock ------------------------------
{
  const { docs, id, ids, doc } = await fixture()
  const r = docs.applyOp({ op: 'deleteCells', notebookId: id, cellIds: [ids[1], ids[2]] }, 'human')
  ok(r.ok, `human deleteCells including their OWN pinned cell still succeeds (${r.ok ? 'ok' : r.error})`)
  ok(!doc.cells.some((c) => c.id === ids[1]), 'the pinned cell was removed for the human')
  ok(docs.locks(id).every((l) => l.cellId !== ids[1]), 'and its now-dangling lock was dropped')
  docs.close(id)
}

// --- insertCells names no existing cell, so it is never gated ----------------
{
  const { docs, id } = await fixture()
  const r = docs.applyOp({ op: 'insertCells', notebookId: id, index: 0, cells: [{ cellType: 'code', source: 'x' }] }, 'claude')
  ok(r.ok, `claude insertCells (targets no existing cell) is not gated (${r.ok ? 'ok' : r.error})`)
  docs.close(id)
}

await rm(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
