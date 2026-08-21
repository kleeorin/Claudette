import { useState } from 'react'
import type { SessionInfo, SandboxConfig, SandboxMount } from '@claudette/shared'
import { useSessions } from '../store/sessions'
import { api } from '../api/client'
import { prettyPath } from '../lib/paths'
import { FileBrowser } from './FileBrowser'
import { ConnectorGrants } from './ConnectorGrants'

// The sandbox editing controls (see SANDBOX.md): enable/disable confinement, edit the
// rw/ro mounts, add a folder, and apply pending changes. Layout-neutral so it can sit
// inside the compact meta-bar popover (SandboxControl) AND the full-height dock panel
// (SandboxPanel) without duplicating the mount logic. Changes apply on the next
// launch; the server auto-applies them the moment the session is idle.
//
// `compact` (the meta-bar popover) trims the explanatory prose to just "what is
// mounted"; the full panel keeps the detail.
export function SandboxEditor({ session, compact = false }: { session: SessionInfo; compact?: boolean }) {
  const { sandboxAvailable, gpuDevices, setSandbox } = useSessions()
  const [picking, setPicking] = useState(false)   // folder-picker modal open
  // Access for the folder about to be added, chosen INSIDE the picker. Defaults to the
  // safe 'ro' each time it opens, so granting write is always a deliberate click.
  const [pickMode, setPickMode] = useState<'rw' | 'ro'>('ro')

  // The requested config, defaulting to enabled + the session cwd (rw) — mirrors the
  // server's normalizeSandbox so a session with no stored config still shows sensibly.
  const cfg: SandboxConfig = session.sandbox ?? { enabled: true, mounts: [{ path: session.cwd, mode: 'rw' }] }
  const enabled = !!session.sandbox?.enabled
  // Server-driven: the running engine's mounts differ from the requested ones. The
  // server auto-applies this the moment the session is idle; only visible mid-turn.
  const pending = !!session.sandboxPending
  const running = session.state === 'running' || session.state === 'waiting'

  // Terminals are host shells unless opted IN per session — this box confines Claude,
  // not the pty the operator drives from the browser (see SandboxConfig).
  const termsConfined = cfg.sandboxTerminals === true

  // GPU passthrough. Offered only where it can do something: this host actually has GPU
  // nodes, or the session already has the flag set (so a config carried over from a GPU
  // host can still be switched off here rather than being stuck invisibly on).
  const gpuOn = cfg.gpu === true
  const showGpu = gpuDevices.length > 0 || gpuOn

  const push = async (next: SandboxConfig) => { await setSandbox(session.id, next) }
  const toggleEnabled = () => push({ ...cfg, enabled: !enabled })
  const toggleTerminals = () => push({ ...cfg, sandboxTerminals: !termsConfined })
  const toggleGpu = () => push({ ...cfg, gpu: !gpuOn })
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
            onClick={() => { setPickMode('ro'); setPicking(true) }}
            className="w-full rounded border border-dashed border-ctp-surface2 text-ctp-subtext hover:text-ctp-text hover:border-ctp-overlay py-1"
          >
            + Add a folder…
          </button>

          {/* Terminals are host shells by DEFAULT (this box only confines Claude);
              ticking this confines them too. Either way it binds at spawn, so it can
              only ever change the NEXT terminal you open — hence the standing note. */}
          <label className="flex items-start gap-2 cursor-pointer select-none pt-0.5">
            <input
              type="checkbox"
              checked={termsConfined}
              onChange={toggleTerminals}
              className="accent-ctp-accent mt-[1px]"
            />
            <span className="leading-snug">
              <span className="text-ctp-text">Sandbox terminals too</span>
              {!compact && (
                <span className="text-ctp-overlay">
                  {' — '}by default a terminal is a <b>full host shell</b> even here:
                  only Claude is confined. Tick this to run shells inside these same
                  mounts.
                </span>
              )}
            </span>
          </label>
          <div className={termsConfined ? 'text-ctp-yellow/90 leading-snug' : 'text-ctp-overlay leading-snug'}>
            Applies to terminals opened <b>from now on</b> — ones already open stay
            {termsConfined ? ' unconfined' : ' as they are'}; close and reopen them.
          </div>

          {/* GPU devices are char nodes, not folders, so they can't come in through the
              mount list above — hence a toggle rather than a path. Unlike every other
              control here this one WIDENS the box, so it's styled as a warning when on. */}
          {showGpu && (
            <>
              <label className="flex items-start gap-2 cursor-pointer select-none pt-0.5">
                <input
                  type="checkbox"
                  checked={gpuOn}
                  onChange={toggleGpu}
                  className="accent-ctp-accent mt-[1px]"
                />
                <span className="leading-snug">
                  <span className="text-ctp-text">Pass through the GPU</span>
                  {!compact && (
                    <span className="text-ctp-overlay">
                      {' — '}without this the box has <b>no GPU at all</b> and CUDA/ROCm
                      report no device, even though this host has one. Covers Claude and
                      this session’s notebook kernels alike.
                    </span>
                  )}
                </span>
              </label>
              {gpuOn && (
                <div className="text-ctp-yellow/90 leading-snug">
                  {gpuDevices.length === 0 ? (
                    <>No GPU devices on this host — the passthrough is a no-op here.</>
                  ) : (
                    <>
                      Bound into the box:{' '}
                      <span className="font-mono text-ctp-text">{gpuDevices.join(' ')}</span>.
                      This is the one setting here that <b>widens</b> confinement — GPU memory
                      isn’t scrubbed between processes, so treat it as shared with the host.
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Connector grants sit OUTSIDE the `enabled` block on purpose: a session's service
          reach matters whether or not it is confined to a filesystem box, and an
          unsandboxed session is exactly the one where you most want to see what external
          servers it can call. The catalog they're drawn from is global (Claudette deck). */}
      <ConnectorGrants session={session} compact={compact} />

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
          confirmLabel={`Mount ${pickMode}`}
          // Pick the access alongside the folder — mounting a drive you intend to write
          // to shouldn't mean adding it read-only and then hunting for the toggle.
          accessory={
            <div className="flex items-center gap-1 shrink-0" title="Read-only, or writable by Claude">
              <span className="text-[11px] text-ctp-overlay">Access</span>
              {(['ro', 'rw'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setPickMode(m)}
                  className={`px-2 py-1 rounded text-[11px] font-mono transition-colors ${
                    pickMode === m
                      ? m === 'rw' ? 'bg-ctp-blue/20 text-ctp-blue' : 'bg-ctp-surface1 text-ctp-text'
                      : 'text-ctp-overlay hover:text-ctp-text'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          }
          onPick={(p) => {
            setPicking(false)
            // Skip exact duplicates; the per-mount toggle still changes access later.
            if (!cfg.mounts.some((m) => m.path === p)) void addMount({ path: p, mode: pickMode })
          }}
        />
      )}
    </div>
  )
}
