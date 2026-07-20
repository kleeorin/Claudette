import {
  createContext, useContext, useEffect, useState, useCallback, useMemo, useRef, type ReactNode,
} from 'react'
import type { NotebookDoc, CellLock, LockReason, KernelStatus, NbCellType, KernelSpecsResponse } from '@claudette/shared'
import { api } from '../api/client'

// The notebook store is a pure VIEW over the server-owned doc (PLAN §4) — the
// inverse of ClaudeMaster's store, which OWNED the document. State arrives via the
// `notebook:update` / `notebook:locks` / `notebook:kernel` WS topics; every mutation
// is an INTENT sent over WS (`notebook:op` / claim / release) or an HTTP call
// (open/save/conflict), and the authoritative result comes back as an update. The
// UI never mutates cells locally except the CodeMirror buffer the user types in
// (reconciled per-cell in Cell.tsx).

interface ContextValue {
  open: NotebookDoc[]                       // open notebooks, in tab order
  // `sessionId` records which session the notebook is opened in — closing that
  // session kills the notebook's kernel.
  openPath: (path: string, sessionId?: string) => Promise<string | null>  // → opened notebookId, or null on failure
  createPath: (path: string, sessionId?: string) => Promise<string | null>  // → error string or null
  // `save`: persist unsaved changes before closing (from the close prompt).
  close: (notebookId: string, save?: boolean) => void
  // Did THIS client open the notebook locally (Files dock / New), vs it arriving
  // pushed from the server (a Claude tool)? Locally-opened ones attach to the active
  // session; server-pushed ones attach only via `focusPane` (the calling session).
  wasLocallyOpened: (notebookId: string) => boolean
  // per-notebook view state
  locksFor: (notebookId: string) => CellLock[]
  kernelFor: (notebookId: string) => KernelStatus
  isRunning: (notebookId: string, cellId: string) => boolean
  isBusy: (notebookId: string) => boolean          // any cell currently executing/queued
  // mutations (intents → server)
  updateSource: (notebookId: string, cellId: string, source: string) => void
  addCell: (notebookId: string, cellType: NbCellType, afterCellId?: string, source?: string) => void
  insertCell: (notebookId: string, index: number, cellType: NbCellType) => void
  deleteCell: (notebookId: string, cellId: string) => void
  moveCell: (notebookId: string, cellId: string, toIndex: number) => void
  setCellType: (notebookId: string, cellId: string, cellType: NbCellType) => void
  // multi-cell / structural (atomic on the server — one undo step each)
  deleteCells: (notebookId: string, cellIds: string[]) => void
  insertCells: (notebookId: string, index: number, cells: { cellType: NbCellType; source: string }[]) => void
  moveCells: (notebookId: string, cellIds: string[], toIndex: number) => void
  splitCell: (notebookId: string, cellId: string, offset: number) => void
  mergeCells: (notebookId: string, cellIds: string[]) => void
  run: (notebookId: string, cellId: string) => void
  runMany: (notebookId: string, cellIds: string[]) => void
  runAll: (notebookId: string) => void
  save: (notebookId: string) => void
  reload: (notebookId: string) => void
  keepMine: (notebookId: string) => void
  claim: (notebookId: string, cellId: string, reason: LockReason) => void
  release: (notebookId: string, cellId: string) => void
  // undo/redo + kernel controls
  undo: (notebookId: string) => void
  redo: (notebookId: string) => void
  clearOutputs: (notebookId: string) => void
  kernelSpecs: () => Promise<KernelSpecsResponse>
  restartKernel: (notebookId: string) => void
  interruptKernel: (notebookId: string) => void
  shutdownKernel: (notebookId: string) => void
  setKernelSpec: (notebookId: string, name: string) => void
}

const NotebooksContext = createContext<ContextValue | null>(null)

