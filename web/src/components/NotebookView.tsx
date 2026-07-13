import { useCallback, useEffect, useRef, useState } from 'react'
import type { KernelStatus } from '@claudette/shared'
import { useNotebooks } from '../store/notebooks'
import { api } from '../api/client'
import { Cell } from './notebook/Cell'

const STATUS_DOT: Record<KernelStatus, string> = {
  idle: 'bg-ctp-green',
  busy: 'bg-ctp-yellow animate-pulse',
  starting: 'bg-ctp-overlay animate-pulse',
  dead: 'bg-ctp-red',
}

// A pure VIEW over the server-owned notebook doc (PLAN §4). Renders the doc from
// the store, sends ops/locks/run intents, and reconciles per-cell. Trimmed vs
// ClaudeMaster's NotebookView: no kernel-spec picker / remote dir picker (the
// server picks python3; that's Phase 3), no clear/restart (no client route yet).
export function NotebookView({ notebookId }: { notebookId: string }) {
  const nb = useNotebooks()
  const doc = nb.open.find((d) => d.notebookId === notebookId)
  const locks = nb.locksFor(notebookId)
  const kernel = nb.kernelFor(notebookId)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const lastD = useRef(0)

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

  if (!doc) {
    return <div className="flex-1 flex items-center justify-center text-xs text-ctp-overlay">Loading…</div>
  }

  const { cells, path, dirty, conflict } = doc
  const name = path.split('/').pop()
  const hasCode = cells.some((c) => c.cellType === 'code' && c.source.trim())

  const runAdvance = (i: number, id: string) => {
    nb.run(notebookId, id)
    if (i < cells.length - 1) focusCell(cells[i + 1].id)
    else { nb.addCell(notebookId, 'code', id); /* new cell arrives via update */ }
  }

  const lockOf = (cellId: string) => locks.find((l) => l.cellId === cellId)

  // Command-mode keys (active when the list, not an editor, has focus).
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('.cm-editor')) return
    if (!selectedId) return
    const idx = cells.findIndex((c) => c.id === selectedId)
    if (idx < 0) return
    const select = (j: number) => { const c = cells[j]; if (c) setSelectedId(c.id) }
    switch (e.key) {
      case 'ArrowDown': case 'j': e.preventDefault(); select(idx + 1); break
      case 'ArrowUp': case 'k': e.preventDefault(); select(idx - 1); break
      case 'Enter': e.preventDefault(); focusCell(selectedId); break
      case 'a': e.preventDefault(); nb.insertCell(notebookId, idx, 'code'); break
      case 'b': e.preventDefault(); nb.insertCell(notebookId, idx + 1, 'code'); break
      case 'm': e.preventDefault(); nb.setCellType(notebookId, selectedId, 'markdown'); break
      case 'y': e.preventDefault(); nb.setCellType(notebookId, selectedId, 'code'); break
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
    <div className="flex flex-col h-full bg-ctp-base overflow-hidden">
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[kernel]}`} title={`kernel: ${kernel}`} />
        <span className="text-xs text-ctp-text truncate" title={path}>
          {name}{dirty && <span className="text-ctp-yellow" title="Unsaved changes"> ●</span>}
        </span>
        <span className="text-[10px] text-ctp-overlay shrink-0">{kernel}</span>
        <div className="flex-1" />
        <button onClick={() => nb.runAll(notebookId)} disabled={!hasCode} title="Run all cells" className="text-xs text-ctp-green hover:text-ctp-text hover:bg-ctp-surface0 px-1.5 py-0.5 rounded transition-colors disabled:opacity-40 disabled:hover:bg-transparent">
          ▶ run all
        </button>
        <button onClick={() => nb.addCell(notebookId, 'code', selectedId ?? undefined)} title="Add code cell" className="text-xs text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface0 px-1.5 py-0.5 rounded transition-colors">
          + code
        </button>
        <button onClick={() => nb.addCell(notebookId, 'markdown', selectedId ?? undefined)} title="Add markdown cell" className="text-xs text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface0 px-1.5 py-0.5 rounded transition-colors">
          + md
        </button>
        <button onClick={() => nb.save(notebookId)} disabled={!dirty} title="Save (Ctrl/Cmd+S)" className="text-xs px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-text hover:bg-ctp-surface1 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
          Save
        </button>
      </div>

      {/* Conflict banner */}
      {conflict && (
        <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 bg-ctp-yellow/15 border-b border-ctp-yellow/40 text-xs text-ctp-yellow">
          <span className="flex-1">This notebook changed on disk while you have unsaved edits.</span>
          <button onClick={() => nb.reload(notebookId)} className="px-1.5 py-0.5 rounded hover:bg-ctp-yellow/20 transition-colors" title="Discard your edits and load the on-disk version">
            Reload from disk
          </button>
          <button onClick={() => nb.keepMine(notebookId)} className="px-1.5 py-0.5 rounded hover:bg-ctp-yellow/20 transition-colors" title="Keep your edits; overwrite disk">
            Keep mine
          </button>
        </div>
      )}

      {/* Cells */}
      <div ref={listRef} tabIndex={-1} onKeyDown={onListKeyDown} className="flex-1 overflow-y-auto px-3 py-3 space-y-4 outline-none">
        {cells.map((cell, i) => {
          const lock = lockOf(cell.id)
          const pinned = lock?.reason === 'pin'
          return (
            <Cell
              key={cell.id}
              cell={cell}
              index={i}
              selected={selectedId === cell.id}
              running={nb.isRunning(notebookId, cell.id)}
              locked={!!lock}
              pinned={pinned}
              onSelect={() => setSelectedId(cell.id)}
              onCodeChange={(code) => nb.updateSource(notebookId, cell.id, code)}
              onEditorFocus={() => { if (!pinned) nb.claim(notebookId, cell.id, 'focus') }}
              onEditorBlur={() => { if (!pinned) nb.release(notebookId, cell.id) }}
              onTogglePin={() => pinned ? nb.release(notebookId, cell.id) : nb.claim(notebookId, cell.id, 'pin')}
              onRun={() => nb.run(notebookId, cell.id)}
              onRunAdvance={() => runAdvance(i, cell.id)}
              onEscape={() => { setSelectedId(cell.id); listRef.current?.focus() }}
              onInsertBelow={() => { nb.run(notebookId, cell.id); nb.addCell(notebookId, 'code', cell.id) }}
              onMoveUp={() => nb.moveCell(notebookId, cell.id, i - 1)}
              onMoveDown={() => nb.moveCell(notebookId, cell.id, i + 1)}
              onToggleType={() => nb.setCellType(notebookId, cell.id, cell.cellType === 'code' ? 'markdown' : 'code')}
              onRemove={() => nb.deleteCell(notebookId, cell.id)}
              onReorder={(from) => { const src = cells[from]; if (src) nb.moveCell(notebookId, src.id, i) }}
            />
          )
        })}
      </div>
    </div>
  )
}
