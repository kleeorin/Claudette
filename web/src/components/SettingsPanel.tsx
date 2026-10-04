import { useCallback, useEffect, useState } from 'react'
import type { PermissionMode } from '@claudette/shared'
// ★ FROM shared, NOT from settingsLogic, and that asymmetry is deliberate. settingsLogic
// still holds its own 12/1 from the weeks when `shared/` was not writable here; this default
// arrived with the server half, so there is no local copy of it to prefer and making one
// would be the third figure the note below exists to avoid. The two mirrored bounds are a
// known debt — see the DELETE-THIS-FILE banner in lib/settingsContract.ts, now due.
import { DEFAULT_MAX_TEAM_SIZE } from '@claudette/shared'
import { api } from '../api/client'
import { useSessions } from '../store/sessions'
import type { AppSettings, AppSettingsResponse, SettingsOverride } from '../lib/settingsContract'
import {
  isLocked, overrideFor, parseTeamSize, MODEL_ALIASES, isCustomModel,
  MAX_TEAM_SIZE_LIMIT, MIN_TEAM_SIZE,
} from '../lib/settingsLogic'

// System-wide Claudette settings — defaults applied to NEW sessions, plus a read-only view of
// the environment this server is running in.
//
// WHICH controls are locked is decided by `isLocked` in lib/settingsLogic.ts, off the server's
// `overrides` array. That is the rule most worth keeping honest here, so it lives where it can
// be asserted without a DOM.
//
// ★ STATE IS CARRIED ON `data-setting` / `aria-disabled` / `data-locked-by`, not in the copy.

const PERMISSION_MODES: { id: PermissionMode; label: string }[] = [
  { id: 'default', label: 'ask each time' },
  { id: 'acceptEdits', label: 'auto-accept edits' },
  { id: 'plan', label: 'plan only' },
  { id: 'bypassPermissions', label: 'bypass permissions' },
]

// One row per setting, so the locked treatment is applied in ONE place. Duplicating it per
// control is how one control ends up editable under an override that disables the others.
function Row(
  { name, label, note, overrides, children }:
  { name: keyof AppSettings; label: string; note?: string; overrides: SettingsOverride[]; children: (locked: boolean) => React.ReactNode },
) {
  const ov = overrideFor(name, overrides)
  const locked = isLocked(name, overrides)
  return (
    <div data-setting={name} data-locked-by={ov?.env} aria-disabled={locked} className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-ctp-text font-medium">{label}</span>
        {ov && (
          // ★ SAY WHICH VARIABLE AND WHAT VALUE. "Managed elsewhere" leaves the operator
          // hunting; naming the variable makes the next step obvious, and showing the value
          // means they can tell whether it is even the one they wanted.
          <span data-testid={`override-${name}`} className="text-[10px] px-1 rounded bg-ctp-yellow/15 text-ctp-yellow">
            set by environment ({ov.env}={ov.value})
          </span>
        )}
      </div>
      {children(locked)}
      {note && <div className="text-ctp-overlay leading-snug">{note}</div>}
    </div>
  )
}

