import type { FastifyInstance } from 'fastify'
import { startAuthorization, completeAuthorization, redirectUri, disconnectAccount } from './connectorOAuth'
import { accountsFor } from './connectorCreds'

// HTTP surface for the interactive connector OAuth flow.
//
// Every route here is behind the app's global auth guard (the preHandler hook in index.ts), and
// that is load-bearing rather than incidental — see the callback below. A sandboxed session
// shares the network namespace and can reach this port, but holds no CLAUDETTE_TOKEN, so it
// cannot start an authorization, complete one, or learn that a token exists.
//
// NO TOKEN VALUE IS EVER RETURNED BY ANY ROUTE HERE. The UI needs to know THAT a connector is
// authorized and by WHICH account; it never needs the credential, and a token that reaches the
// browser is a token in the DOM, in devtools, and in any screen recording.

export function registerConnectorOAuthRoutes(app: FastifyInstance): void {
  // The exact redirect URI to register with the provider. SURFACED rather than documented as a
  // constant because PORT and HOST are configurable, and an exact-matching provider rejects
  // `localhost` for `127.0.0.1` and `:4319` for `:4320`. A doc that says "register
  // http://localhost:4319/..." is wrong for every operator who changed either.
  app.get('/api/connectors/oauth/redirect-uri', async () => ({ redirectUri: redirectUri() }))

  // Which accounts have authorized a connector. Names only — never tokens.
  app.get<{ Querystring: { connector?: string } }>('/api/connectors/oauth/accounts', async (req, reply) => {
    const id = req.query.connector
    if (!id) { reply.code(400); return { error: 'A connector id is required.' } }
    return { accounts: accountsFor(id) }
  })

  // Begin an authorization. Returns the provider URL for the operator's own browser to open.
  //
  // Deliberately NOT a 302. The caller is the operator's SPA making an XHR; answering with a
  // redirect would have the browser follow it inside the fetch, landing the consent page in a
  // response body nobody renders. The client opens the URL itself.
  app.post<{ Body: { connector?: string } }>('/api/connectors/oauth/start', async (req, reply) => {
    const id = req.body?.connector
    if (!id) { reply.code(400); return { error: 'A connector id is required.' } }
    const r = await startAuthorization(id)
    if (!r.ok) { reply.code(400); return { error: r.error } }
    return { url: r.url, redirectUri: r.redirectUri }
  })

  // The provider redirects the operator's BROWSER here with ?code&state.
  //
  // WHY IT IS SAFE FOR THIS TO BE AUTH-GATED: it is a top-level navigation from the operator's
  // own browser, which already holds the app's auth cookie for this origin — so the gate passes
  // for the person who started the flow and fails for everyone else. That is the property that
  // makes it correct to put an authorization code on this origin at all, and it is why the
  // callback lives on the main app rather than on the proxy (which has no gate).
  //
  // Answers HTML, not JSON: a human is looking at this tab.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/connectors/oauth/callback', async (req, reply) => {
      const page = (title: string, detail: string): string =>
        `<!doctype html><meta charset="utf-8"><title>${title}</title>`
        + '<body style="font:14px system-ui;padding:2rem;max-width:40rem">'
        + `<h1 style="font-size:1.1rem">${title}</h1><p>${detail}</p>`
        + '<p>You can close this tab and return to Claudette.</p>'

      // The provider refused, or the user pressed Cancel. `error` is provider-controlled text, so
      // it is NOT interpolated into the page — it goes to the log and the user gets a fixed
      // sentence. Reflecting it would be HTML injection from a third party into our origin.
      if (req.query.error) {
        console.warn(`[connector-oauth] provider returned an error at the callback: ${req.query.error}`)
        reply.code(400).type('text/html')
        return page('Authorization was not completed', 'The provider declined the request, or it was cancelled.')
      }

      const r = await completeAuthorization(req.query.state ?? '', req.query.code ?? '')
      if (!r.ok) {
        reply.code(400).type('text/html')
        // r.error is OUR text or the provider's error CODE (invalid_grant / invalid_client), both
        // safe to show and both genuinely diagnostic — but escaped anyway, because "safe today"
        // is a property of the current callers, not of this line.
        return page('Authorization failed', escapeHtml(r.error))
      }
      reply.type('text/html')
      return page('Connected', `${escapeHtml(r.connectorId)} is now authorized as ${escapeHtml(r.account)}.`)
    })

  // Forget our copy of a grant.
  //
  // ★ THIS DOES NOT REVOKE AT THE PROVIDER. The upstream token stays valid until it expires or
  // the user revokes it in their Google account. What this DOES guarantee is that Claudette will
  // not present it again. The wording here and in the UI must not claim more than that — see the
  // revocation-asymmetry note in CONNECTORS.md.
  app.post<{ Body: { connector?: string; account?: string } }>(
    '/api/connectors/oauth/disconnect', async (req, reply) => {
      const id = req.body?.connector
      if (!id) { reply.code(400); return { error: 'A connector id is required.' } }
      const r = await disconnectAccount(id, req.body?.account)
      // Report what HAPPENED, not what was attempted. "revoked" and "forgotten" are different
      // promises and the UI must not make the stronger one on the weaker outcome.
      return { ...r, accounts: accountsFor(id) }
    })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
