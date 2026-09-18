// ChatProvider's CLEAR WIRING — specifically, what a conversation reset is allowed to touch.
//
// ★ WHY THIS FILE EXISTS. `bashProcs` used to be deleted in the reducer's CLEAR arm, alongside
// `transcripts`, `pending` and `tasks`. That reads as obviously right and is not, and the
// reason is a category difference that no type expresses: `tasks` (agent cards) are REBUILT
// from the transcript, so clearing them alongside it is coherent — whereas `bashProcs` is a
// SERVER-OWNED registry that the client never derives, so applying conversation lifecycle to
// it deletes state with nothing to restore it from.
//
// The cost was not cosmetic, and it turns on WHEN the panel can refill: `session:bashProcs` is
// broadcast on CHANGE, and `session:snapshot` arrives once per CONNECT. So after a wipe nothing
// repopulates until the process finishes or the page reloads. Background a 20-minute build and
// the panel is empty for the rest of its run.
//
// ★★ AND CLEAR IS NOT "the user typed /clear". It is dispatched from FIVE places in ChatView:
// /clear, /resume, both /rewind arms, and the AUTO-RESUME effect — which is not a user action
// at all, merely opening a session whose transcript replays. That is what makes this worth a
// test rather than a comment: the arm is reachable without anyone asking for anything.
//
// TESTED THROUGH THE PROVIDER, NOT BY EXPORTING THE REDUCER, and that was a deliberate choice.
// Exporting `reducer` would widen the module's API purely for testing and would prove only
// that the arm is correct — not that `clearTranscript` still routes to it. The defect class
// this repo keeps rediscovering is wiring, so the test drives the same public surface the app
// does. It costs a fake client; it buys coverage of the actual path.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import type { BashProcRecord, TaskRecord } from '@claudette/shared'

// A FAITHFUL FAKE of the real client's channels — plain Sets with on/emit whose `on` returns
// a delete-me closure — mirroring the fake in sessions.test.tsx. Faithful rather than stubbed
// matters here for one specific reason: ChatProvider subscribes to NINE channels in a single
// effect and returns one combined teardown. A stub whose `on` returned undefined would throw
// at unmount, and the failure would look like a bug in the component rather than in the mock.
const H = vi.hoisted(() => {
  function makeChannel<A extends unknown[]>() {
    const set = new Set<(...a: A) => void>()
    return {
      on(fn: (...a: A) => void) { set.add(fn); return () => { set.delete(fn) } },
      emit(...a: A) { for (const fn of [...set]) fn(...a) },
      reset() { set.clear() },
    }
  }
  return {
    events: makeChannel<[string, unknown]>(),
    snapshots: makeChannel<[string, unknown[], unknown, TaskRecord[] | undefined, BashProcRecord[] | undefined]>(),
    tasks: makeChannel<[string, TaskRecord[]]>(),
    bashProcs: makeChannel<[string, BashProcRecord[]]>(),
    permissions: makeChannel<[string, unknown]>(),
    permsResolved: makeChannel<[string, string]>(),
    userTurns: makeChannel<[string, string, string | undefined]>(),
    sendFailed: makeChannel<[string, string | undefined]>(),
    states: makeChannel<[string, string]>(),
  }
})

vi.mock('../api/client', () => ({
  api: {
    on: {
      event: H.events.on, snapshot: H.snapshots.on, tasks: H.tasks.on,
      bashProcs: H.bashProcs.on, permission: H.permissions.on,
      permissionResolved: H.permsResolved.on, userTurn: H.userTurns.on,
      sendFailed: H.sendFailed.on, stateChange: H.states.on,
    },
    session: {
      sendTurn: () => {}, interrupt: () => {}, stopTask: () => {},
      killBash: () => {}, respondPermission: () => {},
    },
  },
}))

const { ChatProvider, useChat } = await import('./chat')

const PROC: BashProcRecord = {
  toolId: 'toolu_bp1', shellId: 'blo2euyao', command: 'npm run build',
  description: 'Build the app', startedAt: 1_000, status: 'running',
}
const TASK: TaskRecord = {
  toolId: 'toolu_ag1', type: 'general-purpose', description: 'go look',
  launched: true, status: 'running',
}

// A probe that hands the test the provider's public surface. Reading through the real hook
// rather than poking state keeps this a test of what a consumer sees.
let api_: ReturnType<typeof useChat>
function Probe() { api_ = useChat(); return null }

beforeEach(() => { for (const c of Object.values(H)) c.reset() })
afterEach(cleanup)

function mount() { render(<ChatProvider><Probe /></ChatProvider>) }

