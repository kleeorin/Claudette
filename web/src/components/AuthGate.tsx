import { useEffect, useState, type ReactNode } from 'react'
import { checkAuth, submitToken, ensureWs } from '../api/client'

// Gates the app behind the server's access token. On loopback-only dev (no token
// configured) `checkAuth` returns true immediately and this is invisible. When a
// token is required, it renders a small entry screen; on success it opens the WS
// and reveals the app. The `?token=…` bootstrap link is handled inside checkAuth.
export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'ok' | 'needed'>('checking')

  useEffect(() => {
    let live = true
    checkAuth()
      .then((ok) => { if (live) setStatus(ok ? 'ok' : 'needed') })
      .catch(() => { if (live) setStatus('needed') })
    return () => { live = false }
  }, [])

  if (status === 'ok') { ensureWs(); return <>{children}</> }

  if (status === 'checking') {
    return (
      <div className="h-full flex items-center justify-center text-ctp-overlay text-sm">
        <span className="w-2 h-2 rounded-full bg-ctp-accent animate-pulse mr-2" /> Connecting…
      </div>
    )
  }

  return <TokenScreen onAuthed={() => setStatus('ok')} />
}

function TokenScreen({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(false)

  const submit = async () => {
    if (!token.trim() || busy) return
    setBusy(true); setErr(false)
    const ok = await submitToken(token.trim())
    if (ok) onAuthed()
    else { setErr(true); setBusy(false) }
  }

  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="w-[360px] max-w-full rounded-xl border border-ctp-surface1 bg-ctp-mantle shadow-pop p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 24 24" className="w-5 h-5 text-ctp-accent" fill="currentColor" aria-hidden>
            <path d="M12 2.5c.5 0 .9.4.9.9v5.03l3.56-3.56a.9.9 0 0 1 1.27 1.27L14.16 9.7h5.03a.9.9 0 0 1 0 1.8h-5.03l3.56 3.56a.9.9 0 1 1-1.27 1.27L12.9 12.77v5.03a.9.9 0 0 1-1.8 0v-5.03l-3.56 3.56a.9.9 0 0 1-1.27-1.27l3.56-3.56H4.8a.9.9 0 0 1 0-1.8h5.03L6.27 6.14a.9.9 0 0 1 1.27-1.27L11.1 8.43V3.4c0-.5.4-.9.9-.9z" />
          </svg>
          <span className="text-sm font-semibold text-ctp-text">Claudette</span>
        </div>
        <div>
          <div className="text-sm text-ctp-text font-medium">Access token required</div>
          <div className="text-xs text-ctp-overlay mt-0.5">
            Enter the token this server was started with, or open the app with a <code className="text-ctp-subtext">?token=…</code> link once.
          </div>
        </div>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          placeholder="Access token"
          autoFocus
          className="modal-input"
        />
        {err && <div className="text-[11px] text-ctp-red">Invalid token — check the server logs.</div>}
        <button
          onClick={submit}
          disabled={busy || !token.trim()}
          className="w-full text-xs font-medium px-3 py-2 rounded-md bg-ctp-accent text-ctp-base hover:brightness-110 active:brightness-95 disabled:opacity-40 transition"
        >
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </div>
    </div>
  )
}
