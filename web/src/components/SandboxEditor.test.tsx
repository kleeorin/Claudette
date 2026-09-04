// SandboxEditor's FOLDER LIST — the union of "what this session mounts" and "what the
// operator saved as a default" (SandboxDefaultFolder).
//
// WHY THIS FILE EXISTS. The typecheck proves the two halves agree about names; it proves
// nothing about the behaviour the feature is actually for, which is entirely in how those
// two lists are merged into rows. Three properties carry the whole design and each fails
// silently if it regresses:
//
//   1. A path in BOTH lists is ONE row. Concatenating instead of deduping renders the same
//      folder twice with two mode chips that contradict each other on the next click.
//   2. Unticking a SAVED folder leaves the row in place; unticking an unsaved one takes the
//      row with it. That difference IS "a default is always there" — the user's whole ask.
//   3. Forgetting a default (☆) must not unmount it, and unmounting must not forget it.
//      They are two lists, and the buttons that edit them must stay unconfused.
//
// The mode chip is the subtle one: it edits WHATEVER THE ROW SHOWS, which is the session's
// mount for a ticked row and the saved default for an unticked one. Tests 6-7 pin both
// directions, because a chip that always wrote the session would make a default's saved mode
// uneditable, and one that always wrote the default would rewrite every session's access
// from inside a single session.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import type { SessionInfo, SandboxConfig, SandboxMount, SandboxDefaultFolder } from '@claudette/shared'

// Recorded calls, and the defaults list the mocked store hands back. `defaults` is read
// inside useSessions on every render (not captured at mock time), so a test can set it
// before render and the component sees it.
const H = { pushed: [] as SandboxConfig[], saved: [] as SandboxDefaultFolder[], forgotten: [] as string[] }
let defaults: SandboxDefaultFolder[] = []

vi.mock('../store/sessions', () => ({
  useSessions: () => ({
    sandboxAvailable: true,
    gpuDevices: [],
    setSandbox: async (_id: string, cfg: SandboxConfig) => { H.pushed.push(cfg) },
    sandboxDefaults: defaults,
    saveSandboxDefault: async (f: SandboxDefaultFolder) => { H.saved.push(f); return null },
    removeSandboxDefault: async (p: string) => { H.forgotten.push(p) },
  }),
}))
// Stubbed on purpose: this file is about the row logic. The picker and the connector grants
// are separately owned, and pulling them in would drag the real api client into a DOM test.
vi.mock('../api/client', () => ({ api: { http: { relaunchApply: vi.fn() } } }))
vi.mock('./FileBrowser', () => ({ FileBrowser: () => null }))
vi.mock('./ConnectorGrants', () => ({ ConnectorGrants: () => null }))

const { SandboxEditor } = await import('./SandboxEditor')

// Paths stay under /w: prettyPath rewrites a /home/<user> prefix to `~`, which would make
// the rendered text stop matching what the test asked for.
const session = (mounts: SandboxMount[]): SessionInfo => ({
  id: 's1', name: 's1', cwd: '/w/proj', rootDir: '/w/proj', state: 'idle',
  sandbox: { enabled: true, mounts },
})

// A row is identified by the one element carrying the full path as its title — the path
// span. Its parent is the row container holding the checkbox, mode chip and star.
const row = (path: string): HTMLElement => {
  const el = screen.getByTitle(path).parentElement
  if (!el) throw new Error(`no row for ${path}`)
  return el
}
const tick = (path: string) => within(row(path)).getByRole('checkbox')
const modeChip = (path: string, mode: 'rw' | 'ro') => within(row(path)).getByText(mode)
const star = (path: string) => within(row(path)).getByText(/[★☆]/)

afterEach(() => { cleanup(); H.pushed = []; H.saved = []; H.forgotten = []; defaults = [] })

