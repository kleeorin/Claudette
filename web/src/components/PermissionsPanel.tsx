import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  SessionInfo, EffectivePermissions, PermissionMode, PermissionScope, PermissionAction, PermissionRule,
} from '@claudette/shared'
import { api } from '../api/client'
import { useSessions } from '../store/sessions'
import { BypassConfirmDialog } from './BypassConfirmDialog'
import { NoPermsConfirmDialog } from './NoPermsConfirmDialog'

// Permission Control Center — a GUI over Claude's OWN settings files (see the server
// permissions.ts). Lives in the right dock beside Files / Git. Shows the effective
// mode + the allow/deny/ask rules (tagged by scope) and lets you add/remove them and
// switch the session's permission mode. "Allow all" = the bypassPermissions launch
// flag, guarded behind a confirm since it lets Claude run every tool without asking.

interface Props {
  session: SessionInfo
  onClose: () => void
}

// The four modes, in escalating order of latitude. bypass is the "allow all" flag —
// styled red and confirm-gated.
const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Prompt', hint: 'Ask before each tool use (normal)' },
  { value: 'acceptEdits', label: 'Auto-edit', hint: 'Auto-approve file edits; still prompt for the rest' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning — no edits or commands' },
  { value: 'bypassPermissions', label: 'Allow all', hint: 'Skip ALL prompts — Claude runs every tool unasked' },
]

const SCOPES: { value: PermissionScope; label: string; hint: string }[] = [
  { value: 'local', label: 'Local', hint: 'This project, just you (.claude/settings.local.json — gitignored)' },
  { value: 'project', label: 'Project', hint: 'This project, shared/committed (.claude/settings.json)' },
  { value: 'user', label: 'User', hint: 'You, everywhere (~/.claude/settings.json)' },
]

const ACTIONS: PermissionAction[] = ['allow', 'deny', 'ask']

// Tint an action badge: allow=green, deny=red, ask=yellow.
function actionClass(action: PermissionAction): string {
  return action === 'allow' ? 'text-ctp-green' : action === 'deny' ? 'text-ctp-red' : 'text-ctp-yellow'
}