describe('CLEAR — what a conversation reset may and may not touch', () => {
  it('leaves a populated bashProcs registry INTACT', () => {
    mount()
    act(() => { H.bashProcs.emit('s1', [PROC]) })
    expect(api_.bashProcsFor('s1')).toHaveLength(1)

    act(() => { api_.clearTranscript('s1') })

    // ★ THE ASSERTION THIS FILE EXISTS FOR. Not "the panel looks fine" — the registry is
    // still there, in full, keyed the same. Nothing else can put it back until the process
    // changes state or the socket reconnects.
    expect(api_.bashProcsFor('s1')).toHaveLength(1)
    expect(api_.bashProcsFor('s1')[0].toolId).toBe('toolu_bp1')
  })

  it('still clears the transcript and the agent registry it is SUPPOSED to clear', () => {
    // The other half of the ruling, and it is what stops the fix above from being "delete the
    // CLEAR arm". A test that only asserted survival would go green on a CLEAR that had been
    // neutered entirely, which would strand a stale transcript across a /resume.
    mount()
    act(() => { H.snapshots.emit('s1', [], undefined, [TASK], [PROC]) })
    act(() => { H.userTurns.emit('s1', 'hello', undefined) })
    expect(api_.transcriptFor('s1').length).toBeGreaterThan(0)
    expect(api_.tasksFor('s1')).toHaveLength(1)

    act(() => { api_.clearTranscript('s1') })

    expect(api_.transcriptFor('s1')).toHaveLength(0)
    expect(api_.tasksFor('s1')).toHaveLength(0)
    expect(api_.bashProcsFor('s1')).toHaveLength(1)   // and the registry still survives
  })

  it('does not touch another session\'s processes', () => {
    // CLEAR is keyed by session id. Worth pinning because the fix changed this arm from
    // "delete one key" to "pass the whole map through" — a plausible next edit is to hoist
    // that to a wholesale reset, which would be invisible with only one session in play.
    mount()
    act(() => { H.bashProcs.emit('s1', [PROC]) })
    act(() => { H.bashProcs.emit('s2', [{ ...PROC, toolId: 'toolu_bp2' }]) })

    act(() => { api_.clearTranscript('s1') })

    expect(api_.bashProcsFor('s1')).toHaveLength(1)
    expect(api_.bashProcsFor('s2')).toHaveLength(1)
    expect(api_.bashProcsFor('s2')[0].toolId).toBe('toolu_bp2')
  })

  it('a snapshot with no bashProcs field EMPTIES the panel — the one legitimate retraction', () => {
    // The counterpart to everything above, and the reason "never empty it" is the wrong
    // reading of this fix. The server is still allowed to say the list is empty; what is
    // forbidden is the CLIENT deciding that on a conversation event. Without this, a stale
    // "still running" row could never be retracted at all.
    mount()
    act(() => { H.bashProcs.emit('s1', [PROC]) })
    expect(api_.bashProcsFor('s1')).toHaveLength(1)

    act(() => { H.snapshots.emit('s1', [], undefined, undefined, undefined) })

    expect(api_.bashProcsFor('s1')).toHaveLength(0)
  })

})

describe('claudeSessionId — the id that lets auto-resume name the right conversation', () => {
  // ── claudeSessionId: the WIRING, which is the part with a failure mode ──────────────────
  // The rule that uses this id lives in lib/autoResume and is tested there. What cannot be
  // tested there is whether the id ever ARRIVES, and that is exactly the gap that made the
  // original bug invisible: nothing imports ChatView, so the lookup feeding it had no coverage
  // at any layer.
  //
  // ★ BOTH PATHS ARE PINNED ON PURPOSE, AND THE SNAPSHOT ONE IS THE LOAD-BEARING HALF.
  // `session:ready` carries the same value but is broadcast once at engine start and never
  // replayed to a later socket. The scenario this feature exists for — the server restarted,
  // THEN the browser opened — only ever sees the id via the init event replayed in the connect
  // snapshot. A version wired to the live path alone would pass a live-path test and fix
  // nothing for the user.
  it('learns claudeSessionId from a LIVE init event', () => {
    mount()
    act(() => { H.events.emit('s1', { type: 'system', subtype: 'init', session_id: 'conv-live', model: 'opus' }) })
    expect(api_.metaFor('s1').claudeSessionId).toBe('conv-live')
    expect(api_.metaFor('s1').model).toBe('opus')   // the pre-existing fold still works
  })

  it('★ learns claudeSessionId from the CONNECT SNAPSHOT, which is the restart case', () => {
    mount()
    act(() => {
      H.snapshots.emit('s1', [{ type: 'system', subtype: 'init', session_id: 'conv-replayed' }], undefined, undefined, undefined)
    })
    expect(api_.metaFor('s1').claudeSessionId).toBe('conv-replayed')
  })

  it('takes the LAST init in a replay, so a mid-life relaunch wins', () => {
    // A sandbox or role change relaunches the engine and emits a fresh init. Taking the first
    // would resume into the conversation the session has already left.
    mount()
    act(() => {
      H.snapshots.emit('s1', [
        { type: 'system', subtype: 'init', session_id: 'conv-old' },
        { type: 'system', subtype: 'init', session_id: 'conv-new' },
      ], undefined, undefined, undefined)
    })
    expect(api_.metaFor('s1').claudeSessionId).toBe('conv-new')
  })
})
