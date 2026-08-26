// SessionsProvider's WIRING. The transitions are already covered by
// scratchpad/session-reducer-test.mts (32 assertions, pure, no DOM); this file covers only
// what genuinely needs React to run: that the subscription happens once and is cleaned up,
// that events arriving late still reconcile, that identity is preserved well enough not to
// re-render consumers for nothing, and that selecting a session clears its unread dot in the
// SAME commit rather than the next one.
//
// TEST 1 IS THE POINT OF THIS FILE. The subscription effect's dep array was [patch] and is
// now []. That is correct only because `dispatch` is stable and nothing else in the closure
// is read — and if it ever regresses, nothing else in the codebase notices. Everything below
// test 1 is worth having; test 1 is why the dependencies were added.
//
// WHAT THIS FILE CANNOT DO, stated so it is not read as more than it is: "no stale closure"
// is the absence of a bug and cannot be asserted directly. Test 3 pins its observable
// CONSEQUENCE, which is a proxy, not a proof.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import type { SessionInfo, SessionState } from '@claudette/shared'

// A FAITHFUL FAKE, not a stub. The real client's channels are plain Sets with on/emit
// (client.ts:66-72) whose `on` returns a delete-me closure; this reproduces that exactly and
// adds counters. Test 1 is only meaningful because unsubscribe genuinely removes — a stub
// that ignored it would make the whole file vacuous.
const H = vi.hoisted(() => {
  function makeChannel<A extends unknown[]>() {
    const set = new Set<(...a: A) => void>()
    const ch = {
      subscribes: 0,
      unsubscribes: 0,
      on(fn: (...a: A) => void) {
        ch.subscribes++
        set.add(fn)
        return () => { ch.unsubscribes++; set.delete(fn) }
      },
      emit(...a: A) { for (const fn of [...set]) fn(...a) },
      get listeners() { return set.size },
      reset() { set.clear(); ch.subscribes = 0; ch.unsubscribes = 0 },
    }
    return ch
  }
  return {
    lists: makeChannel<[SessionInfo[]]>(),
    states: makeChannel<[string, SessionState]>(),
    readies: makeChannel<[string, string]>(),
    exits: makeChannel<[string, boolean, string]>(),
    conn: makeChannel<[boolean]>(),
    created: [] as Array<{ id: string }>,
  }
})

vi.mock('../api/client', () => ({
  getHealth: async () => ({ ok: true, version: 't', ts: 0, sandboxAvailable: false, gpuDevices: [], homeDir: '/home/t' }),
  api: {
    on: {
      list: H.lists.on, stateChange: H.states.on, ready: H.readies.on,
      exit: H.exits.on, connected: H.conn.on,
    },
    http: {
      listSessions: async () => [],
      listAgents: async () => [],
      createSession: async () => { const r = { id: 'new-1' }; H.created.push(r); return r },
      destroySession: async () => ({ ok: true }),
      setAgent: async () => ({ ok: true }),
      rename: async () => ({ ok: true }),
      setMode: async () => ({ applied: 'live', mode: 'default' }),
      setSandbox: async () => ({ ok: true }),
      setTeamEmploy: async () => ({ ok: true }),
    },
  },
}))

const { SessionsProvider, useSessions } = await import('./sessions')

const sess = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id, name: id, cwd: '/w', rootDir: '/w', state: 'idle', ...over,
})

// A probe that records every COMMITTED value, so test 6 can assert about intermediate
// frames rather than only the final state. Recording during render is impure; acceptable
// here because we control the tree and deliberately do not wrap it in StrictMode.
type Ctx = ReturnType<typeof useSessions>
let ctx: Ctx | null = null
let renders = 0
const commits: Array<{ activeId: string | null; attention: string[] }> = []
function Probe() {
  renders++
  ctx = useSessions()
  commits.push({ activeId: ctx.activeId, attention: [...ctx.attention] })
  return null
}

async function mount() {
  const r = render(<SessionsProvider><Probe /></SessionsProvider>)
  await act(async () => { /* flush the mount-time health/agents/list promises */ })
  return r
}
const emit = async (fn: () => void) => { await act(async () => { fn() }) }

beforeEach(() => {
  for (const c of [H.lists, H.states, H.readies, H.exits, H.conn]) c.reset()
  H.created.length = 0
  ctx = null; renders = 0; commits.length = 0
})
afterEach(() => cleanup())

