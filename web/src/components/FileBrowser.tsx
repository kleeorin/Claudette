import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { Overlay } from './Overlay'
import { api } from '../api/client'
import { crumbs, joinPath } from '../lib/paths'
import { errText } from '../lib/errText'
import type { DirEntry } from '@claudette/shared'
import { useEscape } from '../lib/useDismiss'
import { FileIcon } from './FileIcon'

// A navigable FOLDER picker — choose a directory (a session's working dir, a sandbox
// mount). Files are hidden; read-only browsing over GET /api/fs/list, and the caller
// acts on the picked path.
//
// It used to carry a second 'notebook' mode (pick an .ipynb, or name a new one). Every
// call site passed mode="folder": FileManager owns notebook creation now, so the mode
// prop, the selection/new-name state and the create footer were all unreachable.
interface Props {
  initialPath: string
  onPick: (path: string) => void
  onClose: () => void
  // Caller-owned controls in the action row, so a picker can carry a decision that
  // belongs WITH the pick (e.g. the sandbox's rw/ro mode) instead of making the user
  // set it afterwards. The caller reads its own state in onPick.
  accessory?: ReactNode
  confirmLabel?: string
}

export function FileBrowser({ initialPath, onPick, onClose, accessory, confirmLabel }: Props) {
  const [dir, setDir] = useState(initialPath)
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showHidden, setShowHidden] = useState(false)

  // try/finally: `api.fs.list` REJECTS on a dropped connection or a non-JSON body, and
  // an unguarded rejection left `loading` true — the picker stuck on "Loading…" with a
  // ⟳ button that called this same function and died the same way.
  const load = useCallback(async (path?: string) => {
    setLoading(true); setErr(null)
    try {
      const res = await api.fs.list(path)
      if ('error' in res && res.error) { setErr(res.error); return }
      if (!('error' in res)) { setDir(res.path); setEntries(res.entries) }
    } catch (e) {
      setErr(errText(e, 'could not list this folder'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(initialPath) }, [initialPath, load])
  useEscape(onClose)

  const visible = entries.filter((e) => showHidden || !e.name.startsWith('.')).filter((e) => e.isDir)

  // Portal to <body>: this browser is often opened from inside the sidebar/dialog
  // subtree, and a transformed ancestor (the aside's drawer transform) would make
  // `position: fixed` resolve against that 288px box and clip the modal.
  //
  // The portal, the backdrop and `data-overlay-layer` now come from <Overlay>. That marker is
  // load-bearing — an opener that dismisses itself on an outside click sees clicks in here as
  // outside, because the portal is not a DOM descendant of whatever opened it; see
  // SandboxControl, where its absence made the chip's folder picker unusable. It lives in
  // Overlay.tsx so it cannot be forgotten by the next portal anyone writes.
  return (
    <Overlay onClose={onClose}>
      <div
        className="w-[560px] max-w-[calc(100vw-2rem)] h-[560px] max-h-[calc(100vh-3rem)] flex flex-col rounded-xl border border-ctp-surface1 bg-ctp-mantle shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 h-12 border-b border-ctp-surface0 shrink-0">
          <span className="text-sm font-semibold text-ctp-text">Choose a folder</span>
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
          {!loading && !err && visible.map((e) => (
            <button
              key={e.name}
              onClick={() => void load(joinPath(dir, e.name))}
              className="w-full flex items-center gap-2.5 px-5 py-1.5 text-left text-[13px] transition-colors hover:bg-ctp-surface0 text-ctp-subtext"
            >
              <FileIcon kind="folder" />
              <span className="truncate font-mono">{e.name}</span>
              <span className="ml-auto text-ctp-surface2 text-xs">›</span>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="border-t border-ctp-surface0 shrink-0">
          <div className="flex items-center gap-2 px-5 py-3.5">
            <span className="text-[11px] text-ctp-overlay font-mono truncate flex-1 min-w-0" title={dir}>{dir}</span>
            {accessory}
            <button onClick={onClose} className="text-xs px-3.5 py-1.5 rounded-md text-ctp-subtext hover:bg-ctp-surface0 transition-colors">
              Cancel
            </button>
            <button
              onClick={() => onPick(dir)}
              className="text-xs font-medium px-4 py-1.5 rounded-md bg-ctp-accent text-ctp-base hover:brightness-110 active:brightness-95 transition"
            >
              {confirmLabel ?? 'Use this folder'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  )
}
