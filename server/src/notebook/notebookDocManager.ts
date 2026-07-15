import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { readFile, writeFile, rename, access } from 'fs/promises'
import { watch, type FSWatcher } from 'fs'
import { dirname, basename, resolve } from 'path'
import type {
  NotebookDoc, NotebookOp, NotebookOpResult, NbCell, NbCellType, NbOutput,
  CellLock, LockReason,
} from '@claudette/shared'
import { parseNotebook, serializeNotebook, emptyNotebookText, emptyCodeCell, type NotebookMeta } from './ipynb'

// The authoritative, server-owned notebook document (PLAN §4). One `OpenNotebook`
// per open .ipynb, addressed by a stable server `notebookId` and per-cell stable
// `cellId`. The UI is a pure VIEW that sends ops and renders `update` broadcasts;
// Claude mutates through the SAME `applyOp` path (no UI round-trip — the fix for
// ClaudeMaster's wrong-notebook / temp-version bugs). Kernel outputs (P1.9) are
// routed back into the doc here, by cellId.
//
// Events (bridged to the WS hub in notebookApi.ts):
//   'update'  (doc: NotebookDoc)                       — after any applied op / reload / output
//   'opFocus' (notebookId, cellId, reveal: boolean)    — the cell a just-applied op touched
//   'locks'   (notebookId, locks: CellLock[])          — after any lock change

type Origin = 'human' | 'claude'

const IDLE_LOCK_MS = 30_000  // a focus/dirty lock auto-releases after this idle window
const MAX_HISTORY = 50       // undo/redo depth per notebook (snapshots of the cells array)

interface OpenNotebook {
  doc: NotebookDoc
  meta: NotebookMeta                     // nbformat/nbformat_minor (doc.metadata mirrors meta.metadata)
  baseline: string                       // last text we read from / wrote to disk (echo-filtering)
  watcher?: FSWatcher
  locks: Map<string, CellLock>           // cellId → lock (human-held)
  lockTimers: Map<string, NodeJS.Timeout>
  writing: boolean                       // a persist is in flight (suppress our own watch echo)
  undo: NbCell[][]                       // snapshots of `cells` BEFORE each edit/structural op
  redo: NbCell[][]                       // snapshots undone, redoable
}

export class NotebookDocManager extends EventEmitter {
  private open = new Map<string, OpenNotebook>()   // notebookId → state
  private byPath = new Map<string, string>()       // abs path → notebookId

  // --- open / create -------------------------------------------------------

  // Open a notebook by path, reusing the doc if it's already open. Reads + parses
  // from disk on first open, mints stable ids, and starts watching the file.
  async openPath(path: string): Promise<NotebookDoc> {
    const abs = resolve(path)
    const existingId = this.byPath.get(abs)
    if (existingId) return this.open.get(existingId)!.doc

    const text = await readFile(abs, 'utf8')
    return this.register(abs, text)
  }

  // Create a fresh empty notebook at `path` (fails if it already exists), then open it.
  async createPath(path: string): Promise<NotebookDoc> {
    const abs = resolve(path)
    if (await this.exists(abs)) throw new Error(`already exists: ${abs}`)
    const text = emptyNotebookText()
    await this.atomicWrite(abs, text)
    return this.register(abs, text)
  }

  private register(abs: string, text: string): NotebookDoc {
    const { cells, meta } = parseNotebook(text)
    const notebookId = randomUUID()
    const doc: NotebookDoc = {
      notebookId,
      path: abs,
      cells,
      metadata: meta.metadata,
      version: 0,
      dirty: false,
      canUndo: false,
      canRedo: false,
    }
    const nb: OpenNotebook = {
      doc, meta, baseline: text,
      locks: new Map(), lockTimers: new Map(), writing: false,
      undo: [], redo: [],
    }
    this.open.set(notebookId, nb)
    this.byPath.set(abs, notebookId)
    this.startWatch(nb)
    this.emit('update', doc)
    return doc
  }

  get(notebookId: string): NotebookDoc | undefined { return this.open.get(notebookId)?.doc }
  getByPath(path: string): NotebookDoc | undefined {
    const id = this.byPath.get(resolve(path))
    return id ? this.open.get(id)?.doc : undefined
  }
  list(): NotebookDoc[] { return [...this.open.values()].map((n) => n.doc) }

  close(notebookId: string): void {
    const nb = this.open.get(notebookId)
    if (!nb) return
    nb.watcher?.close()
    for (const t of nb.lockTimers.values()) clearTimeout(t)
    this.open.delete(notebookId)
    this.byPath.delete(nb.doc.path)
  }

  // --- ops -----------------------------------------------------------------

