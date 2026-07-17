import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorView } from '@codemirror/view'
import type { KernelStatus, KernelSpec, NbCellType } from '@claudette/shared'
import { useNotebooks } from '../store/notebooks'
import { api } from '../api/client'
import { setCellMatches, type CellMatch } from '../lib/cellSearch'
import { basename } from '../lib/paths'
import { Cell } from './notebook/Cell'

const STATUS_DOT: Record<KernelStatus, string> = {
  none: 'bg-ctp-surface2',
  idle: 'bg-ctp-green',
  busy: 'bg-ctp-yellow animate-pulse',
  starting: 'bg-ctp-overlay animate-pulse',
  dead: 'bg-ctp-red',
}
const STATUS_LABEL: Record<KernelStatus, string> = {
  none: 'no kernel', idle: 'idle', busy: 'busy', starting: 'starting…', dead: 'dead',
}

// Stable empty search-match list — shared so the find memo keeps a constant
// identity when there's no query (see `matches` below).
const NO_MATCHES: { cellId: string; from: number; to: number }[] = []

// Cells copied/cut in command mode — module-level so they survive cell re-renders,
// notebook switches, and even copying between notebooks (classic Jupyter behavior).
// An ARRAY so a multi-cell selection round-trips through copy/cut → paste.
let cellClipboard: { cellType: NbCellType; source: string }[] | null = null

