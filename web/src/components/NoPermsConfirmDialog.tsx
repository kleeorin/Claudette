import { useEffect } from 'react'
import { createPortal } from 'react-dom'

// Confirm gate for the "No permissions" profile — the strict inverse of "Allow all".
// It strips every `allow` rule from the session's settings files and drops the mode to
// Prompt, so Claude needs explicit approval for every tool. Destructive (removed rules
// aren't stashed), so it's confirm-gated like bypass. Escape or click-outside cancels.
export function NoPermsConfirmDialog({ count, onConfirm, onCancel }: { count: number; onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onCancel}>
      <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border border-ctp-blue/40 bg-ctp-mantle shadow-pop p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold text-ctp-blue mb-1">Switch to “No permissions”?</div>
        <div className="text-xs text-ctp-subtext mb-4 leading-relaxed">
          {count > 0
            ? <>This <b>removes {count} allow rule{count === 1 ? '' : 's'}</b> from your user, project, and local settings and sets the mode to Prompt. </>
            : <>This sets the mode to Prompt (no allow rules are present to remove). </>}
          Claude will then need <b>explicit approval for every tool</b> — nothing runs unasked. Removed rules aren’t
          restored automatically; re-add any you still want.
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md text-ctp-subtext hover:bg-ctp-surface0 transition">Cancel</button>
          <button onClick={onConfirm} className="text-xs px-3 py-1.5 rounded-md bg-ctp-blue/20 text-ctp-blue font-medium hover:bg-ctp-blue/30 transition">
            {count > 0 ? 'Remove allow rules' : 'Set No permissions'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
