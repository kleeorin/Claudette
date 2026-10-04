// BashProcDetail's OUTPUT PANE — the wiring the lib tests cannot reach.
//
// lib/bashProcLights pins the DECISIONS (when to poll, how to classify a response). What only a
// render can show is that the component acts on them: asks the endpoint with the right ids,
// stops asking once the process settles, and — the easy one to miss — fetches ONE MORE TIME
// after it settles, so the pane shows the command's closing lines instead of freezing on the
// last tick before it finished.
//
// STRUCTURAL ASSERTIONS ONLY: data-testid, call counts, call arguments. No Tailwind classes, and
// no negated assertion on copy that a rewording would make vacuous.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import type { BashProcRecord, BashProcOutputResponse } from '@claudette/shared'

const H = vi.hoisted(() => ({
  proc: null as unknown as BashProcRecord,
  sessionState: 'running' as string,
  calls: [] as Array<[string, string]>,
  next: null as unknown as () => Promise<BashProcOutputResponse>,
}))

vi.mock('../api/client', () => ({
  api: { http: { bashProcOutput: (id: string, toolId: string) => { H.calls.push([id, toolId]); return H.next() } } },
}))
vi.mock('../store/chat', () => ({
  // A FRESH record per call, deliberately. Returning the same H.proc object made record
  // identity stable across renders, which hid a real regression: `proc` added to the effect's
  // deps survived mutation testing with ZERO reds, because identity never changed here. A store
  // hands out new records as data arrives, so the harness has to as well.
  useChat: () => ({ bashProcsFor: () => [{ ...H.proc }], killBash: () => {} }),
}))
vi.mock('../store/sessions', () => ({
  useSessions: () => ({ sessions: [{ id: 's1', name: 'S', state: H.sessionState }] }),
}))

const { BashProcDetail } = await import('./BashProcDetail')
const { OUTPUT_POLL_MS } = await import('../lib/bashProcLights')

const PROC: BashProcRecord = {
  toolId: 'toolu_1', shellId: 'sh1', command: 'npm run build', startedAt: Date.now(), status: 'running',
}
const ok = (output: string, truncated = false): BashProcOutputResponse => ({ ok: true, retrievable: true, output, truncated })

