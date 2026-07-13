import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type { DirEntry } from '@claudette/shared'

// Narrow Files dock (right side): a navigable directory tree with New notebook /
// file / folder actions. Clicking a directory navigates; a .ipynb opens as a
// notebook tab; any other file opens as an editor tab. The old modal file picker
// and the tab-strip "+ notebook" are retired in favour of this.
interface Props {
  initialPath: string
  onOpenNotebook: (path: string) => void   // opens/creates a notebook content tab
  onOpenFile: (path: string) => void        // opens a file-editor content tab
  onNewNotebook: (path: string) => Promise<string | null>  // notebooks.createPath
  onClose: () => void
}

const joinPath = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
const isNotebook = (name: string) => name.endsWith('.ipynb')

function crumbs(dir: string): Array<{ label: string; path: string }> {
  const parts = dir.split('/').filter(Boolean)
  const out = [{ label: '/', path: '/' }]
  let acc = ''
  for (const p of parts) { acc += `/${p}`; out.push({ label: p, path: acc }) }
  return out
}

function fmtSize(n: number): string {
  if (!n) return ''
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`
}

type Creating = 'notebook' | 'file' | 'folder' | null

export function FileManager({ initialPath, onOpenNotebook, onOpenFile, onNewNotebook, onClose }: Props) {
  const [dir, setDir] = useState(initialPath)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [creating, setCreating] = useState<Creating>(null)
  const [newName, setNewName] = useState('')
  const [createErr, setCreateErr] = useState<string | null>(null)

  const load = useCallback(async (path?: string) => {
    setLoading(true); setErr(null)
    const res = await api.fs.list(path)
    if ('error' in res && res.error) { setErr(res.error); setLoading(false); return }
    if (!('error' in res)) { setDir(res.path); setEntries(res.entries) }
    setLoading(false)
  }, [])

  useEffect(() => { void load(initialPath) }, [initialPath, load])

  const clickEntry = (e: DirEntry) => {
    const full = joinPath(dir, e.name)
    if (e.isDir) void load(full)
    else if (isNotebook(e.name)) onOpenNotebook(full)
    else onOpenFile(full)
  }

  const beginCreate = (mode: Creating) => { setCreating(mode); setNewName(''); setCreateErr(null) }

  const submitCreate = async () => {
    const n = newName.trim()
    if (!n || !creating) return
    setCreateErr(null)
    let err: string | null = null
    if (creating === 'folder') {
      const r = await api.fs.mkdir(joinPath(dir, n))
      err = r.ok ? null : r.error
    } else if (creating === 'notebook') {
      const p = joinPath(dir, n.endsWith('.ipynb') ? n : `${n}.ipynb`)
      err = await onNewNotebook(p)   // createPath opens + activates it
    } else {
      const r = await api.fs.createFile(joinPath(dir, n))
      err = r.ok ? null : r.error
      if (!err) onOpenFile(joinPath(dir, n))
    }
    if (err) { setCreateErr(err); return }
    setCreating(null); setNewName('')
    await load(dir)
  }

  const visible = entries.filter((e) => showHidden || !e.name.startsWith('.'))
  const actBtn = 'flex-1 text-[11px] py-1 rounded text-ctp-subtext hover:bg-ctp-surface0 hover:text-ctp-text transition-colors'

  return (
    <div className="flex flex-col h-full bg-ctp-base overflow-hidden">
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className="text-xs font-semibold text-ctp-subtext">Files</span>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-ctp-overlay cursor-pointer select-none">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-ctp-accent" />
          Hidden
        </label>
        <button onClick={() => void load(dir)} title="Refresh" className="text-ctp-overlay hover:text-ctp-text text-xs leading-none">⟳</button>
        <button onClick={onClose} title="Close dock" className="text-ctp-overlay hover:text-ctp-text p-1">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-ctp-surface0 shrink-0 overflow-x-auto text-[12px]">
        {crumbs(dir).map((c, i) => (
          <span key={c.path} className="flex items-center shrink-0">
            {i > 0 && <span className="text-ctp-surface2 px-0.5">/</span>}
            <button onClick={() => void load(c.path)} className="px-1 rounded hover:bg-ctp-surface0 text-ctp-subtext hover:text-ctp-text font-mono max-w-[110px] truncate" title={c.path}>
              {c.label}
            </button>
          </span>
        ))}
      </div>

      {/* Create actions */}
      <div className="shrink-0 border-b border-ctp-surface0 px-2 py-1.5">
        <div className="flex items-center gap-1">
          <button className={actBtn} onClick={() => beginCreate('notebook')} title="New notebook here">+ Notebook</button>
          <button className={actBtn} onClick={() => beginCreate('file')} title="New file here">+ File</button>
          <button className={actBtn} onClick={() => beginCreate('folder')} title="New folder here">+ Folder</button>
        </div>
        {creating && (
          <div className="mt-1.5">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void submitCreate() }
                else if (e.key === 'Escape') { setCreating(null); setCreateErr(null) }
              }}
              placeholder={creating === 'notebook' ? 'name.ipynb' : creating === 'folder' ? 'folder-name' : 'file-name.ext'}
              className="modal-input font-mono text-[12px]"
            />
            {createErr && <div className="text-[10px] text-ctp-red mt-1">{createErr}</div>}
          </div>
        )}
      </div>

      {/* Listing */}
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {loading && <div className="px-3 py-2 text-[12px] text-ctp-overlay">Loading…</div>}
        {err && <div className="px-3 py-2 text-[12px] text-ctp-red break-words">{err}</div>}
        {!loading && !err && visible.length === 0 && <div className="px-3 py-2 text-[12px] text-ctp-overlay">Empty folder.</div>}
        {!loading && !err && visible.map((e) => (
          <button
            key={e.name}
            onClick={() => clickEntry(e)}
            className="w-full flex items-center gap-2 px-3 py-1 text-left text-[13px] hover:bg-ctp-surface0/50 text-ctp-subtext transition-colors"
          >
            <span className="shrink-0 w-4 text-center">{e.isDir ? '📁' : isNotebook(e.name) ? '📓' : '📄'}</span>
            <span className="truncate font-mono flex-1">{e.name}</span>
            {e.isDir ? <span className="text-ctp-surface2 text-xs">›</span> : <span className="text-ctp-surface2 text-[10px] tabular-nums">{fmtSize(e.size)}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
