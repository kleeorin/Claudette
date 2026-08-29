import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api/client'
import { crumbs, joinPath, isNotebookPath } from '../lib/paths'
import { errText } from '../lib/errText'
import type { DirEntry } from '@claudette/shared'
import { useDismissOnOutside, useEscape } from '../lib/useDismiss'
import { useScrollMemory } from '../lib/scrollMemory'
import { FileIcon, fileKind } from './FileIcon'

// The files/dirs copied or cut in the browser — module-level so it survives a re-render
// and a folder change, letting you paste them into a different directory (like the OS
// file manager). `cut` moves on paste; `copy` duplicates.
//
// It holds a LIST because the listing is multi-select. A single-row Copy is a list of
// one, so paste has ONE implementation rather than a single path and a plural path free
// to disagree about collisions, cut-clearing or partial failure.
let fileClipboard: { items: { path: string; name: string }[]; mode: 'copy' | 'cut' } | null = null

// The folder this pane was last showing, per session cwd. App.tsx renders
// `<FileManager key={termCwd}>`, so switching sessions DESTROYS and rebuilds the whole
// pane — `dir` re-initialised to the session's cwd and you lost your place every time.
// Module-level so it outlives that remount.
//
// Keyed by cwd rather than sessionId deliberately, and the two are indistinguishable from
// the outside: the remount granularity is already `key={termCwd}`, so two sessions sharing
// a cwd never rebuild the pane and can never observe a difference. Keying by the same
// thing that drives the remount keeps one concept instead of two that must agree.
const lastDirByCwd = new Map<string, string>()

