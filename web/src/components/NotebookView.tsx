import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorView } from '@codemirror/view'
import type { KernelStatus, KernelSpec, NbCellType } from '@claudette/shared'
import { useNotebooks } from '../store/notebooks'
import { api } from '../api/client'
import { setCellMatches, type CellMatch } from '../lib/cellSearch'
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

// A cell copied/cut in command mode — module-level so it survives cell re-renders,
// notebook switches, and even copying between notebooks (classic Jupyter behavior).
let cellClipboard: { cellType: NbCellType; source: string } | null = null

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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Markdown cells being edited (all others show their rendered output) and the set
  // of collapsed heading cells. Both are ephemeral view state, reset per notebook.
  const [mdEditing, setMdEditing] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
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
      setSelectedId(cellId)
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
  // with its offset range within the cell source.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [] as { cellId: string; from: number; to: number }[]
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
  useEffect(() => {
    const views = cellViews.current
    const active = matches.length ? matches[Math.min(matchIdx, matches.length - 1)] : null
    // Never let a match hide inside a collapsed section — reveal it, then the effect
    // re-runs against the now-visible cells.
    if (findOpen && active && hidden.has(active.cellId)) { setCollapsed(new Set()); return }
    const byCell = new Map<string, CellMatch[]>()
    if (findOpen) for (const m of matches) {
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
    if (findOpen && active) {
      setSelectedId(active.cellId)
      // Scroll the exact active-match span into view after CM paints it (cells grow
      // to fit, so it's the notebook list that scrolls). Falls back to the cell.
      requestAnimationFrame(() => {
        const el = document.querySelector('.cm-nb-match-active')
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        else revealCell(active.cellId)
      })
    }
  }, [findOpen, matches, matchIdx, revealCell, hidden])

  const stepMatch = (dir: 1 | -1) => {
    if (matches.length === 0) return
    setMatchIdx((i) => (i + dir + matches.length) % matches.length)
  }

  if (!doc) {
    return <div className="flex-1 flex items-center justify-center text-xs text-ctp-overlay">Loading…</div>
  }

  const { path, dirty, conflict, canUndo, canRedo, kernelName } = doc
  const name = path.split('/').pop()
  const hasCode = cells.some((c) => c.cellType === 'code' && c.source.trim())
  const hasOutputs = cells.some((c) => (c.outputs?.length ?? 0) > 0)
  const kernelLabel = specs?.find((s) => s.name === kernelName)?.displayName ?? kernelName ?? 'Python 3'

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

  const openKernelMenu = () => {
    setKernelMenu(true)
    if (!specs) nb.kernelSpecs().then((r) => setSpecs(r.specs)).catch(() => setSpecs([]))
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
    // Step to the next/prev cell that isn't folded away under a collapsed heading.
    const step = (dir: 1 | -1) => {
      let j = idx + dir
      while (cells[j] && hidden.has(cells[j].id)) j += dir
      if (cells[j]) setSelectedId(cells[j].id)
    }
    switch (e.key) {
      case 'ArrowDown': case 'j': e.preventDefault(); step(1); break
      case 'ArrowUp': case 'k': e.preventDefault(); step(-1); break
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
      case 'm': e.preventDefault(); nb.setCellType(notebookId, selectedId, 'markdown'); break
      case 'y': e.preventDefault(); nb.setCellType(notebookId, selectedId, 'code'); break
      case 'c': e.preventDefault(); cellClipboard = { cellType: sel.cellType, source: sel.source }; break
      case 'x':
        e.preventDefault()
        cellClipboard = { cellType: sel.cellType, source: sel.source }
        nb.deleteCell(notebookId, selectedId)
        setSelectedId((cells[idx + 1] ?? cells[idx - 1])?.id ?? null)
        break
      case 'v':
        e.preventDefault()
        if (cellClipboard) nb.addCell(notebookId, cellClipboard.cellType, selectedId, cellClipboard.source)
        break
      case '?': e.preventDefault(); setHelpOpen(true); break
      case 'd': {
        e.preventDefault()
        const now = Date.now()
        if (now - lastD.current < 500) {
          lastD.current = 0
          nb.deleteCell(notebookId, selectedId)
          const next = cells[idx + 1] ?? cells[idx - 1]
          setSelectedId(next ? next.id : null)
        } else { lastD.current = now }
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
                {specs === null && <div className="px-2.5 py-1 text-ctp-overlay">Loading…</div>}
                {specs?.length === 0 && <div className="px-2.5 py-1 text-ctp-overlay">No kernels found</div>}
                {specs?.map((s) => (
                  <button key={s.name} onClick={() => { nb.setKernelSpec(notebookId, s.name); setKernelMenu(false) }}
                    className={`w-full text-left px-2.5 py-1.5 hover:bg-ctp-surface0 flex items-center gap-2 ${s.name === kernelName ? 'text-ctp-accent' : 'text-ctp-text'}`}>
                    <span className="flex-1 truncate">{s.displayName}</span>
                    {s.name === kernelName && <span>✓</span>}
                  </button>
                ))}
                <div className="my-1 border-t border-ctp-surface0" />
                <button onClick={() => { nb.restartKernel(notebookId); setKernelMenu(false) }} disabled={kernel === 'none'}
                  className="w-full text-left px-2.5 py-1.5 hover:bg-ctp-surface0 disabled:opacity-40 text-ctp-text">↻ Restart kernel</button>
                <button onClick={() => { nb.interruptKernel(notebookId); setKernelMenu(false) }} disabled={kernel !== 'busy'}
                  className="w-full text-left px-2.5 py-1.5 hover:bg-ctp-surface0 disabled:opacity-40 text-ctp-text">■ Interrupt</button>
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
          const selectNextVisible = () => { let j = i + 1; while (cells[j] && hidden.has(cells[j].id)) j++; if (cells[j]) { setSelectedId(cells[j].id); listRef.current?.focus() } }
          return (
            <Cell
              key={cell.id}
              cell={cell}
              index={i}
              selected={selectedId === cell.id}
              running={nb.isRunning(notebookId, cell.id)}
              locked={!!lock}
              pinned={pinned}
              rendered={rendered}
              collapsible={(headingLevel.get(cell.id) ?? 0) > 0}
              collapsed={collapsed.has(cell.id)}
              hiddenCount={foldCount[cell.id] ?? 0}
              onBeginEdit={() => { beginEdit(cell.id); setSelectedId(cell.id); focusCell(cell.id) }}
              onToggleCollapse={() => toggleCollapse(cell.id)}
              onSelect={() => setSelectedId(cell.id)}
              onCodeChange={(code) => nb.updateSource(notebookId, cell.id, code)}
              onEditorFocus={() => { if (!pinned) nb.claim(notebookId, cell.id, 'focus') }}
              onEditorBlur={() => { if (isMd) endEdit(cell.id); if (!pinned) nb.release(notebookId, cell.id) }}
              onTogglePin={() => pinned ? nb.release(notebookId, cell.id) : nb.claim(notebookId, cell.id, 'pin')}
              // Markdown "run" = render (the editor blur already did that); code runs.
              onRun={() => { if (!isMd) nb.run(notebookId, cell.id) }}
              onRunAdvance={() => { if (isMd) selectNextVisible(); else runAdvance(i, cell.id) }}
              onEscape={() => { setSelectedId(cell.id); listRef.current?.focus() }}
              onInsertBelow={() => { nb.run(notebookId, cell.id); nb.addCell(notebookId, 'code', cell.id) }}
              onMoveUp={() => nb.moveCell(notebookId, cell.id, i - 1)}
              onMoveDown={() => nb.moveCell(notebookId, cell.id, i + 1)}
              onToggleType={() => nb.setCellType(notebookId, cell.id, cell.cellType === 'code' ? 'markdown' : 'code')}
              onRemove={() => nb.deleteCell(notebookId, cell.id)}
              onDuplicate={() => duplicate(cell.id)}
              onReorder={(from) => { const src = cells[from]; if (src) nb.moveCell(notebookId, src.id, i) }}
              registerView={registerCellView}
            />
          )
        })}
      </div>

      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
    </div>
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

// Keyboard shortcut reference overlay.
function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Ctrl/Cmd + S', 'Save notebook'],
    ['Ctrl/Cmd + F', 'Find in notebook'],
    ['Ctrl/Cmd + Z', 'Undo  ·  Ctrl/Cmd + Shift + Z: Redo'],
    ['↑ / ↓  or  j / k', 'Select previous / next cell'],
    ['Enter', 'Edit cell (markdown → editor); Esc back to command mode; dbl-click edits'],
    ['Space', 'Collapse / expand a markdown heading section'],
    ['a  /  b', 'Insert cell above / below'],
    ['m  /  y', 'To markdown / to code'],
    ['c  /  x  /  v', 'Copy / cut / paste cell'],
    ['d d', 'Delete selected cell'],
    ['Shift + Enter', 'Run cell, select next'],
    ['Ctrl/Cmd + Enter', 'Run cell in place'],
    ['Alt + Enter', 'Run cell, insert below'],
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