  // The ONLY mutation path (UI ops and Claude ops both land here). `origin`
  // distinguishes a human edit (always allowed) from a Claude edit (hard-denied
  // on a cell the human holds a lock on). Mutation is in-memory + synchronous;
  // persistence is a separate `save()` so the UI can hold unsaved edits.
  applyOp(op: NotebookOp, origin: Origin = 'human'): NotebookOpResult {
    const nb = this.open.get(op.notebookId)
    if (!nb) return { ok: false, error: `no such open notebook: ${op.notebookId}`, code: 'not_found' }
    const { doc } = nb

    // runCell/runAll are executed by the kernel client, not by doc mutation.
    if (op.op === 'runCell' || op.op === 'runAll') {
      return { ok: false, error: `${op.op} is executed via the kernel client, not applyOp` }
    }

    // Lock gate: Claude may not mutate a cell the human holds.
    const targetId = 'cellId' in op ? op.cellId : undefined
    if (origin === 'claude' && targetId && nb.locks.has(targetId)) {
      const reason = nb.locks.get(targetId)!.reason
      return { ok: false, error: `cell ${targetId} is locked by the user (${reason}); edit refused`, code: 'locked' }
    }

    const idx = (cellId: string) => doc.cells.findIndex((c) => c.id === cellId)

    // Snapshot the cells BEFORE mutating; committed to the undo stack only if the op
    // succeeds (the notFound branches return before we reach the commit below).
    const before = snapshotCells(doc.cells)

    // The cell this op leaves the user's attention on — broadcast as `opFocus` so
    // the view can select + reveal it (see the 'notebook:focus' WS message).
    let focusId: string | undefined

    switch (op.op) {
      case 'editCell': {
        const i = idx(op.cellId)
        if (i < 0) return notFound(op.cellId)
        doc.cells[i] = { ...doc.cells[i], source: op.source, outputs: [], executionCount: null }
        focusId = op.cellId
        break
      }
      case 'addCell': {
        const cell = makeCell(op.cellType, op.source)
        if (op.afterCellId) {
          const i = idx(op.afterCellId)
          if (i < 0) return notFound(op.afterCellId)
          doc.cells.splice(i + 1, 0, cell)
        } else {
          doc.cells.push(cell)
        }
        focusId = cell.id
        break
      }
      case 'insertCell': {
        const i = clamp(op.index, 0, doc.cells.length)
        const cell = makeCell(op.cellType, op.source)
        doc.cells.splice(i, 0, cell)
        focusId = cell.id
        break
      }
      case 'deleteCell': {
        const i = idx(op.cellId)
        if (i < 0) return notFound(op.cellId)
        doc.cells.splice(i, 1)
        if (doc.cells.length === 0) doc.cells.push(emptyCodeCell())
        // Land focus on the cell that slid into the deleted slot (else the last one).
        focusId = doc.cells[Math.min(i, doc.cells.length - 1)]?.id
        break
      }
      case 'moveCell': {
        const i = idx(op.cellId)
        if (i < 0) return notFound(op.cellId)
        const [cell] = doc.cells.splice(i, 1)
        doc.cells.splice(clamp(op.toIndex, 0, doc.cells.length), 0, cell)
        focusId = op.cellId
        break
      }
      case 'setCellType': {
        const i = idx(op.cellId)
        if (i < 0) return notFound(op.cellId)
        const c = doc.cells[i]
        doc.cells[i] = op.cellType === 'code'
          ? { ...c, cellType: 'code', outputs: [], executionCount: null }
          : { id: c.id, cellType: op.cellType, source: c.source, metadata: c.metadata }
        focusId = op.cellId
        break
      }
    }

    // The op succeeded — bank the pre-op snapshot for undo (drops the redo branch).
    this.pushHistory(nb, before)
    doc.version++
    doc.dirty = true
    this.emit('update', doc)
    // Reveal (scroll into view) for Claude's edits and any structural change; a plain
    // human text edit only re-selects, so typing/undo never fights the scroll.
    if (focusId) this.emit('opFocus', doc.notebookId, focusId, origin === 'claude' || op.op !== 'editCell')
    return { ok: true, version: doc.version }
  }

  // --- undo / redo ---------------------------------------------------------

  // Bank a pre-op snapshot; a fresh edit invalidates the redo branch. Capped depth.
  private pushHistory(nb: OpenNotebook, before: NbCell[]): void {
    nb.undo.push(before)
    if (nb.undo.length > MAX_HISTORY) nb.undo.shift()
    nb.redo = []
    this.refreshHistoryFlags(nb)
  }
  private refreshHistoryFlags(nb: OpenNotebook): void {
    nb.doc.canUndo = nb.undo.length > 0
    nb.doc.canRedo = nb.redo.length > 0
  }
  // Drop history when the doc is replaced wholesale from disk (the snapshots no
  // longer describe reachable states).
  private resetHistory(nb: OpenNotebook): void {
    nb.undo = []
    nb.redo = []
    this.refreshHistoryFlags(nb)
  }

