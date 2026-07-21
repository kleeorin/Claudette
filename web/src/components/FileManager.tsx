import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api/client'
import { crumbs, joinPath, isNotebookPath } from '../lib/paths'
import type { DirEntry } from '@claudette/shared'

// A file/dir copied or cut in the browser — module-level so it survives a re-render
// and a folder change, letting you paste it into a different directory (like the OS
// file manager). `cut` moves on paste; `copy` duplicates.
let fileClipboard: { path: string; name: string; mode: 'copy' | 'cut' } | null = null

// Insert " copy" before the extension for Duplicate / a paste into the same folder.
function withCopySuffix(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} copy${name.slice(dot)}` : `${name} copy`
}

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
  // File-op UI state: right-click menu, inline rename, delete confirm, op errors,
  // and a tick that forces re-render when the module-level clipboard changes.
  const [menu, setMenu] = useState<{ e: DirEntry; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)   // entry name being renamed
  const [renameVal, setRenameVal] = useState('')
  const [confirmDel, setConfirmDel] = useState<DirEntry | null>(null)
  const [opErr, setOpErr] = useState<string | null>(null)
  const [clipTick, setClipTick] = useState(0)
  // Upload: a hidden <input type=file> we click programmatically, plus per-batch
  // progress (done/total) that also disables the button while it runs.
  const uploadInput = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null)
  // The "+ New" dropdown that gathers the notebook/file/folder/upload add actions.
  const [addOpen, setAddOpen] = useState(false)

  const load = useCallback(async (path?: string) => {
    setLoading(true); setErr(null)
    const res = await api.fs.list(path)
    if ('error' in res && res.error) { setErr(res.error); setLoading(false); return }
    if (!('error' in res)) { setDir(res.path); setEntries(res.entries) }
    setLoading(false)
  }, [])

  useEffect(() => { void load(initialPath) }, [initialPath, load])
  // Close the context menu on any outside click or Escape.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setMenu(null) }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey) }
  }, [menu])
  // Same outside-click / Escape close for the "+ New" dropdown. The trigger stops
  // propagation so opening it isn't immediately undone by this same listener.
  useEffect(() => {
    if (!addOpen) return
    const close = () => setAddOpen(false)
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setAddOpen(false) }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey) }
  }, [addOpen])

  // --- file operations -------------------------------------------------------
  const run = async (p: Promise<{ ok: true } | { ok: false; error: string }>) => {
    const r = await p
    if (!r.ok) { setOpErr(r.error); return false }
    setOpErr(null); await load(dir); return true
  }
  const beginRename = (e: DirEntry) => { setRenaming(e.name); setRenameVal(e.name); setMenu(null) }
  const submitRename = async () => {
    // Clear `renaming` up front so the Enter→blur double-fire can't rename twice.
    const from = renaming
    const n = renameVal.trim()
    setRenaming(null)
    if (!from || !n || n === from) return
    await run(api.fs.rename(joinPath(dir, from), joinPath(dir, n)))
  }
  const copyEntry = (e: DirEntry) => { fileClipboard = { path: joinPath(dir, e.name), name: e.name, mode: 'copy' }; setClipTick((t) => t + 1); setMenu(null) }
  const cutEntry = (e: DirEntry) => { fileClipboard = { path: joinPath(dir, e.name), name: e.name, mode: 'cut' }; setClipTick((t) => t + 1); setMenu(null) }
  // Paste the clipboard into `targetDir` (defaults to the current folder; a right-
  // click on a folder pastes INTO it). A same-folder copy lands as "name copy".
  const paste = async (targetDir: string) => {
    if (!fileClipboard) return
    setMenu(null)
    const src = fileClipboard.path
    const collide = joinPath(targetDir, fileClipboard.name) === src && fileClipboard.mode === 'copy'
    const dest = joinPath(targetDir, collide ? withCopySuffix(fileClipboard.name) : fileClipboard.name)
    const ok = await run(fileClipboard.mode === 'copy' ? api.fs.copy(src, dest) : api.fs.rename(src, dest))
    if (ok && fileClipboard.mode === 'cut') { fileClipboard = null; setClipTick((t) => t + 1) }
  }
  const duplicateEntry = async (e: DirEntry) => { setMenu(null); await run(api.fs.copy(joinPath(dir, e.name), joinPath(dir, withCopySuffix(e.name)))) }
  const doDelete = async () => { const e = confirmDel; if (!e) return; setConfirmDel(null); await run(api.fs.remove(joinPath(dir, e.name))) }
  // Upload the picked files into the current folder, one at a time so a big file
  // doesn't starve the rest and progress advances predictably. Collect per-file
  // failures (e.g. name collisions) into opErr, then refresh the listing.
  const uploadFiles = async (files: FileList | null) => {
    const list = files ? Array.from(files) : []
    if (list.length === 0) return
    setOpErr(null)
    setUploading({ done: 0, total: list.length })
    const errors: string[] = []
    for (let i = 0; i < list.length; i++) {
      const r = await api.fs.upload(dir, list[i])
      if (!r.ok) errors.push(`${list[i].name}: ${r.error}`)
      setUploading({ done: i + 1, total: list.length })
    }
    setUploading(null)
    if (errors.length) setOpErr(errors.join(' · '))
    await load(dir)
  }

  const download = (e: DirEntry) => {
    setMenu(null)
    const a = document.createElement('a')
    a.href = api.fs.downloadUrl(joinPath(dir, e.name))
    a.download = e.name
    document.body.appendChild(a); a.click(); a.remove()
  }

  // Folders navigate on a single click; files open on double-click (the usual
  // desktop convention — a single click would open things by accident).
  const clickEntry = (e: DirEntry) => {
    if (e.isDir) void load(joinPath(dir, e.name))
  }
  const openEntry = (e: DirEntry) => {
    if (e.isDir) return
    const full = joinPath(dir, e.name)
    if (isNotebookPath(e.name)) onOpenNotebook(full)
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
  const addItem = 'w-full text-left px-3 py-1.5 hover:bg-ctp-surface0 text-ctp-text flex items-center gap-2 text-xs'

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
          <div className="relative flex-1">
            <button
              className={`${actBtn} w-full`}
              onClick={(e) => { e.stopPropagation(); setAddOpen((o) => !o) }}
              disabled={!!uploading}
              title="Add to this folder"
            >{uploading ? `↑ ${uploading.done}/${uploading.total}` : '+ New ▾'}</button>
            {addOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute left-0 top-full mt-1 z-50 w-40 rounded-md border border-ctp-surface1 bg-ctp-mantle shadow-pop py-1"
              >
                <button className={addItem} onClick={() => { setAddOpen(false); beginCreate('notebook') }}>📓 Notebook</button>
                <button className={addItem} onClick={() => { setAddOpen(false); beginCreate('file') }}>📄 File</button>
                <button className={addItem} onClick={() => { setAddOpen(false); beginCreate('folder') }}>📁 Folder</button>
                <div className="my-1 border-t border-ctp-surface0" />
                <button className={addItem} onClick={() => { setAddOpen(false); uploadInput.current?.click() }}>↑ Upload files…</button>
              </div>
            )}
          </div>
          <input
            ref={uploadInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => { const f = e.target.files; e.target.value = ''; void uploadFiles(f) }}
          />
          {fileClipboard && (
            <button
              className={actBtn}
              onClick={() => void paste(dir)}
              title={`Paste "${fileClipboard.name}" here (${fileClipboard.mode})`}
              data-cliptick={clipTick}
            >📋 Paste</button>
          )}
        </div>
        {opErr && <div className="text-[10px] text-ctp-red mt-1 break-words">{opErr}</div>}
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
        {!loading && !err && visible.map((e) => renaming === e.name ? (
          <div key={e.name} className="flex items-center gap-2 px-3 py-1">
            <span className="shrink-0 w-4 text-center">{e.isDir ? '📁' : isNotebookPath(e.name) ? '📓' : '📄'}</span>
            <input
              autoFocus
              value={renameVal}
              onChange={(ev) => setRenameVal(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); void submitRename() }
                else if (ev.key === 'Escape') { setRenaming(null); setOpErr(null) }
              }}
              onBlur={() => void submitRename()}
              className="modal-input font-mono text-[12px] flex-1"
            />
          </div>
        ) : (
          <button
            key={e.name}
            onClick={() => clickEntry(e)}
            onDoubleClick={() => openEntry(e)}
            onContextMenu={(ev) => { ev.preventDefault(); setMenu({ e, x: ev.clientX, y: ev.clientY }) }}
            title={e.isDir ? 'Open folder' : 'Double-click to open · right-click for actions'}
            className="group w-full flex items-center gap-2 px-3 py-1 text-left text-[13px] hover:bg-ctp-surface0/50 text-ctp-subtext transition-colors"
          >
            <span className="shrink-0 w-4 text-center">{e.isDir ? '📁' : isNotebookPath(e.name) ? '📓' : '📄'}</span>
            <span className="truncate font-mono flex-1">{e.name}</span>
            <span
              role="button"
              tabIndex={-1}
              onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); setMenu({ e, x: ev.clientX, y: ev.clientY }) }}
              title="Actions"
              className="shrink-0 opacity-0 group-hover:opacity-100 text-ctp-overlay hover:text-ctp-text px-1 leading-none"
            >⋯</span>
            {e.isDir && <span className="text-ctp-surface2 text-xs">›</span>}
          </button>
        ))}
      </div>

      {menu && <RowMenu
        entry={menu.e} x={menu.x} y={menu.y} hasClipboard={!!fileClipboard}
        onOpen={() => { setMenu(null); menu.e.isDir ? void load(joinPath(dir, menu.e.name)) : openEntry(menu.e) }}
        onDownload={() => download(menu.e)}
        onRename={() => beginRename(menu.e)}
        onDuplicate={() => void duplicateEntry(menu.e)}
        onCopy={() => copyEntry(menu.e)}
        onCut={() => cutEntry(menu.e)}
        onPaste={() => void paste(menu.e.isDir ? joinPath(dir, menu.e.name) : dir)}
        onDelete={() => { setConfirmDel(menu.e); setMenu(null) }}
      />}
      {confirmDel && <ConfirmDelete entry={confirmDel} onCancel={() => setConfirmDel(null)} onConfirm={() => void doDelete()} />}
    </div>
  )
}

// Right-click actions menu for a file/dir, positioned at the cursor (portal to body
// so it's never clipped by the dock's overflow). Closes on outside click (wired in
// FileManager). A directory can't be downloaded.
function RowMenu({ entry, x, y, hasClipboard, onOpen, onDownload, onRename, onDuplicate, onCopy, onCut, onPaste, onDelete }: {
  entry: DirEntry; x: number; y: number; hasClipboard: boolean
  onOpen: () => void; onDownload: () => void; onRename: () => void; onDuplicate: () => void
  onCopy: () => void; onCut: () => void; onPaste: () => void; onDelete: () => void
}) {
  const item = 'w-full text-left px-3 py-1.5 hover:bg-ctp-surface0 text-ctp-text flex items-center gap-2'
  // Keep the menu on-screen: nudge left/up near the viewport edges.
  const left = Math.min(x, window.innerWidth - 180)
  const top = Math.min(y, window.innerHeight - 260)
  return createPortal(
    <div
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[60] w-44 rounded-md border border-ctp-surface1 bg-ctp-mantle shadow-pop py-1 text-xs"
    >
      <button className={item} onClick={onOpen}>{entry.isDir ? 'Open folder' : 'Open'}</button>
      {!entry.isDir && <button className={item} onClick={onDownload}>⬇ Download</button>}
      <div className="my-1 border-t border-ctp-surface0" />
      <button className={item} onClick={onRename}>Rename…</button>
      <button className={item} onClick={onDuplicate}>Duplicate</button>
      <button className={item} onClick={onCopy}>Copy</button>
      <button className={item} onClick={onCut}>Cut</button>
      {hasClipboard && <button className={item} onClick={onPaste}>Paste into…{entry.isDir ? ` ${entry.name}` : ''}</button>}
      <div className="my-1 border-t border-ctp-surface0" />
      <button className={`${item} text-ctp-red hover:bg-ctp-red/15`} onClick={onDelete}>Delete…</button>
    </div>,
    document.body,
  )
}

// Small confirm dialog for a delete (recursive for folders). Modal, centered.
function ConfirmDelete({ entry, onCancel, onConfirm }: { entry: DirEntry; onCancel: () => void; onConfirm: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onCancel}>
      <div className="w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-ctp-surface1 bg-ctp-mantle shadow-pop p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold text-ctp-text mb-1.5">Delete {entry.isDir ? 'folder' : 'file'}?</div>
        <div className="text-xs text-ctp-subtext break-words mb-4">
          <span className="font-mono text-ctp-text">{entry.name}</span>
          {entry.isDir ? ' and everything inside it will be permanently deleted.' : ' will be permanently deleted.'} This can’t be undone.
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="text-xs px-3.5 py-1.5 rounded-md text-ctp-subtext hover:bg-ctp-surface0 transition-colors">Cancel</button>
          <button onClick={onConfirm} className="text-xs font-medium px-4 py-1.5 rounded-md bg-ctp-red text-ctp-base hover:brightness-110 active:brightness-95 transition">Delete</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
