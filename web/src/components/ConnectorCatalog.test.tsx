// ConnectorCatalog — does a FAILED load reach the user, or does the panel just sit there?
//
// ★ WHY THIS FILE EXISTS. `get()` in api/client.ts was changed to throw on any non-2xx,
// which was right — before, a 404/401 body resolved and was cast to the success type, and
// that is what crashed the Settings panel. But the landing missed this component. `refresh()`
// had no `catch` and set `loading` false only on the happy path, so once the GET threw,
// `setLoading(false)` never ran and the early `if (loading)` return below rendered
// "Loading catalog…" FOREVER — no error, no retry, on an expired token.
//
// That is byte-for-byte the SettingsPanel defect the same changeset was written to remove: a
// failure that reaches the component and never reaches the USER. Fixing one instance of a
// class while creating three more is the exact pattern this repo keeps rediscovering, which
// is why the fix is pinned here rather than just made.
//
// ASSERTED ON RENDERED TEXT, not on props or state — for the reason ConnectorGrants.test.tsx
// gives in its own header: the typecheck passes either way, and nothing else in the repo
// asserts that a correct failure reaches the screen.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

const H = vi.hoisted(() => ({
  // A function reference the tests can swap, because the defect is only reachable on the
  // REJECTING path and a fixed mock cannot express one — the same gap that left the
  // SettingsPanel failure uncovered until it was found in production.
  listConnectors: async () => ({ connectors: [], accountConnectors: [], strict: false }) as unknown,
}))

vi.mock('../api/client', () => ({
  api: {
    http: {
      listConnectors: () => H.listConnectors(),
      connectorPreflight: async () => ({ servers: [] }),
      deleteConnector: async () => ({ ok: true }),
      saveConnector: async () => ({}),
    },
  },
}))

const { ConnectorCatalog } = await import('./ConnectorCatalog')

beforeEach(() => {
  H.listConnectors = async () => ({ connectors: [], accountConnectors: [], strict: false })
})
afterEach(cleanup)

describe('ConnectorCatalog — a failed load must not look like a slow one', () => {
  it('shows an error instead of loading forever when the catalog GET rejects', async () => {
    // Exactly what `get()` now does on a 401 from an expired token.
    H.listConnectors = async () => { throw new Error('GET /api/connectors failed: 401 {"ok":false,"error":"invalid token"}') }
    render(<ConnectorCatalog cwd="/w" />)

    await waitFor(() => expect(screen.queryByText(/Could not load/i)).toBeTruthy())
    // ★ THE ASSERTION THAT WOULD HAVE CAUGHT THE BUG. The error appearing is not enough on
    // its own — the defect was the loading state never clearing, so the absence of
    // "Loading catalog…" is the half that actually names it.
    expect(screen.queryByText(/Loading catalog/i)).toBeNull()
  })

  it('surfaces the server\'s own words, not a generic message', async () => {
    // The status and body are the only things that distinguish "your token expired" from
    // "the route does not exist". Swallowing them leaves the user with nothing to act on.
    H.listConnectors = async () => { throw new Error('GET /api/connectors failed: 500 kaboom') }
    render(<ConnectorCatalog cwd="/w" />)
    await waitFor(() => expect(screen.queryByText(/kaboom/)).toBeTruthy())
  })

  it('still renders the catalog normally when the GET succeeds', async () => {
    // The counterweight. A panel that showed an error unconditionally would also pass the
    // two cases above and would be useless.
    render(<ConnectorCatalog cwd="/w" />)
    await waitFor(() => expect(screen.queryByText(/Loading catalog/i)).toBeNull())
    expect(screen.queryByText(/Could not load/i)).toBeNull()
  })
})