// Rank of a markdown cell used as a section header: the `#` count of its first
// non-empty line (1..6), or 0 if it isn't a markdown ATX heading.
function headingLevelOf(cellType: NbCellType, source: string): number {
  if (cellType !== 'markdown') return 0
  const line = source.split('\n').find((l) => l.trim() !== '')
  const m = line ? /^(#{1,6})\s/.exec(line.trimStart()) : null
  return m ? m[1].length : 0
}

// A pure VIEW over the server-owned notebook doc (PLAN §4). Renders the doc from
// the store, sends ops/locks/run intents, and reconciles per-cell. Toolbar adds
// undo/redo, clear-outputs, a kernel picker + restart/interrupt with an accurate
// status, cross-cell search (Ctrl+F), and a shortcut help overlay (?).
export function NotebookView({ notebookId }: { notebookId: string }) {
  const nb = useNotebooks()
  const doc = nb.open.find((d) => d.notebookId === notebookId)
  const locks = nb.locksFor(notebookId)
  const kernel = nb.kernelFor(notebookId)
  // `selectedId` is the LEAD (active) cell — used for editing, run-advance, insert
  // targets. `selected` is the full multi-cell selection (always contains the lead
  // when non-empty); `anchorRef` is the fixed end of a Shift+J/K range.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchorRef = useRef<string | null>(null)
  // Markdown cells being edited (all others show their rendered output) and the set
  // of collapsed heading cells. Both are ephemeral view state, reset per notebook.
  const [mdEditing, setMdEditing] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // The open cell context menu (right-click / the ⋯ button): which cell + where.
  const [cellMenu, setCellMenu] = useState<{ cellId: string; x: number; y: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const lastD = useRef(0)

  const beginEdit = useCallback((id: string) => {
    setMdEditing((prev) => { const n = new Set(prev); n.add(id); return n })
  }, [])
  const endEdit = useCallback((id: string) => {
    setMdEditing((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n })
  }, [])
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])

  // Toolbar/overlay UI state.
  const [kernelMenu, setKernelMenu] = useState(false)
  const [specs, setSpecs] = useState<KernelSpec[] | null>(null)
  // Jupyter's default kernelspec name, so the header can name the kernel that WILL
  // launch before one is running (kernelName is only set once a kernel starts).
  const [specDefault, setSpecDefault] = useState<string | null>(null)
  // Distinguishes "haven't fetched yet" (specs === null, no error) from "fetch
  // failed" — the latter offers a retry instead of silently showing "no kernels".
  const [specsError, setSpecsError] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchIdx, setMatchIdx] = useState(0)
  const findInputRef = useRef<HTMLInputElement>(null)
  // Registry of each cell's CodeMirror view, so the find bar can highlight matches
  // and scroll to the exact occurrence inside a cell.
  const cellViews = useRef(new Map<string, EditorView>())
  const registerCellView = useCallback((id: string, view: EditorView | null) => {
    if (view) cellViews.current.set(id, view)
    else cellViews.current.delete(id)
  }, [])

  const focusCell = useCallback((id: string, retry = true) => {
    const el = document.querySelector(`[data-cell-id="${id}"] .cm-content`) as HTMLElement | null
    if (el) el.focus()
    else if (retry) requestAnimationFrame(() => focusCell(id, false))
  }, [])

  // Scroll a cell into view WITHOUT stealing keyboard focus — used to reveal the
  // cell a just-applied op touched (a fresh cell may not be in the DOM yet, so retry
  // once on the next frame).
  const revealCell = useCallback((id: string, retry = true) => {
    const el = document.querySelector(`[data-cell-id="${id}"]`) as HTMLElement | null
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    else if (retry) requestAnimationFrame(() => revealCell(id, false))
  }, [])

  // When an op touches a cell (Claude's edit, or a structural change), select it and
  // — for `reveal` ops — scroll it into view. A plain human text edit (typing/undo)
  // only re-selects, so it never yanks the scroll while the user is in the cell.
  useEffect(() => {
    return api.on.notebookFocus((nid, cellId, reveal) => {
      if (nid !== notebookId) return
      // An op touched this cell → make it the sole selection (collapse any range).
      setSelectedId(cellId)
      setSelected(new Set([cellId]))
      anchorRef.current = cellId
      if (reveal) revealCell(cellId)
    })
  }, [notebookId, revealCell])

  // Ctrl/Cmd+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); nb.save(notebookId) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Focus the find field when the bar opens.
  useEffect(() => { if (findOpen) findInputRef.current?.focus() }, [findOpen])

  const cells = doc?.cells ?? []

  // If the selected cell disappears (a Claude/hover-trash delete, or an external disk
  // reload that re-mints ids), drop the dangling selection so we don't keep a ring and
  // stale command-mode handlers pointed at a cell that no longer exists.
  useEffect(() => {
    if (selectedId && !cells.some((c) => c.id === selectedId)) setSelectedId(null)
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((id) => cells.some((c) => c.id === id)))
      return next.size === prev.size ? prev : next
    })
  }, [cells, selectedId])

  // --- selection helpers -----------------------------------------------------
  // The selection in document order (falls back to the lead cell). Bulk ops use this.
  const selectedInOrder = () => {
    const ids = cells.filter((c) => selected.has(c.id)).map((c) => c.id)
    return ids.length ? ids : selectedId ? [selectedId] : []
  }
  // Single-select a cell (collapses any range and re-seats the range anchor).
  const selectOnly = (id: string) => { setSelectedId(id); setSelected(new Set([id])); anchorRef.current = id }
  // Shift+J/K: grow/shrink a contiguous range between the anchor and `id`.
  const extendTo = (id: string) => {
    const a = anchorRef.current ?? selectedId ?? id
    const ai = cells.findIndex((c) => c.id === a)
    const ti = cells.findIndex((c) => c.id === id)
    if (ai < 0 || ti < 0) { selectOnly(id); return }
    const [lo, hi] = ai <= ti ? [ai, ti] : [ti, ai]
    setSelected(new Set(cells.slice(lo, hi + 1).map((c) => c.id)))
    setSelectedId(id)
  }

  // Heading-based folding (Jupyter-style). A markdown cell whose first non-empty
  // line is an ATX heading (`#`..`######`) is a section header; collapsing it folds
  // every following cell until the next heading of the SAME or HIGHER rank (fewer
  // `#`). `hidden` = cells currently folded away; `foldCount` = how many each
  // collapsed heading hides (for its "N cells hidden" badge). Levels: 1 = most
  // senior (h1), 6 = least; 0 = not a heading.
  const { hidden, foldCount, headingLevel } = useMemo(() => {
    const level = new Map<string, number>()
    for (const c of cells) level.set(c.id, headingLevelOf(c.cellType, c.source))
    const hidden = new Set<string>()
    const foldCount: Record<string, number> = {}
    for (let i = 0; i < cells.length; i++) {
      const lvl = level.get(cells[i].id) ?? 0
      if (lvl > 0 && collapsed.has(cells[i].id)) {
        let count = 0
        for (let j = i + 1; j < cells.length; j++) {
          const jl = level.get(cells[j].id) ?? 0
          if (jl > 0 && jl <= lvl) break
          hidden.add(cells[j].id); count++
        }
        foldCount[cells[i].id] = count
      }
    }
    return { hidden, foldCount, headingLevel: level }
  }, [cells, collapsed])

  // Cross-cell search: a flat, ordered list of matches (one per occurrence), each
  // with its offset range within the cell source. Returns a stable empty array when
  // there's no query so the paint effect below doesn't re-fire on every doc change.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return NO_MATCHES
    const out: { cellId: string; from: number; to: number }[] = []
    for (const c of cells) {
      const s = c.source.toLowerCase()
      let i = s.indexOf(q)
      while (i !== -1) { out.push({ cellId: c.id, from: i, to: i + q.length }); i = s.indexOf(q, i + q.length) }
    }
    return out
  }, [cells, query])

  // Paint every match in every cell (active one distinctly) and scroll the notebook
  // to the exact current occurrence — so stepping between matches actually moves,
  // even within one cell. Offsets are clamped to each editor's live doc length in
  // case the user is typing while the find bar is open.
  const paintedRef = useRef(false)
  // The active match we last selected+scrolled to, so a doc update (streaming output)
  // that leaves the active match unchanged repaints highlights WITHOUT re-yanking the
  // scroll or reverting the user's selection.
  const activeKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const views = cellViews.current
    // Find bar closed: clear any highlights once, then stay idle — don't dispatch a
    // no-op transaction into every editor on each doc change during a streaming run.
    if (!findOpen) {
      if (paintedRef.current) {
        for (const [, view] of views) view.dispatch({ effects: setCellMatches.of({ matches: [], activeFrom: null }) })
        paintedRef.current = false
      }
      activeKeyRef.current = null
      return
    }
    const active = matches.length ? matches[Math.min(matchIdx, matches.length - 1)] : null
    // Never let a match hide inside a collapsed section — un-collapse only the
    // heading(s) whose section contains it (not every fold in the notebook), then the
    // effect re-runs against the now-visible cells.
    if (active && hidden.has(active.cellId)) {
      const targetIdx = cells.findIndex((c) => c.id === active.cellId)
      setCollapsed((prev) => {
        const next = new Set(prev)
        for (const hid of prev) {
          const hi = cells.findIndex((c) => c.id === hid)
          if (hi < 0 || hi >= targetIdx) continue
          const level = headingLevel.get(hid) ?? 0
          let end = cells.length
          for (let j = hi + 1; j < cells.length; j++) {
            const lj = headingLevel.get(cells[j].id) ?? 0
            if (lj > 0 && lj <= level) { end = j; break }
          }
          if (targetIdx < end) next.delete(hid)
        }
        return next
      })
      return
    }
    const byCell = new Map<string, CellMatch[]>()
    for (const m of matches) {
      const arr = byCell.get(m.cellId)
      if (arr) arr.push({ from: m.from, to: m.to })
      else byCell.set(m.cellId, [{ from: m.from, to: m.to }])
    }
    for (const [id, view] of views) {
      const docLen = view.state.doc.length
      const cm = (byCell.get(id) ?? []).filter((r) => r.to <= docLen)
      const activeFrom = active && active.cellId === id && active.to <= docLen ? active.from : null
      view.dispatch({ effects: setCellMatches.of({ matches: cm, activeFrom }) })
    }
    paintedRef.current = true
    // Select + scroll ONLY when the active match actually changed (navigation / new
    // query), not on every doc update — otherwise a streaming run keeps stealing the
    // scroll back to the match and reverting the user's selection.
    const activeKey = active ? `${active.cellId}:${active.from}:${active.to}` : null
    if (active && activeKey !== activeKeyRef.current) {
      // A match inside a rendered markdown cell has no editor to highlight it — flip
      // the cell into edit mode so a CodeMirror view mounts, then this effect repaints.
      const cell = cells.find((c) => c.id === active.cellId)
      if (cell?.cellType === 'markdown' && !mdEditing.has(active.cellId)) beginEdit(active.cellId)
      setSelectedId(active.cellId)
      // Scroll the exact active-match span into view after CM paints it (cells grow
      // to fit, so it's the notebook list that scrolls). Falls back to the cell.
      requestAnimationFrame(() => {
        const el = document.querySelector('.cm-nb-match-active')
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        else revealCell(active.cellId)
      })
    }
    activeKeyRef.current = activeKey
  }, [findOpen, matches, matchIdx, revealCell, hidden, cells, headingLevel, mdEditing, beginEdit])

  const stepMatch = (dir: 1 | -1) => {
    if (matches.length === 0) return
    setMatchIdx((i) => (i + dir + matches.length) % matches.length)
  }

  if (!doc) {
    return <div className="flex-1 flex items-center justify-center text-xs text-ctp-overlay">Loading…</div>
  }

  const { path, dirty, conflict, canUndo, canRedo, kernelName } = doc
  const name = basename(path)
  const hasCode = cells.some((c) => c.cellType === 'code' && c.source.trim())
  const hasOutputs = cells.some((c) => (c.outputs?.length ?? 0) > 0)
  // The kernel this notebook uses: whatever started (kernelName), else Jupyter's
  // default. Show its real display name; fall back to the raw name, then a neutral
  // placeholder — never a hardcoded guess that may not match what actually runs.
  const effectiveSpec = kernelName ?? specDefault ?? undefined
  const kernelLabel = specs?.find((s) => s.name === effectiveSpec)?.displayName ?? effectiveSpec ?? 'No kernel'

  const runAdvance = (i: number, id: string) => {
    nb.run(notebookId, id)
    if (i < cells.length - 1) focusCell(cells[i + 1].id)
    else { nb.addCell(notebookId, 'code', id); /* new cell arrives via update */ }
  }

  const lockOf = (cellId: string) => locks.find((l) => l.cellId === cellId)
  const duplicate = (cellId: string) => {
    const c = cells.find((x) => x.id === cellId)
    if (c) nb.addCell(notebookId, c.cellType, c.id, c.source)
  }
  // Split a cell into two at its editor's caret (last known position survives blur).
  const splitAtCursor = (cellId: string) => {
    const view = cellViews.current.get(cellId)
    const offset = view ? view.state.selection.main.head : 0
    nb.splitCell(notebookId, cellId, offset)
  }

  // --- bulk actions over the current selection -------------------------------
  const clipCells = (ids: string[]) =>
    ids.map((id) => cells.find((c) => c.id === id)).filter(Boolean).map((c) => ({ cellType: c!.cellType, source: c!.source }))
  const copySelection = () => { const ids = selectedInOrder(); if (ids.length) cellClipboard = clipCells(ids) }

  // --- single-cell actions (for the per-cell context menu) -------------------
  // The command-mode c/x/v keys act on the whole selection; these act on one cell,
  // so the ⋯ / right-click menu operates on exactly the cell it was opened over.
  const removeCell = (cellId: string) => {
    const i = cells.findIndex((c) => c.id === cellId)
    const neighbor = (cells[i + 1] ?? cells[i - 1])?.id
    nb.deleteCell(notebookId, cellId)
    if (neighbor) selectOnly(neighbor); else { setSelectedId(null); setSelected(new Set()) }
  }
  const copyCell = (cellId: string) => { cellClipboard = clipCells([cellId]) }
  const cutCell = (cellId: string) => { copyCell(cellId); removeCell(cellId) }
  const pasteRelative = (cellId: string, where: 'above' | 'below') => {
    if (!cellClipboard?.length) return
    const i = cells.findIndex((c) => c.id === cellId)
    if (i < 0) return
    nb.insertCells(notebookId, where === 'above' ? i : i + 1, cellClipboard)
  }
  const mergeBelow = (cellId: string) => {
    const i = cells.findIndex((c) => c.id === cellId)
    if (i >= 0 && cells[i + 1]) nb.mergeCells(notebookId, [cellId, cells[i + 1].id])
  }
  const deleteSelection = () => {
    const ids = selectedInOrder()
    if (!ids.length) return
    const first = cells.findIndex((c) => c.id === ids[0])
    const last = cells.findIndex((c) => c.id === ids[ids.length - 1])
    const neighbor = (cells[last + 1] ?? cells[first - 1])?.id ?? null
    nb.deleteCells(notebookId, ids)
    if (neighbor) selectOnly(neighbor); else { setSelectedId(null); setSelected(new Set()) }
  }
  const cutSelection = () => { copySelection(); deleteSelection() }
  const pasteClipboard = (where: 'above' | 'below') => {
    if (!cellClipboard?.length || !selectedId) return
    const i = cells.findIndex((c) => c.id === selectedId)
    if (i < 0) return
    nb.insertCells(notebookId, where === 'above' ? i : i + 1, cellClipboard)
  }
  const runSelection = () => {
    const ids = selectedInOrder().filter((id) => cells.find((c) => c.id === id)?.cellType === 'code')
    if (ids.length) nb.runMany(notebookId, ids)
  }
  const setTypeSelection = (t: NbCellType) => { for (const id of selectedInOrder()) nb.setCellType(notebookId, id, t) }
  const moveSelection = (where: 'top' | 'bottom' | 'up' | 'down') => {
    const ids = selectedInOrder()
    if (!ids.length) return
    const first = cells.findIndex((c) => c.id === ids[0])
    const last = cells.findIndex((c) => c.id === ids[ids.length - 1])
    // toIndex is a position in the cells REMAINING after the moved run is removed.
    const rest = cells.length - ids.length
    const to = where === 'top' ? 0
      : where === 'bottom' ? rest
      : where === 'up' ? Math.max(0, first - 1)
      : Math.min(rest, first + 1)   // 'down': shift the run one slot later
    nb.moveCells(notebookId, ids, to)
  }
  const mergeSelection = () => {
    const ids = selectedInOrder()
    if (ids.length >= 2) { nb.mergeCells(notebookId, ids); return }
    // A single selected cell merges with the one below it (Jupyter Shift+M).
    if (!selectedId) return
    const i = cells.findIndex((c) => c.id === selectedId)
    if (i >= 0 && cells[i + 1]) nb.mergeCells(notebookId, [selectedId, cells[i + 1].id])
  }

  // Load the available kernelspecs (+ Jupyter's default). Reset the error flag on
  // each attempt so a retry can clear a prior failure; a failure leaves specs null
  // (not []) so the menu shows a retry affordance rather than "No kernels found".
  const loadSpecs = useCallback(() => {
    setSpecsError(false)
    nb.kernelSpecs()
      .then((r) => { setSpecs(r.specs); setSpecDefault(r.default) })
      .catch(() => { setSpecs(null); setSpecsError(true) })
  }, [nb])

  // Fetch specs when the notebook opens so the header can name the real kernel
  // (not a hardcoded guess) even before anything has run.
  useEffect(() => { loadSpecs() }, [loadSpecs])

  const openKernelMenu = () => {
    setKernelMenu(true)
    if (!specs) loadSpecs()   // retry if the initial load failed or hasn't finished
  }

  // Notebook-wide keys (fire wherever focus is inside the notebook): Ctrl+F search,
  // Escape to close the find bar.
  const onNotebookKey = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); setFindOpen(true); setMatchIdx(0) }
    else if (e.key === 'Escape' && findOpen && !(e.target as HTMLElement).closest('.cm-editor')) { setFindOpen(false) }
  }

  // Command-mode keys (active when the list, not an editor, has focus).
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('.cm-editor')) return
    const mod = e.ctrlKey || e.metaKey
    // Undo/redo work with or without a selection.
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? nb.redo(notebookId) : nb.undo(notebookId); return }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); nb.redo(notebookId); return }
    if (!selectedId) return
    const idx = cells.findIndex((c) => c.id === selectedId)
    if (idx < 0) return
    const sel = cells[idx]
    // Next/prev VISIBLE cell id (skipping cells folded under a collapsed heading).
    const neighbor = (dir: 1 | -1): string | null => {
      let j = idx + dir
      while (cells[j] && hidden.has(cells[j].id)) j += dir
      return cells[j]?.id ?? null
    }
    // Plain nav single-selects; Shift+nav extends the range from the anchor.
    const nav = (dir: 1 | -1) => { const id = neighbor(dir); if (id) (e.shiftKey ? extendTo : selectOnly)(id) }

    // Alt+Arrow reorders the selection; add Shift for all-the-way top/bottom.
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      moveSelection(e.key === 'ArrowUp' ? (e.shiftKey ? 'top' : 'up') : (e.shiftKey ? 'bottom' : 'down'))
      return
    }
    // Ctrl/Cmd+Enter runs the whole selection in place.
    if (mod && e.key === 'Enter') { e.preventDefault(); runSelection(); return }

    switch (e.key) {
      case 'ArrowDown': case 'j': case 'J': e.preventDefault(); nav(1); break
      case 'ArrowUp': case 'k': case 'K': e.preventDefault(); nav(-1); break
      // Enter edits the cell: a markdown cell flips from rendered → editor, then focuses.
      case 'Enter':
        e.preventDefault()
        if (sel.cellType === 'markdown') beginEdit(selectedId)
        focusCell(selectedId)
        break
      // Space toggles a heading's fold when it's collapsible.
      case ' ':
        if (headingLevel.get(selectedId)) { e.preventDefault(); toggleCollapse(selectedId) }
        break
      case 'a': e.preventDefault(); nb.insertCell(notebookId, idx, 'code'); break
      case 'b': e.preventDefault(); nb.insertCell(notebookId, idx + 1, 'code'); break
      case 'm': e.preventDefault(); setTypeSelection('markdown'); break
      case 'y': e.preventDefault(); setTypeSelection('code'); break
      case 'M': e.preventDefault(); mergeSelection(); break        // Shift+M
      case 'c': e.preventDefault(); copySelection(); break
      case 'x': e.preventDefault(); cutSelection(); break
      case 'v': e.preventDefault(); pasteClipboard('below'); break
      case 'V': e.preventDefault(); pasteClipboard('above'); break  // Shift+V
      case 'Backspace': case 'Delete': e.preventDefault(); deleteSelection(); break
      case '?': e.preventDefault(); setHelpOpen(true); break
      case 'd': {
        e.preventDefault()
        const now = Date.now()
        if (now - lastD.current < 500) { lastD.current = 0; deleteSelection() }
        else lastD.current = now
        break
      }
    }
  }

  return (
    <div className="flex flex-col h-full bg-ctp-base overflow-hidden" onKeyDown={onNotebookKey}>
      {/* Header / toolbar */}
      <div className="h-9 shrink-0 flex items-center gap-1 px-2 bg-ctp-mantle border-b border-ctp-surface0 overflow-x-auto">
        {/* Kernel: status dot + picker + restart/interrupt */}
        <div className="relative shrink-0 flex items-center">
          <button onClick={openKernelMenu} title="Choose kernel" className="flex items-center gap-1.5 px-1.5 h-6 rounded hover:bg-ctp-surface0 transition-colors">
            <span className={`w-2 h-2 rounded-full ${STATUS_DOT[kernel]}`} />
            <span className="text-xs text-ctp-text max-w-[110px] truncate">{kernelLabel}</span>
            <span className="text-[10px] text-ctp-overlay">{STATUS_LABEL[kernel]}</span>
            <span className="text-[9px] text-ctp-overlay">▾</span>
          </button>
          {kernelMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setKernelMenu(false)} />
              <div className="absolute top-7 left-0 z-50 w-52 rounded-md border border-ctp-surface1 bg-ctp-mantle shadow-pop py-1 text-xs">
                <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-ctp-overlay">Kernel</div>
                {specs === null && !specsError && <div className="px-2.5 py-1 text-ctp-overlay">Loading…</div>}
                {specsError && (
                  <button onClick={loadSpecs} className="w-full text-left px-2.5 py-1.5 hover:bg-ctp-surface0 text-ctp-red">
                    Couldn't load kernels — retry
                  </button>
                )}
                {specs?.length === 0 && <div className="px-2.5 py-1 text-ctp-overlay">No kernels found</div>}
                {specs?.map((s) => (
                  <button key={s.name} onClick={() => { nb.setKernelSpec(notebookId, s.name); setKernelMenu(false) }}
                    className={`w-full text-left px-2.5 py-1.5 hover:bg-ctp-surface0 flex items-center gap-2 ${s.name === effectiveSpec ? 'text-ctp-accent' : 'text-ctp-text'}`}>
                    <span className="flex-1 truncate">{s.displayName}</span>
                    {s.name === effectiveSpec && <span>✓</span>}
                  </button>
                ))}
                <div className="my-1 border-t border-ctp-surface0" />
                <button onClick={() => { nb.restartKernel(notebookId); setKernelMenu(false) }} disabled={kernel === 'none'}
                  className="w-full text-left px-2.5 py-1.5 hover:bg-ctp-surface0 disabled:opacity-40 text-ctp-text">↻ Restart kernel</button>
                <button onClick={() => { nb.interruptKernel(notebookId); setKernelMenu(false) }} disabled={kernel !== 'busy'}
                  className="w-full text-left px-2.5 py-1.5 hover:bg-ctp-surface0 disabled:opacity-40 text-ctp-text">■ Interrupt</button>
                <button onClick={() => { nb.shutdownKernel(notebookId); setKernelMenu(false) }} disabled={kernel === 'none'}
                  className="w-full text-left px-2.5 py-1.5 hover:bg-ctp-surface0 disabled:opacity-40 text-ctp-red">⊗ Shut down kernel</button>
              </div>
            </>
          )}
        </div>
        {/* Quick interrupt when busy (no menu needed). */}
        {kernel === 'busy' && (
          <button onClick={() => nb.interruptKernel(notebookId)} title="Interrupt kernel" className="shrink-0 text-xs text-ctp-red hover:bg-ctp-surface0 px-1.5 h-6 rounded transition-colors">■</button>
        )}

        <span className="text-xs text-ctp-text truncate mx-1 min-w-0" title={path}>
          {name}{dirty && <span className="text-ctp-yellow" title="Unsaved changes"> ●</span>}
        </span>
        <div className="flex-1" />

        {/* Undo / redo */}
        <TB onClick={() => nb.undo(notebookId)} disabled={!canUndo} title="Undo (Ctrl+Z)">↶</TB>
        <TB onClick={() => nb.redo(notebookId)} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">↷</TB>
        <Sep />
        <TB onClick={() => nb.clearOutputs(notebookId)} disabled={!hasOutputs} title="Clear all outputs">⌫ out</TB>
        <button onClick={() => nb.runAll(notebookId)} disabled={!hasCode} title="Run all cells" className="shrink-0 text-xs text-ctp-green hover:text-ctp-text hover:bg-ctp-surface0 px-1.5 h-6 rounded transition-colors disabled:opacity-40 disabled:hover:bg-transparent">▶ run all</button>
        <TB onClick={() => nb.addCell(notebookId, 'code', selectedId ?? undefined)} title="Add code cell">+ code</TB>
        <TB onClick={() => nb.addCell(notebookId, 'markdown', selectedId ?? undefined)} title="Add markdown cell">+ md</TB>
        <Sep />
        <TB onClick={() => { setFindOpen(true); setMatchIdx(0) }} title="Find in notebook (Ctrl+F)">⌕</TB>
        <TB onClick={() => setHelpOpen(true) } title="Keyboard shortcuts (?)">?</TB>
        <button onClick={() => nb.save(notebookId)} disabled={!dirty} title="Save (Ctrl/Cmd+S)" className="shrink-0 text-xs px-2 h-6 rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">Save</button>
      </div>

      {/* Multi-select action bar — appears when a range of cells is selected. */}
      {selected.size > 1 && (
        <div className="shrink-0 flex items-center gap-1 px-3 py-1 bg-ctp-accent/10 border-b border-ctp-accent/25 text-xs overflow-x-auto">
          <span className="text-ctp-subtext shrink-0 mr-1 tabular-nums">{selected.size} selected</span>
          <SB onClick={runSelection} title="Run selected (Ctrl/Cmd+Enter)">▶ Run</SB>
          <SB onClick={copySelection} title="Copy (c)">Copy</SB>
          <SB onClick={cutSelection} title="Cut (x)">Cut</SB>
          <SB onClick={mergeSelection} title="Merge selected (Shift+M)">Merge</SB>
          <SB onClick={() => moveSelection('top')} title="Move to top (Alt+Shift+↑)">⤒ Top</SB>
          <SB onClick={() => moveSelection('bottom')} title="Move to bottom (Alt+Shift+↓)">⤓ Bottom</SB>
          <SB onClick={deleteSelection} title="Delete selected (dd)" danger>Delete</SB>
          <div className="flex-1" />
          <SB onClick={() => selectedId && selectOnly(selectedId)} title="Clear selection">Deselect</SB>
        </div>
      )}

      {/* Find bar */}
      {findOpen && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-ctp-surface0/60 border-b border-ctp-surface0">
          <span className="text-ctp-overlay text-xs">⌕</span>
          <input
            ref={findInputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setMatchIdx(0) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1) }
              else if (e.key === 'Escape') { e.preventDefault(); setFindOpen(false) }
            }}
            placeholder="Find in cells…"
            className="flex-1 bg-transparent text-xs text-ctp-text placeholder:text-ctp-overlay outline-none"
          />
          <span className="text-[11px] text-ctp-overlay tabular-nums">
            {matches.length ? `${Math.min(matchIdx, matches.length - 1) + 1}/${matches.length}` : (query ? '0/0' : '')}
          </span>
          <button onClick={() => stepMatch(-1)} disabled={!matches.length} title="Previous (Shift+Enter)" className="text-xs text-ctp-overlay hover:text-ctp-text disabled:opacity-30 px-1">↑</button>
          <button onClick={() => stepMatch(1)} disabled={!matches.length} title="Next (Enter)" className="text-xs text-ctp-overlay hover:text-ctp-text disabled:opacity-30 px-1">↓</button>
          <button onClick={() => setFindOpen(false)} title="Close (Esc)" className="text-xs text-ctp-overlay hover:text-ctp-text px-1">✕</button>
        </div>
      )}

      {/* Conflict banner */}
      {conflict && (
        <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 bg-ctp-yellow/15 border-b border-ctp-yellow/40 text-xs text-ctp-yellow">
          <span className="flex-1">This notebook changed on disk while you have unsaved edits.</span>
          <button onClick={() => nb.reload(notebookId)} className="px-1.5 py-0.5 rounded hover:bg-ctp-yellow/20 transition-colors" title="Discard your edits and load the on-disk version">Reload from disk</button>
          <button onClick={() => nb.keepMine(notebookId)} className="px-1.5 py-0.5 rounded hover:bg-ctp-yellow/20 transition-colors" title="Keep your edits; overwrite disk">Keep mine</button>
        </div>
      )}

      {/* Cells — folded cells (under a collapsed heading) are skipped, keeping each
          visible cell's ORIGINAL index for ops/drag/reorder. */}
      <div ref={listRef} tabIndex={-1} onKeyDown={onListKeyDown} className="flex-1 overflow-y-auto px-3 py-3 space-y-4 outline-none">
        {cells.map((cell, i) => {
          if (hidden.has(cell.id)) return null
          const lock = lockOf(cell.id)
          const pinned = lock?.reason === 'pin'
          const isMd = cell.cellType === 'markdown'
          const rendered = isMd && !mdEditing.has(cell.id)
          // Select the next VISIBLE cell (command mode) after a markdown Shift+Enter.
          const selectNextVisible = () => { let j = i + 1; while (cells[j] && hidden.has(cells[j].id)) j++; if (cells[j]) { selectOnly(cells[j].id); listRef.current?.focus() } }
          return (
            <Cell
              key={cell.id}
              cell={cell}
              index={i}
              selected={selected.has(cell.id) || selectedId === cell.id}
              running={nb.isRunning(notebookId, cell.id)}
              locked={!!lock}
              pinned={pinned}
              rendered={rendered}
              collapsible={(headingLevel.get(cell.id) ?? 0) > 0}
              collapsed={collapsed.has(cell.id)}
              hiddenCount={foldCount[cell.id] ?? 0}
              onBeginEdit={() => { beginEdit(cell.id); selectOnly(cell.id); focusCell(cell.id) }}
              onToggleCollapse={() => toggleCollapse(cell.id)}
              onSelect={() => selectOnly(cell.id)}
              onCodeChange={(code) => nb.updateSource(notebookId, cell.id, code)}
              onEditorFocus={() => { if (!pinned) nb.claim(notebookId, cell.id, 'focus') }}
              onEditorBlur={() => { if (isMd) endEdit(cell.id); if (!pinned) nb.release(notebookId, cell.id) }}
              onTogglePin={() => pinned ? nb.release(notebookId, cell.id) : nb.claim(notebookId, cell.id, 'pin')}
              // Markdown "run" = render (the editor blur already did that); code runs.
              onRun={() => { if (!isMd) nb.run(notebookId, cell.id) }}
              onRunAdvance={() => { if (isMd) selectNextVisible(); else runAdvance(i, cell.id) }}
              onEscape={() => { selectOnly(cell.id); listRef.current?.focus() }}
              onInsertBelow={() => { nb.run(notebookId, cell.id); nb.addCell(notebookId, 'code', cell.id) }}
              onMoveUp={() => nb.moveCell(notebookId, cell.id, i - 1)}
              onMoveDown={() => nb.moveCell(notebookId, cell.id, i + 1)}
              onToggleType={() => nb.setCellType(notebookId, cell.id, cell.cellType === 'code' ? 'markdown' : 'code')}
              onRemove={() => { const n = (cells[i + 1] ?? cells[i - 1])?.id; nb.deleteCell(notebookId, cell.id); if (n) selectOnly(n); else { setSelectedId(null); setSelected(new Set()) } }}
              onDuplicate={() => duplicate(cell.id)}
              onSplit={() => splitAtCursor(cell.id)}
              onReorder={(from) => { const src = cells[from]; if (src) nb.moveCell(notebookId, src.id, i) }}
              registerView={registerCellView}
              onMenu={(x, y) => { selectOnly(cell.id); setCellMenu({ cellId: cell.id, x, y }) }}
            />
          )
        })}
      </div>

      {cellMenu && (() => {
        const c = cells.find((x) => x.id === cellMenu.cellId)
        if (!c) return null
        const i = cells.findIndex((x) => x.id === cellMenu.cellId)
        return (
          <CellContextMenu
            x={cellMenu.x} y={cellMenu.y}
            isCode={c.cellType === 'code'}
            hasClipboard={!!cellClipboard?.length}
            canSplit={c.cellType !== 'markdown' || mdEditing.has(c.id)}
            hasBelow={i < cells.length - 1}
            onClose={() => setCellMenu(null)}
            onRun={() => nb.run(notebookId, c.id)}
            onCopy={() => copyCell(c.id)}
            onCut={() => cutCell(c.id)}
            onPasteAbove={() => pasteRelative(c.id, 'above')}
            onPasteBelow={() => pasteRelative(c.id, 'below')}
            onDuplicate={() => duplicate(c.id)}
            onConvert={() => nb.setCellType(notebookId, c.id, c.cellType === 'code' ? 'markdown' : 'code')}
            onMergeBelow={() => mergeBelow(c.id)}
            onSplit={() => splitAtCursor(c.id)}
            onMoveUp={() => nb.moveCell(notebookId, c.id, i - 1)}
            onMoveDown={() => nb.moveCell(notebookId, c.id, i + 1)}
            onDelete={() => removeCell(c.id)}
          />
        )
      })()}

      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