  // Restore the previous (undo) / next (redo) cells snapshot; the current state moves
  // onto the opposite stack. Returns false when there is nothing to step to.
  undo(notebookId: string): boolean { return this.step(notebookId, 'undo') }
  redo(notebookId: string): boolean { return this.step(notebookId, 'redo') }
  private step(notebookId: string, dir: 'undo' | 'redo'): boolean {
    const nb = this.open.get(notebookId)
    if (!nb) return false
    const from = dir === 'undo' ? nb.undo : nb.redo
    const to = dir === 'undo' ? nb.redo : nb.undo
    const snap = from.pop()
    if (!snap) return false
    const prev = nb.doc.cells
    to.push(snapshotCells(prev))
    nb.doc.cells = snap
    nb.doc.version++
    nb.doc.dirty = true
    this.refreshHistoryFlags(nb)
    this.emit('update', nb.doc)
    // Best-effort: reveal the first cell that differs between the two states.
    const focusId = firstChangedCellId(prev, snap)
    if (focusId) this.emit('opFocus', notebookId, focusId, true)
    return true
  }

  // Clear every code cell's outputs + execution count (undoable). Marks dirty so a
  // save persists the cleared state.
  clearAllOutputs(notebookId: string): void {
    const nb = this.open.get(notebookId)
    if (!nb) return
    const before = snapshotCells(nb.doc.cells)
    let changed = false
    for (const c of nb.doc.cells) {
      if (c.cellType !== 'code') continue
      if ((c.outputs?.length ?? 0) === 0 && c.executionCount == null) continue
      c.outputs = []
      c.executionCount = null
      changed = true
    }
    if (!changed) return
    this.pushHistory(nb, before)
    nb.doc.version++
    nb.doc.dirty = true
    this.emit('update', nb.doc)
  }

  // Record the selected kernelspec name on the doc (drives the header picker label).
  setKernelName(notebookId: string, name: string): void {
    const nb = this.open.get(notebookId)
    if (!nb || nb.doc.kernelName === name) return
    nb.doc.kernelName = name
    this.emit('update', nb.doc)
  }

  // Resolve a 0-based index to a stable cellId against the current doc. The MCP
  // tools address cells by index (Claude reasons in positions); everything below
  // the tool boundary is cellId-addressed.
  cellIdAt(notebookId: string, index: number): string | undefined {
    return this.open.get(notebookId)?.doc.cells[index]?.id
  }

  // --- persistence ---------------------------------------------------------

  // Write the doc through to disk (atomic temp+rename), clear dirty, refresh the
  // echo baseline so our own write doesn't come back as an "external" change.
  async save(notebookId: string): Promise<void> {
    const nb = this.open.get(notebookId)
    if (!nb) return
    const text = serializeNotebook(nb.doc.cells, nb.meta)
    nb.writing = true
    try {
      await this.atomicWrite(nb.doc.path, text)
      nb.baseline = text
      nb.doc.dirty = false
      nb.doc.conflict = false
      this.emit('update', nb.doc)
    } finally {
      nb.writing = false
    }
  }

  // --- kernel output routing (used by the kernel client, P1.9) -------------

  bindKernel(notebookId: string, kernelId: string | undefined): void {
    const nb = this.open.get(notebookId)
    if (!nb) return
    nb.doc.kernelId = kernelId
    this.emit('update', nb.doc)
  }

  clearCellOutputs(notebookId: string, cellId: string): void {
    this.mutateCell(notebookId, cellId, (c) => { c.outputs = []; c.executionCount = null })
  }
  appendCellOutput(notebookId: string, cellId: string, output: NbOutput): void {
    this.mutateCell(notebookId, cellId, (c) => { (c.outputs ??= []).push(output) })
  }
  setCellExecutionCount(notebookId: string, cellId: string, n: number | null): void {
    this.mutateCell(notebookId, cellId, (c) => { c.executionCount = n })
  }

  // Output changes mutate in place and broadcast, but do NOT bump `version`
  // (that's for edit-op optimistic concurrency) nor mark `dirty` — outputs are
  // regenerable and streaming them would spam saves. The user saves to persist them.
  private mutateCell(notebookId: string, cellId: string, fn: (c: NbCell) => void): void {
    const nb = this.open.get(notebookId)
    if (!nb) return
    const c = nb.doc.cells.find((x) => x.id === cellId)
    if (!c) return
    fn(c)
    this.emit('update', nb.doc)
  }

  // --- cell locks (P1.8) ---------------------------------------------------

  claimCell(notebookId: string, cellId: string, reason: LockReason): void {
    const nb = this.open.get(notebookId)
    if (!nb || !nb.doc.cells.some((c) => c.id === cellId)) return
    nb.locks.set(cellId, { notebookId, cellId, reason })
    // focus/dirty locks auto-release when idle; a manual pin is sticky.
    this.clearLockTimer(nb, cellId)
    if (reason !== 'pin') {
      nb.lockTimers.set(cellId, setTimeout(() => this.releaseCell(notebookId, cellId), IDLE_LOCK_MS))
    }
    this.emitLocks(nb)
  }