describe('SandboxEditor folder list', () => {
  it('1. lists a saved default that is NOT mounted, unticked, alongside the mounts', () => {
    defaults = [{ path: '/w/docs', mode: 'ro' }]
    render(<SandboxEditor session={session([{ path: '/w/proj', mode: 'rw' }])} />)

    expect((tick('/w/proj') as HTMLInputElement).checked).toBe(true)
    // The whole point: a folder this session does not mount is still on screen, one click away.
    expect((tick('/w/docs') as HTMLInputElement).checked).toBe(false)
  })

  it('2. renders a path that is both mounted AND saved exactly ONCE', () => {
    defaults = [{ path: '/w/docs', mode: 'ro' }]
    render(<SandboxEditor session={session([{ path: '/w/docs', mode: 'rw' }])} />)

    expect(screen.getAllByTitle('/w/docs')).toHaveLength(1)
    expect((tick('/w/docs') as HTMLInputElement).checked).toBe(true)
    // Mounted, so the chip shows the SESSION's rw — not the default's saved ro.
    expect(within(row('/w/docs')).getByText('rw')).toBeTruthy()
    expect(star('/w/docs').textContent).toBe('★')
  })

  it('3. ticking an unmounted default mounts it at the mode it was saved with', () => {
    defaults = [{ path: '/w/docs', mode: 'ro' }]
    render(<SandboxEditor session={session([{ path: '/w/proj', mode: 'rw' }])} />)

    fireEvent.click(tick('/w/docs'))
    expect(H.pushed).toHaveLength(1)
    expect(H.pushed[0].mounts).toEqual([{ path: '/w/proj', mode: 'rw' }, { path: '/w/docs', mode: 'ro' }])
    // Mounting is not saving — the list it came from is untouched.
    expect(H.saved).toHaveLength(0)
  })

  it('4. unticking drops the mount, and the row SURVIVES only if the folder is saved', () => {
    defaults = [{ path: '/w/docs', mode: 'ro' }]
    const mounts = [{ path: '/w/proj', mode: 'rw' as const }, { path: '/w/docs', mode: 'ro' as const }]
    const { rerender } = render(<SandboxEditor session={session(mounts)} />)

    fireEvent.click(tick('/w/docs'))
    expect(H.pushed[0].mounts).toEqual([{ path: '/w/proj', mode: 'rw' }])

    // Re-render with the config the server would now hold. THIS is "always there": the row
    // is still on screen, unticked, because the folder is saved.
    rerender(<SandboxEditor session={session(H.pushed[0].mounts)} />)
    expect((tick('/w/docs') as HTMLInputElement).checked).toBe(false)

    // The mirror image: an UNSAVED mount unticked the same way leaves nothing behind.
    defaults = []
    rerender(<SandboxEditor session={session([{ path: '/w/scratch', mode: 'rw' }])} />)
    fireEvent.click(tick('/w/scratch'))
    rerender(<SandboxEditor session={session([])} />)
    expect(screen.queryByTitle('/w/scratch')).toBeNull()
  })

  it('5. ☆ saves a mounted-but-unsaved folder at its current mode, without touching the mount', () => {
    render(<SandboxEditor session={session([{ path: '/w/scratch', mode: 'rw' }])} />)

    expect(star('/w/scratch').textContent).toBe('☆')
    fireEvent.click(star('/w/scratch'))
    expect(H.saved).toEqual([{ path: '/w/scratch', mode: 'rw' }])
    expect(H.pushed).toHaveLength(0)
  })

  it('6. ★ forgets the default and leaves the mount alone', () => {
    defaults = [{ path: '/w/docs', mode: 'ro' }]
    render(<SandboxEditor session={session([{ path: '/w/docs', mode: 'ro' }])} />)

    fireEvent.click(star('/w/docs'))
    expect(H.forgotten).toEqual(['/w/docs'])
    // Forgetting a shortcut is not revoking a mount the operator granted.
    expect(H.pushed).toHaveLength(0)
  })

  it('7. the mode chip edits the session when ticked, and the saved default when not', () => {
    defaults = [{ path: '/w/docs', mode: 'ro' }]
    render(<SandboxEditor session={session([{ path: '/w/proj', mode: 'rw' }])} />)

    // Unticked row → the chip is the only way to change what a tick will grant, so it must
    // rewrite the DEFAULT and must not push a mount into a session that has none.
    fireEvent.click(modeChip('/w/docs', 'ro'))
    expect(H.saved).toEqual([{ path: '/w/docs', mode: 'rw' }])
    expect(H.pushed).toHaveLength(0)

    // Ticked row → the chip is this session's access, and the saved list stays put.
    fireEvent.click(modeChip('/w/proj', 'rw'))
    expect(H.pushed).toHaveLength(1)
    expect(H.pushed[0].mounts).toEqual([{ path: '/w/proj', mode: 'ro' }])
    expect(H.saved).toHaveLength(1)   // still just the one from above
  })
})
