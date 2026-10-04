// The Files dock's RETURN-TO-SESSION-FOLDER button.
//
// ★ WHY THIS BUTTON NEEDS A TEST AT ALL, given it is three lines of JSX.
// The pane deliberately RESUMES where it was last left rather than at the session root
// (`lastDirByCwd`), which is the right default and is exactly what makes this button
// necessary: a pane can open several levels away from the folder the session actually works
// in, and before this the only route back was clicking up the breadcrumb one segment at a
// time. So the button's whole value is that it goes to `initialPath` — the SESSION's cwd —
// and not to anything derived from where the pane currently is.
//
// ★★ THE REGRESSION IT EXISTS TO CATCH, and it is one token wide:
//     void load(initialPath)   →   void load(dir)
// That still compiles, still navigates, still looks right in review — and silently turns the
// control into a second Refresh button. The disabled-state assertions alone would NOT catch
// it (the button is correctly enabled either way); only navigating somewhere else and then
// asserting WHERE the click lands can see it.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

// ★ A DISTINCT cwd PER TEST, and this is not fastidiousness — it is required.
// FileManager remembers the last folder per cwd in `lastDirByCwd`, a MODULE-LEVEL map that
// deliberately outlives any one mount (that is the resume-where-you-left-off feature). Share
// one cwd across these tests and the second one opens where the first navigated to, so the
// suite passes or fails on test ORDER. Keying each test to its own cwd sidesteps the shared
// map without reaching into private module state.
let n = 0
const nextCwd = () => `/home/u/proj-${++n}`

// A faithful-enough fake of `api.fs.list`: it records every path asked for, which is the
// assertion surface here, and answers with a directory listing shaped like the real one.
const H = vi.hoisted(() => ({ listed: [] as string[] }))
vi.mock('../api/client', () => ({
  api: {
    fs: {
      list: async (path: string) => {
        H.listed.push(path)
        return { path, entries: [{ name: 'src', isDir: true }, { name: 'a.txt', isDir: false, size: 3 }] }
      },
      downloadUrl: (p: string) => `/dl?${p}`,
      copy: async () => ({ ok: true }), createFile: async () => ({ ok: true }),
      mkdir: async () => ({ ok: true }), remove: async () => ({ ok: true }),
      rename: async () => ({ ok: true }), upload: async () => ({ ok: true }),
    },
  },
}))

const { FileManager } = await import('./FileManager')

const mount = (cwd: string) => render(
  <FileManager initialPath={cwd} onOpenNotebook={() => {}} onOpenFile={() => {}} onNewNotebook={async () => null} onClose={() => {}} />,
)
// Wait for the mount's OWN initial load to land before asserting on what a click asked for.
// Without this the component's first `list` resolves after the log is cleared and shows up as
// if the click had caused it — a false failure that looks exactly like a real bug.
const settled = async (cwd: string) => {
  await waitFor(() => expect(homeBtn()).toBeTruthy())
  await waitFor(() => expect(H.listed).toContain(cwd))
}
const homeBtn = () => document.querySelector('[data-at-session-dir]') as HTMLButtonElement

afterEach(() => { cleanup(); H.listed = [] })

describe('the return-to-session-folder button', () => {
  it('is present and DISABLED while the pane is already in the session folder', async () => {
    const cwd = nextCwd(); mount(cwd); await settled(cwd)
    // Disabled rather than hidden, deliberately: hiding it would shift Refresh and Close
    // leftwards as you navigate, moving controls under the cursor.
    expect(homeBtn().getAttribute('data-at-session-dir')).toBe('true')
    expect(homeBtn().disabled).toBe(true)
  })

  it('becomes ENABLED once the pane is somewhere else', async () => {
    const cwd = nextCwd(); mount(cwd); await settled(cwd)
    fireEvent.click(await screen.findByText('src'))     // walk into a subfolder
    await waitFor(() => expect(homeBtn().getAttribute('data-at-session-dir')).toBe('false'))
    expect(homeBtn().disabled).toBe(false)
  })

  it('★★ navigates to the SESSION folder, not to wherever the pane currently is', async () => {
    const cwd = nextCwd(); const sub = `${cwd}/src`
    mount(cwd); await settled(cwd)
    fireEvent.click(await screen.findByText('src'))
    await waitFor(() => expect(H.listed).toContain(sub))

    H.listed = []                                        // only what the CLICK asks for
    fireEvent.click(homeBtn())
    await waitFor(() => expect(H.listed.length).toBeGreaterThan(0))

    // The assertion that catches `load(dir)`: it must ask for the session cwd, and must NOT
    // re-ask for the folder it was already showing.
    expect(H.listed).toContain(cwd)
    expect(H.listed).not.toContain(sub)
  })

  it('does nothing when it is already in the session folder', async () => {
    // A disabled button should not navigate; asserting the negative stops a future version
    // that drops `disabled` but keeps the styling from looking fine.
    const cwd = nextCwd(); mount(cwd); await settled(cwd)
    H.listed = []
    fireEvent.click(homeBtn())
    await new Promise((r) => setTimeout(r, 50))
    expect(H.listed).toEqual([])
  })
})