// How the clipboard describes itself in a button title / label.
function clipLabel(c: NonNullable<typeof fileClipboard>): string {
  return c.items.length === 1 ? `"${c.items[0].name}"` : `${c.items.length} items`
}

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
  // Resume where this cwd was left, not at its root. Lazy initialiser: `initialPath` is
  // only the FALLBACK for a cwd never visited, and evaluating it eagerly would read the
  // map on every render for a value used once.
  const [dir, setDir] = useState(() => lastDirByCwd.get(initialPath) ?? initialPath)
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
  // The pending delete carries the DIRECTORY it was confirmed against, not just the rows.
  // `{ dir, names }` exists to make a name-without-its-dir unrepresentable, and this was
  // the one place that dropped the guarantee: the confirm snapshotted entries, then
  // doDelete rebuilt paths from the LIVE `dir`. It was safe only because ConfirmDelete is
  // a fixed-inset portal, so no row click could move `dir` while it was open — an
  // irreversible op resting on another component's styling. Now it can't.
  const [confirmDel, setConfirmDel] = useState<{ dir: string; entries: DirEntry[] } | null>(null)
  const [opErr, setOpErr] = useState<string | null>(null)
  const [clipTick, setClipTick] = useState(0)
  // Upload: a hidden <input type=file> we click programmatically, plus per-batch
  // progress (done/total) that also disables the button while it runs.
  const uploadInput = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null)
  // The "+ New" dropdown that gathers the notebook/file/folder/upload add actions.
  const [addOpen, setAddOpen] = useState(false)
  // --- multi-select ---------------------------------------------------------
  // Selected rows, stored as NAMES together with the directory they were chosen in. The
  // dir is not decoration: a bare name is ambiguous the moment the listing changes under
  // us, and the actions this feeds include Delete. Anything whose dir no longer matches is
  // treated as no selection at all (see `selected` below) rather than silently re-bound to
  // whatever folder is open now.
  const [sel, setSel] = useState<{ dir: string; names: Set<string> }>({ dir: initialPath, names: new Set() })
  // Touch mode: a plain tap toggles selection instead of opening. Ctrl/Cmd-click and
  // Shift-click cover the desktop case without it, but neither exists on a phone, and
  // this dock is used on one.
  const [selMode, setSelMode] = useState(false)
  // The CURRENT dir, readable from inside an in-flight batch whose own closure has gone
  // stale. Kept in sync on every render rather than in an effect, so it is never a render
  // behind the value it mirrors.
  const dirRef = useRef(dir)
  dirRef.current = dir
  // The row a Shift-click extends FROM. A ref, not state: it must not trigger a render,
  // and it is read inside the click handler that sets it.
  const anchor = useRef<string | null>(null)

  // try/finally: `api.fs.list` REJECTS on a dropped connection or a non-JSON body, and
  // an unguarded rejection left the dock on "Loading…" with no working way out (⟳ calls
  // straight back into here).
  // Resolves TRUE if the listing landed. The caller that resumes a remembered folder needs
  // to know, so it can fall back rather than strand the pane on an error.
  const load = useCallback(async (path?: string): Promise<boolean> => {
    setLoading(true); setErr(null)
    try {
      const res = await api.fs.list(path)
      if ('error' in res && res.error) { setErr(res.error); return false }
      if (!('error' in res)) {
        setDir(res.path); setEntries(res.entries)
        // Record against the SESSION's cwd (`initialPath`), not the folder just loaded —
        // the map answers "where was this session's pane left?", so the key must stay put
        // while the value moves. Written on the RESOLVED path from the server, so a folder
        // that failed to list is never remembered as somewhere we were.
        lastDirByCwd.set(initialPath, res.path)
        // A refresh must not silently drop the selection (every file op calls load(), so
        // that would make "select 3, copy, then delete" impossible) — but it MUST drop
        // names that are no longer there, or a stale name survives a delete and the next
        // action reports a phantom failure. Navigating to a different folder clears it.
        const live = new Set(res.entries.map((x) => x.name))
        setSel((prev) => prev.dir === res.path
          ? { dir: res.path, names: new Set([...prev.names].filter((n) => live.has(n))) }
          : { dir: res.path, names: new Set() })
        return true
      }
      return false
    } catch (e) {
      setErr(errText(e, 'could not list this folder'))
      return false
    } finally {
      setLoading(false)
    }
    // initialPath is the key `lastDirByCwd` is written under — a stale one would record
    // this session's folder against a previous session's cwd.
  }, [initialPath])

  // Open where this session's pane was last left. The remembered folder can be GONE by
  // now — deleted, renamed, an unmounted drive — so a failure falls back to the session
  // cwd and forgets it, rather than leaving the pane showing an error for a directory the
  // user has no obvious way to navigate out of.
  //
  // The cancel guard is not about the setState calls — those are harmless no-ops after
  // unmount. It is about `lastDirByCwd`, which is MODULE state the next instance is
  // already using: switch away and back while the first load is still in flight, and a
  // failing first instance would delete-then-overwrite the entry the second instance had
  // just restored from, dropping the user at the cwd root. Costs a remembered position,
  // never a file, but it is shared state written from an async tail.
  useEffect(() => {
    let cancelled = false
    const remembered = lastDirByCwd.get(initialPath)
    void (async () => {
      if (remembered && remembered !== initialPath) {
        const ok = await load(remembered)
        if (cancelled) return
        if (ok) return
        // Not distinguished from a TRANSIENT listing failure, deliberately: telling those
        // apart means string-matching an error message, which is more fragile than the
        // thing it would fix. The cost of getting it wrong is one forgotten position.
        lastDirByCwd.delete(initialPath)
      }
      if (cancelled) return
      await load(initialPath)
    })()
    return () => { cancelled = true }
  }, [initialPath, load])
  // Close the context menu on any outside click or Escape.
  useDismissOnOutside(!!menu, () => setMenu(null))
  // Same outside-click / Escape close for the "+ New" dropdown. The trigger stops
  // propagation so opening it isn't immediately undone by this same listener.
  useDismissOnOutside(addOpen, () => setAddOpen(false))

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
  const toClip = (list: DirEntry[], mode: 'copy' | 'cut') => {
    if (!list.length) return
    fileClipboard = { items: list.map((e) => ({ path: joinPath(dir, e.name), name: e.name })), mode }
    setClipTick((t) => t + 1); setMenu(null)
  }
  // Run one file op per item, collecting per-item failures instead of aborting the batch.
  // This is the same shape as uploadFiles, and for the same reason: with N items, "one of
  // them failed" is the NORMAL outcome (a name collision, a permission), and a loop that
  // throws on the first one leaves the rest undone with nothing on screen explaining why.
  //
  // Returns the items that FAILED, not a count. A caller that has its own collection to
  // reconcile (paste, with the clipboard) needs to know which ones, and a count forces it
  // to choose between keeping everything or dropping everything — both wrong.
  //
  // Generic over anything that has a `name` so the clipboard's own items can be passed
  // straight in — an earlier version forced them into stand-in DirEntry objects with
  // invented isDir/size fields, which is a lie sitting one refactor away from being read.
  const runBatch = async <T extends { name: string }>(
    list: T[],
    op: (item: T) => Promise<{ ok: true } | { ok: false; error: string }>,
  ): Promise<T[]> => {
    // Where this batch belongs. A batch of N is N sequential awaits with the listing still
    // interactive, so `dir` can move under it; the trailing refresh used to close over the
    // render-time value and call setDir(old), yanking the user back out of the folder they
    // had just opened. The per-item ops are unaffected — they use the dir they were
    // confirmed against, which is the correct one.
    const home = dir
    const errors: string[] = []
    const failed: T[] = []
    for (const e of list) {
      const r = await op(e)
      if (!r.ok) { errors.push(`${e.name}: ${r.error}`); failed.push(e) }
    }
    setOpErr(errors.length ? errors.join(' · ') : null)
    // Only refresh if we're still looking at the folder this batch was about. dirRef is
    // read rather than `dir` because this closure's `dir` is the stale one by definition.
    if (dirRef.current === home) await load(home)
    return failed
  }
  // Paste the clipboard into `targetDir` (defaults to the current folder; a right-
  // click on a folder pastes INTO it). A same-folder copy lands as "name copy".
  const paste = async (targetDir: string) => {
    if (!fileClipboard) return
    setMenu(null)
    const { items, mode } = fileClipboard
    const failed = await runBatch(items, (it) => {
      const collide = joinPath(targetDir, it.name) === it.path && mode === 'copy'
      const dest = joinPath(targetDir, collide ? withCopySuffix(it.name) : it.name)
      return mode === 'copy' ? api.fs.copy(it.path, dest) : api.fs.rename(it.path, dest)
    })
    // A CUT clipboard is PRUNED to what failed, not cleared-or-kept wholesale. Clearing it
    // after a partial move strands the failures with no way to retry them as a group;
    // keeping it whole means the retry re-attempts the items that already moved, which now
    // fail with a source-missing error and bury the real failures in phantom ones. Pruning
    // is the same rule load() applies to the selection, so the two collections converge on
    // exactly what still needs doing.
    if (mode === 'cut') {
      const names = new Set(failed.map((f) => f.name))
      fileClipboard = names.size ? { items: items.filter((it) => names.has(it.name)), mode } : null
      setClipTick((t) => t + 1)
    }
  }
  const duplicateEntries = async (list: DirEntry[]) => {
    setMenu(null)
    await runBatch(list, (e) => api.fs.copy(joinPath(dir, e.name), joinPath(dir, withCopySuffix(e.name))))
  }
  const doDelete = async () => {
    const pending = confirmDel
    if (!pending?.entries.length) return
    setConfirmDel(null)
    // joinPath against the SNAPSHOT's dir, never the live one: what the user confirmed was
    // "delete these rows, in that folder".
    await runBatch(pending.entries, (e) => api.fs.remove(joinPath(pending.dir, e.name)))
  }
  // Upload the picked files into the current folder, one at a time so a big file
  // doesn't starve the rest and progress advances predictably. Collect per-file
  // failures (e.g. name collisions) into opErr, then refresh the listing.
  // Takes a plain File[] the caller has already snapshotted off the input — see the
  // onChange below for why a live FileList must never be passed in here.
  // The finally is load-bearing: without it a thrown upload left `uploading` set, which
  // disables the "+ New" button — the dock got stuck on "↑ 0/1" with no way back.
  const uploadFiles = async (list: File[]) => {
    if (list.length === 0) return
    setOpErr(null)
    setUploading({ done: 0, total: list.length })
    const errors: string[] = []
    try {
      for (let i = 0; i < list.length; i++) {
        const r = await api.fs.upload(dir, list[i])
        if (!r.ok) errors.push(`${list[i].name}: ${r.error}`)
        setUploading({ done: i + 1, total: list.length })
      }
    } finally {
      setUploading(null)
      if (errors.length) setOpErr(errors.join(' · '))
      await load(dir)
    }
  }

  // Download one file, or several. There is no archive endpoint, so N files means N
  // separate downloads rather than one zip — the browser asks once whether to allow
  // multiple, then saves them individually. A server-side zip would be nicer for a big
  // selection; it needs a new route, so it is deliberately not faked here.
  //
  // The 120ms gap is load-bearing: fired in a tight loop, browsers coalesce or silently
  // drop all but the first few anchor clicks, so a "Download 5" would quietly save 2.
  const downloadEntries = async (list: DirEntry[]) => {
    setMenu(null)
    const files = list.filter((e) => !e.isDir)
    const skipped = list.length - files.length
    // Say what was NOT done. Skipping folders silently is how "Download 4" saves 2 files
    // and looks like it worked.
    setOpErr(skipped
      ? `${skipped} folder${skipped > 1 ? 's' : ''} skipped — folders can't be downloaded (no archive endpoint yet).`
      : null)
    for (let i = 0; i < files.length; i++) {
      const a = document.createElement('a')
      a.href = api.fs.downloadUrl(joinPath(dir, files[i].name))
      a.download = files[i].name
      document.body.appendChild(a); a.click(); a.remove()
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 120))
    }
  }

  // Declared here rather than beside the other derived values further down: everything in
  // the selection block below reads it, and it is the definition of "on screen".
  const visible = entries.filter((e) => showHidden || !e.name.startsWith('.'))

  // --- selection ------------------------------------------------------------
  // What is ACTUALLY selected: the on-screen rows whose names are in `sel`, and only
  // when `sel` belongs to the folder now open. Deriving it this way rather than trusting
  // the raw name set closes two holes by construction instead of by remembering to:
  // a selected dotfile that the Hidden filter has since hidden can never be acted on by
  // a button reading "3 selected", and a selection left over from another folder can
  // never resolve against this one's names. You can only act on what you can see.
  const selected = sel.dir === dir ? visible.filter((e) => sel.names.has(e.name)) : []
  const selCount = selected.length
  const clearSel = () => { setSel({ dir, names: new Set() }); anchor.current = null }
  const setNames = (names: Set<string>) => setSel({ dir, names })
  const toggleOne = (name: string) => {
    const names = new Set(sel.dir === dir ? sel.names : [])
    names.has(name) ? names.delete(name) : names.add(name)
    setNames(names); anchor.current = name
  }
  // Shift-click extends over the VISIBLE order, which is the order on screen — extending
  // over `entries` would sweep in rows the Hidden filter is keeping out of sight.
  const extendTo = (name: string) => {
    const from = visible.findIndex((e) => e.name === (anchor.current ?? name))
    const to = visible.findIndex((e) => e.name === name)
    if (from < 0 || to < 0) return toggleOne(name)
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    const names = new Set(sel.dir === dir ? sel.names : [])
    for (let i = lo; i <= hi; i++) names.add(visible[i].name)
    setNames(names)
  }
  const allSelected = visible.length > 0 && selCount === visible.length
  // Escape clears, the way it does everywhere else in the app — but only when nothing
  // else on screen owns Escape first, or dismissing a menu would also throw away the
  // selection the menu was about to act on.
  useEscape(clearSel, selCount > 0 && !menu && !confirmDel && !creating && renaming === null)

  // Folders navigate on a single click; files open on double-click (the usual
  // desktop convention — a single click would open things by accident).
  const clickEntry = (e: DirEntry) => {
    if (e.isDir) void load(joinPath(dir, e.name))
  }
  // One click handler for the row, because selection and navigation compete for it:
  //   select mode (touch)  → tap toggles; there is no Ctrl/Shift on a phone
  //   Ctrl/Cmd-click       → toggle this row
  //   Shift-click          → extend from the last-touched row
  //   plain click          → drop any selection, then behave exactly as before
  // The last line matters: a stray click is always an escape hatch out of a selection,
  // so you can never get stuck in a state where clicking a folder refuses to open it.
  const rowClick = (e: DirEntry, ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    if (ev.shiftKey) return extendTo(e.name)
    if (selMode || ev.metaKey || ev.ctrlKey) return toggleOne(e.name)
    if (selCount) clearSel()
    clickEntry(e)
  }
  // A right-click INSIDE a selection acts on the whole selection; outside it, on the one
  // row (and drops the selection, so the menu can never act on rows you can't see are
  // selected). Same rule as every desktop file manager.
  const menuTargets = (e: DirEntry): DirEntry[] =>
    selected.some((s) => s.name === e.name) ? selected : [e]
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
      err = await onNewNotebook(p)   // the handler focuses the new notebook's tab; null = created
    } else {
      const r = await api.fs.createFile(joinPath(dir, n))
      err = r.ok ? null : r.error
      if (!err) onOpenFile(joinPath(dir, n))
    }
    if (err) { setCreateErr(err); return }
    setCreating(null); setNewName('')
    await load(dir)
  }

  // Scroll position, per session AND per folder — the same shape as `git:${cwd}:changes`.
  // Both halves are needed: keyed on cwd alone, walking into a subfolder would restore the
  // parent's offset; keyed on dir alone, two sessions sitting in the same folder would
  // fight over one position.
  const listRef = useRef<HTMLDivElement | null>(null)
  useScrollMemory(`files:${initialPath}:${dir}`, () => listRef.current)

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
        {/* Ctrl/Shift-click cover multi-select on a desktop; neither exists on a phone,
            and this dock is used on one. This toggle is the touch route in. */}
        <button
          onClick={() => { setSelMode((v) => { if (v) clearSel(); return !v }) }}
          title={selMode ? 'Leave select mode' : 'Select multiple'}
          className={`text-xs leading-none px-1 rounded ${selMode ? 'text-ctp-accent bg-ctp-surface0' : 'text-ctp-overlay hover:text-ctp-text'}`}
        >☑</button>
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
                <button className={addItem} onClick={() => { setAddOpen(false); beginCreate('notebook') }}><FileIcon kind="notebook" /> Notebook</button>
                <button className={addItem} onClick={() => { setAddOpen(false); beginCreate('file') }}><FileIcon kind="file" /> File</button>
                <button className={addItem} onClick={() => { setAddOpen(false); beginCreate('folder') }}><FileIcon kind="folder" /> Folder</button>
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
            // Snapshot the picked files into a real array BEFORE resetting the input.
            // `e.target.files` is the input's LIVE FileList, and clearing `value` empties
            // that same object in place (Blink's FileInputType::SetValue calls
            // file_list_->clear()) — so the previous "capture the reference, then reset"
            // order handed uploadFiles an already-empty list and every upload silently
            // did nothing. The reset itself has to stay: without it, re-picking the same
            // file fires no change event.
            onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ''; void uploadFiles(picked) }}
          />
          {fileClipboard && (
            <button
              className={actBtn}
              onClick={() => void paste(dir)}
              title={`Paste ${clipLabel(fileClipboard)} here (${fileClipboard.mode})`}
              data-cliptick={clipTick}
            >📋 Paste{fileClipboard.items.length > 1 ? ` ${fileClipboard.items.length}` : ''}</button>
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

      {/* Selection actions. Present only with a selection, so the dock costs nothing in
          the ordinary case, and it reports the DERIVED count — what is on screen and
          selected — rather than the size of the name set. */}
      {selCount > 0 && (
        <div className="shrink-0 border-b border-ctp-surface0 px-2 py-1.5 bg-ctp-surface0/40">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-ctp-text font-medium shrink-0">{selCount} selected</span>
            <button
              className="text-[11px] text-ctp-overlay hover:text-ctp-text px-1 shrink-0"
              onClick={() => allSelected ? clearSel() : setNames(new Set(visible.map((e) => e.name)))}
            >{allSelected ? 'None' : 'All'}</button>
            <button onClick={clearSel} title="Clear selection (Esc)" className="ml-auto text-ctp-overlay hover:text-ctp-text px-1 shrink-0">✕</button>
          </div>
          <div className="flex items-center gap-1 mt-1">
            <button className={actBtn} onClick={() => void downloadEntries(selected)} title="Download the selected files">⬇ Download</button>
            <button className={actBtn} onClick={() => toClip(selected, 'copy')} title="Copy the selection">Copy</button>
            <button className={actBtn} onClick={() => toClip(selected, 'cut')} title="Cut the selection">Cut</button>
            <button
              className={`${actBtn} text-ctp-red hover:bg-ctp-red/15 hover:text-ctp-red`}
              onClick={() => setConfirmDel({ dir, entries: selected })}
              title="Delete the selection"
            >Delete…</button>
          </div>
        </div>
      )}

      {/* Listing */}
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto py-1">
        {loading && <div className="px-3 py-2 text-[12px] text-ctp-overlay">Loading…</div>}
        {err && <div className="px-3 py-2 text-[12px] text-ctp-red break-words">{err}</div>}
        {!loading && !err && visible.length === 0 && <div className="px-3 py-2 text-[12px] text-ctp-overlay">Empty folder.</div>}
        {!loading && !err && visible.map((e) => renaming === e.name ? (
          <div key={e.name} className="flex items-center gap-2 px-3 py-1">
            <FileIcon kind={fileKind(e.isDir, isNotebookPath(e.name))} />
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
          // onDoubleClick is gated on `selMode` and the modifier keys, but NOT on the
          // selection count: a plain click has already cleared any selection by the time the
          // second one lands, so a count check would add a stale-closure question with no
          // behaviour to show for it. The modifiers do need excluding — a Ctrl- or
          // Shift-double-click would otherwise toggle the selection twice AND open the file,
          // which no file manager does.
          <button
            key={e.name}
            onClick={(ev) => rowClick(e, ev)}
            onDoubleClick={(ev) => { if (!selMode && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) openEntry(e) }}
            onContextMenu={(ev) => {
              ev.preventDefault()
              // Right-clicking outside the selection drops it, so the menu that opens can
              // never be about rows the user has stopped thinking about.
              if (selCount && !selected.some((x) => x.name === e.name)) clearSel()
              setMenu({ e, x: ev.clientX, y: ev.clientY })
            }}
            title={selMode ? 'Tap to select' : e.isDir ? 'Open folder' : 'Double-click to open · right-click for actions'}
            className={`group w-full flex items-center gap-2 px-3 py-1 text-left text-[13px] transition-colors ${
              sel.names.has(e.name) && sel.dir === dir
                ? 'bg-ctp-accent/15 text-ctp-text'
                : 'hover:bg-ctp-surface0/50 text-ctp-subtext'
            }`}
          >
            {/* The checkbox is shown once selecting is in play — in select mode, on hover,
                or while a selection exists. Hidden otherwise so the ordinary listing is
                not permanently half a file manager. */}
            <span
              role="checkbox"
              aria-checked={sel.names.has(e.name) && sel.dir === dir}
              tabIndex={-1}
              onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); toggleOne(e.name) }}
              className={`shrink-0 w-3.5 h-3.5 rounded-[3px] border flex items-center justify-center text-[9px] leading-none transition-opacity ${
                sel.names.has(e.name) && sel.dir === dir
                  ? 'bg-ctp-accent border-ctp-accent text-ctp-base opacity-100'
                  : `border-ctp-surface2 text-transparent ${selMode || selCount ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`
              }`}
            >✓</span>
            <FileIcon kind={fileKind(e.isDir, isNotebookPath(e.name))} />
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
        entry={menu.e} targets={menuTargets(menu.e)} x={menu.x} y={menu.y} clipboard={fileClipboard}
        onOpen={() => { setMenu(null); menu.e.isDir ? void load(joinPath(dir, menu.e.name)) : openEntry(menu.e) }}
        onDownload={() => void downloadEntries(menuTargets(menu.e))}
        onRename={() => beginRename(menu.e)}
        onDuplicate={() => void duplicateEntries(menuTargets(menu.e))}
        onCopy={() => toClip(menuTargets(menu.e), 'copy')}
        onCut={() => toClip(menuTargets(menu.e), 'cut')}
        onPaste={() => void paste(menu.e.isDir ? joinPath(dir, menu.e.name) : dir)}
        onDelete={() => { setConfirmDel({ dir, entries: menuTargets(menu.e) }); setMenu(null) }}
      />}
      {confirmDel && <ConfirmDelete entries={confirmDel.entries} onCancel={() => setConfirmDel(null)} onConfirm={() => void doDelete()} />}
    </div>
  )
}

