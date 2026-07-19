import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { readFile, writeFile, rename, access, realpath, rm } from 'fs/promises'
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
const MAX_OUTPUTS = 1000     // per-cell output cap — a runaway loop can't grow it unbounded
const MAX_STREAM_CHARS = 200_000  // cap on a single coalesced stdout/stderr block

interface OpenNotebook {
  doc: NotebookDoc
  meta: NotebookMeta                     // nbformat/nbformat_minor (doc.metadata mirrors meta.metadata)
  baseline: string                       // last text we read from / wrote to disk (echo-filtering)
  watcher?: FSWatcher
  watchDebounce?: NodeJS.Timeout         // pending disk-change debounce (cancelled on close)
  locks: Map<string, CellLock>           // cellId → lock (human-held)
  lockTimers: Map<string, NodeJS.Timeout>
  writing: boolean                       // a persist is in flight (suppress our own watch echo)
  undo: NbCell[][]                       // snapshots of `cells` BEFORE each edit/structural op
  redo: NbCell[][]                       // snapshots undone, redoable
}

export class NotebookDocManager extends EventEmitter {
  private open = new Map<string, OpenNotebook>()   // notebookId → state (currently open)
  private byPath = new Map<string, string>()       // abs path → notebookId (currently open)
  // Stable notebookId per path for the SESSION — survives close, so reopening a path
  // gets the same id and its still-running kernel (keyed by notebookId) reconnects.
  private idByPath = new Map<string, string>()
  // Notebooks closed while a cell was still running — the doc is kept live so the
  // run's output keeps landing, then saved + unregistered once the kernel goes idle
  // (onKernelIdle). Their `update` broadcasts are suppressed (the tab is gone).
  private pendingClose = new Set<string>()

  // --- open / create -------------------------------------------------------

  // Open a notebook by path, reusing the doc if it's already open. Reads + parses
  // from disk on first open, mints stable ids, and starts watching the file.
  async openPath(path: string, guardRealDir?: string): Promise<NotebookDoc> {
    const abs = resolve(path)
    const existingId = this.byPath.get(abs)
    if (existingId) {
      this.pendingClose.delete(existingId)   // reopened before its deferred close fired
      return this.open.get(existingId)!.doc
    }
    // SANDBOX.md G1: refuse a fresh read whose parent was relinked since authorization.
    if (guardRealDir !== undefined) {
      const now = await realpath(dirname(abs)).catch(() => null)
      if (now !== guardRealDir) throw new Error(`refusing to open ${abs}: its directory changed since authorization (possible symlink-swap escape)`)
    }
    const text = await readFile(abs, 'utf8')
    return this.register(abs, text)
  }

  // Create a fresh empty notebook at `path` (fails if it already exists), then open it.
  // `guardRealDir` (SANDBOX.md G1): the canonical parent dir the CALLER authorized — the
  // write refuses if the parent has since been relinked out from under it.
  async createPath(path: string, guardRealDir?: string): Promise<NotebookDoc> {
    const abs = resolve(path)
    if (await this.exists(abs)) throw new Error(`already exists: ${abs}`)
    const text = emptyNotebookText()
    await this.atomicWrite(abs, text, guardRealDir)
    return this.register(abs, text)
  }

  private register(abs: string, text: string): NotebookDoc {
    const { cells, meta } = parseNotebook(text)
    // Reuse the path's stable id (so a reopen rebinds to its running kernel), else mint.
    const notebookId = this.idByPath.get(abs) ?? randomUUID()
    this.idByPath.set(abs, notebookId)
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
    if (nb.watchDebounce) clearTimeout(nb.watchDebounce)   // cancel a pending disk-change fire
    for (const t of nb.lockTimers.values()) clearTimeout(t)
    this.open.delete(notebookId)
    this.byPath.delete(nb.doc.path)
  }

  // Close a notebook tab. If a cell is still running, DEFER the actual close: keep the
  // doc live so the run's output keeps landing, then save + unregister once idle
  // (onKernelIdle). An idle notebook closes immediately (unsaved edits discarded, as
  // before — nothing is mid-flight to lose). The kernel keeps running either way.
  requestClose(notebookId: string, isRunning: boolean, save: boolean): void {
    // Running → defer regardless; finalizeClose persists the run's output (and any
    // unsaved edits) when it finishes. Idle → save-then-close, or discard-then-close.
    if (isRunning) { this.pendingClose.add(notebookId); return }
    if (save) { this.pendingClose.add(notebookId); void this.finalizeClose(notebookId) }  // save's emit stays suppressed
    else this.close(notebookId)
  }