// Per-cell context menu (⋯ button or right-click). Portal to body so the notebook's
// scroll never clips it; closes on outside click / Escape. `Paste` only shows when
// the cell clipboard has content; `Split`/`Merge below` only when they're meaningful.
function CellContextMenu({
  x, y, isCode, hasClipboard, canSplit, hasBelow,
  onClose, onRun, onCopy, onCut, onPasteAbove, onPasteBelow, onDuplicate, onConvert, onMergeBelow, onSplit, onMoveUp, onMoveDown, onDelete,
}: {
  x: number; y: number; isCode: boolean; hasClipboard: boolean; canSplit: boolean; hasBelow: boolean
  onClose: () => void
  onRun: () => void; onCopy: () => void; onCut: () => void; onPasteAbove: () => void; onPasteBelow: () => void
  onDuplicate: () => void; onConvert: () => void; onMergeBelow: () => void; onSplit: () => void
  onMoveUp: () => void; onMoveDown: () => void; onDelete: () => void
}) {
  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey) }
  }, [onClose])
  const item = 'w-full text-left px-3 py-1.5 hover:bg-ctp-surface0 text-ctp-text flex items-center gap-2'
  const run = (fn: () => void) => () => { onClose(); fn() }
  const left = Math.min(x, window.innerWidth - 200)
  const top = Math.min(y, window.innerHeight - 340)
  return createPortal(
    <div style={{ left, top }} onClick={(e) => e.stopPropagation()} className="fixed z-[60] w-48 rounded-md border border-ctp-surface1 bg-ctp-mantle shadow-pop py-1 text-xs">
      {isCode && <><button className={item} onClick={run(onRun)}>▶ Run cell</button><div className="my-1 border-t border-ctp-surface0" /></>}
      <button className={item} onClick={run(onCopy)}>Copy</button>
      <button className={item} onClick={run(onCut)}>Cut</button>
      {hasClipboard && <button className={item} onClick={run(onPasteAbove)}>Paste above</button>}
      {hasClipboard && <button className={item} onClick={run(onPasteBelow)}>Paste below</button>}
      <button className={item} onClick={run(onDuplicate)}>Duplicate</button>
      <div className="my-1 border-t border-ctp-surface0" />
      <button className={item} onClick={run(onConvert)}>{isCode ? 'To markdown' : 'To code'}</button>
      {hasBelow && <button className={item} onClick={run(onMergeBelow)}>Merge with below</button>}
      {canSplit && <button className={item} onClick={run(onSplit)}>Split at cursor</button>}
      <button className={item} onClick={run(onMoveUp)}>Move up</button>
      <button className={item} onClick={run(onMoveDown)}>Move down</button>
      <div className="my-1 border-t border-ctp-surface0" />
      <button className={`${item} text-ctp-red hover:bg-ctp-red/15`} onClick={run(onDelete)}>Delete</button>
    </div>,
    document.body,
  )
}

