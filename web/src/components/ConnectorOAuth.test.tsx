// ConnectorOAuth — the DOM wiring the pure tests in lib/connectorAuth.test.ts cannot reach:
// that the redirect URI is FETCHED rather than built, that the multi-account refusal is
// actually rendered, and that disconnect does not imply revocation.
//
// ★ ASSERTIONS ARE ON STRUCTURE — `data-auth-state`, `data-testid`, roles, aria-labels. Never
// on Tailwind classes, and never a negated assertion on a message copied from the component:
// that goes green the instant someone rewords the thing it was guarding.
//
// MUTATIONS (measured 2026-09-08), each with `ran=N` per the rule in scratchpad/assert.mjs —
// a crashed mutant yields zero failures exactly like a clean pass, so a red set alone is not
// a proof:
//   D1  delete the `state === 'multi-account'` block
//       → the refusal-rendered case reds ALONE. ran=6.
//   D2  render the revoke note unconditionally (drop `accounts.length > 0`)
//       → ORIGINALLY NO RED, at ran=15. Recorded as a gap rather than a pass, and the ran
//         count is what made that call safe: 15 assertions executed and none failed, so the
//         silence was a real hole and not a mutant that never ran. Closed by the
//         nothing-to-revoke case below; now reds. ran=16.
//   D3  construct the redirect URI from window.location instead of fetching it
//       → the fetched-URI case reds. ran=6.
//   D4  drop the `account` argument from the disconnect call
//       → the per-account disconnect case reds. ran=6.
//   XX  a patch matching no text must REFUSE.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { ConnectorView } from '@claudette/shared'

const H = { accounts: [] as string[], disconnected: [] as Array<{ connector: string; account?: string }>, started: [] as string[] }

vi.mock('../api/client', () => ({
  api: {
    http: {
      oauthAccounts: async () => ({ accounts: H.accounts }),
      oauthRedirectUri: async () => ({ redirectUri: 'http://127.0.0.1:4319/api/connectors/oauth/callback' }),
      oauthStart: async (connector: string) => { H.started.push(connector); return { error: 'no client' } },
      oauthDisconnect: async (connector: string, account?: string) => {
        H.disconnected.push({ connector, account })
        return { removed: true, accounts: H.accounts.filter((a) => a !== account) }
      },
    },
  },
}))

const { ConnectorOAuth } = await import('./ConnectorOAuth')

const CONN = (over: Partial<ConnectorView> = {}) =>
  ({ id: 'gcalendar', name: 'Google Calendar', ...over }) as ConnectorView

beforeEach(() => { H.accounts = []; H.disconnected = []; H.started = [] })
afterEach(cleanup)

describe('ConnectorOAuth', () => {
  it('publishes the authorization state on data-auth-state', async () => {
    H.accounts = []
    render(<ConnectorOAuth connector={CONN({ needsSetup: true })} />)
    await waitFor(() => expect(document.querySelector('[data-auth-state]')).toBeTruthy())
    expect(document.querySelector('[data-auth-state]')?.getAttribute('data-auth-state')).toBe('needs-client')
  })

  // ★ THE ONE THE REFUSAL EXISTS FOR. Two accounts means the server dials UNAUTHENTICATED,
  // which looks identical to working until a call fails. If the UI says nothing, that failure
  // is invisible — which is the whole reason the server refuses rather than guessing.
  it('renders the multi-account refusal, and withdraws the Connect button', async () => {
    H.accounts = ['a@x.com', 'b@x.com']
    render(<ConnectorOAuth connector={CONN({ oauthClientRef: 'g1' })} />)
    await waitFor(() => expect(screen.queryByTestId('oauth-multi-account')).toBeTruthy())
    expect(document.querySelector('[data-auth-state]')?.getAttribute('data-auth-state')).toBe('multi-account')
    expect(screen.queryByTestId('oauth-connect')).toBeNull()
  })

  it('shows the redirect URI it FETCHED, with a copy control', async () => {
    render(<ConnectorOAuth connector={CONN({ needsSetup: true })} />)
    const uri = await screen.findByTestId('oauth-redirect-uri')
    // Asserting the value came from the API, not that it merely looks like a URL: a
    // client-built string would differ on port or host and fail at the provider silently.
    expect(uri.textContent).toBe('http://127.0.0.1:4319/api/connectors/oauth/callback')
    expect(screen.getByLabelText('Copy the redirect URI')).toBeTruthy()
  })

  it('disconnect names the account it is removing', async () => {
    H.accounts = ['me@x.com']
    render(<ConnectorOAuth connector={CONN({ oauthClientRef: 'g1' })} />)
    fireEvent.click(await screen.findByLabelText('Disconnect me@x.com'))
    await waitFor(() => expect(H.disconnected).toEqual([{ connector: 'gcalendar', account: 'me@x.com' }]))
  })

  it('says disconnecting is not revoking, wherever an account exists', async () => {
    H.accounts = ['me@x.com']
    render(<ConnectorOAuth connector={CONN({ oauthClientRef: 'g1' })} />)
    // Structural: the note is PRESENT. Its wording is not asserted — that would pin prose.
    expect(await screen.findByTestId('oauth-revoke-note')).toBeTruthy()
  })

  // Added after mutation D2 showed the note's ABSENCE was unpinned. Not writing the test to
  // the mutation: "do not tell someone to revoke a token they do not have" is a real property
  // — a revocation warning on a connector nobody has authorized is an instruction to act on
  // something that does not exist, which is the same class of fault as the setup hint that
  // told an operator to create a client they had just created.
  it('…and does NOT say it where there is nothing to revoke', async () => {
    H.accounts = []
    render(<ConnectorOAuth connector={CONN({ needsSetup: true, oauthClientRef: 'g1' })} />)
    await screen.findByTestId('oauth-redirect-uri')   // wait for the effects to settle first
    expect(screen.queryByTestId('oauth-revoke-note')).toBeNull()
  })

  it("surfaces the server's reason when starting a flow is refused", async () => {
    render(<ConnectorOAuth connector={CONN({ needsSetup: true })} />)
    fireEvent.click(await screen.findByTestId('oauth-connect'))
    await waitFor(() => expect(screen.queryByTestId('oauth-error')).toBeTruthy())
    expect(H.started).toEqual(['gcalendar'])
  })
})