// Right-click actions menu, positioned at the cursor (portal to body so it's never
// clipped by the dock's overflow). Closes on outside click (wired in FileManager).
//
// `entry` is the row that was clicked; `targets` is what the actions will actually act on
// — the whole selection when the click landed inside it, otherwise just that row. Both are
// passed because the menu needs them for different things: the LABELS come from `targets`
// (so "Delete 3 items…" cannot claim a count the action won't perform), while Open and
// Rename are inherently single and stay bound to `entry`.
function RowMenu({ entry, targets, x, y, clipboard, onOpen, onDownload, onRename, onDuplicate, onCopy, onCut, onPaste, onDelete }: {
  entry: DirEntry; targets: DirEntry[]; x: number; y: number
  clipboard: { items: { path: string; name: string }[]; mode: 'copy' | 'cut' } | null
  onOpen: () => void; onDownload: () => void; onRename: () => void; onDuplicate: () => void
  onCopy: () => void; onCut: () => void; onPaste: () => void; onDelete: () => void
}) {
  const item = 'w-full text-left px-3 py-1.5 hover:bg-ctp-surface0 text-ctp-text flex items-center gap-2'
  const n = targets.length
  const many = n > 1
  const suffix = many ? ` ${n} items` : ''
  // Download is offered when at least ONE target is a file. It stays offered for a mixed
  // selection — downloadEntries skips the folders and says how many it skipped, which is
  // more useful than hiding the action and leaving no explanation.
  const anyFile = targets.some((t) => !t.isDir)
  // Keep the menu on-screen: nudge left/up near the viewport edges.
  const left = Math.min(x, window.innerWidth - 180)
  const top = Math.min(y, window.innerHeight - 260)
  return createPortal(
    <div
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[60] w-44 rounded-md border border-ctp-surface1 bg-ctp-mantle shadow-pop py-1 text-xs"
    >
      {/* Open and Rename act on ONE thing by definition, so they are hidden for a
          multi-selection rather than silently applying to whichever row was clicked. */}
      {!many && <button className={item} onClick={onOpen}>{entry.isDir ? 'Open folder' : 'Open'}</button>}
      {anyFile && <button className={item} onClick={onDownload}>⬇ Download{suffix}</button>}
      <div className="my-1 border-t border-ctp-surface0" />
      {!many && <button className={item} onClick={onRename}>Rename…</button>}
      <button className={item} onClick={onDuplicate}>Duplicate{suffix}</button>
      <button className={item} onClick={onCopy}>Copy{suffix}</button>
      <button className={item} onClick={onCut}>Cut{suffix}</button>
      {clipboard && (
        <button className={item} onClick={onPaste}>
          Paste {clipboard.items.length > 1 ? `${clipboard.items.length} items` : ''}into…{entry.isDir ? ` ${entry.name}` : ''}
        </button>
      )}
      <div className="my-1 border-t border-ctp-surface0" />
      <button className={`${item} text-ctp-red hover:bg-ctp-red/15`} onClick={onDelete}>Delete{suffix}…</button>
    </div>,
    document.body,
  )
}

