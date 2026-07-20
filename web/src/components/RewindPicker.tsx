import { useEffect, useState } from 'react'
import type { RewindPoint } from '@claudette/shared'
import { api } from '../api/client'

// Native replacement for the TUI's `/rewind` (unavailable in headless stream-json
// mode) — lists the current conversation's past user turns and lets you rewind to
// just before one. Picking forks the transcript truncated at that turn into a new
// conversation and resumes into it, so you continue from there; everything from the
// selected turn onward drops away. Non-destructive: the original conversation is an
// untouched fork you can return to via /resume. Sibling of ResumePicker.
export function RewindPicker({
  sessionId, onPick, onClose,
}: {
  sessionId: string
  onPick: (point: RewindPoint) => void
  onClose: () => void
}) {
  const [list, setList] = useState<RewindPoint[] | null>(null)

  useEffect(() => {
    let live = true
    api.http.rewindPoints(sessionId).then((l) => { if (live) setList(l) }).catch(() => { if (live) setList([]) })
    return () => { live = false }
  }, [sessionId])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  // Newest turn first: rewinding to a recent turn is the common case.
  const ordered = list ? [...list].reverse() : null

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center pt-16 bg-ctp-crust/60" onClick={onClose}>
      <div
        className="w-[min(640px,90%)] max-h-[70%] flex flex-col rounded-lg border border-ctp-surface1 bg-ctp-mantle shadow-pop overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-ctp-surface0">
          <div className="text-sm font-medium text-ctp-text">Rewind the conversation</div>
          <div className="text-[11px] text-ctp-overlay mt-0.5">Pick a turn to return to — it and everything after drop away, and you continue from there. The original is kept (undo via /resume).</div>
        </div>
        <div className="overflow-y-auto">
          {ordered === null && <div className="px-4 py-6 text-xs text-ctp-overlay text-center">Loading…</div>}
          {ordered?.length === 0 && (
            <div className="px-4 py-6 text-xs text-ctp-overlay text-center">No earlier turns to rewind to.</div>
          )}
          {ordered?.map((p) => (
            <button
              key={p.uuid}
              onClick={() => onPick(p)}
              className="w-full text-left px-4 py-2.5 border-b border-ctp-surface0/50 hover:bg-ctp-surface0/60 transition-colors"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="shrink-0 text-[10px] font-mono text-ctp-overlay">#{p.ordinal}</span>
                <span className="flex-1 text-[13px] text-ctp-text truncate">{firstLine(p.text)}</span>
                {p.mtimeMs > 0 && <span className="shrink-0 text-[10px] text-ctp-overlay">{ago(p.mtimeMs)}</span>}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// A prompt can be multi-line; the row shows only its first non-empty line.
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