// Compact toolbar button + a divider.
function TB({ children, onClick, title, disabled }: { children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className="shrink-0 text-xs text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface0 px-1.5 h-6 rounded transition-colors disabled:opacity-30 disabled:hover:bg-transparent">
      {children}
    </button>
  )
}
function Sep() { return <span className="shrink-0 w-px h-4 bg-ctp-surface1 mx-0.5" /> }

// Multi-select action-bar button.
function SB({ children, onClick, title, danger }: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean }) {
  return (
    <button onClick={onClick} title={title}
      className={`shrink-0 text-[11px] px-2 h-6 rounded transition-colors ${danger ? 'text-ctp-red hover:bg-ctp-red/15' : 'text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0'}`}>
      {children}
    </button>
  )
}

// Keyboard shortcut reference overlay.
function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Ctrl/Cmd + S', 'Save notebook'],
    ['Ctrl/Cmd + F', 'Find in notebook'],
    ['Ctrl/Cmd + Z', 'Undo  ·  Ctrl/Cmd + Shift + Z: Redo'],
    ['↑ / ↓  or  j / k', 'Select previous / next cell'],
    ['Shift + ↑/↓  or  J/K', 'Extend selection to previous / next cell'],
    ['Enter', 'Edit cell (markdown → editor); Esc back to command mode; dbl-click edits'],
    ['Space', 'Collapse / expand a markdown heading section'],
    ['a  /  b', 'Insert cell above / below'],
    ['m  /  y', 'To markdown / to code (whole selection)'],
    ['c  /  x', 'Copy / cut selection'],
    ['v  /  Shift + V', 'Paste below / above'],
    ['Shift + M', 'Merge selected cells (or with the cell below)'],
    ['d d  /  Delete', 'Delete selection'],
    ['Alt + ↑/↓', 'Move selection up / down'],
    ['Alt + Shift + ↑/↓', 'Move selection to top / bottom'],
    ['Shift + Enter', 'Run cell, select next'],
    ['Ctrl/Cmd + Enter', 'Run cell / selection in place'],
    ['Alt + Enter', 'Run cell, insert below'],
    ['✂ (cell menu)', 'Split cell at the cursor'],
    ['?', 'This help'],
  ]
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="w-[460px] max-w-[calc(100vw-2rem)] rounded-xl border border-ctp-surface1 bg-ctp-mantle shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-5 h-12 border-b border-ctp-surface0">
          <span className="text-sm font-semibold text-ctp-text">Keyboard shortcuts</span>
          <button onClick={onClose} className="ml-auto text-ctp-overlay hover:text-ctp-text text-sm">✕</button>
        </div>
        <div className="p-4 grid gap-1.5 max-h-[70vh] overflow-y-auto">
          {rows.map(([k, d]) => (
            <div key={k} className="flex items-baseline gap-3 text-xs">
              <kbd className="shrink-0 font-mono text-[11px] text-ctp-subtext bg-ctp-surface0 rounded px-1.5 py-0.5 min-w-[130px]">{k}</kbd>
              <span className="text-ctp-subtext">{d}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
