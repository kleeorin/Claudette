import { useEscape } from '../lib/useDismiss'
import { Overlay } from './Overlay'

// Confirm gate for the "Allow all" (bypassPermissions) mode — shared by the chat
// mode dropdown and the Permissions panel so the guard + wording are identical
// wherever you flip it. Escape or click-outside cancels.
export function BypassConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  useEscape(onCancel)

  return (
    <Overlay onClose={onCancel}>
      <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border border-ctp-red/40 bg-ctp-mantle shadow-pop p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold text-ctp-red mb-1">Allow all tools?</div>
        <div className="text-xs text-ctp-subtext mb-4 leading-relaxed">
          Claude will run <b>every tool — edits, shell commands, deletes — without asking</b> for the rest of this
          session. Fine inside a sandbox; risky otherwise. You can switch back to Prompt anytime.
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded-md text-ctp-subtext hover:bg-ctp-surface0 transition">Cancel</button>
          <button onClick={onConfirm} className="text-xs px-3 py-1.5 rounded-md bg-ctp-red/20 text-ctp-red font-medium hover:bg-ctp-red/30 transition">Allow all</button>
        </div>
      </div>
    </Overlay>
  )
}
