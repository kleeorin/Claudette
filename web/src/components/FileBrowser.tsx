import { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api/client'
import { crumbs, joinPath, isNotebookPath } from '../lib/paths'
import type { DirEntry } from '@claudette/shared'

// A navigable file/folder picker, used in two modes:
//   • 'folder'   — choose a directory (e.g. a session's working dir). Files hidden.
//   • 'notebook' — choose an existing .ipynb OR name a new one to create. Non-.ipynb
//                  files show but are not selectable.
// Read-only browsing over GET /api/fs/list; the caller acts on the picked path.
interface Props {
  mode: 'folder' | 'notebook'
  initialPath: string
  onPick: (path: string, create?: boolean) => void
  onClose: () => void
  error?: string | null   // an open/create failure from the caller, shown in the footer
}

export function FileBrowser({ mode, initialPath, onPick, onClose, error }: Props) {
  const [dir, setDir] = useState(initialPath)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)  // notebook mode: chosen file
  const [newName, setNewName] = useState('')                     // notebook mode: create-new

  const load = useCallback(async (path?: string) => {
    setLoading(true); setErr(null); setSelected(null)
    const res = await api.fs.list(path)
    if ('error' in res && res.error) { setErr(res.error); setLoading(false); return }
    if (!('error' in res)) { setDir(res.path); setEntries(res.entries) }
    setLoading(false)
  }, [])

  useEffect(() => { void load(initialPath) }, [initialPath, load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const visible = entries
    .filter((e) => showHidden || !e.name.startsWith('.'))
    .filter((e) => mode === 'notebook' || e.isDir)  // folder mode: dirs only

  const isNotebook = (e: DirEntry) => !e.isDir && isNotebookPath(e.name)

  const clickEntry = (e: DirEntry) => {
    if (e.isDir) { setSelected(null); void load(joinPath(dir, e.name)) }
    else if (mode === 'notebook' && isNotebook(e)) setSelected(joinPath(dir, e.name))
  }

  const createNew = () => {
    const n = newName.trim()
    if (!n) return
    onPick(joinPath(dir, n.endsWith('.ipynb') ? n : `${n}.ipynb`), true)
  }

  // Portal to <body>: this browser is often opened from inside the sidebar/dialog
  // subtree, and a transformed ancestor (the aside's drawer transform) would make
  // `position: fixed` resolve against that 288px box and clip the modal.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div
        className="w-[560px] max-w-[calc(100vw-2rem)] h-[560px] max-h-[calc(100vh-3rem)] flex flex-col rounded-xl border border-ctp-surface1 bg-ctp-mantle shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 h-12 border-b border-ctp-surface0 shrink-0">
          <span className="text-sm font-semibold text-ctp-text">
            {mode === 'folder' ? 'Choose a folder' : 'Open notebook'}
          </span>
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-ctp-overlay cursor-pointer select-none">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-ctp-accent" />
            Hidden
          </label>
          <button onClick={onClose} className="text-ctp-overlay hover:text-ctp-text text-sm">✕</button>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-0.5 px-4 py-2 border-b border-ctp-surface0 shrink-0 overflow-x-auto text-[12px]">
          {crumbs(dir).map((c, i) => (
            <span key={c.path} className="flex items-center shrink-0">
              {i > 0 && <span className="text-ctp-surface2 px-0.5">/</span>}
              <button
                onClick={() => void load(c.path)}
                className="px-1 rounded hover:bg-ctp-surface0 text-ctp-subtext hover:text-ctp-text font-mono max-w-[140px] truncate"
                title={c.path}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>

        {/* Listing */}
        <div className="flex-1 min-h-0 overflow-y-auto py-1">
          {loading && <div className="px-5 py-3 text-[12px] text-ctp-overlay">Loading…</div>}
          {err && <div className="px-5 py-3 text-[12px] text-ctp-red">{err}</div>}
          {!loading && !err && visible.length === 0 && (
            <div className="px-5 py-3 text-[12px] text-ctp-overlay">Empty folder.</div>
          )}
          {!loading && !err && visible.map((e) => {
            const selectable = e.isDir || (mode === 'notebook' && isNotebook(e))
            const isSel = selected === joinPath(dir, e.name)
            return (
              <button
                key={e.name}
                onClick={() => clickEntry(e)}
                onDoubleClick={() => { if (mode === 'notebook' && isNotebook(e)) onPick(joinPath(dir, e.name), false) }}
                disabled={!selectable}
                className={`w-full flex items-center gap-2.5 px-5 py-1.5 text-left text-[13px] transition-colors ${
                  isSel ? 'bg-ctp-accent/20 text-ctp-text' : selectable ? 'hover:bg-ctp-surface0 text-ctp-subtext' : 'text-ctp-surface2 cursor-default'
                }`}
              >
                <span className="shrink-0 w-4 text-center">{e.isDir ? '📁' : isNotebook(e) ? '📓' : '📄'}</span>
                <span className="truncate font-mono">{e.name}</span>
                {e.isDir && <span className="ml-auto text-ctp-surface2 text-xs">›</span>}
              </button>
            )
          })}
        </div>

        {/* Footer — action differs by mode */}
        <div className="border-t border-ctp-surface0 shrink-0">
          {error && <div className="px-5 pt-2.5 text-[11px] text-ctp-red">{error}</div>}
          {mode === 'notebook' && (
            <div className="flex items-center gap-2 px-5 pt-3">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createNew() } }}
                placeholder="new-notebook.ipynb"
                className="modal-input font-mono text-[12px] flex-1"
              />
              <button
                onClick={createNew}
                disabled={!newName.trim()}
                className="text-xs px-3.5 py-1.5 rounded-md text-ctp-subtext hover:bg-ctp-surface0 disabled:opacity-40 transition-colors whitespace-nowrap"
                title="Create a new notebook here"
              >
                Create here
              </button>
            </div>
          )}
          <div className="flex items-center gap-2 px-5 py-3.5">
            <span className="text-[11px] text-ctp-overlay font-mono truncate flex-1" title={mode === 'folder' ? dir : selected ?? dir}>
              {mode === 'folder' ? dir : selected ?? '—'}
            </span>
            <button onClick={onClose} className="text-xs px-3.5 py-1.5 rounded-md text-ctp-subtext hover:bg-ctp-surface0 transition-colors">
              Cancel
            </button>
            <button
              onClick={() => (mode === 'folder' ? onPick(dir, false) : selected && onPick(selected, false))}
              disabled={mode === 'notebook' && !selected}
              className="text-xs font-medium px-4 py-1.5 rounded-md bg-ctp-accent text-ctp-base hover:brightness-110 active:brightness-95 disabled:opacity-40 transition"
            >
              {mode === 'folder' ? 'Use this folder' : 'Open'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
