import { useEffect, useRef, useState } from 'react'
import type { SessionInfo, SandboxConfig, SandboxMount } from '@claudette/shared'
import { useSessions } from '../store/sessions'
import { api } from '../api/client'
import { FileBrowser } from './FileBrowser'

// The per-session sandbox chip + popover (see SANDBOX.md). The chip is HONEST:
// it reflects the EFFECTIVE state (`session.sandboxed`), never the mere request,
// so a session that fell back to unconfined never shows a green light. The popover
// toggles confinement and edits the mounts ("what is mounted"); changes apply on
// the next launch, so it offers a one-click relaunch to bring them into force.

type Effective = 'on' | 'off' | 'unavailable'

function effectiveState(session: SessionInfo, hostCanSandbox: boolean): Effective {
  if (!session.sandbox?.enabled) return 'off'
  // Enabled but not actually confined (host lacks bwrap/userns, or not relaunched yet).
  if (session.sandboxed) return 'on'
  return hostCanSandbox ? 'off' /* enabled, will confine on next launch */ : 'unavailable'
}

export function SandboxControl({ session }: { session: SessionInfo }) {
  const { sandboxAvailable, setSandbox } = useSessions()
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)   // folder-picker modal open
  const ref = useRef<HTMLDivElement>(null)

  // The requested config, defaulting to enabled + the session cwd (rw) — mirrors the
  // server's normalizeSandbox so a session with no stored config still shows sensibly.
  const cfg: SandboxConfig = session.sandbox ?? { enabled: true, mounts: [{ path: session.cwd, mode: 'rw' }] }
  const enabled = !!session.sandbox?.enabled
  const eff = effectiveState(session, sandboxAvailable)
  // Server-driven: the running engine's mounts differ from the requested ones. The
  // server auto-applies this the moment the session is idle; it's only visible while
  // a turn is still in flight. (Replaces the old ephemeral local "dirty" flag.)
  const pending = !!session.sandboxPending
  const running = session.state === 'running' || session.state === 'waiting'

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const push = async (next: SandboxConfig) => { await setSandbox(session.id, next) }
  const toggleEnabled = () => push({ ...cfg, enabled: !enabled })
  const setMode = (i: number, mode: 'rw' | 'ro') =>
    push({ ...cfg, mounts: cfg.mounts.map((m, j) => (j === i ? { ...m, mode } : m)) })
  const removeMount = (i: number) => push({ ...cfg, mounts: cfg.mounts.filter((_, j) => j !== i) })
  const addMount = (m: SandboxMount) => push({ ...cfg, mounts: [...cfg.mounts, m] })
  const applyNow = () => { void api.http.relaunchApply(session.id) }

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
        <div className="absolute right-0 z-20 mt-1 w-80 rounded-lg border border-ctp-surface1 bg-ctp-mantle shadow-xl p-3 text-[11px] text-ctp-subtext space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-ctp-text font-medium">Sandbox</span>
            <button
              onClick={toggleEnabled}
              className={`px-2 py-0.5 rounded text-[10px] font-medium ${enabled ? 'bg-ctp-green/20 text-ctp-green' : 'bg-ctp-surface0 text-ctp-overlay'}`}
            >
              {enabled ? 'ON' : 'OFF'}
            </button>
          </div>

          {!sandboxAvailable && (
            <div className="rounded bg-ctp-yellow/10 border border-ctp-yellow/30 text-ctp-yellow px-2 py-1.5 leading-snug">
              This host can’t sandbox yet (bubblewrap/user-namespaces). Run
              <code className="mx-1 text-ctp-text">scripts/enable-sandbox.sh</code>
              then relaunch. Sessions run <b>unconfined</b> until then.
            </div>
          )}

          {enabled && (
            <>
              <div className="text-ctp-overlay leading-snug">
                Claude can read <b>and write</b> the <span className="text-ctp-blue font-mono">rw</span> mounts,
                only <b>read</b> the <span className="text-ctp-subtext font-mono">ro</span> ones, and can’t see
                anything else. Network stays <b>open</b> (loopback + internet).
              </div>
              <div className="space-y-1">
                {cfg.mounts.length === 0 && <div className="text-ctp-overlay italic">No mounts — nothing writable.</div>}
                {cfg.mounts.map((m, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="font-mono text-ctp-text truncate flex-1" title={m.path}>
                      {m.path.replace(/^\/home\/[^/]+/, '~')}
                      {m.path === session.cwd && <span className="text-ctp-overlay"> (project)</span>}
                    </span>
                    <button
                      onClick={() => setMode(i, m.mode === 'rw' ? 'ro' : 'rw')}
                      className={`px-1.5 rounded text-[10px] font-mono ${m.mode === 'rw' ? 'bg-ctp-blue/20 text-ctp-blue' : 'bg-ctp-surface0 text-ctp-subtext'}`}
                      title={m.mode === 'rw' ? 'Writable — click for read-only' : 'Read-only — click for writable'}
                    >
                      {m.mode}
                    </button>
                    <button onClick={() => removeMount(i)} className="text-ctp-overlay hover:text-ctp-red px-0.5" title="Remove mount">×</button>
                  </div>
                ))}
              </div>
              <button
                onClick={() => setPicking(true)}
                className="w-full rounded border border-dashed border-ctp-surface2 text-ctp-subtext hover:text-ctp-text hover:border-ctp-overlay py-1"
              >
                + Add a folder…
              </button>
            </>
          )}

          {/* Pending changes auto-apply the moment the session is idle. While a turn
              is running the relaunch waits — offer to apply now (ends the turn). */}
          {pending && running && (
            <div className="flex items-center gap-2">
              <span className="text-ctp-yellow flex-1">Changes apply when this turn ends.</span>
              <button
                onClick={applyNow}
                className="rounded bg-ctp-blue/20 text-ctp-blue hover:bg-ctp-blue/30 px-2 py-0.5 font-medium"
              >
                Apply now
              </button>
            </div>
          )}
          {pending && !running && <div className="text-ctp-overlay animate-pulse">Applying changes…</div>}
          {!pending && enabled && !session.sandboxed && sandboxAvailable && (
            <div className="text-ctp-overlay">Applies on next launch — relaunch the session to confine it.</div>
          )}
        </div>
      )}

      {picking && (
        <FileBrowser
          mode="folder"
          initialPath={session.cwd}
          onClose={() => setPicking(false)}
          onPick={(p) => {
            setPicking(false)
            // Added folders default to read-only (the safe default for a reference
            // dir); flip to rw with the per-mount toggle. Skip exact duplicates.
            if (!cfg.mounts.some((m) => m.path === p)) void addMount({ path: p, mode: 'ro' })
          }}
        />
      )}
    </div>
  )
}