export function PermissionsPanel({ session, onClose }: Props) {
  const { setMode } = useSessions()
  const { cwd, agentId } = session
  const mode: PermissionMode = session.permissionMode ?? 'default'

  const [perms, setPerms] = useState<EffectivePermissions | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modeHint, setModeHint] = useState<string | null>(null)
  const [confirmBypass, setConfirmBypass] = useState(false)
  const [confirmNoPerms, setConfirmNoPerms] = useState(false)

  // Add-rule form.
  const [addAction, setAddAction] = useState<PermissionAction>('allow')
  const [addScope, setAddScope] = useState<PermissionScope>('local')
  const [addValue, setAddValue] = useState('')

  const refresh = useCallback(async () => {
    try {
      const p = await api.perms.get(cwd, agentId)
      setPerms(p)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [cwd, agentId])

  // Load on mount / session switch, and poll gently so allow-always rules Claude
  // writes mid-session appear without a manual reload. The add-form state is
  // separate, so a refresh never clobbers a rule you're typing.
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [refresh])

  // Switch the session's permission mode. bypass routes through a confirm first.
  const applyMode = useCallback(async (m: PermissionMode) => {
    const r = await setMode(session.id, m)
    if (r && 'applied' in r) {
      setModeHint(
        r.applied === 'live' ? 'applied'
          : r.applied === 'relaunched' ? 'relaunching…'
            : r.applied === 'error' ? `error: ${r.error}` : 'applies on next run',
      )
      setTimeout(() => setModeHint(null), 3000)
    }
  }, [session.id, setMode])

  const chooseMode = useCallback((m: PermissionMode) => {
    if (m === mode) return
    if (m === 'bypassPermissions') { setConfirmBypass(true); return }
    void applyMode(m)
  }, [mode, applyMode])

  const doAdd = useCallback(async () => {
    const value = addValue.trim()
    if (!value) return
    setBusy(true); setError(null)
    try {
      const r = await api.perms.addRule(cwd, addScope, addAction, value)
      if (!r.ok) setError(r.error)
      else setAddValue('')
      await refresh()
    } finally { setBusy(false) }
  }, [cwd, addScope, addAction, addValue, refresh])

  const doRemove = useCallback(async (rule: PermissionRule) => {
    setBusy(true); setError(null)
    try {
      const r = await api.perms.removeRule(cwd, rule.scope, rule.action, rule.value)
      if (!r.ok) setError(r.error)
      await refresh()
    } finally { setBusy(false) }
  }, [cwd, refresh])

  // Rules grouped by scope, preserving the user<project<local order.
  const byScope = useMemo(() => {
    const groups: Record<PermissionScope, PermissionRule[]> = { user: [], project: [], local: [] }
    for (const r of perms?.rules ?? []) groups[r.scope].push(r)
    return groups
  }, [perms])

  const ruleCount = perms?.rules.length ?? 0

  // "No permissions" profile: the strict inverse of "Allow all". It's active when the
  // mode is Prompt AND no allow rule is in effect, so every tool needs explicit
  // approval. Applying it strips every allow rule (across scopes) and drops to default.
  const allowRules = useMemo(() => (perms?.rules ?? []).filter((r) => r.action === 'allow'), [perms])
  const noPermsActive = mode === 'default' && allowRules.length === 0
  const applyNoPerms = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      for (const r of allowRules) {
        const res = await api.perms.removeRule(cwd, r.scope, 'allow', r.value)
        if (!res.ok) { setError(res.error); break }
      }
      if (mode !== 'default') await applyMode('default')
      await refresh()
    } finally { setBusy(false) }
  }, [allowRules, cwd, mode, applyMode, refresh])

  return (
    <Shell>
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ctp-mauve shrink-0">
          <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
        </svg>
        <span className="flex-1 text-xs text-ctp-text">Permissions</span>
        <button onClick={() => { void refresh() }} title="Refresh" className="text-ctp-overlay hover:text-ctp-text text-xs leading-none">⟳</button>
        <button onClick={onClose} title="Close (back to Chat)" className="text-ctp-overlay hover:text-ctp-text p-1">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {error && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-ctp-red bg-ctp-red/10 border-b border-ctp-surface0 break-words">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Mode */}
        <Section title="Mode">
          <div className="grid grid-cols-2 gap-1.5">
            {MODES.map((m) => {
              const on = mode === m.value
              const danger = m.value === 'bypassPermissions'
              return (
                <button
                  key={m.value}
                  onClick={() => chooseMode(m.value)}
                  title={m.hint}
                  className={`px-2 py-1.5 rounded text-[11px] text-left border transition-colors ${
                    on
                      ? danger
                        ? 'border-ctp-red bg-ctp-red/15 text-ctp-red'
                        : 'border-ctp-mauve bg-ctp-mauve/15 text-ctp-text'
                      : danger
                        ? 'border-ctp-surface0 text-ctp-overlay hover:border-ctp-red/60 hover:text-ctp-red'
                        : 'border-ctp-surface0 text-ctp-subtext hover:border-ctp-surface2 hover:text-ctp-text'
                  }`}
                >
                  {m.label}
                </button>
              )
            })}
          </div>
          {/* "No permissions": the strict inverse of Allow all — strip every allow rule
              so nothing runs without explicit approval. Confirm-gated (it's destructive). */}
          <button
            onClick={() => setConfirmNoPerms(true)}
            title="Remove every allow rule and require explicit approval for every tool"
            className={`mt-1.5 w-full px-2 py-1.5 rounded text-[11px] text-left border transition-colors ${
              noPermsActive
                ? 'border-ctp-blue bg-ctp-blue/15 text-ctp-blue'
                : 'border-ctp-surface0 text-ctp-subtext hover:border-ctp-blue/60 hover:text-ctp-blue'
            }`}
          >
            <span className="font-medium">No permissions</span>
            <span className="ml-1.5 text-ctp-overlay">· strip allow rules; approve every tool</span>
          </button>
          {mode === 'bypassPermissions' && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-ctp-red">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-ctp-red" />
              Allow-all is ON — Claude runs every tool without asking.
            </div>
          )}
          {noPermsActive && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-ctp-blue">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-ctp-blue" />
              No allow rules — every tool needs explicit approval.
            </div>
          )}
          {modeHint && <div className="mt-1 text-[10px] text-ctp-overlay">{modeHint}</div>}
        </Section>

        {/* Rules by scope */}
        <Section title={`Rules (${ruleCount})`}>
          {perms?.error && <Empty>Couldn’t read settings — {perms.error}</Empty>}
          {SCOPES.map((s) => {
            const rules = byScope[s.value]
            const file = perms?.files.find((f) => f.scope === s.value)
            return (
              <div key={s.value} className="mb-1.5">
                <div className="flex items-center gap-1.5 px-1 pb-0.5" title={s.hint}>
                  <span className="text-[10px] font-semibold text-ctp-overlay uppercase tracking-wider">{s.label}</span>
                  {file?.unreadable && <span className="text-[9px] text-ctp-red" title={file.path}>invalid JSON</span>}
                  {file && !file.exists && <span className="text-[9px] text-ctp-surface2" title={file.path}>no file</span>}
                </div>
                {rules.length === 0 ? (
                  <p className="px-1 py-0.5 text-[11px] text-ctp-surface2">—</p>
                ) : (
                  <div className="space-y-0.5">
                    {rules.map((r, i) => (
                      <div key={`${r.action}:${r.value}:${i}`} className="group flex items-center gap-2 px-1.5 py-1 rounded text-xs hover:bg-ctp-surface0/50">
                        <span className={`shrink-0 w-9 text-[9px] font-semibold uppercase ${actionClass(r.action)}`}>{r.action}</span>
                        <span className="flex-1 truncate font-mono text-ctp-subtext" title={r.value}>{r.value}</span>
                        <button
                          onClick={() => doRemove(r)}
                          disabled={busy}
                          title="Remove this rule"
                          className="opacity-0 group-hover:opacity-100 shrink-0 px-1 leading-none text-ctp-overlay hover:text-ctp-red disabled:opacity-30"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {/* Add rule */}
          <div className="mt-2 pt-2 border-t border-ctp-surface0 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <select
                value={addAction}
                onChange={(e) => setAddAction(e.target.value as PermissionAction)}
                title="Rule type"
                className="bg-ctp-surface0 text-ctp-subtext rounded px-1 py-1 text-[11px] outline-none hover:text-ctp-text cursor-pointer"
              >
                {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <select
                value={addScope}
                onChange={(e) => setAddScope(e.target.value as PermissionScope)}
                title="Which settings file to write"
                className="bg-ctp-surface0 text-ctp-subtext rounded px-1 py-1 text-[11px] outline-none hover:text-ctp-text cursor-pointer"
              >
                {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void doAdd() } }}
                placeholder="e.g. Bash(npm run test:*)"
                className="flex-1 min-w-0 bg-ctp-base border border-ctp-surface0 focus:border-ctp-mauve outline-none rounded px-2 py-1 text-[11px] font-mono text-ctp-text placeholder:text-ctp-overlay"
              />
              <button
                onClick={() => void doAdd()}
                disabled={busy || !addValue.trim()}
                className="shrink-0 px-2.5 py-1 text-[11px] rounded bg-ctp-mauve/20 text-ctp-mauve hover:bg-ctp-mauve/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Add
              </button>
            </div>
            <p className="text-[10px] text-ctp-overlay leading-snug">
              Match a tool like <span className="font-mono">Read</span> or scope it, e.g.{' '}
              <span className="font-mono">Bash(git*)</span>, <span className="font-mono">Edit(src/**)</span>.
            </p>
          </div>
        </Section>

        {/* Read-only: agent tool scope + notebook funnel */}
        <Section title="System (read-only)">
          {perms?.agent && (
            <div className="mb-1.5 text-[11px]">
              <div className="text-[10px] font-semibold text-ctp-overlay uppercase tracking-wider mb-0.5">Role · {perms.agent.name}</div>
              {perms.agent.allowedTools?.length ? (
                <div className="flex gap-1.5"><span className="shrink-0 w-9 text-[9px] font-semibold uppercase text-ctp-green">allow</span><span className="flex-1 font-mono text-ctp-overlay break-words">{perms.agent.allowedTools.join(', ')}</span></div>
              ) : null}
              {perms.agent.disallowedTools?.length ? (
                <div className="flex gap-1.5"><span className="shrink-0 w-9 text-[9px] font-semibold uppercase text-ctp-red">deny</span><span className="flex-1 font-mono text-ctp-overlay break-words">{perms.agent.disallowedTools.join(', ')}</span></div>
              ) : null}
              {!perms.agent.allowedTools?.length && !perms.agent.disallowedTools?.length && (
                <p className="text-[11px] text-ctp-surface2">Full tools (no role scoping).</p>
              )}
            </div>
          )}
          <div className="text-[11px]">
            <div className="text-[10px] font-semibold text-ctp-overlay uppercase tracking-wider mb-0.5">Notebook funnel</div>
            <div className="flex gap-1.5"><span className="shrink-0 w-9 text-[9px] font-semibold uppercase text-ctp-red">deny</span><span className="flex-1 font-mono text-ctp-overlay break-words">{(perms?.notebookFunnel ?? []).join(', ')}</span></div>
            <p className="mt-0.5 text-[10px] text-ctp-surface2 leading-snug">Notebook edits always route through the app’s cell tools — never raw file writes.</p>
          </div>
        </Section>
      </div>

      {confirmBypass && (
        <BypassConfirmDialog
          onConfirm={() => { setConfirmBypass(false); void applyMode('bypassPermissions') }}
          onCancel={() => setConfirmBypass(false)}
        />
      )}
      {confirmNoPerms && (
        <NoPermsConfirmDialog
          count={allowRules.length}
          onConfirm={() => { setConfirmNoPerms(false); void applyNoPerms() }}
          onCancel={() => setConfirmNoPerms(false)}
        />
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col h-full bg-ctp-base overflow-hidden">{children}</div>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-2.5 py-2 border-b border-ctp-surface0">
      <div className="text-[10px] font-semibold text-ctp-overlay uppercase tracking-widest mb-1.5">{title}</div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-0.5 text-[11px] text-ctp-overlay">{children}</p>
}