describe('SessionsProvider wiring', () => {
  // ── 1. THE EMPTY DEP ARRAY ────────────────────────────────────────────────
  it('subscribes exactly once and never resubscribes, however much state churns', async () => {
    await mount()
    const channels = [H.lists, H.states, H.readies, H.exits, H.conn]
    expect(channels.map((c) => c.subscribes)).toEqual([1, 1, 1, 1, 1])

    await emit(() => H.lists.emit([sess('a'), sess('b')]))
    for (let i = 0; i < 20; i++) {
      await emit(() => H.states.emit('a', i % 2 ? 'idle' : 'running'))
    }
    await emit(() => H.conn.emit(true))

    // If the dep array regresses to [patch] (or gains any value that changes identity), the
    // effect re-runs and these climb. That is the entire reason this file exists.
    expect(channels.map((c) => c.subscribes)).toEqual([1, 1, 1, 1, 1])
    expect(channels.map((c) => c.listeners)).toEqual([1, 1, 1, 1, 1])
    expect(channels.map((c) => c.unsubscribes)).toEqual([0, 0, 0, 0, 0])
  })

  // ── 2. cleanup ────────────────────────────────────────────────────────────
  it('unsubscribes every channel on unmount', async () => {
    const r = await mount()
    r.unmount()
    const channels = [H.lists, H.states, H.readies, H.exits, H.conn]
    expect(channels.map((c) => c.listeners)).toEqual([0, 0, 0, 0, 0])
    for (const c of channels) expect(c.unsubscribes).toBe(c.subscribes)
  })

  // ── 3. late events reconcile against CURRENT state ───────────────────────
  // A PROXY for "no stale closure", not a proof — you cannot assert the absence of a bug.
  // A handler that read closed-over state would answer this against the state at subscribe
  // time, when the session did not exist and was certainly not running.
  it('an event arriving after heavy churn still respects current state', async () => {
    await mount()
    await emit(() => H.lists.emit([sess('a')]))
    for (let i = 0; i < 10; i++) await emit(() => H.states.emit('a', i % 2 ? 'idle' : 'running'))
    await emit(() => H.states.emit('a', 'running'))
    await emit(() => H.readies.emit('a', 'claude-session-id'))
    // The ready-clobber rule, applied at the far end of a long event stream.
    expect(ctx!.sessions.find((s) => s.id === 'a')!.state).toBe('running')
  })

  // ── 4. identity: a no-op event must not re-render consumers ──────────────
  it('a redundant state event does not re-render consumers', async () => {
    await mount()
    await emit(() => H.lists.emit([sess('a', { state: 'running' })]))
    await emit(() => H.states.emit('a', 'running'))   // settle to the same value
    const before = renders
    await emit(() => H.states.emit('a', 'running'))   // …and again: nothing changed
    expect(renders).toBe(before)
  })

  // ── 5. isFresh stability ─────────────────────────────────────────────────
  // The consequence of reducer test 11. isFresh is useCallback(..., [store.fresh]); if any
  // action rebuilt that set, the context value would churn and ChatView's auto-resume effect
  // (its only consumer, ChatView.tsx:249 with isFresh in its deps at :267) would re-run on
  // every running→idle.
  it('isFresh keeps its identity across ordinary churn', async () => {
    await mount()
    await emit(() => H.lists.emit([sess('a'), sess('b')]))
    const first = ctx!.isFresh
    await emit(() => H.states.emit('a', 'running'))
    await emit(() => H.states.emit('a', 'idle'))
    await emit(() => H.exits.emit('b', true, 'boom'))
    expect(ctx!.isFresh).toBe(first)
  })

  // ── 6. the unread dot clears in the SAME commit ──────────────────────────
  // The old code cleared attention in a useEffect on activeId, which runs AFTER render — so
  // there was a frame in which the session you had just opened still showed its dot. Now it
  // is part of the same transition (withActive), so NO COMMIT should ever show both.
  it('never commits a frame where the active session still carries its unread dot', async () => {
    await mount()
    await emit(() => H.lists.emit([sess('a'), sess('b')]))
    await emit(() => H.states.emit('b', 'running'))
    await emit(() => H.states.emit('b', 'idle'))     // finishes unwatched → flagged
    expect(ctx!.attention.has('b')).toBe(true)
    await emit(() => ctx!.setActive('b'))
    const bad = commits.filter((c) => c.activeId !== null && c.attention.includes(c.activeId))
    expect(bad).toEqual([])
    expect(ctx!.attention.has('b')).toBe(false)
  })

  // ── 7. create() lands atomically ─────────────────────────────────────────
  // Three statements in the old provider (mark fresh, add optimistically, select) are one
  // action now. The point is that no commit can show the session without its fresh mark —
  // which is what made the ref version theoretically racy.
  it('a created session is present, active and fresh in the same commit', async () => {
    await mount()
    await act(async () => { await ctx!.create('New', '/w') })
    expect(ctx!.sessions.map((s) => s.id)).toContain('new-1')
    expect(ctx!.activeId).toBe('new-1')
    expect(ctx!.isFresh('new-1')).toBe(true)
    // …and a session that merely arrived over the wire is NOT fresh.
    await emit(() => H.lists.emit([sess('restored'), sess('new-1')]))
    expect(ctx!.isFresh('restored')).toBe(false)
  })
})

// ════════ TWO THINGS TO EXPECT ON THE FIRST RUN ════════
// THIS FILE HAS NEVER BEEN EXECUTED. It was written while vitest could not be installed
// (node_modules was read-only), so it is staged, not passing. Treat a green first run as
// news, not as confirmation.
//
// 1. The top-level `await import('./sessions')` requires the file to be treated as an ES
//    module with top-level await — standard under vitest, but if it complains, move it to a
//    `beforeAll` or use a static import (the vi.mock call is hoisted above both either way).
// 2. Test 4 asserts an exact render count and is the most brittle line here. React may
//    legitimately batch or re-render for reasons unrelated to the store. If it proves flaky,
//    weaken it to an identity check on the sessions array rather than a render count —
//    which tests the same claim one layer lower and is not at the mercy of the scheduler.
//    Do NOT simply delete it: the identity preservation it guards is what keeps H2's
//    workaround from having to spread further.