export function SettingsPanel() {
  const { agents } = useSessions()
  const [data, setData] = useState<AppSettingsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [teamRaw, setTeamRaw] = useState('')
  const [teamErr, setTeamErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.http.appSettings()
      setData(r)
      setTeamRaw(r.settings.maxTeamSize === undefined ? '' : String(r.settings.maxTeamSize))
    } catch { setError('Could not load settings.') }
  }, [])
  useEffect(() => { void load() }, [load])

  const apply = async (r: (AppSettingsResponse & { error?: string }) | undefined) => {
    setBusy(false)
    if (r?.error) { setError(r.error); return }
    if (r?.settings) setData(r)
  }

  // ★ SET AND CLEAR ARE TWO VERBS, AND THE ROUTING LIVES HERE SO EVERY CONTROL AGREES.
  // `save` never clears — see the two-verbs note in lib/settingsContract.ts — so a control
  // offering "no preference" has to call `reset`, not send a null. Doing that decision once
  // is the same argument as `Row` applying the locked treatment once: four controls each
  // choosing their own verb is how one of them ends up sending a null the server does not
  // accept, and it would fail only for the field nobody clears often.
  const setValue = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setBusy(true); setError(null)
    await apply(await api.http.saveAppSettings({ [key]: value } as Partial<AppSettings>))
  }
  const clearValue = async (key: keyof AppSettings) => {
    setBusy(true); setError(null)
    await apply(await api.http.resetAppSetting(key))
  }
  // Convenience for the controls whose "empty" means "no preference".
  const setOrClear = <K extends keyof AppSettings>(key: K, value: AppSettings[K] | undefined) =>
    value === undefined ? void clearValue(key) : void setValue(key, value)

  // ★ THE ERROR STATE OUTRANKS THE LOADING STATE, and getting that order wrong is what made a
  // failed load indistinguishable from a slow one — FOREVER, since nothing retries.
  // `load` sets `error` and leaves `data` null, so an early `if (!data)` that returned only
  // "Loading settings…" meant the "Could not load settings." branch further down could never
  // render: it sits inside the main return, which a null `data` never reaches. The message was
  // written, correct, and dead.
  //
  // This is the same shape as the bug it follows, one layer up. There, a failed request did not
  // present as a failure to the component (`get` returned the 404 body as if it were the
  // success type); here, a failure that DID reach the component still did not present as a
  // failure to the user. Fixing the first only moved the silence.
  if (!data) {
    return error
      ? <div data-testid="settings-error" className="text-ctp-red/90">{error}</div>
      : <div data-testid="settings-loading" className="text-ctp-overlay">Loading settings…</div>
  }
  const { settings, overrides, environment } = data

  const commitTeamSize = () => {
    const r = parseTeamSize(teamRaw)
    if ('error' in r) { setTeamErr(r.error); return }
    setTeamErr(null)
    // parseTeamSize returns null for an empty entry — "no preference" — which is a CLEAR,
    // not a save of null.
    setOrClear('maxTeamSize', r.value === null ? undefined : r.value)
  }

  return (
    <div className="space-y-4 text-xs">
      {error && <div data-testid="settings-error" className="text-ctp-red/90">{error}</div>}

      <Row name="defaultModel" label="Default model" overrides={overrides}
        note="Applies to sessions created from now on. An alias tracks the latest model in that family; a full id pins one and will not move.">
        {(locked) => (
          <div className="flex flex-wrap items-center gap-1.5">
            {/* ★ "let the CLI choose" IS A REAL OPTION, NOT A PLACEHOLDER. Absent is what
                every existing install has today, so preselecting an alias would change the
                model for every new session the first time anyone saved anything here. */}
            <button
              type="button" disabled={locked || busy} data-testid="model-unset"
              aria-pressed={settings.defaultModel === undefined}
              onClick={() => void clearValue('defaultModel')}
              className={`px-2 py-0.5 rounded ${settings.defaultModel === undefined ? 'bg-ctp-accent/20 text-ctp-accent' : 'bg-ctp-surface0 text-ctp-subtext'} disabled:opacity-40`}
            >let the CLI choose</button>
            {MODEL_ALIASES.map((m) => (
              <button
                key={m} type="button" disabled={locked || busy} data-testid={`model-${m}`}
                aria-pressed={settings.defaultModel === m}
                onClick={() => void setValue('defaultModel', m)}
                className={`px-2 py-0.5 rounded ${settings.defaultModel === m ? 'bg-ctp-accent/20 text-ctp-accent' : 'bg-ctp-surface0 text-ctp-subtext'} disabled:opacity-40`}
              >{m}</button>
            ))}
            <input
              type="text" disabled={locked || busy} data-testid="model-custom"
              defaultValue={isCustomModel(settings.defaultModel) ? settings.defaultModel : ''}
              placeholder="or a full model id"
              onBlur={(e) => { const v = e.target.value.trim(); if (v !== (settings.defaultModel ?? '')) setOrClear('defaultModel', v === '' ? undefined : v) }}
              className="px-1.5 py-0.5 rounded bg-ctp-base border border-ctp-surface1 text-ctp-text w-48 disabled:opacity-40"
            />
          </div>
        )}
      </Row>

      <Row name="defaultAgentId" label="Default role for new sessions" overrides={overrides}
        note="Used when a new session does not name a role of its own. A teammate hired by a coordinator keeps the role it was hired with and ignores this.">
        {(locked) => (
          <select
            disabled={locked || busy} data-testid="default-agent"
            value={settings.defaultAgentId ?? ''}
            onChange={(e) => setOrClear('defaultAgentId', e.target.value === '' ? undefined : e.target.value)}
            className="px-1.5 py-0.5 rounded bg-ctp-base border border-ctp-surface1 text-ctp-text disabled:opacity-40"
          >
            <option value="">general (built-in default)</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </Row>

      {/* ★ WHY THIS CONTROL OFFERS NO "allow all": the server REFUSES to store an elevated
          mode as a default, on save and again on load, so a hand-edited settings file cannot
          plant one either. Saying so here means a user who expected the option learns why
          rather than assuming the list is incomplete. */}
      <Row name="defaultPermissionMode" label="Default permission mode" overrides={overrides}
        note="Used when a new session does not specify one. Elevated modes cannot be stored as a default — allow-all is a live decision and has to be granted per session, so only the prompting modes appear here.">
        {(locked) => (
          <select
            disabled={locked || busy} data-testid="default-permission-mode"
            value={settings.defaultPermissionMode ?? ''}
            onChange={(e) => setOrClear('defaultPermissionMode', e.target.value === '' ? undefined : (e.target.value as PermissionMode))}
            className="px-1.5 py-0.5 rounded bg-ctp-base border border-ctp-surface1 text-ctp-text disabled:opacity-40"
          >
            <option value="">ask each time (built-in default)</option>
            {PERMISSION_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        )}
      </Row>

      {/* ★ THE NOTE IS THE FEATURE HERE, not decoration. The cap is checked when HIRING and
          nowhere else: boot restore bypasses it, so lowering this below the current roster
          keeps every existing teammate, across restarts. An operator reads "team size" as a
          bound on what their machine will run, and if we do not say otherwise the setting
          quietly under-delivers exactly the reassurance it exists to provide. */}
      {/* ★ THE "NOT YET ENFORCED" CAVEAT IS GONE BECAUSE IT CAME TRUE. Hiring now resolves
          this stored setting per hire — server/src/mcp/teamTools.ts calls resolveMaxTeamSize()
          inside the handler rather than caching a constant at module load — so a saved value
          binds the very next hire with no restart. The caveat asserting the opposite is now
          the false statement, which is the failure this note was rewritten to end.
          What REPLACES it is the one thing an operator still cannot see: UNSET IS 6, not the
          12 the range implies. Every install is unset today, so "blank" is the branch they are
          all on, and a panel that shows a 1–12 range while silently behaving as 6 recreates
          exactly the mismatch we just closed. Say the number, and take it from the shared
          constant the server resolves against rather than typing 6 in here.
          The new-hires-only sentence stays: the cap is tested at hire time against the current
          roster and boot restore never consults it, so lowering this keeps every teammate
          already employed, across restarts. That is unchanged by the wiring. */}
      <Row name="maxTeamSize" label="Maximum team size" overrides={overrides}
        note={`Obeyed from the next hire onwards — no restart needed. Left unset it is ${DEFAULT_MAX_TEAM_SIZE}, not ${MAX_TEAM_SIZE_LIMIT}. Limits NEW HIRES only — it never dismisses anyone, including after a restart. Accepts ${MIN_TEAM_SIZE}–${MAX_TEAM_SIZE_LIMIT}.`}>
        {(locked) => (
          <div className="flex items-center gap-2">
            <input
              type="text" inputMode="numeric" disabled={locked || busy} data-testid="max-team-size"
              value={teamRaw} placeholder="unset"
              onChange={(e) => setTeamRaw(e.target.value)}
              onBlur={commitTeamSize}
              className="px-1.5 py-0.5 rounded bg-ctp-base border border-ctp-surface1 text-ctp-text w-20 disabled:opacity-40"
            />
            {teamErr && <span data-testid="team-size-error" className="text-ctp-red/90">{teamErr}</span>}
          </div>
        )}
      </Row>

      {/* ★ READ-ONLY, AND NOT "editable, takes effect on restart". HOST and PORT are read once
          at module load, so a control here would do nothing until a restart — the same silent
          no-op as an enabled control under an env override. HOST is also security-relevant: a
          non-loopback bind without a token fail-closes at startup, which is not a thing to
          offer casually in a settings box. */}
      {/* ★ RENDERED ONLY IF THE SERVER SENT IT, and the guard is not defensive padding.
          `environment` is typed as required, but this object came off the wire through
          JSON.parse — the type is an assertion about a server, not a fact about a value, and
          the server half of these routes did not exist when this was written. Reading
          `environment.host` on an undefined threw exactly that: "Cannot read properties of
          undefined (reading 'host')".
          What makes it worth a guard rather than a shrug is WHERE the boundary is: the only
          ErrorBoundary is at the ROOT, wrapping <App/> in main.tsx. So a throw here does not
          degrade the settings panel — it blanks the whole application and the user has to
          reload. A read-only facts block is never worth the entire app. */}
      {environment && (
      <div data-testid="environment-panel" className="pt-2 border-t border-ctp-surface0 space-y-1">
        <div className="text-ctp-text font-medium">Environment</div>
        <div className="text-ctp-overlay leading-snug">
          Read-only. These are fixed when the server starts; change them where you launch it.
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-ctp-subtext">
          <dt>host</dt><dd data-testid="env-host" className="text-ctp-text">{environment.host}</dd>
          <dt>port</dt><dd data-testid="env-port" className="text-ctp-text">{environment.port}</dd>
          <dt>data dir</dt><dd data-testid="env-data-dir" className="text-ctp-text break-all">{environment.dataDir}</dd>
        </dl>
        {/* Computed from the LIVE port, and matched exactly by the provider — a hand-typed
            guess produces `redirect_uri_mismatch`, which names nothing useful. */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-ctp-overlay">OAuth redirect URI:</span>
          <code data-testid="env-redirect-uri" className="font-mono text-ctp-text break-all">{environment.oauthRedirectUri}</code>
          <button
            type="button" aria-label="Copy the redirect URI" title="Copy the redirect URI"
            onClick={() => { void navigator.clipboard?.writeText(environment.oauthRedirectUri).then(() => setCopied(true)).catch(() => setCopied(false)) }}
            className="px-1.5 rounded bg-ctp-surface0 text-ctp-subtext hover:text-ctp-text"
          >{copied ? 'copied' : 'copy'}</button>
        </div>
      </div>
      )}
    </div>
  )
}
