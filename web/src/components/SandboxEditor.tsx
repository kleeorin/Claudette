import { useState } from 'react'
import type { SessionInfo, SandboxConfig, SandboxMount } from '@claudette/shared'
import { useSessions } from '../store/sessions'
import { api } from '../api/client'
import { prettyPath } from '../lib/paths'
import { FileBrowser } from './FileBrowser'

// The sandbox editing controls (see SANDBOX.md): enable/disable confinement, edit the
// rw/ro mounts, add a folder, and apply pending changes. Layout-neutral so it can sit
// inside the compact meta-bar popover (SandboxControl) AND the full-height dock panel
// (SandboxPanel) without duplicating the mount logic. Changes apply on the next
// launch; the server auto-applies them the moment the session is idle.
//
// `compact` (the meta-bar popover) trims the explanatory prose to just "what is
// mounted"; the full panel keeps the detail.
export function SandboxEditor({ session, compact = false }: { session: SessionInfo; compact?: boolean }) {
  const { sandboxAvailable, setSandbox } = useSessions()
  const [picking, setPicking] = useState(false)   // folder-picker modal open

  // The requested config, defaulting to enabled + the session cwd (rw) — mirrors the
  // server's normalizeSandbox so a session with no stored config still shows sensibly.
  const cfg: SandboxConfig = session.sandbox ?? { enabled: true, mounts: [{ path: session.cwd, mode: 'rw' }] }
  const enabled = !!session.sandbox?.enabled
  // Server-driven: the running engine's mounts differ from the requested ones. The
  // server auto-applies this the moment the session is idle; only visible mid-turn.
  const pending = !!session.sandboxPending
  const running = session.state === 'running' || session.state === 'waiting'

  const push = async (next: SandboxConfig) => { await setSandbox(session.id, next) }
  const toggleEnabled = () => push({ ...cfg, enabled: !enabled })
  const setMode = (i: number, mode: 'rw' | 'ro') =>
    push({ ...cfg, mounts: cfg.mounts.map((m, j) => (j === i ? { ...m, mode } : m)) })
  const removeMount = (i: number) => push({ ...cfg, mounts: cfg.mounts.filter((_, j) => j !== i) })
  const addMount = (m: SandboxMount) => push({ ...cfg, mounts: [...cfg.mounts, m] })
  const applyNow = () => { void api.http.relaunchApply(session.id) }

  return (
    <div className="p-3 text-[11px] text-ctp-subtext space-y-2.5">
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
          {!compact && (
            <>
              <div className="text-ctp-overlay leading-snug">
                Claude can read <b>and write</b> the <span className="text-ctp-blue font-mono">rw</span> mounts,
                only <b>read</b> the <span className="text-ctp-subtext font-mono">ro</span> ones, and can’t see
                anything else. Network stays <b>open</b> (loopback + internet).
              </div>
              <div className="text-ctp-overlay leading-snug">
                Always mounted <span className="text-ctp-blue font-mono">rw</span>: Claude’s global config
                (<span className="font-mono">~/.claude</span>) and this project’s
                <span className="font-mono"> .claude</span> — so config + memory survive even if you set the
                project folder read-only or remove it below.
              </div>
              <div className="text-ctp-yellow/90 leading-snug">
                Heads-up: <span className="font-mono">~/.claude</span> also holds your Claude credentials and
                <b> every</b> project’s transcripts + memory, so a sandboxed session can still <b>read</b> all of
                that. This confines the <b>workspace</b>, not your secrets.
              </div>
            </>
          )}
          {compact && <div className="text-ctp-overlay leading-snug">Mounted (writable <span className="text-ctp-blue font-mono">rw</span> / read-only <span className="font-mono">ro</span>):</div>}
          <div className="space-y-1">
            {cfg.mounts.length === 0 && <div className="text-ctp-overlay italic">No mounts — nothing writable.</div>}
            {cfg.mounts.map((m, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className="font-mono text-ctp-text truncate flex-1" title={m.path}>
                  {prettyPath(m.path)}
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

      {/* Pending changes auto-apply the moment the session is idle. While a turn is
          running the relaunch waits — offer to apply now (ends the turn). */}
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
