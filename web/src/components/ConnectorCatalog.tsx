import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ConnectorDef, ConnectorView, ConnectorTransport, AccountConnector, StrictPreflight,
} from '@claudette/shared'
import { connectorIdError, accountConnectorNameError } from '@claudette/shared'
import { api } from '../api/client'

// The connector CATALOG — install-wide, so it lives in the Claudette deck rather than any
// per-session panel (see CONNECTORS.md). This is where connectors are defined; granting
// them to a session happens in that session's sandbox panel.
//
// Two things this UI has to keep honest, because the server cannot:
//  • Secrets are write-only. The server redacts headers/env/args and the URL's
//    userinfo+query on the way out, so an edit form NEVER receives what it is editing.
//    That means a blank secret field must read as "leave it alone", not "clear it" — which
//    is exactly the store's omit-means-keep rule. The placeholder says so.
//  • Account connectors are weaker than catalog ones and the copy must not imply parity:
//    Claudette holds no credential, so an undeclared account connector cannot be denied
//    at all. That is a fail-OPEN and it is stated, not buried.

const HEALTH_STYLE: Record<string, { dot: string; label: string }> = {
  connected: { dot: 'bg-ctp-green', label: 'connected' },
  connecting: { dot: 'bg-ctp-yellow animate-pulse', label: 'connecting' },
  'needs-auth': { dot: 'bg-ctp-yellow', label: 'needs auth' },
  error: { dot: 'bg-ctp-red', label: 'error' },
  disconnected: { dot: 'bg-ctp-surface2', label: 'not dialled yet' },
}