export function NotebooksProvider({ children }: { children: ReactNode }) {
  const [docs, setDocs] = useState<Record<string, NotebookDoc>>({})
  const [order, setOrder] = useState<string[]>([])
  const [locks, setLocks] = useState<Record<string, CellLock[]>>({})
  const [kernels, setKernels] = useState<Record<string, KernelStatus>>({})
  const [running, setRunning] = useState<Record<string, Set<string>>>({})
  const docsRef = useRef<Record<string, NotebookDoc>>({}); docsRef.current = docs
  // Notebooks this client opened via a user action (Files dock / New) — the only
  // ones the shell auto-attaches to the active session.
  const localIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    const offUpd = api.on.notebookUpdate((doc) => {
      setDocs((prev) => ({ ...prev, [doc.notebookId]: doc }))
      setOrder((prev) => prev.includes(doc.notebookId) ? prev : [...prev, doc.notebookId])
    })
    const offLocks = api.on.notebookLocks((notebookId, l) =>
      setLocks((prev) => ({ ...prev, [notebookId]: l })))
    const offKernel = api.on.notebookKernel((notebookId, status) =>
      setKernels((prev) => ({ ...prev, [notebookId]: status })))
    // The server owns the running set now (notebook:running) — it covers every
    // terminal path (done, error, deleted mid-run, kernel dead/restart) that the old
    // client-side busy→idle heuristic missed. We just mirror it.
    const offRunning = api.on.notebookRunning((notebookId, cellIds) =>
      setRunning((prev) => ({ ...prev, [notebookId]: new Set(cellIds) })))
    return () => { offUpd(); offLocks(); offKernel(); offRunning() }
  }, [])

  // Returns the opened notebook's id (so the caller can focus its tab, even when
  // the notebook was already open), or null on failure.
  const openPath = useCallback(async (path: string, sessionId?: string): Promise<string | null> => {
    const res = await api.notebook.open(path, sessionId)
    if (res.error || !res.doc) return null
    const doc = res.doc
    localIds.current.add(doc.notebookId)
    setDocs((prev) => ({ ...prev, [doc.notebookId]: doc }))
    setOrder((prev) => prev.includes(doc.notebookId) ? prev : [...prev, doc.notebookId])
    return doc.notebookId
  }, [])

  const createPath = useCallback(async (path: string, sessionId?: string): Promise<string | null> => {
    const res = await api.notebook.create(path, sessionId)
    if (res.error || !res.doc) return res.error ?? 'failed to create notebook'
    const doc = res.doc
    localIds.current.add(doc.notebookId)
    setDocs((prev) => ({ ...prev, [doc.notebookId]: doc }))
    setOrder((prev) => prev.includes(doc.notebookId) ? prev : [...prev, doc.notebookId])
    return null
  }, [])

  const close = useCallback((notebookId: string, save = false) => {
    // Unregister the doc server-side (else it keeps pushing `notebook:update` and the
    // tab reappears on the next edit). The KERNEL keeps running — it dies only on an
    // explicit shutdown, when its owning session closes, or when Claudette exits.
    void api.notebook.close(notebookId, save)
    localIds.current.delete(notebookId)
    setOrder((prev) => prev.filter((id) => id !== notebookId))
    setDocs((prev) => { const { [notebookId]: _drop, ...rest } = prev; return rest })
    setLocks((prev) => { const { [notebookId]: _l, ...rest } = prev; return rest })
    setKernels((prev) => { const { [notebookId]: _k, ...rest } = prev; return rest })
    setRunning((prev) => { const { [notebookId]: _r, ...rest } = prev; return rest })
  }, [])

  const markRunning = useCallback((notebookId: string, cellIds: string[]) => {
    setRunning((prev) => {
      const set = new Set(prev[notebookId] ?? [])
      for (const id of cellIds) set.add(id)
      return { ...prev, [notebookId]: set }
    })
  }, [])

  const run = useCallback((notebookId: string, cellId: string) => {
    markRunning(notebookId, [cellId])
    api.notebook.op({ op: 'runCell', notebookId, cellId })
  }, [markRunning])

  // Run several cells in document order (bulk-run over a selection / run above|below).
  // The caller passes ids already in order; non-code ids are harmless (the kernel
  // skips them) but we only mark code cells busy — the server's running set corrects
  // us regardless.
  const runMany = useCallback((notebookId: string, cellIds: string[]) => {
    markRunning(notebookId, cellIds)
    for (const cellId of cellIds) api.notebook.op({ op: 'runCell', notebookId, cellId })
  }, [markRunning])

  const runAll = useCallback((notebookId: string) => {
    const d = docsRef.current[notebookId]
    if (d) markRunning(notebookId, d.cells.filter((c) => c.cellType === 'code').map((c) => c.id))
    api.notebook.op({ op: 'runAll', notebookId })
  }, [markRunning])

  // Memoize so a notebook WS event (frequent during execution) doesn't rebuild the
  // value + `open` array identity and re-render every consumer.
  const value = useMemo<ContextValue>(() => ({
    open: order.map((id) => docs[id]).filter(Boolean),
    openPath, createPath, close,
    wasLocallyOpened: (id) => localIds.current.has(id),
    locksFor: (id) => locks[id] ?? [],
    kernelFor: (id) => kernels[id] ?? 'none',
    isRunning: (id, cellId) => running[id]?.has(cellId) ?? false,
    isBusy: (id) => (running[id]?.size ?? 0) > 0,
    updateSource: (notebookId, cellId, source) => api.notebook.op({ op: 'editCell', notebookId, cellId, source }),
    addCell: (notebookId, cellType, afterCellId, source) => api.notebook.op({ op: 'addCell', notebookId, cellType, afterCellId, source }),
    insertCell: (notebookId, index, cellType) => api.notebook.op({ op: 'insertCell', notebookId, index, cellType }),
    deleteCell: (notebookId, cellId) => api.notebook.op({ op: 'deleteCell', notebookId, cellId }),
    moveCell: (notebookId, cellId, toIndex) => api.notebook.op({ op: 'moveCell', notebookId, cellId, toIndex }),
    setCellType: (notebookId, cellId, cellType) => api.notebook.op({ op: 'setCellType', notebookId, cellId, cellType }),
    deleteCells: (notebookId, cellIds) => api.notebook.op({ op: 'deleteCells', notebookId, cellIds }),
    insertCells: (notebookId, index, cells) => api.notebook.op({ op: 'insertCells', notebookId, index, cells }),
    moveCells: (notebookId, cellIds, toIndex) => api.notebook.op({ op: 'moveCells', notebookId, cellIds, toIndex }),
    splitCell: (notebookId, cellId, offset) => api.notebook.op({ op: 'splitCell', notebookId, cellId, offset }),
    mergeCells: (notebookId, cellIds) => api.notebook.op({ op: 'mergeCells', notebookId, cellIds }),
    run,
    runMany,
    runAll,
    save: (notebookId) => { void api.notebook.save(notebookId) },
    reload: (notebookId) => { void api.notebook.reload(notebookId) },
    keepMine: (notebookId) => { void api.notebook.keepMine(notebookId) },
    claim: (notebookId, cellId, reason) => api.notebook.claim(notebookId, cellId, reason),
    release: (notebookId, cellId) => api.notebook.release(notebookId, cellId),
    undo: (notebookId) => { void api.notebook.undo(notebookId) },
    redo: (notebookId) => { void api.notebook.redo(notebookId) },
    clearOutputs: (notebookId) => { void api.notebook.clearOutputs(notebookId) },
    kernelSpecs: () => api.notebook.kernelSpecs(),
    restartKernel: (notebookId) => { void api.notebook.kernelRestart(notebookId) },
    interruptKernel: (notebookId) => { void api.notebook.kernelInterrupt(notebookId) },
    shutdownKernel: (notebookId) => { void api.notebook.kernelShutdown(notebookId) },
    setKernelSpec: (notebookId, name) => { void api.notebook.kernelSetSpec(notebookId, name) },
  }), [order, docs, locks, kernels, running, openPath, createPath, close, run, runMany, runAll])

  return <NotebooksContext.Provider value={value}>{children}</NotebooksContext.Provider>
}

export function useNotebooks(): ContextValue {
  const ctx = useContext(NotebooksContext)
  if (!ctx) throw new Error('useNotebooks must be used within NotebooksProvider')
  return ctx
}
