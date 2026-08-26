import { useCallback, useEffect, useState } from 'react'
import type { SessionInfo, ConnectorView, AccountConnector } from '@claudette/shared'
import { api } from '../api/client'

// A session's connector GRANTS — which catalog connectors it may reach, and which account
// connectors it is allowed. Lives inside the sandbox panel because it answers the same
// question the mounts do: what can this session reach? Mounts are filesystem reach,
// connectors are service reach, and both are trust-gated and fail closed.
//
// The catalog itself is edited in the Claudette deck (global). This is deliberately only
// the grant: a per-session panel that also edited global definitions is how someone
// changes a URL for every session while believing they changed it for one.
//
// The pending semantics differ from the sandbox's in a way the copy has to carry:
// GRANTING needs a relaunch (the engine reads its server list once at spawn and ignores
// tools/list_changed), but REVOKING is already in force — the proxy refuses the next call.
// So "pending" here never means "still reachable".
// `bare` drops the leading rule + padding, for a host that already draws its own section
// divider (the permissions dock). Purely presentational — the grant logic is identical,
// so there is one place a connector grant is made and one set of caveats explaining it.
export function ConnectorGrants({ session, compact = false, bare = false }: { session: SessionInfo; compact?: boolean; bare?: boolean }) {
  const [catalog, setCatalog] = useState<ConnectorView[] | null>(null)
  const [accounts, setAccounts] = useState<AccountConnector[]>([])
  const [strict, setStrict] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const granted = session.connectors ?? []
  const accountAllow = session.accountConnectors ?? []

  const refresh = useCallback(async () => {
    const r = await api.http.listConnectors()
    setCatalog(r.connectors)
    setAccounts(r.accountConnectors)
    setStrict(r.strict)
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const push = async (connectors: string[], allow: string[]) => {
    setBusy(true); setError(null)
    const r = await api.http.setSessionConnectors(session.id, connectors, allow)
    if (r.error) setError(r.error)
    setBusy(false)
  }

  const toggle = (id: string) =>
    void push(granted.includes(id) ? granted.filter((x) => x !== id) : [...granted, id], accountAllow)
  const toggleAccount = (name: string) =>
    void push(granted, accountAllow.includes(name) ? accountAllow.filter((x) => x !== name) : [...accountAllow, name])

  if (!catalog) return null

  return (
    <div className={`space-y-2 ${bare ? '' : 'pt-1 border-t border-ctp-surface0'}`}>
      <div className="flex items-center gap-2">
        <span className="text-ctp-text font-medium">Connectors</span>
        <span className="text-ctp-overlay">{granted.length ? `${granted.length} granted` : 'none granted'}</span>
      </div>

      {catalog.length === 0 && accounts.length === 0 && (
        <div className="text-ctp-overlay leading-snug">
          No connectors defined yet — add them in <b>Claudette → Connectors</b>, then grant them
          to this session here.
        </div>
      )}

      {!compact && catalog.length > 0 && (
        <div className="text-ctp-overlay leading-snug">
          External MCP servers this session may reach. Ungranted means the tools are
          <b> absent entirely</b>, not merely refused.
        </div>
      )}

      <div className="space-y-1">
        {catalog.map((c) => {
          const on = granted.includes(c.id)
          return (
            <label key={c.id} className="flex items-start gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={on} disabled={busy} onChange={() => toggle(c.id)} className="accent-ctp-accent mt-[1px]" />
              <span className="leading-snug min-w-0 flex-1">
                <span className={on ? 'text-ctp-text' : 'text-ctp-subtext'}>{c.name}</span>
                <code className="text-ctp-overlay ml-1.5">{c.id}</code>
                {c.health === 'needs-auth' && <span className="text-ctp-yellow ml-1.5" title={c.lastError}>needs auth</span>}
                {c.health === 'error' && <span className="text-ctp-red ml-1.5" title={c.lastError}>error</span>}
                {/* Read-only roles get the whole server denied until it has been probed —
                    worth saying HERE, where the grant is made, not only in the catalog. */}
                {on && !c.tools && (
                  <span className="block text-ctp-overlay">
                    Not probed yet — a read-only role (planner, reviewer, researcher) is denied all of
                    its tools until it is.
                  </span>
                )}
                {/* An http connector is dialled BY Claudette, so its credential stays out of
                    the box. A stdio one is spawned by the engine INSIDE the box, with its env
                    and args on the command line the session can read. Say so at the moment of
                    granting — it is the decision this changes. */}
                {on && c.transport === 'stdio' && (
                  <span className="block text-ctp-yellow">
                    stdio — the session can read this connector’s env and args, secrets included.
                  </span>
                )}
              </span>
            </label>
          )
        })}
      </div>

      {accounts.length > 0 && (
        <div className="space-y-1 pt-1">
          <div className="text-ctp-overlay">claude.ai account connectors:</div>
          {strict ? (
            <div className="text-ctp-overlay leading-snug">
              Strict MCP mode is on, so the CLI never fetches these — the allow list below has no
              effect while it stays on.
            </div>
          ) : (
            <div className="text-ctp-overlay leading-snug">
              Allowed here, denied otherwise. Claudette holds no credential for these, so this is a
              deny rule rather than a real grant.
            </div>
          )}
          {accounts.map((a) => (
            <label key={a.name} className={`flex items-center gap-2 cursor-pointer select-none ${strict ? 'opacity-50' : ''}`}>
              <input type="checkbox" checked={accountAllow.includes(a.name)} disabled={busy || strict} onChange={() => toggleAccount(a.name)} className="accent-ctp-accent" />
              <code className="text-ctp-subtext">{a.name}</code>
            </label>
          ))}
        </div>
      )}

      {error && <div className="text-ctp-red/90 leading-snug">{error}</div>}

      {/* The asymmetry, stated where it matters. A revocation is already effective. */}
      {session.connectorsPending && (
        <div className="text-ctp-yellow/90 leading-snug">
          A <b>new</b> grant is waiting for a relaunch — the engine reads its server list once at
          startup. Anything you <b>removed</b> is already blocked.
        </div>
      )}
    </div>
  )
}
