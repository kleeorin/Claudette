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
  // THE SOCKET'S TWO LIVENESS QUESTIONS, kept faithful rather than stubbed to a constant.
  // `SessionsProvider` seeds `wasDown = api.hasEverConnected() && !api.isConnected()`, and
  // the real client answers those from two different pieces of state: `everConnected` is set
  // once in `sock.onopen` and NEVER cleared, while `isConnected()` reads the socket's current
  // readyState. That difference is the entire point of having both — readyState cannot tell
  // "never connected yet" from "was connected and dropped". Driving both off the `conn`
  // channel the test already emits on keeps one source of truth, so a test that emits
  // `conn(true)` then `conn(false)` gets `ever=true, up=false` exactly as a real drop would,
  // instead of a pair of frozen booleans that agree with nothing.
  const conn = makeChannel<[boolean]>()
  const connState = { ever: false, up: false }
  const rawEmit = conn.emit.bind(conn)
  conn.emit = (up: boolean) => { if (up) connState.ever = true; connState.up = up; rawEmit(up) }
  const rawReset = conn.reset.bind(conn)
  conn.reset = () => { connState.ever = false; connState.up = false; rawReset() }
  return {
    lists: makeChannel<[SessionInfo[]]>(),
    states: makeChannel<[string, SessionState]>(),
    readies: makeChannel<[string, string]>(),
    exits: makeChannel<[string, boolean, string]>(),
    conn,
    connState,
    created: [] as Array<{ id: string }>,
  }
})

vi.mock('../api/client', () => ({
  getHealth: async () => ({ ok: true, version: 't', ts: 0, sandboxAvailable: false, gpuDevices: [], homeDir: '/home/t' }),
  api: {
    // ★ ADDED 2026-08-31, AND THEIR ABSENCE IS WHY ALL SEVEN CASES FAILED AT MOUNT. The
    // store started calling these when the reconnect seed was added; the mock was written
    // before that and could not notice, because the suite had never been run. Mock drift is
    // silent for exactly as long as nothing executes the mock.
    hasEverConnected: () => H.connState.ever,
    isConnected: () => H.connState.up,
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
  // `.keys()`, not the map itself. `attention` is a ReadonlyMap, so spreading it yields
  // [key, value] PAIRS — and test 6 then asked whether a `string[]` of pairs `.includes()` a
  // plain string id, which is false for every possible input. The suite could not run, so
  // nothing caught it; the type error that says so was masked by tsconfig's `exclude` of
  // test files, and vitest does not typecheck. Three layers of green over an assertion that
  // had no way to fail.
  commits.push({ activeId: ctx.activeId, attention: [...ctx.attention.keys()] })
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

// ════════ FIRST EXECUTED 2026-08-31 — WHAT THAT RUN FOUND ════════
// This file was committed with 7 cases and had NEVER been executed: `web/package.json`
// declared `"test": "vitest run"` and vitest was installed nowhere. The note that stood here
// predicted two things about the first run and was wrong about both; what actually happened
// is more useful, so it replaces the prediction rather than sitting beside it.
//
// 1. ALL SEVEN FAILED AT MOUNT, on `api.hasEverConnected is not a function`. The store began
//    calling it when the reconnect seed was added; this mock predates that. Mock drift is
//    silent for exactly as long as nothing runs the mock — the fake cannot notice that the
//    real thing grew a method. Fixed by giving the fake both liveness questions and driving
//    them off the `conn` channel the tests already emit on, so there is one source of truth.
// 2. TEST 6 COULD NOT FAIL. See the note on the Probe above. Found by `tsc`, in one run,
//    the moment web/tsconfig.json stopped excluding test files — never by running the suite,
//    because vitest does not typecheck and the assertion was green either way.
// 3. The top-level `await import('./sessions')` was fine. Test 4 was not flaky.
//
// ════════ ALL SEVEN ARE FALSIFIABLE, AND THAT WAS MEASURED ════════
// A suite that has just gone from "never ran" to "7 passed" has not yet earned anything: the
// two states look identical from the outside. Each case was therefore made to fail on
// purpose, against a COPY of the store and reducer (never the live files — a restore
// clobbers a concurrent editor), with a control mutation that matched no text and was
// refused before running, since a patch that silently matches nothing runs the UNMUTATED
// code and reads as "this assertion cannot fail".
//
//   test 1  subscription deps [] -> [store]                        → red (also reds test 3)
//   test 2  cleanup drops one unsubscribe                          → red
//   test 3  'ready' clobbers a running session to idle             → red
//   test 4  patchSessions rebuilds the array when nothing changed  → red   ← see below
//   test 5  isFresh keyed on `store` instead of `store.fresh`      → red
//   test 6  withActive stops clearing the attention flag           → red, on `bad`
//   test 7  'created' does not mark the session fresh              → red
//
// ★ TEST 6 REDDENS ON ITS CENTRAL ASSERTION, not merely its trailing one:
//   `expected [ { activeId: 'b', attention: ['b'] } ] to deeply equal []`. That is the
//   same-commit invariant actually being enforced, which it never was before today.
//
// ★ TEST 4 IS NARROWER THAN IT LOOKS, and this is worth knowing before trusting it.
//   Deleting `case 'state'`'s `return state` early-out does NOT redden it: the reducer's
//   state object churns, the provider re-renders, but `value`'s useMemo absorbs it because
//   `sessions`, `activeId` and `attention` all keep their identity — so no CONSUMER
//   re-renders, which is precisely what this test measures and says it measures. What does
//   redden it is identity churn one level down, in `patchSessions`. So this case guards the
//   memo, not the reducer's early-out. That early-out is not uncovered — it is pinned by
//   `scratchpad/session-reducer-test.mts` (F1.7, "redundant waiting→waiting returns the SAME
//   state object"), which is the division of labour this file's header describes. Two tests,
//   two layers, neither redundant; do not "simplify" either into the other.
