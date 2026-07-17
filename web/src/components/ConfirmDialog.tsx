import { useEffect } from 'react'
import { createPortal } from 'react-dom'

// Generic "are you sure?" gate. Mirrors BypassConfirmDialog's look/behaviour
// (Escape or click-outside cancels) but takes its wording from props so any
// destructive action can reuse it. `danger` tints the confirm button red.
export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string
  body: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const confirmClass = danger
    ? 'bg-ctp-red/20 text-ctp-red hover:bg-ctp-red/30'
    : 'bg-ctp-accent/20 text-ctp-accent hover:bg-ctp-accent/30'

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onCancel}>
      <div className={`w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border ${danger ? 'border-ctp-red/40' : 'border-ctp-surface1'} bg-ctp-mantle shadow-pop p-5`} onClick={(e) => e.stopPropagation()}>
        <div className={`text-sm font-semibold mb-1 ${danger ? 'text-ctp-red' : 'text-ctp-text'}`}>{title}</div>
        <div className="text-xs text-ctp-subtext mb-4 leading-relaxed">{body}</div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md text-ctp-subtext hover:bg-ctp-surface0 transition">{cancelLabel}</button>
          <button onClick={onConfirm} className={`text-xs px-3 py-1.5 rounded-md font-medium transition ${confirmClass}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
