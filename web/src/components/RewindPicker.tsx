import { useEffect, useState } from 'react'
import type { RewindPoint, RewindMode, RewindPreview } from '@claudette/shared'
import { api } from '../api/client'

// Native replacement for the TUI's `/rewind` (unavailable in headless stream-json
// mode). Two steps: pick a past user turn, then choose what to restore —
//   • Chat    — fork the transcript to before the turn and continue from there
//   • Code    — restore the working tree to that turn's snapshot
//   • Both    — do both
// Conversation rewind is non-destructive (the original is an untouched fork, undoable
// via /resume). Code restore overwrites working files, so it shows a preview + confirm
// first. Code is offered only for turns that have a snapshot (git repos, turns taken
// since Phase 2 shipped). Sibling of ResumePicker; the parent runs the actual rewind.
export function RewindPicker({
  sessionId, onPick, onClose,
}: {
  sessionId: string
  onPick: (point: RewindPoint, mode: RewindMode, deleteNewer: boolean) => void
  onClose: () => void
}) {
  const [list, setList] = useState<RewindPoint[] | null>(null)
  const [selected, setSelected] = useState<RewindPoint | null>(null)

  useEffect(() => {
    let live = true
    api.http.rewindPoints(sessionId).then((l) => { if (live) setList(l) }).catch(() => { if (live) setList([]) })
    return () => { live = false }
  }, [sessionId])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (selected) setSelected(null); else onClose() } }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, selected])

  // Newest turn first: rewinding to a recent turn is the common case.
  const ordered = list ? [...list].reverse() : null

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center pt-16 bg-ctp-crust/60" onClick={onClose}>
      <div
        className="w-[min(640px,90%)] max-h-[70%] flex flex-col rounded-lg border border-ctp-surface1 bg-ctp-mantle shadow-pop overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {selected ? (
          <RewindConfirm
            sessionId={sessionId}
            point={selected}
            onBack={() => setSelected(null)}
            onConfirm={(mode, deleteNewer) => onPick(selected, mode, deleteNewer)}
          />
        ) : (
          <>
            <div className="px-4 py-2.5 border-b border-ctp-surface0">
              <div className="text-sm font-medium text-ctp-text">Rewind the conversation</div>
              <div className="text-[11px] text-ctp-overlay mt-0.5">Pick a turn to return to — it and everything after drop away. You choose next whether to restore the chat, the code, or both.</div>
            </div>
            <div className="overflow-y-auto">
              {ordered === null && <div className="px-4 py-6 text-xs text-ctp-overlay text-center">Loading…</div>}
              {ordered?.length === 0 && (
                <div className="px-4 py-6 text-xs text-ctp-overlay text-center">No earlier turns to rewind to.</div>
              )}
              {ordered?.map((p) => (
                <button
                  key={p.uuid}
                  onClick={() => setSelected(p)}
                  className="w-full text-left px-4 py-2.5 border-b border-ctp-surface0/50 hover:bg-ctp-surface0/60 transition-colors"
                >
                  <div className="flex items-baseline gap-3">
                    <span className="shrink-0 text-[10px] font-mono text-ctp-overlay">#{p.ordinal}</span>
                    <span className="flex-1 text-[13px] text-ctp-text truncate">{firstLine(p.text)}</span>
                    {p.hasSnapshot && <span className="shrink-0 text-[9px] uppercase tracking-wide text-ctp-green/80" title="A code snapshot exists for this turn">code</span>}
                    {p.mtimeMs > 0 && <span className="shrink-0 text-[10px] text-ctp-overlay">{ago(p.mtimeMs)}</span>}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Step 2: choose what to restore for the selected turn, with a live preview + confirm
// when code is involved.
function RewindConfirm({
  sessionId, point, onBack, onConfirm,
}: {
  sessionId: string
  point: RewindPoint
  onBack: () => void
  onConfirm: (mode: RewindMode, deleteNewer: boolean) => void
}) {
  const [mode, setMode] = useState<RewindMode>('conversation')
  const [deleteNewer, setDeleteNewer] = useState(true)
  const [preview, setPreview] = useState<RewindPreview | null | 'loading'>(null)
  const wantsCode = mode === 'code' || mode === 'both'

  // Fetch the code-restore preview whenever a code mode is active. Skipped for a plain
  // chat rewind (nothing on disk changes).
  useEffect(() => {
    if (!wantsCode) { setPreview(null); return }
    let live = true
    setPreview('loading')
    api.http.rewindPreview(sessionId, point.uuid)
      .then((p) => { if (live) setPreview(p) })
      .catch(() => { if (live) setPreview(null) })
    return () => { live = false }
  }, [sessionId, point.uuid, wantsCode])

  const modes: { key: RewindMode; label: string; hint: string; disabled?: boolean }[] = [
    { key: 'conversation', label: 'Chat', hint: 'Rewind the conversation only' },
    { key: 'code', label: 'Code', hint: point.hasSnapshot ? 'Restore files only' : 'No snapshot for this turn', disabled: !point.hasSnapshot },
    { key: 'both', label: 'Both', hint: point.hasSnapshot ? 'Chat + files' : 'No snapshot for this turn', disabled: !point.hasSnapshot },
  ]

  return (
    <>
      <div className="px-4 py-2.5 border-b border-ctp-surface0 flex items-center gap-2">
        <button onClick={onBack} className="text-ctp-overlay hover:text-ctp-text text-sm" title="Back to the turn list">←</button>
        <div className="min-w-0">
          <div className="text-sm font-medium text-ctp-text truncate">Rewind to #{point.ordinal}</div>
          <div className="text-[11px] text-ctp-overlay truncate">{firstLine(point.text)}</div>
        </div>
      </div>

      <div className="px-4 py-3 space-y-3 overflow-y-auto">
        <div className="grid grid-cols-3 gap-2">
          {modes.map((m) => (
            <button
              key={m.key}
              disabled={m.disabled}
              onClick={() => setMode(m.key)}
              title={m.hint}
              className={
                'rounded-md border px-2 py-1.5 text-xs transition-colors ' +
                (m.disabled
                  ? 'border-ctp-surface0 text-ctp-overlay/50 cursor-not-allowed'
                  : mode === m.key
                    ? 'border-ctp-mauve bg-ctp-mauve/15 text-ctp-text'
                    : 'border-ctp-surface1 text-ctp-subtext hover:bg-ctp-surface0/60')
              }
            >
              <div className="font-medium">{m.label}</div>
              <div className="text-[10px] text-ctp-overlay mt-0.5 leading-tight">{m.hint}</div>
            </button>
          ))}
        </div>

        {/* Chat effect — always applies. */}
        {(mode === 'conversation' || mode === 'both') && (
          <div className="text-[11px] text-ctp-subtext">
            The conversation forks to just before this turn and continues from there. The original is kept (undo via <span className="font-mono">/resume</span>).
          </div>
        )}

        {/* Code effect — preview + the destructive knob. */}
        {wantsCode && (
          <div className="rounded-md border border-ctp-surface0 bg-ctp-base/50 px-3 py-2 text-[11px]">
            {preview === 'loading' && <div className="text-ctp-overlay">Checking what would change…</div>}
            {preview === null && <div className="text-ctp-overlay">No snapshot available for this turn.</div>}
            {preview && preview !== 'loading' && (
              <div className="space-y-1.5">
                <div className="text-ctp-subtext">
                  <span className="text-ctp-peach font-medium">{preview.reverted.length}</span> file{preview.reverted.length === 1 ? '' : 's'} will be reverted to this turn's snapshot.
                </div>
                {preview.deleted.length > 0 && (
                  <label className="flex items-start gap-2 text-ctp-subtext cursor-pointer">
                    <input type="checkbox" checked={deleteNewer} onChange={(e) => setDeleteNewer(e.target.checked)} className="mt-0.5 accent-ctp-red" />
                    <span>
                      Also delete <span className="text-ctp-red font-medium">{preview.deleted.length}</span> file{preview.deleted.length === 1 ? '' : 's'} created since (untracked). Unchecked, they're left in place.
                    </span>
                  </label>
                )}
                {preview.reverted.length === 0 && preview.deleted.length === 0 && (
                  <div className="text-ctp-overlay">The working tree already matches this snapshot — nothing to restore.</div>
                )}
                <div className="text-ctp-overlay pt-0.5">Your branch, HEAD, and staged changes are not touched — only file contents.</div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="px-4 py-2.5 border-t border-ctp-surface0 flex items-center justify-end gap-2">
        <button onClick={onBack} className="px-3 py-1.5 text-xs text-ctp-subtext hover:text-ctp-text">Cancel</button>
        <button
          onClick={() => onConfirm(mode, deleteNewer)}
          disabled={wantsCode && (preview === 'loading' || preview === null)}
          className="px-3 py-1.5 text-xs rounded-md bg-ctp-mauve/90 text-ctp-crust font-medium hover:bg-ctp-mauve disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {mode === 'conversation' ? 'Rewind chat' : mode === 'code' ? 'Restore code' : 'Rewind both'}
        </button>
      </div>
    </>
  )
}

// A prompt can be multi-line; rows show only its first non-empty line.
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? text
  return line.trim()
}

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`
  return `${Math.floor(h / 24)}d ago`
}