  // Is this notebook mid-deferred-close? Its `update` broadcasts are suppressed (the
  // tab is already gone) so a background run doesn't resurrect it on the client.
  isClosing(notebookId: string): boolean { return this.pendingClose.has(notebookId) }

  // The kernel manager calls this when a notebook's runs finish. If the tab was closed
  // mid-run, persist the captured output to disk, then unregister the doc.
  onKernelIdle(notebookId: string): void {
    if (this.pendingClose.has(notebookId)) void this.finalizeClose(notebookId)
  }

  private async finalizeClose(notebookId: string): Promise<void> {
    // Save (persists the run's output) BEFORE dropping pendingClose, so save's own
    // `update` emit is still suppressed by the broadcast filter — the tab is gone.
    if (this.get(notebookId)?.dirty) { try { await this.save(notebookId) } catch { /* best effort */ } }
    this.close(notebookId)
    this.pendingClose.delete(notebookId)
  }

  // Reopening (or Claude re-focusing) a notebook mid-deferred-close cancels the close
  // and re-broadcasts the live doc so the reopened tab picks it up.
  cancelClose(notebookId: string): void {
    if (!this.pendingClose.delete(notebookId)) return
    const nb = this.open.get(notebookId)
    if (nb) this.emit('update', nb.doc)
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
        // Drop any lock the deleted cell held (else a sticky 'pin' lingers forever on
        // a cellId that no longer exists) and re-broadcast the pruned lock set.
        if (nb.locks.has(op.cellId)) {
          this.clearLockTimer(nb, op.cellId)
          nb.locks.delete(op.cellId)
          this.emitLocks(nb)
        }
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
        // No-op when the type is unchanged — otherwise a redundant convert-to-code
        // would wipe the cell's outputs/executionCount for nothing.
        if (c.cellType !== op.cellType) {
          doc.cells[i] = op.cellType === 'code'
            ? { ...c, cellType: 'code', outputs: [], executionCount: null }
            : { id: c.id, cellType: op.cellType, source: c.source, metadata: c.metadata }
        }
        focusId = op.cellId
        break
      }
      case 'deleteCells': {
        const ids = new Set(op.cellIds)
        const positions = op.cellIds.map(idx).filter((i) => i >= 0)
        if (positions.length === 0) return notFound(op.cellIds[0] ?? '(none)')
        const firstIdx = Math.min(...positions)
        doc.cells = doc.cells.filter((c) => !ids.has(c.id))
        this.dropLocks(nb, ids)
        if (doc.cells.length === 0) doc.cells.push(emptyCodeCell())
        // Land on the cell that slid into the first deleted slot (else the last one).
        focusId = doc.cells[Math.min(firstIdx, doc.cells.length - 1)]?.id
        break
      }
      case 'insertCells': {
        if (op.cells.length === 0) return { ok: false, error: 'insertCells: no cells given' }
        const at = clamp(op.index, 0, doc.cells.length)
        const made = op.cells.map((c) => makeCell(c.cellType, c.source))
        doc.cells.splice(at, 0, ...made)
        focusId = made[0].id
        break
      }
      case 'moveCells': {
        const moveSet = new Set(op.cellIds.filter((id) => idx(id) >= 0))
        if (moveSet.size === 0) return notFound(op.cellIds[0] ?? '(none)')
        const moving = doc.cells.filter((c) => moveSet.has(c.id))   // preserve doc order
        const rest = doc.cells.filter((c) => !moveSet.has(c.id))
        const at = clamp(op.toIndex, 0, rest.length)
        rest.splice(at, 0, ...moving)
        doc.cells = rest
        focusId = moving[0].id
        break
      }
      case 'splitCell': {
        const i = idx(op.cellId)
        if (i < 0) return notFound(op.cellId)
        const c = doc.cells[i]
        const off = clamp(op.offset, 0, c.source.length)
        // Head keeps the cell's id (and thus its place); tail becomes a new cell. A
        // split invalidates outputs, so clear them on the (now-shorter) head.
        doc.cells[i] = { ...c, source: c.source.slice(0, off), outputs: [], executionCount: null }
        const tail = makeCell(c.cellType, c.source.slice(off))
        doc.cells.splice(i + 1, 0, tail)
        focusId = tail.id
        break
      }
      case 'mergeCells': {
        // Merge in DOCUMENT order regardless of the order ids were passed in.
        const inOrder = doc.cells.filter((c) => op.cellIds.includes(c.id))
        if (inOrder.length < 2) return { ok: false, error: 'mergeCells needs at least two existing cells', code: 'not_found' }
        const first = inOrder[0]
        const merged = inOrder.map((c) => c.source).join('\n')
        const drop = new Set(inOrder.slice(1).map((c) => c.id))
        doc.cells[idx(first.id)] = { ...first, source: merged, outputs: [], executionCount: null }
        doc.cells = doc.cells.filter((c) => !drop.has(c.id))
        this.dropLocks(nb, drop)
        focusId = first.id
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
  async save(notebookId: string, guardRealDir?: string): Promise<void> {
    const nb = this.open.get(notebookId)
    if (!nb) return
    const text = serializeNotebook(nb.doc.cells, nb.meta)
    nb.writing = true
    try {
      await this.atomicWrite(nb.doc.path, text, guardRealDir)
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
    this.mutateCell(notebookId, cellId, (c) => {
      const outs = (c.outputs ??= [])
      // Coalesce consecutive stream chunks of the same stream (stdout/stderr) into one
      // output — what real Jupyter frontends do — so a tight print loop appends to one
      // block (capped) instead of spawning an output per line.
      const last = outs[outs.length - 1] as (NbOutput & { name?: string; text?: string }) | undefined
      const cur = output as NbOutput & { name?: string; text?: string }
      if (cur.output_type === 'stream' && last?.output_type === 'stream' && last.name === cur.name) {
        last.text = capChars(String(last.text ?? '') + String(cur.text ?? ''), MAX_STREAM_CHARS)
        return
      }
      if (cur.output_type === 'stream') cur.text = capChars(String(cur.text ?? ''), MAX_STREAM_CHARS)
      outs.push(output)
      // Hard cap the output count so a runaway non-stream loop (e.g. display() in a
      // loop) can't grow the array without bound — keep the most recent.
      if (outs.length > MAX_OUTPUTS) outs.splice(0, outs.length - MAX_OUTPUTS)
    })
  }
  setCellExecutionCount(notebookId: string, cellId: string, n: number | null): void {
    this.mutateCell(notebookId, cellId, (c) => { c.executionCount = n })
  }

  // Output changes mutate in place and broadcast. They don't bump `version` (that's
  // for edit-op optimistic concurrency), but they DO mark `dirty` — fresh run outputs
  // are unsaved state, so a concurrent external disk change must surface as a conflict
  // (via onDiskChange's dirty guard) instead of silently discarding them on reload.
  private mutateCell(notebookId: string, cellId: string, fn: (c: NbCell) => void): void {
    const nb = this.open.get(notebookId)
    if (!nb) return
    const c = nb.doc.cells.find((x) => x.id === cellId)
    if (!c) return
    fn(c)
    nb.doc.dirty = true
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
  // Drop any locks held on the given (about-to-be-removed) cells, then re-broadcast
  // the pruned set — else a sticky lock lingers on a cellId that no longer exists.
  private dropLocks(nb: OpenNotebook, cellIds: Set<string>): void {
    let changed = false
    for (const id of cellIds) {
      if (!nb.locks.has(id)) continue
      this.clearLockTimer(nb, id)
      nb.locks.delete(id)
      changed = true
    }
    if (changed) this.emitLocks(nb)
  }
  private emitLocks(nb: OpenNotebook): void {
    this.emit('locks', nb.doc.notebookId, [...nb.locks.values()])
  }

  // --- file watch / conflict ----------------------------------------------

  private startWatch(nb: OpenNotebook): void {
    const dir = dirname(nb.doc.path)
    const base = basename(nb.doc.path)
    try {
      // Watch the directory (survives the temp+rename swap better than watching
      // the file inode) and filter by basename. The debounce handle lives on `nb`
      // so close() can cancel a fire that would otherwise mutate a closed doc.
      nb.watcher = watch(dir, (_event, filename) => {
        if (filename && filename.toString() !== base) return
        clearTimeout(nb.watchDebounce)
        nb.watchDebounce = setTimeout(() => { void this.onDiskChange(nb) }, 50)
      })
    } catch {
      // best-effort; a missing dir just means no external-change detection
    }
  }

  private async onDiskChange(nb: OpenNotebook): Promise<void> {
    if (!this.open.has(nb.doc.notebookId)) return       // closed after the watch fired
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
    this.applyDiskText(nb, text)
  }

  // Reparse `text` from disk into the doc, keeping the same notebookId so the view
  // stays bound; bumps version, resets undo history, and broadcasts the update.
  private applyDiskText(nb: OpenNotebook, text: string): void {
    const { cells, meta } = parseNotebook(text)
    nb.doc.cells = cells
    nb.meta = meta
    nb.doc.metadata = meta.metadata
    nb.baseline = text
    nb.doc.version++
    this.resetHistory(nb)
    // The reparsed cells may have different ids (a file without 4.5 ids re-mints
    // them), so any held lock now points at a gone cell — prune the orphans.
    const live = new Set(cells.map((c) => c.id))
    let pruned = false
    for (const cellId of [...nb.locks.keys()]) {
      if (!live.has(cellId)) { this.clearLockTimer(nb, cellId); nb.locks.delete(cellId); pruned = true }
    }
    if (pruned) this.emitLocks(nb)
    this.emit('update', nb.doc)
  }

  // Resolve a conflict by discarding local edits and taking disk.
  async reloadFromDisk(notebookId: string): Promise<void> {
    const nb = this.open.get(notebookId)
    if (!nb) return
    const text = await readFile(nb.doc.path, 'utf8')
    nb.doc.dirty = false
    nb.doc.conflict = false
    this.applyDiskText(nb, text)
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
  //
  // SANDBOX.md G1 (TOCTOU symlink-swap): the caller authorized `abs` by canonicalizing it
  // (realpath'ing the parent) at CHECK time, but this write re-resolves symlinks at
  // syscall time — a confined box could swap the parent dir for a symlink in between and
  // redirect the write out of its mounts. When the caller passes the parent realpath it
  // authorized (`guardRealDir`), refuse if the parent's realpath no longer matches (it was
  // relinked/moved since the check). We deliberately compare against the CHECKED value, not
  // "parent must not be a symlink", so legitimate symlinked mount ancestors still work. The
  // temp file is created with `wx` (O_EXCL) so a pre-planted final-component symlink can't
  // be followed either. (A residual few-instruction window remains — the airtight fix is
  // openat2/RESOLVE_NO_SYMLINKS, unavailable in Node; documented in SANDBOX.md.)
  private async atomicWrite(abs: string, text: string, guardRealDir?: string): Promise<void> {
    if (guardRealDir !== undefined) {
      const now = await realpath(dirname(abs)).catch(() => null)
      if (now !== guardRealDir) throw new Error(`refusing to write ${abs}: its directory changed since authorization (possible symlink-swap escape)`)
    }
    const tmp = `${abs}.${randomUUID()}.tmp`
    await writeFile(tmp, text, { flag: 'wx' })
    try {
      if (guardRealDir !== undefined) {
        const tmpDir = await realpath(dirname(tmp)).catch(() => null)
        if (tmpDir !== guardRealDir) throw new Error(`refusing to write ${abs}: temp file resolved outside the authorized directory`)
      }
      await rename(tmp, abs)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {})
      throw e
    }
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
// Bound a stream block's length, keeping the head and tail (the interesting ends) with
// an elision marker — a runaway loop stays legible instead of ballooning memory.
function capChars(s: string, max: number): string {
  if (s.length <= max) return s
  const keep = Math.floor(max / 2)
  return `${s.slice(0, keep)}\n… [output truncated: ${s.length - max} more chars] …\n${s.slice(s.length - keep)}`
}
function notFound(cellId: string): NotebookOpResult {
  return { ok: false, error: `no such cell: ${cellId}`, code: 'not_found' }
}
