import { useCallback, useEffect, useState } from 'react'
import { errText } from '../lib/errText'
import type { ConnectorView } from '@claudette/shared'
import { api } from '../api/client'
import { authState, canConnect, type ConnectorAuthState } from '../lib/connectorAuth'

// The authorization block for one OAuth connector: which accounts are authorized, the button
// that starts a flow, the redirect URI the operator must register, and disconnect.
//
// WHICH state is shown is decided by `authState` in lib/connectorAuth.ts, not here — that
// ordering is what surfaces the multi-account refusal, and it is worth testing without a DOM.
// This component renders what it is told and owns the network calls.
//
// ★ STATE IS CARRIED ON `data-auth-state`, NOT IN THE COPY. Tests assert that attribute and
// the roles below; the wording is presentation and is expected to be reworded.

export function ConnectorOAuth({ connector, onChanged }: { connector: ConnectorView; onChanged?: () => void }) {
  const [accounts, setAccounts] = useState<string[]>([])
  const [redirectUri, setRedirectUri] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // ★ `r.error` IS NO LONGER THE FAILURE PATH — the throw is. GETs reject on any non-2xx,
  // so the server's 400 body never arrives here as a value; its message comes through the
  // rejection instead. The `error` field is kept in the type only because a 2xx body may
  // still carry one, and reading it costs nothing. Without the catch this was an unhandled
  // rejection that discarded the server's message entirely.
  const refresh = useCallback(async () => {
    try {
      const r = await api.http.oauthAccounts(connector.id)
      if (r.error) { setError(r.error); return }
      setAccounts(r.accounts ?? [])
    } catch (e) {
      setError(errText(e))
    }
  }, [connector.id])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    // Fetched, never constructed — see the note on api.http.oauthRedirectUri.
    void api.http.oauthRedirectUri().then((r) => setRedirectUri(r.redirectUri ?? null)).catch(() => {})
  }, [])

  const state = authState(connector, accounts)

  const connect = async () => {
    setBusy(true); setError(null)
    const r = await api.http.oauthStart(connector.id)
    setBusy(false)
    // A 400 here is the ordinary answer when no usable client exists yet — the browser cannot
    // tell a resolving oauthClientRef from a dangling one, so the button is offered and the
    // server's reason is surfaced rather than guessed at.
    if (r.error || !r.url) { setError(r.error ?? 'Could not start authorization.'); return }
    window.open(r.url, '_blank', 'noopener')
  }

  const disconnect = async (account?: string) => {
    setBusy(true); setError(null)
    const r = await api.http.oauthDisconnect(connector.id, account)
    setBusy(false)
    if (r.error) { setError(r.error); return }
    setAccounts(r.accounts ?? [])
    onChanged?.()
  }

  const copyUri = async () => {
    if (!redirectUri) return
    try { await navigator.clipboard.writeText(redirectUri); setCopied(true) } catch { setCopied(false) }
  }

  return (
    <div data-auth-state={state} className="pl-3.5 space-y-1 leading-snug">
      {state === 'multi-account' && (
        // ★ THE REFUSAL MUST BE VISIBLE. The server will not choose between two authorized
        // accounts, so it dials UNAUTHENTICATED — which looks identical to working until a
        // call fails. Saying nothing here is what makes that failure invisible, which is the
        // whole reason the refusal exists.
        <div data-testid="oauth-multi-account" className="text-ctp-red/90">
          {accounts.length} accounts are authorized, so this connector is <b>not dialling as
          any of them</b>. Claudette refuses to guess which one you meant rather than act as
          the wrong person. Disconnect all but the one you want.
        </div>
      )}

      {state === 'needs-authorization' && (
        <div className="text-ctp-yellow/90">Client configured — no account has authorized it yet.</div>
      )}

      {accounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-ctp-overlay">authorized:</span>
          {accounts.map((a) => (
            <span key={a} data-account={a} className="flex items-center gap-1 px-1.5 rounded bg-ctp-surface0 text-ctp-text">
              {a}
              <button
                type="button" disabled={busy} onClick={() => void disconnect(a)}
                aria-label={`Disconnect ${a}`} title={`Disconnect ${a}`}
                className="text-ctp-overlay hover:text-ctp-red disabled:opacity-40"
              >✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canConnect(state) && (
          <button
            type="button" onClick={() => void connect()} disabled={busy}
            data-testid="oauth-connect"
            className="px-2 py-0.5 rounded bg-ctp-accent/15 text-ctp-accent hover:bg-ctp-accent/25 disabled:opacity-40"
          >{accounts.length > 0 ? 'Connect another account' : 'Connect'}</button>
        )}
        {state === 'ready' && <span data-testid="oauth-ready" className="text-ctp-green">authorized</span>}
      </div>

      {/* ★ DISCONNECT IS NOT REVOCATION, AND THE WORDING HAS TO SAY SO. Removing our copy of
          the token leaves it valid at the provider until it expires or is revoked there. An
          operator disconnecting BECAUSE they believe a credential is compromised would
          otherwise walk away thinking they had closed it. */}
      {accounts.length > 0 && (
        <div data-testid="oauth-revoke-note" className="text-ctp-overlay">
          Disconnecting removes only Claudette’s copy of the token. It stays valid at the
          provider until it expires or you revoke it there — if you are disconnecting because a
          credential may be exposed, revoke it in your provider’s account settings as well.
        </div>
      )}

      {redirectUri && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-ctp-overlay">redirect URI:</span>
          <code data-testid="oauth-redirect-uri" className="font-mono text-ctp-text break-all">{redirectUri}</code>
          <button
            type="button" onClick={() => void copyUri()}
            aria-label="Copy the redirect URI" title="Copy the redirect URI"
            className="px-1.5 rounded bg-ctp-surface0 text-ctp-subtext hover:text-ctp-text"
          >{copied ? 'copied' : 'copy'}</button>
        </div>
      )}

      {error && <div data-testid="oauth-error" className="text-ctp-red/90">{error}</div>}
    </div>
  )
}