// Small confirm dialog for a delete (recursive for folders). Modal, centered.
//
// It NAMES what it is about to delete rather than only counting it. "Delete 7 items?" is
// exactly as easy to confirm whether or not the selection is the one you meant, which
// makes the confirmation worthless for the mistake it exists to catch — a stray
// Shift-click that swept in a folder. Long lists are capped with an explicit "+N more" so
// the dialog cannot grow past the screen, and the folder count is called out separately
// because a folder delete is recursive and is the expensive mistake.
const NAMED = 8
function ConfirmDelete({ entries, onCancel, onConfirm }: { entries: DirEntry[]; onCancel: () => void; onConfirm: () => void }) {
  const n = entries.length
  const dirs = entries.filter((e) => e.isDir).length
  const shown = entries.slice(0, NAMED)
  const rest = n - shown.length
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onCancel}>
      <div className="w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-ctp-surface1 bg-ctp-mantle shadow-pop p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold text-ctp-text mb-1.5">
          {n === 1 ? `Delete ${entries[0].isDir ? 'folder' : 'file'}?` : `Delete ${n} items?`}
        </div>
        <div className="text-xs text-ctp-subtext break-words mb-4">
          <div className="max-h-40 overflow-y-auto mb-2 space-y-0.5">
            {shown.map((e) => (
              <div key={e.name} className="flex items-center gap-1.5">
                <FileIcon kind={fileKind(e.isDir, isNotebookPath(e.name))} />
                <span className="font-mono text-ctp-text truncate">{e.name}</span>
              </div>
            ))}
            {rest > 0 && <div className="text-ctp-overlay pl-[22px]">+{rest} more</div>}
          </div>
          {dirs > 0 && (
            <span>
              {dirs === 1 && n === 1 ? 'The folder' : `${dirs} folder${dirs > 1 ? 's' : ''}`} and everything inside
              {dirs > 1 ? ' them' : ' it'} will be permanently deleted.{' '}
            </span>
          )}
          This can’t be undone.
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
