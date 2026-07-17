import type { SessionInfo } from '@claudette/shared'
import { SandboxEditor } from './SandboxEditor'

// Sandbox panel — the full-height dock sibling of Files / Git / Permissions. Wraps
// the shared SandboxEditor (the same controls as the meta-bar chip's popover) so you
// can toggle confinement and edit the rw/ro mounts from the right dock. See SANDBOX.md.
export function SandboxPanel({ session, onClose }: { session: SessionInfo; onClose: () => void }) {
  return (
    <div className="flex flex-col h-full bg-ctp-base overflow-hidden">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className="text-ctp-green shrink-0">🔒</span>
        <span className="text-xs font-medium text-ctp-text flex-1 truncate">Sandbox</span>
        <button onClick={onClose} title="Close (back to Chat)" className="text-ctp-overlay hover:text-ctp-text p-1">✕</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <SandboxEditor session={session} />
      </div>
    </div>
  )
}
