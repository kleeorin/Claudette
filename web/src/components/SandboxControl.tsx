import { useEffect, useRef, useState } from 'react'
import type { SessionInfo } from '@claudette/shared'
import { useSessions } from '../store/sessions'
import { SandboxEditor } from './SandboxEditor'

// The per-session sandbox chip + popover (see SANDBOX.md). The chip is HONEST:
// it reflects the EFFECTIVE state (`session.sandboxed`), never the mere request,
// so a session that fell back to unconfined never shows a green light. The popover
// wraps the shared SandboxEditor (toggle confinement + edit mounts); the same editor
// also backs the full-height SandboxPanel in the right dock.

type Effective = 'on' | 'off' | 'unavailable'

function effectiveState(session: SessionInfo, hostCanSandbox: boolean): Effective {
  if (!session.sandbox?.enabled) return 'off'
  // Enabled but not actually confined (host lacks bwrap/userns, or not relaunched yet).
  if (session.sandboxed) return 'on'
  return hostCanSandbox ? 'off' /* enabled, will confine on next launch */ : 'unavailable'
}

export function SandboxControl({ session }: { session: SessionInfo }) {
  const { sandboxAvailable } = useSessions()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const eff = effectiveState(session, sandboxAvailable)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const chip = {
    on:          { icon: '🔒', label: 'sandboxed',   cls: 'text-ctp-green',  title: 'Filesystem-isolated · network open. Claude can only write inside the mounts below.' },
    off:         { icon: '○',  label: 'unsandboxed', cls: 'text-ctp-overlay', title: 'No filesystem confinement — Claude can touch anything you can.' },
    unavailable: { icon: '⚠',  label: 'sandbox n/a', cls: 'text-ctp-yellow', title: 'Sandbox requested but this host can’t confine — run scripts/enable-sandbox.sh. Running unconfined.' },
  }[eff]

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 hover:brightness-125 cursor-pointer ${chip.cls}`}
        title={chip.title}
      >
        <span>{chip.icon}</span><span>{chip.label}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1 w-80 rounded-lg border border-ctp-surface1 bg-ctp-mantle shadow-xl">
          <SandboxEditor session={session} compact />
        </div>
      )}
    </div>
  )
}
