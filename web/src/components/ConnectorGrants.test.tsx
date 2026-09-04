// ConnectorGrants — does a connector that CANNOT WORK YET say so, in both grant states?
//
// WHY THIS FILE EXISTS. A real operator granted `gcalendar`, saw a checked box, and had no
// idea it needed a Google OAuth client they had to create. The server was blameless: it
// reported `needsSetup: true`, `health: 'needs-auth'`, `lastError: 'upstream returned 401'`
// and a per-product `setupHint`, all correct, all in the API response. This component
// rendered the explanation only when the row was gated on `blocked` — which is
// `needsSetup && !on` — so the ONE state a confused operator is actually in, granted and
// broken, was the one state that explained nothing.
//
// The bug was invisible to every other check we have. The typecheck passes either way: the
// fields exist and are read. The connector harnesses talk to a live server and assert on its
// RESPONSE, which was already correct. Nothing anywhere asserted that a correct response
// reaches the screen. That gap is exactly the shape of this repo's recurring defect — a check
// that is green in the state it was meant to catch — so the assertions below are written
// against the RENDERED TEXT, not against the props.
//
// Test 2 is the one that matters. Test 1 pins the case that already worked, because the
// generalisation had to not regress it, and a fix that trades one broken state for another is
// how the third vacuous assertion in real-turn-browser-test.mjs came to exist.
//
// MUTATIONS (measured 2026-09-04; re-run them rather than trusting this record — and note
// WHICH edit, since an edit loose enough to have variants has no reproducible result):
//   M1  gate the explanation back on `blocked` instead of `c.needsSetup`
//       → test 2 reds ("granted + needsSetup explains itself"); test 1 stays green. That is
//         precisely the regression this file exists for, and the asymmetry is the evidence
//         the two tests are not one test written twice.
//   M2  drop the `{c.setupHint ? ... : null}` interpolation
//       → tests 1 and 2 both red on the hint assertion.
//   M3  delete the `{c.lastError && ...}` block
//       → test 3 reds.
//   M4  make the lead unconditional (`Can’t be granted yet — ` for both states)
//       → test 2 reds on the granted-lead assertion, while the hint assertion stays green —
//         which is why the lead is asserted separately from the hint.
//   XX  a patch matching no text must REFUSE, not silently run the unmutated file.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { SessionInfo, ConnectorView } from '@claudette/shared'

// The catalog the mocked client hands back. Read inside the component's effect on mount, so a
// test sets it before render and the component sees it.
let catalog: ConnectorView[] = []

vi.mock('../api/client', () => ({
  api: {
    http: {
      listConnectors: async () => ({ connectors: catalog, accountConnectors: [], strict: false }),
      setSessionConnectors: async () => ({}),
    },
  },
}))

const { ConnectorGrants } = await import('./ConnectorGrants')

// The gcalendar row as the live server actually reports it, so the fixture cannot drift into
// a shape the product never produces — the failure mode that made turn-indicator's fixtures
// green against a world they did not describe.
const GCAL: ConnectorView = {
  id: 'gcalendar',
  name: 'Google Calendar',
  transport: 'http',
  builtin: true,
  needsSetup: true,
  setupHint: 'Needs a Google OAuth client (Cloud Console → Web application) with Calendar scopes.',
  health: 'needs-auth',
  lastError: 'upstream returned 401',
  headerKeys: [],
  envKeys: [],
} as unknown as ConnectorView

const session = (granted: string[]) =>
  ({ id: 's1', name: 'S', connectors: granted, accountConnectors: [] }) as unknown as SessionInfo

afterEach(() => { cleanup(); catalog = [] })

describe('ConnectorGrants — a connector that cannot work yet', () => {
  it('1 UNGRANTED + needsSetup: blocks the toggle and explains why (the case that already worked)', async () => {
    catalog = [GCAL]
    render(<ConnectorGrants session={session([])} compact />)
    expect(await screen.findByText(/Google Calendar/)).toBeTruthy()
    // The checkbox must stay disabled — generalising the message must not unblock the grant.
    const box = document.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(box.disabled).toBe(true)
    expect(box.checked).toBe(false)
    expect(document.body.textContent).toContain('Can’t be granted yet')
    // The SERVER's per-product hint, not a copy of it living in web/src.
    expect(document.body.textContent).toContain('Cloud Console → Web application')
  })

  it('2 GRANTED + needsSetup: still explains itself, and does not claim it cannot be granted', async () => {
    catalog = [GCAL]
    render(<ConnectorGrants session={session(['gcalendar'])} compact />)
    expect(await screen.findByText(/Google Calendar/)).toBeTruthy()
    const box = document.querySelector('input[type="checkbox"]') as HTMLInputElement
    // Checked and enabled — revoking must always stay possible. This is exactly the state
    // that used to render two words and nothing else.
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(false)
    // ★ THE ASSERTION THIS FILE EXISTS FOR.
    expect(document.body.textContent).toContain('Cloud Console → Web application')
    // The lead must be true of a granted row. Asserted separately from the hint so a wrong
    // lead cannot hide behind a right hint.
    expect(document.body.textContent).toContain('Granted, but it cannot work yet')
    expect(document.body.textContent).not.toContain('Can’t be granted yet')
  })

  it('3 the upstream error reaches the SCREEN, not just a title attribute', async () => {
    catalog = [GCAL]
    render(<ConnectorGrants session={session(['gcalendar'])} compact />)
    expect(await screen.findByText(/Google Calendar/)).toBeTruthy()
    // Was previously reachable only as a tooltip on chips this state never renders. A title
    // is also invisible on a phone, which is where this panel is usually read.
    expect(screen.getByText('upstream returned 401')).toBeTruthy()
  })

  it('4 a healthy connector shows none of it (the alarm can stay silent)', async () => {
    catalog = [{ ...GCAL, id: 'ok', name: 'Fine', needsSetup: false, health: 'connected', lastError: undefined, setupHint: undefined } as unknown as ConnectorView]
    render(<ConnectorGrants session={session(['ok'])} compact />)
    expect(await screen.findByText(/Fine/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('cannot work yet')
    expect(document.body.textContent).not.toContain('Can’t be granted yet')
    expect(document.body.textContent).not.toContain('upstream returned 401')
  })
})