export function ConnectorCatalog({ cwd }: { cwd: string }) {
  const [connectors, setConnectors] = useState<ConnectorView[]>([])
  const [accounts, setAccounts] = useState<AccountConnector[]>([])
  const [strict, setStrict] = useState(false)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ConnectorView | 'new' | null>(null)
  const [preflight, setPreflight] = useState<StrictPreflight | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const r = await api.http.listConnectors()
    setConnectors(r.connectors)
    setAccounts(r.accountConnectors)
    setStrict(r.strict)
    setLoading(false)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const remove = async (id: string) => {
    setBusy(true)
    await api.http.deleteConnector(id)
    await refresh()
    setBusy(false)
  }

  // Strict mode is shown BEHIND its pre-flight, never as a bare switch: it is the setting
  // that makes hand-configured MCP servers stop appearing, so the cost is displayed before
  // it is paid.
  const openPreflight = async () => {
    setBusy(true)
    setPreflight(await api.http.connectorPreflight(cwd))
    setBusy(false)
  }

  if (loading) return <div className="p-4 text-[11px] text-ctp-overlay">Loading catalog…</div>

  return (
    <div className="p-4 space-y-5 text-[11px] text-ctp-subtext">
      {/* --- catalog list ------------------------------------------------------ */}
      <section className="space-y-2">
        <header className="flex items-center gap-2">
          <h3 className="text-ctp-text font-medium text-xs">Catalog</h3>
          <span className="text-ctp-overlay">— defined here, granted per session</span>
          <button
            onClick={() => setEditing('new')}
            className="ml-auto rounded bg-ctp-accent/20 text-ctp-accent hover:bg-ctp-accent/30 px-2 py-0.5 font-medium"
          >
            + Add connector
          </button>
        </header>

        {connectors.length === 0 && (
          <div className="rounded border border-dashed border-ctp-surface2 px-3 py-4 text-center text-ctp-overlay">
            No connectors yet. Add one, or import what the Claude CLI already has configured
            (below).
          </div>
        )}

        <div className="space-y-1.5">
          {connectors.map((c) => {
            const h = HEALTH_STYLE[c.health] ?? HEALTH_STYLE.disconnected
            return (
              <div key={c.id} className="rounded border border-ctp-surface0 bg-ctp-mantle px-2.5 py-2 space-y-1">
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${h.dot}`} title={c.lastError ?? h.label} />
                  <span className="text-ctp-text font-medium truncate">{c.name}</span>
                  <code className="text-ctp-overlay shrink-0">{c.id}</code>
                  <span className="text-ctp-overlay shrink-0">{c.transport}</span>
                  {/* THREE STATES, and this badge is the third one. `needsSetup` is not
                      "disabled" (the operator chose not to grant it) and not "error" (it was
                      dialled and something went wrong): it CANNOT be granted yet, because the
                      vendor requires an OAuth client only the operator can create. Saying so
                      here is what makes blocking the toggle below legible rather than broken. */}
                  {c.needsSetup && (
                    <span
                      className="shrink-0 px-1.5 rounded bg-ctp-yellow/15 text-ctp-yellow text-[10px] font-medium"
                      title="This connector needs an OAuth client you create — see below"
                    >needs setup</span>
                  )}
                  <button onClick={() => setEditing(c)} className="ml-auto text-ctp-overlay hover:text-ctp-text px-1 shrink-0">edit</button>
                  {/* A built-in has no stored definition to delete — it lives in code and is
                      merged in on read — so × HIDES it, and hiding is reversible. Offering
                      "remove" would either silently do nothing or imply a permanence that
                      does not exist. */}
                  <button
                    onClick={() => void remove(c.id)}
                    disabled={busy}
                    className="text-ctp-overlay hover:text-ctp-red px-1 shrink-0"
                    title={c.builtin ? 'Hide this built-in connector (reversible)' : 'Remove from the catalog'}
                  >×</button>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ctp-overlay pl-3.5">
                  {c.urlDisplay && <span className="font-mono">{c.urlDisplay}</span>}
                  {/* The command is shown in FULL for a stdio connector: it is the program
                      the engine will spawn, so it is the thing worth judging — especially
                      for a row that arrived by import rather than by being typed here. */}
                  {c.command && <span className="font-mono text-ctp-text" title="The program the engine spawns for this connector">{c.command}</span>}
                  {c.headerKeys.length > 0 && <span title="Header names — values are never sent to the browser">headers: {c.headerKeys.join(', ')}</span>}
                  {c.envKeys.length > 0 && <span title="Env var names — values are never sent to the browser">env: {c.envKeys.join(', ')}</span>}
                  {c.hasArgs && <span title="Arguments are hidden: connection strings are commonly passed there">args set</span>}
                  {c.enabledByDefault && <span className="text-ctp-blue">granted to new sessions</span>}
                  {/* Tool classification drives read-only-role scoping. Unprobed is not
                      neutral — it denies the whole server to a read-only role. */}
                  <span title="Learned from tools/list traffic. Until then a read-only role is denied the whole server.">
                    {c.tools ? `${c.tools.length} tools (${c.tools.filter((t) => t.write).length} write)` : 'tools not probed yet'}
                  </span>
                  {!!c.inUseBy && <span>granted to {c.inUseBy} session{c.inUseBy === 1 ? '' : 's'}</span>}
                </div>
                {c.builtin && !c.needsSetup && (
                  <div className="pl-3.5 text-ctp-overlay">built in — shipped with Claudette, not added here</div>
                )}
                {c.needsSetup && (
                  <div className="pl-3.5 text-ctp-yellow/90 leading-snug">
                    {/* Prefer the server's per-product wording. It lives beside the built-in
                        definitions so it cannot drift from them; the fallback is here only for
                        a built-in that declares requiresOAuthClient without a hint, which
                        should not happen but should not render blank if it does. */}
                    {c.setupHint ?? 'Needs an OAuth client you create, with this product’s scopes on the consent screen.'}
                    {' '}Add it under OAuth clients below, then point this connector at it with{' '}
                    <span className="text-ctp-text">edit</span>. Until then it cannot be granted
                    to a session.
                  </div>
                )}
                {c.importedFrom && <div className="pl-3.5 text-ctp-overlay truncate" title={c.importedFrom}>imported from {c.importedFrom}</div>}
                {c.lastError && <div className="pl-3.5 text-ctp-red/90">{c.lastError}</div>}
                {!!c.inUseBy && (
                  <div className="pl-3.5 text-ctp-yellow/90">
                    Editing this applies on <b>relaunch</b> for sessions already using it.
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* --- account connectors ---------------------------------------------- */}
      <AccountSection accounts={accounts} onSaved={setAccounts} />

      {/* --- strict mode ------------------------------------------------------ */}
      <section className="space-y-2">
        <header className="flex items-center gap-2">
          <h3 className="text-ctp-text font-medium text-xs">Strict MCP mode</h3>
          <span className={`px-1.5 rounded text-[10px] font-medium ${strict ? 'bg-ctp-green/20 text-ctp-green' : 'bg-ctp-surface0 text-ctp-overlay'}`}>
            {strict ? 'ON' : 'OFF'}
          </span>
        </header>
        <p className="text-ctp-overlay leading-snug">
          With strict mode on, this catalog is the <b>only</b> source of MCP reach: the CLI stops
          reading <span className="font-mono">.mcp.json</span>, settings-scoped servers and
          <span className="font-mono"> ~/.claude.json</span> projects, and never fetches claude.ai
          account connectors. That is the point — and it is also what makes a hand-configured
          server disappear. Check what it would cost first.
        </p>
        {!strict && (
          <button onClick={() => void openPreflight()} disabled={busy} className="rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-text px-2 py-0.5">
            What would this change?
          </button>
        )}
        {strict && (
          <button
            onClick={async () => { setBusy(true); await api.http.setStrictMcp(false); await refresh(); setBusy(false) }}
            disabled={busy}
            className="rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-text px-2 py-0.5"
          >
            Turn strict mode off
          </button>
        )}
        {preflight && (
          <PreflightReport
            report={preflight}
            busy={busy}
            onImport={async () => { setBusy(true); await api.http.importConnectors(cwd); await refresh(); setPreflight(await api.http.connectorPreflight(cwd)); setBusy(false) }}
            onEnable={async () => { setBusy(true); await api.http.setStrictMcp(true); setPreflight(null); await refresh(); setBusy(false) }}
            onDismiss={() => setPreflight(null)}
          />
        )}
      </section>

      {editing && (
        <ConnectorForm
          existing={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refresh() }}
        />
      )}
    </div>
  )
}

// --- account connectors --------------------------------------------------------
// Deliberately a plain name list, because that is genuinely all Claudette can know: there
// is no credential and no API to enumerate them with. The copy has to carry that limit.
function AccountSection({ accounts, onSaved }: { accounts: AccountConnector[]; onSaved: (a: AccountConnector[]) => void }) {
  const [draft, setDraft] = useState('')
  const nameErr = draft.trim() ? accountConnectorNameError(draft) : null
  const save = async (next: AccountConnector[]) => onSaved((await api.http.setAccountConnectors(next)).accountConnectors)

  return (
    <section className="space-y-2">
      <header className="flex items-center gap-2">
        <h3 className="text-ctp-text font-medium text-xs">claude.ai account connectors</h3>
      </header>
      <p className="text-ctp-overlay leading-snug">
        Connectors bound to your Anthropic account and served by the CLI. Claudette holds no
        credential for these, so it cannot grant one — the only lever is a <b>deny</b> rule per
        session, and a rule can only name a connector listed here.
      </p>
      <p className="text-ctp-yellow/90 leading-snug">
        So this list is a <b>deny list's vocabulary</b>, not an inventory: an account connector
        you don't list here <b>cannot be denied</b> to any session. Strict mode makes the whole
        question moot — the CLI stops fetching them entirely.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {accounts.map((a) => (
          <span key={a.name} className="inline-flex items-center gap-1 rounded bg-ctp-surface0 px-1.5 py-0.5">
            <code className="text-ctp-text">{a.name}</code>
            <button onClick={() => void save(accounts.filter((x) => x.name !== a.name))} className="text-ctp-overlay hover:text-ctp-red">×</button>
          </span>
        ))}
        {accounts.length === 0 && <span className="text-ctp-overlay italic">None listed.</span>}
      </div>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => { e.preventDefault(); if (nameErr || !draft.trim()) return; void save([...accounts, { name: draft.trim() }]); setDraft('') }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="server name, e.g. gmail"
          className="flex-1 min-w-0 rounded bg-ctp-surface0 px-2 py-1 text-ctp-text placeholder:text-ctp-overlay outline-none focus:ring-1 focus:ring-ctp-accent"
        />
        <button type="submit" disabled={!!nameErr || !draft.trim()} className="rounded bg-ctp-surface0 hover:bg-ctp-surface1 disabled:opacity-40 text-ctp-text px-2 py-1">Add</button>
      </form>
      {/* The name lands in the comma-joined --disallowedTools value, so a stray comma
          would forge extra rules. The server drops such a name anyway; catching it here
          means the operator sees why instead of watching it silently not appear. */}
      {nameErr && <div className="text-ctp-red/90 leading-snug">{nameErr}</div>}
    </section>
  )
}

// --- strict-mode pre-flight ----------------------------------------------------
function PreflightReport({ report, busy, onImport, onEnable, onDismiss }: {
  report: StrictPreflight
  busy: boolean
  onImport: () => void
  onEnable: () => void
  onDismiss: () => void
}) {
  return (
    <div className="rounded border border-ctp-surface1 bg-ctp-mantle p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-ctp-text font-medium">If you turn strict mode on</span>
        <button onClick={onDismiss} className="ml-auto text-ctp-overlay hover:text-ctp-text">✕</button>
      </div>

      {report.importable.length > 0 && (
        <div className="space-y-1">
          <div className="text-ctp-yellow/90">
            {report.importable.length} configured server{report.importable.length === 1 ? '' : 's'} would
            stop appearing, but can be imported into the catalog first:
          </div>
          <ul className="pl-3 space-y-0.5">
            {report.importable.map((i) => (
              <li key={i.id} className="text-ctp-overlay truncate" title={i.source}>
                <code className="text-ctp-text">{i.id}</code> — {i.name}
                {i.transport && <span className="ml-1.5">({i.transport})</span>}
                {/* A stdio import is a program this machine will run. Naming it here is the
                    difference between an informed import and a blind one. */}
                {i.command && <span className="ml-1.5 font-mono text-ctp-yellow/90">spawns: {i.command}</span>}
              </li>
            ))}
          </ul>
          <button onClick={onImport} disabled={busy} className="rounded bg-ctp-blue/20 text-ctp-blue hover:bg-ctp-blue/30 px-2 py-0.5 font-medium">
            Import these {report.importable.length}
          </button>
          <div className="text-ctp-overlay">Importing does not grant them — every session still starts with no reach.</div>
          <div className="text-ctp-yellow/90 leading-snug">
            These definitions come from files in whatever project you opened. They are
            validated exactly as a hand-added connector is (https-only except loopback, no
            control characters in headers), but check any <span className="font-mono">spawns:</span> line
            above — that is a program this machine will run.
          </div>
        </div>
      )}

      {report.skipped.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-ctp-red/90">Cannot be carried over:</div>
          <ul className="pl-3">
            {report.skipped.map((s) => (
              <li key={`${s.source}:${s.name}`} className="text-ctp-overlay">{s.name} — {s.reason}</li>
            ))}
          </ul>
        </div>
      )}

      {report.alreadyInCatalog.length > 0 && (
        <div className="text-ctp-overlay">
          Already in the catalog (these survive, in sessions granted them): {report.alreadyInCatalog.join(', ')}
        </div>
      )}

      {report.sessionsWithNoGrants.length > 0 && (
        <div className="text-ctp-yellow/90">
          {report.sessionsWithNoGrants.length} open session{report.sessionsWithNoGrants.length === 1 ? '' : 's'} currently
          {report.sessionsWithNoGrants.length === 1 ? ' has' : ' have'} no grants, so
          {report.sessionsWithNoGrants.length === 1 ? ' it' : ' they'} would reach no MCP server at all
          beyond Claudette's own tools: {report.sessionsWithNoGrants.map((s) => s.name).join(', ')}.
        </div>
      )}

      <ul className="space-y-0.5 pl-3 list-disc list-inside text-ctp-overlay">
        {report.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>

      <button onClick={onEnable} disabled={busy} className="rounded bg-ctp-green/20 text-ctp-green hover:bg-ctp-green/30 px-2 py-0.5 font-medium">
        Turn strict mode on
      </button>
    </div>
  )
}

// --- add / edit form -----------------------------------------------------------
function ConnectorForm({ existing, onCancel, onSaved }: {
  existing: ConnectorView | null
  onCancel: () => void
  onSaved: () => void
}) {
  const [id, setId] = useState(existing?.id ?? '')
  const [name, setName] = useState(existing?.name ?? '')
  const [transport, setTransport] = useState<ConnectorTransport>(existing?.transport ?? 'http')
  const [url, setUrl] = useState('')
  const [headerKey, setHeaderKey] = useState('Authorization')
  const [headerVal, setHeaderVal] = useState('')
  // Basic auth is common enough — Atlassian's MCP server is the case in point — that
  // making the operator base64 `email:token` by hand is a needless place to go wrong. A
  // mistyped header is indistinguishable from a bad credential once it 401s.
  const [authMode, setAuthMode] = useState<'raw' | 'basic'>('raw')
  const [basicUser, setBasicUser] = useState('')
  const [basicSecret, setBasicSecret] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [byDefault, setByDefault] = useState(!!existing?.enabledByDefault)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Validate the id in the browser AND server-side. Not belt-and-braces for its own sake:
  // an illegal id fails every turn of a granted session, so catching it at the point of
  // typing is worth the duplicated rule (the regex lives in shared/, so it can't drift).
  const idErr = id ? connectorIdError(id) : null

  // The composed header value, or '' to leave the stored one alone (omit-means-keep).
  // btoa() is latin1-only, so encode UTF-8 first — an accented name in an email would
  // otherwise throw InvalidCharacterError at the point of saving.
  const authHeader = authMode === 'basic'
    ? (basicUser.trim() && basicSecret.trim()
        ? 'Basic ' + btoa(String.fromCharCode(...new TextEncoder().encode(`${basicUser.trim()}:${basicSecret.trim()}`)))
        : '')
    : headerVal.trim()

  const submit = async () => {
    setBusy(true); setError(null)
    // Secrets are OMIT-MEANS-KEEP: an empty field on an edit leaves the stored value
    // alone, because the browser was never told what it was.
    const def: ConnectorDef = {
      id, name, transport,
      ...(transport === 'http'
        ? {
            url: url.trim() || undefined,
            ...(authHeader ? { headers: { [headerKey.trim() || 'Authorization']: authHeader } } : {}),
          }
        : {
            command: command.trim() || undefined,
            ...(argsText.trim() ? { args: argsText.split('\n').map((s) => s.trim()).filter(Boolean) } : {}),
            ...(envText.trim() ? { env: parseEnv(envText) } : {}),
          }),
      enabledByDefault: byDefault,
    }
    const r = await api.http.saveConnector(def)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    onSaved()
  }

  const editing = !!existing
  // Portalled for the same reason the deck is (see ClaudetteDeck) — and so it stacks above
  // the deck rather than inside its scroll container.
  return createPortal(
    <div data-overlay-layer className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      {/* Marked by hand, not via <Overlay>: this is a full-screen stacked layer with the
          same click-away hazard, but a different CONSTRUCTION — a separate absolutely
          positioned backdrop sibling plus a `relative` card, rather than container-click
          with stopPropagation on the card. Expressing both shapes in one primitive would
          mean two dismissal modes and two backdrop styles inside it, which is worse than
          this one attribute. See Overlay.tsx for what the marker is for; the cursor-
          positioned row/kernel menus deliberately do NOT carry it, because a menu is not a
          layer over the whole screen and its own dismissal IS the click. */}
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative w-full max-w-md rounded-lg bg-ctp-base border border-ctp-surface1 shadow-pop p-4 space-y-3 text-[11px] max-h-[85vh] overflow-y-auto">
        <div className="text-xs font-medium text-ctp-text">{editing ? `Edit ${existing.name}` : 'Add a connector'}</div>

        <label className="block space-y-1">
          <span className="text-ctp-overlay">Id {editing && <span>— immutable</span>}</span>
          <input
            value={id}
            disabled={editing}
            onChange={(e) => setId(e.target.value)}
            placeholder="github-issues"
            className="w-full rounded bg-ctp-surface0 px-2 py-1 font-mono text-ctp-text disabled:text-ctp-overlay outline-none focus:ring-1 focus:ring-ctp-accent"
          />
          {/* The id is also the MCP server name, so the constraint is not cosmetic. */}
          {idErr && <span className="block text-ctp-red/90 leading-snug">{idErr}</span>}
          {editing && (
            <span className="block text-ctp-overlay leading-snug">
              Grants and deny rules are keyed on the id, so renaming it would strand every grant.
              Change the display name instead.
            </span>
          )}
        </label>

        <label className="block space-y-1">
          <span className="text-ctp-overlay">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="GitHub Issues" className="w-full rounded bg-ctp-surface0 px-2 py-1 text-ctp-text outline-none focus:ring-1 focus:ring-ctp-accent" />
        </label>

        <div className="space-y-1">
          <span className="text-ctp-overlay">Transport</span>
          <div className="flex gap-1">
            {(['http', 'stdio'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTransport(t)}
                className={`px-2 py-0.5 rounded font-mono ${transport === t ? 'bg-ctp-accent/20 text-ctp-accent' : 'text-ctp-overlay hover:bg-ctp-surface0'}`}
              >
                {t}
              </button>
            ))}
          </div>
          <span className="block text-ctp-overlay leading-snug">
            {transport === 'http'
              ? 'Claudette dials it and proxies, so the credential never enters a session and revoking is immediate.'
              : 'Carried verbatim — the engine spawns it, which is what puts it inside the session’s sandbox. Claudette never runs it. Its env and args ride the launch command line, so a granted session can READ them: treat any secret here as disclosed to that session.'}
          </span>
        </div>

        {transport === 'http' ? (
          <>
            <label className="block space-y-1">
              <span className="text-ctp-overlay">URL{editing && ' — blank keeps the stored one'}</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/mcp" className="w-full rounded bg-ctp-surface0 px-2 py-1 font-mono text-ctp-text outline-none focus:ring-1 focus:ring-ctp-accent" />
              <span className="block text-ctp-overlay">https only, except 127.0.0.1.</span>
            </label>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-ctp-overlay">Auth</span>
                {([['raw', 'header'], ['basic', 'email + token']] as const).map(([m, label]) => (
                  <button
                    key={m}
                    onClick={() => setAuthMode(m)}
                    className={`px-2 py-0.5 rounded ${authMode === m ? 'bg-ctp-accent/20 text-ctp-accent' : 'text-ctp-overlay hover:bg-ctp-surface0'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {authMode === 'basic' ? (
                <div className="space-y-1.5">
                  <input
                    value={basicUser}
                    onChange={(e) => setBasicUser(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded bg-ctp-surface0 px-2 py-1 font-mono text-ctp-text outline-none focus:ring-1 focus:ring-ctp-accent"
                  />
                  <input
                    value={basicSecret}
                    onChange={(e) => setBasicSecret(e.target.value)}
                    type="password"
                    placeholder={existing?.headerKeys.length ? 'API token — unchanged if left blank' : 'API token'}
                    className="w-full rounded bg-ctp-surface0 px-2 py-1 font-mono text-ctp-text outline-none focus:ring-1 focus:ring-ctp-accent"
                  />
                  <span className="block text-ctp-overlay leading-snug">
                    Sent as <span className="font-mono">Authorization: Basic base64(email:token)</span>.
                    Encoding happens here; the token is stored server-side and never sent back to
                    this browser.
                  </span>
                </div>
              ) : (
              <div className="flex gap-1.5">
                <input value={headerKey} onChange={(e) => setHeaderKey(e.target.value)} className="w-1/3 rounded bg-ctp-surface0 px-2 py-1 font-mono text-ctp-text outline-none focus:ring-1 focus:ring-ctp-accent" />
                <input
                  value={headerVal}
                  onChange={(e) => setHeaderVal(e.target.value)}
                  type="password"
                  placeholder={existing?.headerKeys.length ? 'unchanged — leave blank to keep' : 'Bearer …'}
                  className="flex-1 min-w-0 rounded bg-ctp-surface0 px-2 py-1 font-mono text-ctp-text outline-none focus:ring-1 focus:ring-ctp-accent"
                />
              </div>
              )}
              {authMode === 'raw' && (
                <span className="block text-ctp-overlay leading-snug">
                  Stored server-side and never sent back to this browser. Leave blank when editing
                  to keep the current value.
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <label className="block space-y-1">
              <span className="text-ctp-overlay">Command{editing && ' — blank keeps the stored one'}</span>
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="mcp-server-postgres" className="w-full rounded bg-ctp-surface0 px-2 py-1 font-mono text-ctp-text outline-none focus:ring-1 focus:ring-ctp-accent" />
            </label>
            <label className="block space-y-1">
              <span className="text-ctp-overlay">Arguments — one per line</span>
              <textarea value={argsText} onChange={(e) => setArgsText(e.target.value)} rows={2} placeholder={existing?.hasArgs ? 'unchanged — leave blank to keep' : '--connection\npostgres://…'} className="w-full rounded bg-ctp-surface0 px-2 py-1 font-mono text-ctp-text outline-none focus:ring-1 focus:ring-ctp-accent" />
              <span className="block text-ctp-overlay">Hidden after saving — connection strings are commonly passed here.</span>
            </label>
            <label className="block space-y-1">
              <span className="text-ctp-overlay">Environment — KEY=value per line</span>
              <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} rows={2} placeholder={existing?.envKeys.length ? 'unchanged — leave blank to keep' : 'PGPASSWORD=…'} className="w-full rounded bg-ctp-surface0 px-2 py-1 font-mono text-ctp-text outline-none focus:ring-1 focus:ring-ctp-accent" />
            </label>
          </>
        )}

        <label className="flex items-start gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={byDefault} onChange={(e) => setByDefault(e.target.checked)} className="accent-ctp-accent mt-[1px]" />
          <span className="leading-snug">
            <span className="text-ctp-text">Grant to new sessions</span>
            <span className="text-ctp-overlay"> — off by default. A connector switched on everywhere is the
            ungoverned reach this feature replaces; existing sessions are never changed by this.</span>
          </span>
        </label>

        {error && <div className="rounded bg-ctp-red/10 border border-ctp-red/30 text-ctp-red px-2 py-1 leading-snug">{error}</div>}

        <div className="flex items-center gap-2 pt-1">
          <button onClick={onCancel} className="rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-text px-2 py-1">Cancel</button>
          <button
            onClick={() => void submit()}
            disabled={busy || !!idErr || !id || !name}
            className="rounded bg-ctp-accent/20 text-ctp-accent hover:bg-ctp-accent/30 disabled:opacity-40 px-2 py-1 font-medium"
          >
            {busy ? 'Saving…' : editing ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// KEY=value per line. Split on the FIRST '=' only: values routinely contain '=' (base64
// padding in a token being the obvious case).
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return out
}
