import { useEffect, useState } from 'react'
import type { ConversationMeta } from '@claudette/shared'
import { api } from '../api/client'

// Native replacement for the TUI's `/resume` — lists past conversations for the
// session's working directory (from ~/.claude/projects/<cwd>/*.jsonl) and lets you
// pick one to continue. Picking rebinds the session's engine via --resume and
// replays the transcript. Ported from ClaudeMaster (window.api → HTTP).
export function ResumePicker({
  cwd, onPick, onClose,
}: {
  cwd: string
  onPick: (meta: ConversationMeta) => void
  onClose: () => void
}) {
  const [list, setList] = useState<ConversationMeta[] | null>(null)

  useEffect(() => {
    let live = true
    api.http.listConversations(cwd).then((l) => { if (live) setList(l) }).catch(() => { if (live) setList([]) })
    return () => { live = false }
  }, [cwd])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center pt-16 bg-ctp-crust/60" onClick={onClose}>
      <div
        className="w-[min(640px,90%)] max-h-[70%] flex flex-col rounded-lg border border-ctp-surface1 bg-ctp-mantle shadow-pop overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-ctp-surface0 flex items-center justify-between">
          <span className="text-sm font-medium text-ctp-text">Resume a conversation</span>
          <span className="text-[11px] text-ctp-overlay font-mono truncate max-w-[60%]">{cwd}</span>
        </div>
        <div className="overflow-y-auto">
          {list === null && <div className="px-4 py-6 text-xs text-ctp-overlay text-center">Loading…</div>}
          {list?.length === 0 && (
            <div className="px-4 py-6 text-xs text-ctp-overlay text-center">No past conversations in this folder.</div>
          )}
          {list?.map((c) => (
            <button
              key={c.id}
              onClick={() => onPick(c)}
              className="w-full text-left px-4 py-2.5 border-b border-ctp-surface0/50 hover:bg-ctp-surface0/60 transition-colors"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-ctp-text truncate">{c.title}</span>
                <span className="shrink-0 text-[10px] text-ctp-overlay">{ago(c.mtimeMs)} · {c.turns} turn{c.turns === 1 ? '' : 's'}</span>
              </div>
              {c.lastPrompt && <div className="text-[11px] text-ctp-subtext truncate mt-0.5">{c.lastPrompt}</div>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`
  return `${Math.floor(h / 24)}d ago`
}