  releaseCell(notebookId: string, cellId: string): void {
    const nb = this.open.get(notebookId)
    if (!nb || !nb.locks.has(cellId)) return
    nb.locks.delete(cellId)
    this.clearLockTimer(nb, cellId)
    this.emitLocks(nb)
  }

  locks(notebookId: string): CellLock[] {
    return [...(this.open.get(notebookId)?.locks.values() ?? [])]
  }

  private clearLockTimer(nb: OpenNotebook, cellId: string): void {
    const t = nb.lockTimers.get(cellId)
    if (t) { clearTimeout(t); nb.lockTimers.delete(cellId) }
  }
  private emitLocks(nb: OpenNotebook): void {
    this.emit('locks', nb.doc.notebookId, [...nb.locks.values()])
  }

  // --- file watch / conflict ----------------------------------------------

  private startWatch(nb: OpenNotebook): void {
    const dir = dirname(nb.doc.path)
    const base = basename(nb.doc.path)
    let debounce: NodeJS.Timeout | undefined
    try {
      // Watch the directory (survives the temp+rename swap better than watching
      // the file inode) and filter by basename.
      nb.watcher = watch(dir, (_event, filename) => {
        if (filename && filename.toString() !== base) return
        clearTimeout(debounce)
        debounce = setTimeout(() => { void this.onDiskChange(nb) }, 50)
      })
    } catch {
      // best-effort; a missing dir just means no external-change detection
    }
  }

  private async onDiskChange(nb: OpenNotebook): Promise<void> {
    if (nb.writing) return                              // our own write, ignore
    let text: string
    try { text = await readFile(nb.doc.path, 'utf8') } catch { return }
    if (text === nb.baseline) return                    // no real change (echo)

    if (nb.doc.dirty) {
      // We have unsaved edits AND disk changed → conflict; let the user resolve.
      nb.doc.conflict = true
      this.emit('update', nb.doc)
      return
    }
    // Clean reload: reparse from disk, keep the same notebookId (view stays bound).
    const { cells, meta } = parseNotebook(text)
    nb.doc.cells = cells
    nb.meta = meta
    nb.doc.metadata = meta.metadata
    nb.baseline = text
    nb.doc.version++
    this.resetHistory(nb)
    this.emit('update', nb.doc)
  }

  // Resolve a conflict by discarding local edits and taking disk.
  async reloadFromDisk(notebookId: string): Promise<void> {
    const nb = this.open.get(notebookId)
    if (!nb) return
    const text = await readFile(nb.doc.path, 'utf8')
    const { cells, meta } = parseNotebook(text)
    nb.doc.cells = cells
    nb.meta = meta
    nb.doc.metadata = meta.metadata
    nb.baseline = text
    nb.doc.dirty = false
    nb.doc.conflict = false
    nb.doc.version++
    this.resetHistory(nb)
    this.emit('update', nb.doc)
  }

  // Resolve a conflict by overwriting disk with our version.
  async keepMine(notebookId: string): Promise<void> {
    const nb = this.open.get(notebookId)
    if (nb) nb.doc.conflict = false
    await this.save(notebookId)
  }

  // --- helpers -------------------------------------------------------------

  private async exists(abs: string): Promise<boolean> {
    return access(abs).then(() => true, () => false)
  }

  // Atomic write: temp file in the same dir + rename (same-filesystem, atomic on
  // POSIX) so a reader never sees a half-written notebook.
  private async atomicWrite(abs: string, text: string): Promise<void> {
    const tmp = `${abs}.${randomUUID()}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, abs)
  }
}

// --- module helpers --------------------------------------------------------

function makeCell(cellType: NbCellType, source?: string): NbCell {
  const cell: NbCell = { id: randomUUID(), cellType, source: source ?? '', metadata: {} }
  if (cellType === 'code') { cell.outputs = []; cell.executionCount = null }
  return cell
}
// Deep copy of the cells array for the undo/redo stacks (outputs included).
function snapshotCells(cells: NbCell[]): NbCell[] {
  return structuredClone(cells)
}
// The id of the first cell that differs between two states (for undo/redo reveal).
function firstChangedCellId(a: NbCell[], b: NbCell[]): string | undefined {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i]; const y = b[i]
    if (!x || !y || x.id !== y.id || x.source !== y.source || x.cellType !== y.cellType) {
      return (y ?? x)?.id
    }
  }
  return b[0]?.id
}
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)) }
function notFound(cellId: string): NotebookOpResult {
  return { ok: false, error: `no such cell: ${cellId}`, code: 'not_found' }
}