// Let the fetch promise resolve and React commit.
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  vi.useFakeTimers()
  H.proc = { ...PROC }; H.sessionState = 'running'; H.calls = []
  H.next = async () => ok('LINE-ONE\n')
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('BashProcDetail — the output pane', () => {
  it('asks the endpoint for THIS session and THIS toolId, and renders the output', async () => {
    render(<BashProcDetail sessionId="s1" toolId="toolu_1" />)
    await flush()
    expect(H.calls[0]).toEqual(['s1', 'toolu_1'])
    expect(screen.getByTestId('bashproc-output-text').textContent).toBe('LINE-ONE\n')
  })

  it('polls while the process is running', async () => {
    render(<BashProcDetail sessionId="s1" toolId="toolu_1" />)
    await flush()
    const before = H.calls.length
    await act(async () => { vi.advanceTimersByTime(OUTPUT_POLL_MS * 3) })
    await flush()
    // EXACT, not ≥. A one-sided bound catches under-polling and is blind to OVER-polling —
    // e.g. `proc` (the object) added to the deps would re-fetch on every parent render while
    // this stayed green. Review finding; the settle case below already used the exact form.
    expect(H.calls.length).toBe(before + 3)
  })

  it('★ fetches ONE final time when the process settles, then stops polling', async () => {
    const { rerender } = render(<BashProcDetail sessionId="s1" toolId="toolu_1" />)
    await flush()
    H.next = async () => ok('LINE-ONE\nFINAL-LINE\n')
    H.proc = { ...PROC, status: 'done', endedAt: Date.now() }
    rerender(<BashProcDetail sessionId="s1" toolId="toolu_1" />)
    await flush()
    // The closing lines arrived — the pane did not freeze on the pre-settle tick.
    expect(screen.getByTestId('bashproc-output-text').textContent).toContain('FINAL-LINE')
    const settled = H.calls.length
    await act(async () => { vi.advanceTimersByTime(OUTPUT_POLL_MS * 5) })
    await flush()
    expect(H.calls.length).toBe(settled)   // …and nothing after that
  })

  it('renders a not-retrievable reason verbatim, as a reason and not an error', async () => {
    const reason = 'Nothing has been written to the output file yet.'
    H.next = async () => ({ ok: true, retrievable: false, reason })
    render(<BashProcDetail sessionId="s1" toolId="toolu_1" />)
    await flush()
    expect(screen.getByTestId('bashproc-output-reason').textContent).toBe(reason)
    expect(screen.queryByTestId('bashproc-output-error')).toBeNull()
  })

  it('★ renders a failed request as an ERROR, never as an empty pane', async () => {
    // get() throws on the endpoint's 404; that is a client/registry disagreement to surface.
    H.next = async () => { throw new Error('GET /api/session/s1/bashProc/toolu_1/output failed: 404') }
    render(<BashProcDetail sessionId="s1" toolId="toolu_1" />)
    await flush()
    expect(screen.getByTestId('bashproc-output-error')).toBeTruthy()
    expect(screen.queryByTestId('bashproc-output-empty')).toBeNull()
  })

  it('says so when the output is truncated to its tail', async () => {
    H.next = async () => ok('…tail…', true)
    render(<BashProcDetail sessionId="s1" toolId="toolu_1" />)
    await flush()
    expect(screen.getByTestId('bashproc-output-truncated')).toBeTruthy()
  })

  it('does NOT call the endpoint at all once the engine has stopped', async () => {
    // Both tiers level down: the server would only answer "no longer retrievable".
    H.sessionState = 'exited'
    render(<BashProcDetail sessionId="s1" toolId="toolu_1" />)
    await flush()
    expect(H.calls.length).toBe(0)
  })

  it('★ drops a STALE response that lands after a newer one (overlapping polls)', async () => {
    // Two requests from the SAME effect run: the older is slow, the newer fast. `cancelled`
    // cannot tell them apart — only ordering can. Without it the older tail lands last and
    // scrolls the pane BACKWARDS to superseded output.
    const deferred: Array<(r: BashProcOutputResponse) => void> = []
    H.next = () => new Promise((res) => { deferred.push(res) })
    render(<BashProcDetail sessionId="s1" toolId="toolu_1" />)
    await flush()                                             // request #1 in flight
    await act(async () => { vi.advanceTimersByTime(OUTPUT_POLL_MS) })
    await flush()                                             // request #2 in flight
    expect(deferred.length).toBe(2)
    deferred[1](ok('NEW-TAIL\n')); await flush()              // newer lands first
    deferred[0](ok('OLD-TAIL\n')); await flush()              // then the stale one
    expect(screen.getByTestId('bashproc-output-text').textContent).toBe('NEW-TAIL\n')
  })

  it('still updates when EVERY response is slower than the poll interval', async () => {
    // The trap in the obvious fix ("apply only the latest ISSUED"): each response is superseded
    // before it lands, so the pane would never update at all. Newest-APPLIED keeps progress.
    const deferred: Array<(r: BashProcOutputResponse) => void> = []
    H.next = () => new Promise((res) => { deferred.push(res) })
    render(<BashProcDetail sessionId="s1" toolId="toolu_1" />)
    await flush()
    await act(async () => { vi.advanceTimersByTime(OUTPUT_POLL_MS) })   // #2 issued before #1 lands
    await flush()
    deferred[0](ok('FIRST\n')); await flush()
    expect(screen.getByTestId('bashproc-output-text').textContent).toBe('FIRST\n')
  })

  // jsdom has no layout, so the scroll geometry is stubbed on the element itself.
  const geometry = (el: HTMLElement, scrollHeight: number, clientHeight: number) => {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  }

  it('★ does NOT yank a reader who scrolled up back to the bottom', async () => {
    // Its own toolId, so the module-level pin memory (per session+process) cannot leak
    // between the two scroll cases.
    H.proc = { ...PROC, toolId: 'toolu_scrollup' }
    render(<BashProcDetail sessionId="s1" toolId="toolu_scrollup" />)
    await flush()
    const pre = screen.getByTestId('bashproc-output-text')
    geometry(pre, 1000, 100)
    pre.scrollTop = 100                                       // 800px from the bottom
    act(() => { pre.dispatchEvent(new Event('scroll')) })
    H.next = async () => ok('LINE-ONE\nLINE-TWO\n')
    await act(async () => { vi.advanceTimersByTime(OUTPUT_POLL_MS) })
    await flush()
    expect(pre.textContent).toContain('LINE-TWO')             // it DID update…
    expect(pre.scrollTop).toBe(100)                           // …and left the reader where they were
  })

  it('follows new output while the reader is parked at the bottom', async () => {
    // Its own toolId, so the module-level pin memory (per session+process) cannot leak
    // between the two scroll cases.
    H.proc = { ...PROC, toolId: 'toolu_parked' }
    render(<BashProcDetail sessionId="s1" toolId="toolu_parked" />)
    await flush()
    const pre = screen.getByTestId('bashproc-output-text')
    geometry(pre, 1000, 100)
    pre.scrollTop = 900                                       // at the bottom
    act(() => { pre.dispatchEvent(new Event('scroll')) })
    H.next = async () => ok('LINE-ONE\nLINE-TWO\n')
    await act(async () => { vi.advanceTimersByTime(OUTPUT_POLL_MS) })
    await flush()
    expect(pre.scrollTop).toBe(1000)
  })
})
