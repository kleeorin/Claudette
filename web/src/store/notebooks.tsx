import {
  createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode,
} from 'react'
import type { NotebookDoc, CellLock, LockReason, KernelStatus, NbCellType } from '@claudette/shared'
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
  activeId: string | null
  active: NotebookDoc | null
  setActive: (id: string | null) => void
  openPath: (path: string) => Promise<string | null>   // returns error string or null
  createPath: (path: string) => Promise<string | null>
  close: (notebookId: string) => void
  // per-notebook view state
  locksFor: (notebookId: string) => CellLock[]
  kernelFor: (notebookId: string) => KernelStatus
  isRunning: (notebookId: string, cellId: string) => boolean
  // mutations (intents → server)
  updateSource: (notebookId: string, cellId: string, source: string) => void
  addCell: (notebookId: string, cellType: NbCellType, afterCellId?: string) => void
  insertCell: (notebookId: string, index: number, cellType: NbCellType) => void
  deleteCell: (notebookId: string, cellId: string) => void
  moveCell: (notebookId: string, cellId: string, toIndex: number) => void
  setCellType: (notebookId: string, cellId: string, cellType: NbCellType) => void
  run: (notebookId: string, cellId: string) => void
  runAll: (notebookId: string) => void
  save: (notebookId: string) => void
  reload: (notebookId: string) => void
  keepMine: (notebookId: string) => void
  claim: (notebookId: string, cellId: string, reason: LockReason) => void
  release: (notebookId: string, cellId: string) => void
}

const NotebooksContext = createContext<ContextValue | null>(null)

export function NotebooksProvider({ children }: { children: ReactNode }) {
  const [docs, setDocs] = useState<Record<string, NotebookDoc>>({})
  const [order, setOrder] = useState<string[]>([])
  const [locks, setLocks] = useState<Record<string, CellLock[]>>({})
  const [kernels, setKernels] = useState<Record<string, KernelStatus>>({})
  const [running, setRunning] = useState<Record<string, Set<string>>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeRef = useRef<string | null>(null); activeRef.current = activeId
  const kernelRef = useRef<Record<string, KernelStatus>>({}); kernelRef.current = kernels

  useEffect(() => {
    const offUpd = api.on.notebookUpdate((doc) => {
      setDocs((prev) => ({ ...prev, [doc.notebookId]: doc }))
      setOrder((prev) => prev.includes(doc.notebookId) ? prev : [...prev, doc.notebookId])
      // First doc we see becomes active if nothing is.
      if (!activeRef.current) setActiveId(doc.notebookId)
    })
    const offLocks = api.on.notebookLocks((notebookId, l) =>
      setLocks((prev) => ({ ...prev, [notebookId]: l })))
    const offKernel = api.on.notebookKernel((notebookId, status) => {
      // Clear the optimistic per-cell running set on the busy→idle transition (a run
      // finished). Coarser for run-all (all clear at the final idle) — acceptable.
      if (status === 'idle' && kernelRef.current[notebookId] === 'busy') {
        setRunning((prev) => ({ ...prev, [notebookId]: new Set() }))
      }
      setKernels((prev) => ({ ...prev, [notebookId]: status }))
    })
    return () => { offUpd(); offLocks(); offKernel() }
  }, [])

  const openPath = useCallback(async (path: string): Promise<string | null> => {
    const res = await api.notebook.open(path)
    if (res.error || !res.doc) return res.error ?? 'failed to open notebook'
    const doc = res.doc
    setDocs((prev) => ({ ...prev, [doc.notebookId]: doc }))
    setOrder((prev) => prev.includes(doc.notebookId) ? prev : [...prev, doc.notebookId])
    setActiveId(doc.notebookId)
    return null
  }, [])

  const createPath = useCallback(async (path: string): Promise<string | null> => {
    const res = await api.notebook.create(path)
    if (res.error || !res.doc) return res.error ?? 'failed to create notebook'
    const doc = res.doc
    setDocs((prev) => ({ ...prev, [doc.notebookId]: doc }))
    setOrder((prev) => prev.includes(doc.notebookId) ? prev : [...prev, doc.notebookId])
    setActiveId(doc.notebookId)
    return null
  }, [])

  const close = useCallback((notebookId: string) => {
    setOrder((prev) => {
      const next = prev.filter((id) => id !== notebookId)
      if (activeRef.current === notebookId) setActiveId(next[next.length - 1] ?? null)
      return next
    })
    setDocs((prev) => { const { [notebookId]: _drop, ...rest } = prev; return rest })
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

  const runAll = useCallback((notebookId: string, doc?: NotebookDoc) => {
    setDocs((prev) => {
      const d = prev[notebookId]
      if (d) markRunning(notebookId, d.cells.filter((c) => c.cellType === 'code').map((c) => c.id))
      return prev
    })
    api.notebook.op({ op: 'runAll', notebookId })
  }, [markRunning])

  const value: ContextValue = {
    open: order.map((id) => docs[id]).filter(Boolean),
    activeId,
    active: activeId ? docs[activeId] ?? null : null,
    setActive: setActiveId,
    openPath, createPath, close,
    locksFor: (id) => locks[id] ?? [],
    kernelFor: (id) => kernels[id] ?? 'idle',
    isRunning: (id, cellId) => running[id]?.has(cellId) ?? false,
    updateSource: (notebookId, cellId, source) => api.notebook.op({ op: 'editCell', notebookId, cellId, source }),
    addCell: (notebookId, cellType, afterCellId) => api.notebook.op({ op: 'addCell', notebookId, cellType, afterCellId }),
    insertCell: (notebookId, index, cellType) => api.notebook.op({ op: 'insertCell', notebookId, index, cellType }),
    deleteCell: (notebookId, cellId) => api.notebook.op({ op: 'deleteCell', notebookId, cellId }),
    moveCell: (notebookId, cellId, toIndex) => api.notebook.op({ op: 'moveCell', notebookId, cellId, toIndex }),
    setCellType: (notebookId, cellId, cellType) => api.notebook.op({ op: 'setCellType', notebookId, cellId, cellType }),
    run,
    runAll: (notebookId) => runAll(notebookId),
    save: (notebookId) => { void api.notebook.save(notebookId) },
    reload: (notebookId) => { void api.notebook.reload(notebookId) },
    keepMine: (notebookId) => { void api.notebook.keepMine(notebookId) },
    claim: (notebookId, cellId, reason) => api.notebook.claim(notebookId, cellId, reason),
    release: (notebookId, cellId) => api.notebook.release(notebookId, cellId),
  }

  return <NotebooksContext.Provider value={value}>{children}</NotebooksContext.Provider>
}

export function useNotebooks(): ContextValue {
  const ctx = useContext(NotebooksContext)
  if (!ctx) throw new Error('useNotebooks must be used within NotebooksProvider')
  return ctx
}
