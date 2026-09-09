// The session store's transitions, tested without a DOM, a renderer or a browser — which
// is possible only because reduceSessionStore is a pure function with no React import.
//
// Each test names the bug it pins. Test 1 replaces scratchpad/ready-clobber-test.mjs, a
// Chrome-driving test for the same defect: ~300ms of browser becomes ~3ms of tsx, and the
// failure says which transition broke instead of handing you a screenshot.
//
// ONE HONESTY NOTE, because it decides how to read a failure: this is NOT provably a
// behaviour-preserving refactor of SessionsProvider. prevStateRef is mutated synchronously
// inside the handler while the sessions array updates through batched setState, so the two
// are read at different moments; here both come from the same state at reduce time. These
// tests assert the INTENDED behaviour, which is unusually knowable because the comments at
// sessions.tsx:88-97 state it outright. If one of these disagrees with what the running app
// does today, that is a BUG FOUND, not a regression introduced — check it against the
// comment before changing the test.
//
//   npx tsx scratchpad/session-reducer-test.mts
import {
  reduceSessionStore as reduce,
  initialSessionStore,
  isFresh,
  needsAttention,
  attentionReason,
  type SessionStoreState,
  type SessionStoreAction,
} from '../web/src/store/sessionReducer'
import type { SessionInfo } from '../shared/src/types'

import { check, passed as pass, failed as fail } from './assert.mjs'

const sess = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  id, name: id, cwd: '/w', rootDir: '/w', state: 'idle', ...over,
})
// Apply a sequence, so a test reads as the event order that produced the bug.
const run = (start: SessionStoreState, ...actions: SessionStoreAction[]): SessionStoreState =>
  actions.reduce(reduce, start)
const stateOf = (s: SessionStoreState, id: string) => s.sessions.find((x) => x.id === id)?.state

const TWO = run(initialSessionStore, { type: 'list', sessions: [sess('a'), sess('b')] })

// 1. READY-CLOBBER — sessions.tsx:91-97. The CLI inits lazily, so system/init routinely
//    lands AFTER the first turn already set 'running'. Settling to idle there hid the
//    working indicator and the interrupt for the whole turn.
{
  const s = run(TWO, { type: 'state', id: 'a', state: 'running' }, { type: 'ready', id: 'a' })
  check('ready does NOT clobber a running session', stateOf(s, 'a') === 'running', String(stateOf(s, 'a')))
  const w = run(TWO, { type: 'state', id: 'a', state: 'waiting' }, { type: 'ready', id: 'a' })
  check('ready does NOT clobber a waiting session (live permission prompt)', stateOf(w, 'a') === 'waiting', String(stateOf(w, 'a')))
  const e = run(TWO, { type: 'state', id: 'a', state: 'exited' }, { type: 'ready', id: 'a' })
  check('ready DOES settle a session that is not mid-turn', stateOf(e, 'a') === 'idle', String(stateOf(e, 'a')))
}

// 2. attention flags a finished turn only on a session you are NOT viewing.
{
  const seen = run(TWO, { type: 'setActive', id: 'a' },
    { type: 'state', id: 'a', state: 'running' }, { type: 'state', id: 'a', state: 'idle' })
  check('a turn finishing on the ACTIVE session does not flag attention', !needsAttention(seen, 'a'))
  const unseen = run(TWO, { type: 'setActive', id: 'a' },
    { type: 'state', id: 'b', state: 'running' }, { type: 'state', id: 'b', state: 'idle' })
  check('a turn finishing on a BACKGROUND session flags attention', needsAttention(unseen, 'b'))
}

// 3. attention requires a PRIOR running/waiting — sessions.tsx:89. Without the prev check
//    any redundant idle report would light the dot on every background session.
{
  const s = run(TWO, { type: 'setActive', id: 'a' }, { type: 'state', id: 'b', state: 'idle' })
  check('idle→idle is not a finished turn and does not flag', !needsAttention(s, 'b'))
}

// 4. exit: a startup failure keeps the row (so the operator can read it and retry);
//    a clean close drops it and moves the selection off it. sessions.tsx:98-105.
{
  const failed = run(TWO, { type: 'setActive', id: 'a' },
    { type: 'exit', id: 'b', failed: true, error: 'claude: command not found' })
  check('a failed exit KEEPS the row', !!failed.sessions.find((s) => s.id === 'b'))
  check('a failed exit records exitError', failed.sessions.find((s) => s.id === 'b')?.exitError === 'claude: command not found')
  check('a failed exit on a background session flags attention', needsAttention(failed, 'b'))

  const clean = run(TWO, { type: 'setActive', id: 'a' }, { type: 'exit', id: 'a', failed: false, error: '' })
  check('a clean exit DROPS the row', !clean.sessions.find((s) => s.id === 'a'))
  check('a clean exit on the ACTIVE session clears the selection', clean.activeId === null, String(clean.activeId))
}

// 5. INVARIANT, checked across a whole event storm rather than at one point: the active
//    session never carries an attention flag. This is only assertable because the clear is
//    part of the transition (withActive) instead of a post-render effect.
{
  let s = run(TWO, { type: 'setActive', id: 'a' })
  const storm: SessionStoreAction[] = [
    { type: 'state', id: 'b', state: 'running' }, { type: 'state', id: 'b', state: 'idle' },
    { type: 'setActive', id: 'b' },
    { type: 'state', id: 'a', state: 'running' }, { type: 'state', id: 'a', state: 'idle' },
    { type: 'setActive', id: 'a' },
    { type: 'created', session: sess('c') },
    { type: 'state', id: 'c', state: 'running' }, { type: 'state', id: 'c', state: 'idle' },
  ]
  let violated = ''
  for (const a of storm) {
    s = reduce(s, a)
    if (s.activeId && needsAttention(s, s.activeId)) { violated = `${a.type} left ${s.activeId} flagged while active`; break }
  }
  check('INVARIANT: the active session never carries an attention flag', violated === '', violated)
}

// 6. `list` must not clobber an existing selection — sessions.tsx:82 guarded on
//    !activeRef.current, so a routine broadcast cannot yank the user's view.
{
  const s = run(TWO, { type: 'setActive', id: 'b' }, { type: 'list', sessions: [sess('a'), sess('b')] })
  check('list does not clobber an existing activeId', s.activeId === 'b', String(s.activeId))
  const fresh = run(initialSessionStore, { type: 'list', sessions: [sess('a'), sess('b')] })
  check('list defaults the selection when there is none', fresh.activeId === 'a', String(fresh.activeId))
  const empty = run(initialSessionStore, { type: 'list', sessions: [] })
  check('list of an empty set leaves activeId null', empty.activeId === null, String(empty.activeId))
}

// 7. markBusy is idle→running ONLY — sessions.tsx:194-196. It exists to show the working
//    indicator before the WS round-trip, so it must not override a live prompt or
//    resurrect a dead session.
{
  const fromIdle = run(TWO, { type: 'markBusy', id: 'a' })
  check('markBusy promotes an idle session', stateOf(fromIdle, 'a') === 'running', String(stateOf(fromIdle, 'a')))
  const fromWaiting = run(TWO, { type: 'state', id: 'a', state: 'waiting' }, { type: 'markBusy', id: 'a' })
  check('markBusy does NOT override waiting', stateOf(fromWaiting, 'a') === 'waiting', String(stateOf(fromWaiting, 'a')))
  const fromExited = run(TWO, { type: 'state', id: 'a', state: 'exited' }, { type: 'markBusy', id: 'a' })
  check('markBusy does NOT resurrect an exited session', stateOf(fromExited, 'a') === 'exited', String(stateOf(fromExited, 'a')))
}

// 8. IDENTITY PRESERVATION — this is hazard H2's root cause, and the reason App.tsx keys
//    its prune effect on a derived string instead of on `sessions`. A no-op transition must
//    return the SAME array, or the workaround becomes permanent. If this test is ever
//    "simplified" away, H2 quietly comes back.
{
  const s1 = run(TWO, { type: 'state', id: 'a', state: 'running' })
  const s2 = reduce(s1, { type: 'state', id: 'a', state: 'running' })   // same state again
  check('a redundant state event does not churn the sessions array identity', s1.sessions === s2.sessions)
  const p = reduce(s1, { type: 'patch', id: 'a', fields: { name: 'a' } })  // same name
  check('a patch with no actual change returns the same state object', p === s1)
  const unknown = reduce(s1, { type: 'patch', id: 'nope', fields: { name: 'x' } })
  check('a patch for an unknown id is a no-op', unknown === s1)
}

// 9. `fresh` tracks sessions created this load — see hazard N2 in the reducer header. A
//    restored session (arriving via `list`) must NOT be fresh, or it would skip auto-resume.
{
  const s = run(TWO, { type: 'created', session: sess('c') })
  check('a created session is fresh', isFresh(s, 'c'))
  check('a session that arrived via list is NOT fresh', !isFresh(s, 'a'))
  check('created selects the new session', s.activeId === 'c', String(s.activeId))
  const dup = reduce(s, { type: 'created', session: sess('c') })
  check('created is idempotent (no duplicate row)', dup.sessions.filter((x) => x.id === 'c').length === 1)
}

// 10. PURITY — N1 moved prevState and fresh out of refs into state, and the whole safety of
//     that move rests on the reducer never mutating what it was handed. React StrictMode
//     double-invokes reducers precisely to catch this; assert it here so it fails in the
//     suite rather than as a heisenbug in the browser.
{
  const before = run(TWO, { type: 'state', id: 'a', state: 'running' })
  const attnBefore = [...before.attention].sort().join(',')
  const prevBefore = [...before.prevState.entries()].sort().map(([k, v]) => `${k}=${v}`).join(',')
  const freshBefore = [...before.fresh].sort().join(',')
  // Same input reduced twice must not disturb the input.
  reduce(before, { type: 'state', id: 'b', state: 'running' })
  reduce(before, { type: 'state', id: 'b', state: 'running' })
  check('reducing does not mutate the input attention set',
    [...before.attention].sort().join(',') === attnBefore)
  check('reducing does not mutate the input prevState map',
    [...before.prevState.entries()].sort().map(([k, v]) => `${k}=${v}`).join(',') === prevBefore)
  check('reducing does not mutate the input fresh set',
    [...before.fresh].sort().join(',') === freshBefore)
  const a = reduce(before, { type: 'state', id: 'b', state: 'idle' })
  const b = reduce(before, { type: 'state', id: 'b', state: 'idle' })
  check('the reducer is deterministic (same input twice → same output shape)',
    JSON.stringify(a.sessions) === JSON.stringify(b.sessions) && a.activeId === b.activeId)
}

// 11. `fresh` IDENTITY SURVIVES EVERY NON-`created` ACTION. This is not a detail: it is the
//     load-bearing premise of the provider's isFresh, which is
//         useCallback((id) => store.fresh.has(id), [store.fresh])
//     (sessions.tsx). If any other action rebuilt the set, that callback's identity would
//     churn on ordinary state traffic and ChatView's auto-resume effect (ChatView.tsx:249,
//     its only consumer, with isFresh in its deps at :267) would re-run on every
//     running→idle. The old code got stability by making isFresh `useCallback(..., [])`
//     over a ref; this reducer earns it instead, and that is only true while this holds.
{
  const base = run(TWO, { type: 'created', session: sess('c') })
  const others: SessionStoreAction[] = [
    { type: 'state', id: 'a', state: 'running' },
    { type: 'state', id: 'a', state: 'idle' },
    { type: 'ready', id: 'a' },
    { type: 'patch', id: 'a', fields: { name: 'renamed' } },
    { type: 'setActive', id: 'b' },
    { type: 'markBusy', id: 'b' },
    { type: 'exit', id: 'b', failed: true, error: 'boom' },
    { type: 'list', sessions: [sess('a'), sess('b'), sess('c')] },
    { type: 'destroyed', id: 'b' },
  ]
  let s = base
  let churned = ''
  for (const a of others) {
    const next = reduce(s, a)
    if (next.fresh !== s.fresh) { churned = a.type; break }
    s = next
  }
  check('fresh identity survives every non-created action (isFresh stays stable)',
    churned === '', churned ? `rebuilt by '${churned}'` : '')
  // …and DOES change on created, or the memo would be stale and a new session would never
  // be seen as fresh. The negative half matters as much as the positive one.
  const afterCreate = reduce(s, { type: 'created', session: sess('d') })
  check('fresh identity DOES change on created (so the memo invalidates)', afterCreate.fresh !== s.fresh)
  check('…and the new session is actually in it', isFresh(afterCreate, 'd'))
}

// ── F1: ATTENTION REASONS ────────────────────────────────────────────────────────────
// The light used to fire only when a turn FINISHED unwatched, so a session blocked on a
// permission prompt was never flagged. `waiting` is set in exactly one place in the engine
// (the permission-prompt handler), so it is a precise signal. The two reasons differ in how
// they CLEAR, which is the part a boolean could not express.
{
  const active = (id: string) => ({ type: 'setActive', id } as SessionStoreAction)
  const st = (id: string, state: SessionInfo['state']) => ({ type: 'state', id, state } as SessionStoreAction)

  // 1. unwatched running→waiting flags `blocked`.
  const blocked = run(TWO, active('b'), st('a', 'running'), st('a', 'waiting'))
  check('F1.1 unwatched running→waiting flags blocked', attentionReason(blocked, 'a') === 'blocked',
    String(attentionReason(blocked, 'a')))

  // 2. the ACTIVE session going waiting flags nothing — you are looking straight at it.
  const activeWaits = run(TWO, active('a'), st('a', 'running'), st('a', 'waiting'))
  check('F1.2 the ACTIVE session going waiting is not flagged', attentionReason(activeWaits, 'a') === undefined,
    String(attentionReason(activeWaits, 'a')))

  // 3. leaving waiting retires the blocked entry — the prompt was answered.
  const answered = run(blocked, st('a', 'running'))
  check('F1.3 waiting→running clears blocked', attentionReason(answered, 'a') === undefined,
    String(attentionReason(answered, 'a')))

  // 4. ★ THE LOAD-BEARING ONE ★ viewing a blocked session does NOT clear it. Looking at a
  //    permission prompt does not answer it, so a light that went out here would report
  //    "handled" for something still waiting on the operator.
  const viewed = run(blocked, active('a'))
  check('F1.4 blocked SURVIVES being viewed', attentionReason(viewed, 'a') === 'blocked',
    String(attentionReason(viewed, 'a')))

  // 5. …while finished still clears on view. Regression guard for the old behaviour.
  const finished = run(TWO, active('b'), st('a', 'running'), st('a', 'idle'))
  check('F1.5 finished is set, then cleared by viewing',
    attentionReason(finished, 'a') === 'finished' && attentionReason(run(finished, active('a')), 'a') === undefined)

  // 6. blocked→idle unwatched ends as `finished`, not stuck blocked.
  const done = run(blocked, st('a', 'idle'))
  check('F1.6 blocked→idle unwatched becomes finished', attentionReason(done, 'a') === 'finished',
    String(attentionReason(done, 'a')))

  // 7. a redundant waiting report must not churn identity — consumers memoise on this map.
  const again = run(blocked, st('a', 'waiting'))
  check('F1.7 redundant waiting→waiting returns the SAME state object', again === blocked)

  // 7b. …and one that actually reaches flagAttention. 7 above is satisfied by the EARLY
  //     RETURN in `case 'state'` (prev === action.state && sessions unchanged), which fires
  //     before flagAttention is ever called — so it pins that guard, not this one. Verified
  //     by experiment: removing flagAttention's identity check leaves 7 passing. A repeated
  //     `exit failed` DOES reach it: the session row is already exited with the same error,
  //     so the only thing that could churn identity is the attention map.
  const failed1 = run(TWO, active('b'), { type: 'exit', id: 'a', failed: true, error: 'boom' } as SessionStoreAction)
  const failed2 = run(failed1, { type: 'exit', id: 'a', failed: true, error: 'boom' } as SessionStoreAction)
  check('F1.7b a repeated identical failure does not churn the attention map', failed2 === failed1)

  // 8. a departed session is forgotten from the map, not left to accumulate.
  const gone = run(blocked, { type: 'exit', id: 'a', failed: false, error: '' } as SessionStoreAction)
  check('F1.8 exit forgets the attention entry', attentionReason(gone, 'a') === undefined,
    String(attentionReason(gone, 'a')))
}

// ── F2: `list` RECONCILES A DEAD SELECTION ───────────────────────────────────────────
// THE BUG: `list` returned early whenever ANY selection existed —
//     if (state.activeId !== null || sessions.length === 0) return withList
// — and never asked whether that id was still in the incoming list. `destroyed` does clear
// the selection, but it is dispatched ONLY by the client's own destroy() call. A session
// killed out of band (another tab, another client, the server, a direct
// POST /api/session/destroy) arrives as a plain `session:list` broadcast, so the row vanished
// while activeId went on pointing at a dead id. Everything downstream then dangled:
// `sessions.find(active)` → undefined, ChatView kept a `key` for a session that no longer
// exists, the per-session pane/terminal maps kept indexing it, and `canTerm` — literally
// `activeId !== null` — left the Terminal button ENABLED with nothing to attach to. That
// last one is the visible symptom scratchpad/terminal-ui-e2e.mjs catches.
//
// F2.1 IS THE FAILS-FIRST CASE, and this is a MEASURED run, not a prediction. The guard
// above was restored verbatim (everything else left in place, so the measurement isolates
// that one line) and the suite went 52/56 — four red:
//     F2.1  active dropped → selection stayed on the dead id 'a'
//     F2.1b …so the selected id was absent from sessions
//     F2.2  list emptied → selection STILL 'a', with no sessions at all
//     F2.5b a removal after a clean ack → selection stayed on the removed 'c'
// F2.6 passes under the old guard too, and that is worth knowing rather than hiding: it goes
// through `destroyed`, which clears the selection itself, so the next list starts from
// activeId === null and takes the default-selection path both before and after the fix. It
// pins `unacked`'s cleanup, not the reconcile. An earlier draft of this comment predicted
// "F2.1, F2.2 and F2.6, 3 red" from reading the code; the run says otherwise, and the run
// wins.
{
  const destroy = (id: string) => ({ type: 'list', sessions: [sess(id)] } as SessionStoreAction)

  // 1. THE FIX. `a` is selected, then a broadcast arrives that no longer contains it.
  const dead = run(TWO, { type: 'setActive', id: 'a' }, destroy('b'))
  check('F2.1 a list that drops the ACTIVE session moves the selection', dead.activeId === 'b',
    String(dead.activeId))
  check('F2.1b …and the surviving session is the one selected',
    !!dead.sessions.find((x) => x.id === dead.activeId), JSON.stringify(dead.sessions.map((x) => x.id)))

  // 2. The last session going away must clear the selection, not pick a nonexistent [0].
  const emptied = run(TWO, { type: 'setActive', id: 'a' }, { type: 'list', sessions: [] })
  check('F2.2 a list that empties the set clears the selection', emptied.activeId === null,
    String(emptied.activeId))

  // 3. A LIVE selection is still never stolen — the original guarantee the fix must keep.
  const kept = run(TWO, { type: 'setActive', id: 'b' }, { type: 'list', sessions: [sess('a'), sess('b')] })
  check('F2.3 a list that still contains the active session does NOT move it', kept.activeId === 'b',
    String(kept.activeId))

  // 4. THE RACE THE FIX MUST NOT CREATE. `list` and `create` travel on different channels
  //    (WS vs HTTP), so a list COMPUTED BEFORE a create can be DELIVERED AFTER it. By shape
  //    that is identical to a removal — an active id absent from the incoming list — but it
  //    must be handled in the opposite direction. Without `unacked` the reconcile would yank
  //    the selection off a session the user just made.
  const created = run(TWO, { type: 'created', session: sess('c') })
  check('F2.4a created selects the new session', created.activeId === 'c', String(created.activeId))
  const stale = run(created, { type: 'list', sessions: [sess('a'), sess('b')] })
  check('F2.4b a STALE list that predates the create KEEPS the new selection',
    stale.activeId === 'c', String(stale.activeId))

  // 4c. The merge's interaction with the EMPTY payload, which is the one combination where
  //     `sessions[0]` and the orphan list decide the answer between them: the server reports
  //     zero sessions while an optimistic create is still unacknowledged. The merged array is
  //     then exactly the orphan, so the selection stays on it rather than going null — which
  //     is the same rule as F2.4b, reached by the path most likely to be special-cased wrong.
  const staleEmpty = run(created, { type: 'list', sessions: [] })
  check('F2.4c an EMPTY stale list still keeps the unacked session and its selection',
    staleEmpty.activeId === 'c' && staleEmpty.sessions.map((x) => x.id).join() === 'c',
    `${staleEmpty.activeId} [${staleEmpty.sessions.map((x) => x.id).join(',')}]`)

  // 5. …and the ack is what re-arms it. Once the server reports the row, `unacked` clears,
  //    so a LATER removal is a real removal and must move the selection. This is the pair
  //    that stops F2.4 from being a permanent exemption.
  const acked = run(created, { type: 'list', sessions: [sess('a'), sess('b'), sess('c')] })
  check('F2.5a a list containing the new session acks it', acked.activeId === 'c', String(acked.activeId))
  const thenGone = run(acked, { type: 'list', sessions: [sess('a'), sess('b')] })
  check('F2.5b …after which a removal DOES move the selection', thenGone.activeId === 'a',
    String(thenGone.activeId))

  // 6. `unacked` must not outlive the session. A session destroyed before the server ever
  //    listed it would otherwise stay permanently unacknowledged, and `list` would refuse
  //    forever to move the selection off it — the original bug, made permanent.
  const madeThenKilled = run(TWO, { type: 'created', session: sess('c') }, { type: 'destroyed', id: 'c' })
  check('F2.6a destroying an unacked session clears the selection',
    madeThenKilled.activeId === null, String(madeThenKilled.activeId))
  const nextList = run(madeThenKilled, { type: 'list', sessions: [sess('a'), sess('b')] })
  check('F2.6b …and the next list selects a real session, not the dead one',
    nextList.activeId === 'a', String(nextList.activeId))

  // 7. IDENTITY. A redundant broadcast is the most frequent action in the app (index.ts:158
  //    broadcasts on every `changed`, which SessionManager emits from 17 sites), so it must
  //    return the SAME state object — see hazard H2. The reconcile added two new ways to
  //    churn it: rebuilding `unacked`, and calling withActive on every list.
  const base = run(TWO, { type: 'setActive', id: 'b' })
  const redundant = reduce(base, { type: 'list', sessions: [sess('a'), sess('b')] })
  check('F2.7a a redundant list returns the IDENTICAL state object', redundant === base)
  const emptyBase = run(initialSessionStore, { type: 'list', sessions: [] })
  const redundantEmpty = reduce(emptyBase, { type: 'list', sessions: [] })
  check('F2.7b …and so does a redundant EMPTY list', redundantEmpty === emptyBase)
  // The ack path must still churn exactly once and then settle.
  const ack1 = reduce(created, { type: 'list', sessions: [sess('a'), sess('b'), sess('c')] })
  const ack2 = reduce(ack1, { type: 'list', sessions: [sess('a'), sess('b'), sess('c')] })
  check('F2.7c the list that ACKS a create churns state (it must)', ack1 !== created)
  check('F2.7d …but the next identical list does not', ack2 === ack1)

  // 7e. THE CASE THE MERGE ACTUALLY PUT AT RISK, and the one 7a does NOT cover. 7a measures a
  //     redundant list once `unacked` is EMPTY, where `orphans` is trivially [] and nothing
  //     can churn. The merge only does work while `unacked` is NON-empty — it rebuilds
  //     `incoming` as a brand-new array on every stale broadcast — so that is where identity
  //     had to be re-checked. `sameSessions` is what has to catch it, comparing content rather
  //     than reference, since `incoming` is freshly allocated on each of those broadcasts.
  const stale2 = reduce(stale, { type: 'list', sessions: [sess('a'), sess('b')] })
  check('F2.7e a REPEATED stale list (unacked non-empty, merge active) returns the IDENTICAL state',
    stale2 === stale, `identical=${stale2 === stale} ids=[${stale2.sessions.map((x) => x.id).join(',')}]`)
  check('F2.7f …and the carried-through row survives the repeat',
    stale2.sessions.some((x) => x.id === 'c') && stale2.activeId === 'c',
    JSON.stringify(stale2.sessions.map((x) => x.id)))

  // 8. THE CENTRAL INVARIANT, and the check that closed a real gap.
  //    This began as a CHARACTERIZATION test recording a hole the first version of the fix
  //    left open: in the F2.4 stale-list case the selection was kept but the ROW was not,
  //    because `sessions` was taken wholesale from the incoming payload. activeId then pointed
  //    at a session absent from `sessions` — the very dangling-reference state the fix exists
  //    to remove, merely transient and reached from the other direction. `list` now carries
  //    unacknowledged rows through, so the row and the selection move together and the window
  //    does not exist. The assertion is inverted from what it originally pinned; it is left in
  //    this position, with this history, because a test that silently changed sides would hide
  //    the fact that the gap was real and deliberately closed.
  check('F2.8 the stale-list window keeps the active ROW as well as the selection',
    stale.activeId === 'c' && stale.sessions.some((x) => x.id === 'c'),
    JSON.stringify(stale.sessions.map((x) => x.id)))
  // The invariant the whole `list` case now maintains, asserted directly rather than inferred
  // from the cases above: a non-null selection ALWAYS has a row. Checked across every state
  // this section built, so a future edit that reintroduces a dangling id fails here even if it
  // slips past the specific scenarios.
  const everyState = [stale, stale2, staleEmpty, created, acked, ack1, ack2, thenGone, nextList,
    madeThenKilled, redundant, emptyBase, dead, emptied, kept]
  check('F2.9 INVARIANT: across every state above, a non-null activeId has a row in sessions',
    everyState.every((st) => st.activeId === null || st.sessions.some((x) => x.id === st.activeId)),
    everyState.map((st) => `${st.activeId ?? 'null'}:[${st.sessions.map((x) => x.id).join(',')}]`).join(' '))
}

// ── F3: `reconnected` RETIRES OPTIMISTIC ROWS THE SERVER NEVER ACKNOWLEDGED ──────────
// `unacked` is added to in `created` and cleared in `list` (the server reported the row) or
// `forget` (we destroyed it). Neither fires if the CONNECTION dies between a create and the
// broadcast that would have acknowledged it — the id then stays unacknowledged forever, and
// because `list` carries unacknowledged rows through, that is a phantom session row that
// never disappears and a selection that can never move off it. A server restart is exactly
// that sequence, so this is a scheduled failure, not a hypothetical one.
//
// The counting alternative — drop an id after N lists that omit it — was rejected because it
// fights hazard H2: a per-list counter mutates state on precisely the repeated identical
// broadcast that F2.7a/F2.7e require to return the same object. This changes state at most
// once per reconnect and never during steady-state traffic.
{
  const reconnect = { type: 'reconnected' } as SessionStoreAction

  // 1. It does the one job it exists for.
  const pending = run(TWO, { type: 'created', session: sess('c') })
  check('F3.1a a create leaves the row unacknowledged', pending.unacked.has('c'))
  const back = run(pending, reconnect)
  check('F3.1b reconnected clears a non-empty unacked', back.unacked.size === 0,
    `[${[...back.unacked].join(',')}]`)

  // 2. IDENTITY — the common case by far. Every reconnect on a steady tree hits this, and a
  //    reconnect storm on a flaky link would otherwise churn the store on every up-edge for
  //    no change at all. Same requirement as F2.7a/e, one action along.
  const steady = run(TWO, { type: 'setActive', id: 'b' })
  check('F3.2 reconnected on an empty unacked returns the IDENTICAL state object',
    reduce(steady, reconnect) === steady)

  // 3. It must clear `unacked` and NOTHING ELSE. `fresh` is life-of-session and suppresses
  //    auto-resume, so clearing it would make a brand-new session resume someone else's
  //    transcript; the selection must survive so a reconnect does not move the user's view;
  //    and the row survives because the following `list` is what is authoritative about rows.
  const rich = run(TWO, { type: 'setActive', id: 'b' }, { type: 'state', id: 'a', state: 'running' },
    { type: 'state', id: 'a', state: 'idle' }, { type: 'created', session: sess('c') })
  const after = run(rich, reconnect)
  check('F3.3a reconnected does NOT clear fresh', isFresh(after, 'c') && isFresh(rich, 'c'))
  check('F3.3b reconnected does NOT move the selection', after.activeId === rich.activeId,
    `${rich.activeId} → ${after.activeId}`)
  check('F3.3c reconnected does NOT drop rows', after.sessions === rich.sessions,
    `[${after.sessions.map((x) => x.id).join(',')}]`)
  check('F3.3d reconnected does NOT touch attention', after.attention === rich.attention)
  check('F3.3e reconnected does NOT touch prevState', after.prevState === rich.prevState)

  // 4. THE BUG BEING CLOSED, end to end, in the order the restart actually produces it:
  //    create → connection dies and returns → the authoritative list does not contain it.
  //    Both halves must move: the selection AND the row.
  const restarted = run(TWO, { type: 'created', session: sess('c') }, reconnect,
    { type: 'list', sessions: [sess('a'), sess('b')] })
  check('F3.4a after a reconnect, a list omitting the created session MOVES the selection',
    restarted.activeId === 'a', String(restarted.activeId))
  check('F3.4b …and the phantom row is gone',
    !restarted.sessions.some((x) => x.id === 'c'),
    JSON.stringify(restarted.sessions.map((x) => x.id)))
  check('F3.4c …and the invariant still holds',
    restarted.activeId === null || restarted.sessions.some((x) => x.id === restarted.activeId))
  // ★ THIS SEQUENCE IS AMBIGUOUS, AND THE ASSERTION ABOVE ENCODES A POLICY CHOICE ★
  // `created → reconnected → a list without it` is produced by TWO different realities:
  //   (i)  the server restarted and genuinely lost the session — move the selection, which is
  //        what F3.4a/b assert and what closes the phantom-row bug;
  //   (ii) the session was created DURING the outage (createSession is HTTP, so it succeeds
  //        while the WS is down), the server has it, and this list merely predates it — in
  //        which case moving the selection is the create-race `unacked` exists to prevent.
  // The reducer cannot tell them apart: same actions, same order, same payloads. So no test
  // here can decide it, and this one should not be read as evidence that (ii) was considered
  // and ruled out. It is a deliberate preference for (i), justified by frequency — a restart
  // is ordered on purpose, while creating a session during a sub-8s reconnect backoff is
  // rare — and by cost: (ii) costs the user their selection and self-heals in the row on the
  // next list, while (i) left a phantom that never went away. If that trade is ever revisited,
  // clearing `unacked` on the DOWN edge instead is what protects (ii), at the price of leaving
  // (i) bounded by the next disconnect rather than closed at this one.

  // 5. WITHOUT the reconnect the phantom is exactly what you get — the counterfactual stated
  //    as a run rather than as prose, so this section says why it exists and not merely what
  //    it checks. This is the state the operator would have been left in.
  const phantom = run(TWO, { type: 'created', session: sess('c') },
    { type: 'list', sessions: [sess('a'), sess('b')] })
  check('F3.5 …whereas with no reconnect the phantom row and its selection persist (the bug)',
    phantom.activeId === 'c' && phantom.sessions.some((x) => x.id === 'c'),
    JSON.stringify(phantom.sessions.map((x) => x.id)))
}

// ── F4: `created` MUST NOT RE-MARK AN ALREADY-ACKNOWLEDGED SESSION ───────────────────
// `created` declined to duplicate an existing row but added to `unacked` unconditionally,
// which reproduced the original dangling-selection bug THROUGH the mechanism added to
// prevent it.
//
// The server half of the race is read from the source, not inferred: `sessionApi.ts`'s
// `/api/session/create` handler calls the synchronous `sessions.create(...)` with no `await`,
// and `SessionManager.create` runs `this.emit('changed')` on the line BEFORE
// `return session.id` — so the `session:list` carrying the new session is emitted strictly
// before the HTTP response is produced.
// *** THE CLIENT HALF IS A PROXY, NOT A MEASUREMENT. *** That the browser parses the WS frame
// before the fetch promise resolves is plausible on loopback and is what the sequence below
// assumes, but it has NOT been observed. What is proven is the server's emit order. The tests
// below drive the action order directly, so they pin the reducer's behaviour GIVEN that
// interleaving; they are not evidence that the interleaving occurs.
{
  // The five steps, as actions: the list wins the race, then the create resolves, then the
  // session is destroyed out of band.
  const listFirst = run(TWO, { type: 'list', sessions: [sess('a'), sess('b'), sess('c')] })
  check('F4.1a a list that arrives first makes `c` an ordinary acknowledged row',
    !listFirst.unacked.has('c'), `[${[...listFirst.unacked].join(',')}]`)
  const thenCreated = run(listFirst, { type: 'created', session: sess('c') })
  check('F4.1b …and the late `created` must NOT re-mark it unacknowledged',
    !thenCreated.unacked.has('c'), `[${[...thenCreated.unacked].join(',')}]`)

  // THE ONE THAT MATTERS — the same five steps end to end. An out-of-band destroy must be
  // read as a removal, not as a list predating a create.
  const oob = run(thenCreated, { type: 'list', sessions: [sess('a'), sess('b')] })
  check('F4.1c an out-of-band destroy after that MOVES the selection', oob.activeId === 'a',
    String(oob.activeId))
  check('F4.1d …and leaves no phantom row', !oob.sessions.some((x) => x.id === 'c'),
    JSON.stringify(oob.sessions.map((x) => x.id)))

  // The guard must not have disabled the protection it sits inside: when `created` genuinely
  // comes FIRST, the row is still marked and F2.4b's stale-list protection still applies.
  const createFirst = run(TWO, { type: 'created', session: sess('c') })
  check('F4.2a the ordinary path (created BEFORE any list) still marks unacked',
    createFirst.unacked.has('c'), `[${[...createFirst.unacked].join(',')}]`)
  const stillHeld = run(createFirst, { type: 'list', sessions: [sess('a'), sess('b')] })
  check('F4.2b …so a stale list still keeps the new session and its selection',
    stillHeld.activeId === 'c' && stillHeld.sessions.some((x) => x.id === 'c'),
    JSON.stringify(stillHeld.sessions.map((x) => x.id)))

  // Identity: a re-dispatched `created` for a row we already hold must not churn the store,
  // matching patchSessions / flagAttention / forget.
  check('F4.3 a repeated `created` for a row we already hold returns the IDENTICAL state',
    reduce(thenCreated, { type: 'created', session: sess('c') }) === thenCreated)
}

// ── F5: `list` MUST FORGET THE ROWS IT REMOVED ───────────────────────────────────────
// `forget` was reachable only from `exit` and `destroyed`, but the whole premise of the
// `list` case is that `destroyed` fires ONLY for our own destroy() — an out-of-band removal
// arrives as a plain `list`. So the side tables were never cleaned on the one path that
// matters, and `attention` / `prevState` / `fresh` grew without bound in a long-lived tab.
//
// HONESTY NOTE, because it decides how to read a green here: there is NO correctness impact
// today. Nothing reads those maps for an absent id, so this cannot be asserted through
// behaviour — a test that went via `needsAttention` on a removed id would pass whether or not
// the entry was dropped, i.e. for the wrong reason. These assert the maps DIRECTLY, and the
// fails-first below is what shows they can actually red.
{
  // A session that finished a turn unwatched, then is destroyed from another tab.
  const seeded = run(TWO,
    { type: 'created', session: sess('c') },
    { type: 'list', sessions: [sess('a'), sess('b'), sess('c')] },
    { type: 'setActive', id: 'a' },
    { type: 'state', id: 'c', state: 'running' },
    { type: 'state', id: 'c', state: 'idle' })
  check('F5.0a fixture: `c` carries an attention entry', seeded.attention.has('c'),
    String(attentionReason(seeded, 'c')))
  check('F5.0b fixture: `c` carries a prevState entry', seeded.prevState.has('c'))
  check('F5.0c fixture: `c` is fresh', isFresh(seeded, 'c'))

  const removed = run(seeded, { type: 'list', sessions: [sess('a'), sess('b')] })
  // ★ BOTH INVERTED 2026-08-25, for the same reason F5.1c was — and they should have been
  //   inverted IN THE SAME PASS. They were written to the spec that F5.1c was found wrong for,
  //   and were not re-examined when it flipped. **A spec found wrong for one sibling is wrong for
  //   the siblings written from it.** Same shape as a retraction that misses a copy, one level
  //   down, and unlike F6 these read as REQUIREMENTS rather than characterization, so a future
  //   reader would have defended them.
  //   WHY A LIST OMISSION MUST CLEAR NOTHING: the argument that spared `fresh` — that an omission
  //   is not a departure, because a session can be absent from one broadcast and present in the
  //   next — is an argument about what an omission MEANS, and it does not single out `fresh`. The
  //   counter-claim ("attention/prevState are re-established by whatever re-adds the row") is
  //   false: `prevState` is written only by `case 'state'`, `attention` only by `flagAttention`,
  //   and the event that re-adds a row is a `list`, which writes neither. `stateChange` is a
  //   TRANSITION event, so a session still sitting in `waiting` emits nothing to restore it.
  //   Clearing them cost a `blocked` light that goes out while the prompt is still pending, and a
  //   finished turn that is never flagged.
  check('F5.1a an out-of-band list removal KEEPS the attention entry — an omission is not a departure',
    removed.attention.has('c'), `[${[...removed.attention.keys()].join(',')}]`)
  check('F5.1b …and KEEPS the prevState entry, or a finished turn goes unflagged',
    removed.prevState.has('c'), `[${[...removed.prevState.keys()].join(',')}]`)
  // ★ INVERTED 2026-08-25, and the original expectation was a REAL BUG, not a nitpick.
  //   This once asserted the `fresh` entry was dropped too. It was written to a spec that turned
  //   out to be wrong, and the wrongness was user-visible: `destroyed`/`exit` mean the id is GONE
  //   so clearing everything is right, but a `list` OMISSION does not — a session can be absent
  //   from one broadcast and present in the next. `fresh` means "created in this app load", which
  //   stays true across such a gap, and ChatView's auto-resume effect is gated on it. Dropping it
  //   made a briefly-absent session eligible for auto-resume, so it pulled in a conversation it
  //   should never have loaded.
  //   HOW IT WAS CAUGHT: `super-editor-test` went red and stayed red for hours while this file
  //   sat at a confident 92/92 — the reducer suite could not see it, because the damage happens
  //   in a CONSUMER of `fresh`, not in the reducer. Isolated by bisection: with the forget loop
  //   disabled and every other part of the reconcile intact, that harness passes 19/19.
  //   The list path now uses `forgetPresenceState`, which clears `attention` and `prevState`
  //   (meaningful only WHILE present, and re-established by whatever re-adds the row) and never
  //   touches `fresh`.
  check('F5.1c …but the FRESH entry SURVIVES — a list omission is not a destroy',
    removed.fresh.has('c'), `[${[...removed.fresh].join(',')}]`)
  // And the distinction must be real, not accidental: an actual destroy DOES clear `fresh`.
  // Without this, "never clear fresh anywhere" would satisfy the line above.
  const reallyGone = run(seeded, { type: 'destroyed', id: 'c' })
  check('F5.1d …whereas an actual `destroyed` DOES clear it',
    !reallyGone.fresh.has('c'), `[${[...reallyGone.fresh].join(',')}]`)
  // …and clears the other two as well. Without this, "clear nothing, ever" satisfies F5.1a-c and
  // the side tables would grow without bound at EVERY exit, not just at list omissions.
  check('F5.1e …and `destroyed` clears attention and prevState too',
    !reallyGone.attention.has('c') && !reallyGone.prevState.has('c'),
    `attention=[${[...reallyGone.attention.keys()].join(',')}] prevState=[${[...reallyGone.prevState.keys()].join(',')}]`)

  // …while the surviving rows keep theirs — a forget loop that over-reaches would be just as
  // wrong, and an assertion that only checks the removed id could not tell the difference.
  const survivors = run(seeded, { type: 'state', id: 'b', state: 'running' },
    { type: 'list', sessions: [sess('a'), sess('b')] })
  check('F5.2 …and the SURVIVING rows keep their side-table entries',
    survivors.prevState.has('b'), `[${[...survivors.prevState.keys()].join(',')}]`)

  // Identity with the loop in the path — the same requirement as F2.7a/e, re-checked because a
  // loop that rebuilds state per removed row is exactly the shape that can churn.
  check('F5.3a an unchanged list does not churn even with side tables populated',
    reduce(seeded, { type: 'list', sessions: [sess('a'), sess('b'), sess('c')] }) === seeded)
  check('F5.3b …and the removing list churns exactly once, then settles',
    reduce(removed, { type: 'list', sessions: [sess('a'), sess('b')] }) === removed)
}

// ── F6: the orphan merge can REORDER the sidebar (characterization) ──────────────────
// `incoming = [...action.sessions, ...orphans]` appends, while `state.sessions` holds orphans
// wherever `created` put them. Two outstanding creates acknowledged out of order therefore
// move the still-unacked one behind the acknowledged one, until its own ack restores the
// server's order. PRESENTATION ONLY — the invariant, the selection and every side table are
// unaffected — and it needs two concurrent creates with out-of-order acks to appear at all.
//
// Left unfixed deliberately — but NOT for the reason first given, which does not survive
// being checked. The stated justification was that a positional re-insert would fight the
// server's canonical order. It would; the point is that APPENDING ALREADY DOES. Inserting each
// orphan at the index it holds in `state.sessions` fixes the case below exactly, and in the
// rare case where the server has genuinely reordered it is arbitrary — which is precisely what
// appending is in that same case. So re-insert is weakly BETTER than append, not a worse
// trade, and "it risks disagreeing with the canonical order" cannot be the argument for
// keeping append.
// The honest argument for leaving it is smaller and holds: the symptom is cosmetic, needs two
// concurrent creates acknowledged out of order to appear at all, corrects itself on the next
// ack (F6.3), and touches neither the invariant nor the selection nor any side table. That is
// not worth extra index arithmetic in the hottest action in the store. Pinned here so the
// decision is on the record with the reasoning that actually supports it.
{
  const two = run(initialSessionStore, { type: 'list', sessions: [sess('a')] },
    { type: 'created', session: sess('c') }, { type: 'created', session: sess('d') })
  check('F6.0 fixture: both creates are outstanding, in creation order',
    two.sessions.map((x) => x.id).join() === 'a,c,d' && two.unacked.has('c') && two.unacked.has('d'),
    two.sessions.map((x) => x.id).join())
  const dAcked = run(two, { type: 'list', sessions: [sess('a'), sess('d')] })
  check('F6.1 KNOWN, ACCEPTED: acking `d` first moves the still-unacked `c` behind it',
    dAcked.sessions.map((x) => x.id).join() === 'a,d,c', dAcked.sessions.map((x) => x.id).join())
  check('F6.2 …but nothing else moves: `c` is still present, still unacked, still selected',
    dAcked.sessions.some((x) => x.id === 'c') && dAcked.unacked.has('c') && dAcked.activeId === 'd',
    `active=${dAcked.activeId} unacked=[${[...dAcked.unacked].join(',')}]`)
  const bothAcked = run(dAcked, { type: 'list', sessions: [sess('a'), sess('c'), sess('d')] })
  check('F6.3 …and the server order is restored once `c` is acknowledged too',
    bothAcked.sessions.map((x) => x.id).join() === 'a,c,d', bothAcked.sessions.map((x) => x.id).join())
}

// ── F7 — A `finished` FLAG MUST NOT SURVIVE THE SESSION GOING BACK TO WORK ──────────────
// Reported by the operator 2026-09-03: a subsession's light was RED while it was WORKING, so
// red meant "finished, needs you" and "busy" at once and distinguished neither.
//
// `finished` was cleared in exactly ONE place — `withActive`, i.e. by VIEWING the session. That
// is sufficient only if viewing is the only way a finished session stops being finished, and it
// is not: sending it another turn starts it working again. On a session you are not watching —
// a teammate, which is the entire point of subsessions — nothing ever cleared it, so the dot
// reported a turn that had ended two turns earlier.
{
  // `b` finishes unwatched (active is `a`), then is sent more work.
  const finished = run(TWO,
    { type: 'setActive', id: 'a' },
    { type: 'state', id: 'b', state: 'running' },
    { type: 'state', id: 'b', state: 'idle' },
  )
  check('F7.0 fixture: an unwatched finish really does flag `b`',
    finished.attention.get('b') === 'finished', String(finished.attention.get('b')))

  const working = run(finished, { type: 'state', id: 'b', state: 'running' })
  check('F7.1 starting a new turn RETIRES the stale `finished` flag — red must not mean "busy"',
    !working.attention.has('b'),
    { pass: 'cleared', fail: `still ${working.attention.get('b')} while running — the sidebar renders this as the red "done" light` })

  // The scoping matters as much as the clear: (a2) must not fire on the idle transition, or it
  // would wipe the flag that the SAME action is setting for a finished turn.
  const refinished = run(working, { type: 'state', id: 'b', state: 'idle' })
  check('F7.2 …and finishing AGAIN re-flags it — the clear is scoped to `running`, not unscoped',
    refinished.attention.get('b') === 'finished', String(refinished.attention.get('b')))

  // A blocked session must not be reported as "done": `running` clears `finished` first, then
  // `waiting` sets `blocked`, so the reason the sidebar reads is the current one.
  const blocked = run(finished, { type: 'state', id: 'b', state: 'running' }, { type: 'state', id: 'b', state: 'waiting' })
  check('F7.3 finished → working → blocked ends as `blocked`, not a stale `finished`',
    blocked.attention.get('b') === 'blocked', String(blocked.attention.get('b')))
}

// ── L1/L2 — `listLoaded`, the flag a per-session PRUNE gates on ──────────────────────────
// These live HERE, in the reducer harness, and putting them anywhere else would be a false
// pass. web/src/lib/sessionLights.test.ts already pins the flag's CONSUMER (pruneMutes skips
// while it is false), but every `listLoaded` in that file is a plain boolean literal handed
// in by the test — nothing there can reach the reducer, so the flag's PRODUCER is unguarded
// by it. Measured: deleting `&& state.listLoaded` from the `list` case leaves the web suite
// at 46/46 AND this harness at 98/98. Two green suites, one deleted term, and a user whose
// server currently reports ZERO sessions loses their whole persisted mute store on every page
// load — the exact bug the flag was added to fix.
//
// WHY THE TERM LOOKS DELETABLE, which is the whole hazard: `listLoaded` is only ever set
// true and never cleared, so `&& state.listLoaded` reads as redundant. It is not. The `list`
// case returns `state` UNCHANGED when the incoming list matches what is already held, and on
// an empty server the very first list matches the initial empty array — so without that term
// the identity short-circuit fires on the one list that was supposed to flip the flag, and it
// stays false forever.
//
// MUTATIONS (measured 2026-09-04):
//   L-M1  delete `&& state.listLoaded` from the identity check in the `list` case
//         → L1 reds ALONE. Every other assertion in this file stays green, and so does the
//           whole web suite. That asymmetry is the finding, not a footnote.
//         Re-measured 2026-09-04 at 101/102 — this record said 99/100, which was correct when
//         written and went stale the moment the assertion floor added a case. A count in a
//         mutation record is a measurement with a date, and this file now has two of them
//           (L1/L2 landing, then the floor); restamped rather than left to look authoritative.
//   L-M2  set `listLoaded: true` unconditionally in the initial store
//         → L1 reds. I PREDICTED THIS ONE WRONG: I expected nothing to red, on the reasoning
//           that the flag would be vacuously true. L1 is stronger than I gave it credit for,
//           because it asserts the TRANSITION — `initial === false` AND `after === true` — so
//           a pre-set flag fails its first conjunct. Corrected to what was measured. Writing
//           the prediction down and then not running it is how a mutation record becomes
//           fiction; this is the second time today the measurement disagreed with me.
{
  // (a) An EMPTY first list must still flip the flag. This is the boot case on a server with
  // no sessions — the one the identity short-circuit would otherwise swallow.
  check('L1 initialSessionStore has listLoaded false, and an EMPTY first list flips it true',
    initialSessionStore.listLoaded === false
      && run(initialSessionStore, { type: 'list', sessions: [] }).listLoaded === true,
    `initial=${initialSessionStore.listLoaded} afterEmptyList=${run(initialSessionStore, { type: 'list', sessions: [] }).listLoaded}`)

  // (b) …and once flipped, a repeat empty list must change nothing at all. The flag must not
  // buy its correctness with identity churn: this state object is a dependency of effects in
  // the shell, and a new reference on every redundant broadcast would re-run them forever.
  const once = run(initialSessionStore, { type: 'list', sessions: [] })
  const twice = run(once, { type: 'list', sessions: [] })
  check('L2 a repeat empty list returns the SAME object (no identity churn)',
    twice === once, twice === once ? 'same reference' : 'NEW reference — effects keyed on this state will re-run')
}

// ── L3 — 'blocked' CAN co-occur with state 'idle', and the sidebar dot depends on it ──────
// This pins a reachable state rather than a desirable one, deliberately. The sidebar's status
// dot takes `flagged = attention.has(id)` — ANY reason — instead of the narrower
// `=== 'finished'` that drives the "done" label. That widening exists precisely because of
// the sequence below: a `list` action writes neither `attention` nor `prevState` (see its own
// comment), so a session flagged 'blocked' while waiting keeps that flag when a later plain
// list reports it idle. Under the old narrow wiring, dotState('idle', muted, false) returned
// 'muted' — a DARK dot on a session the store says is blocked, with no session:state event
// needed to reach it.
//
// If someone later makes `list` clear attention, this test reds. That is the intended signal:
// it means the widening is no longer load-bearing and the dot's wiring can be revisited. It
// is not an assertion that this behaviour is good.
//
// MUTATIONS — "make the `list` case clear attention" NAMES TWO DIFFERENT EDITS, and they do
// not produce the same result. This is the same lesson as M2 in turn-indicator-test.mjs: a
// mutation described loosely enough to have variants has no reproducible result, so both are
// recorded with the site each one touches. Measured 2026-09-04:
//
//   L3-A  clear the entry for each session the list REPORTS
//         → 94/102, EIGHT reds: F2.7a/b/d/e, F5.3a/b, L2, L3.
//   L3-B  rebuild `attention` from the list, so entries for OMITTED sessions go too
//         → 93/102, NINE reds: all of the above plus F5.1a.
//
// ★ F5.1a IS THE ONE THAT MATTERS, and it only appears under B. "An out-of-band list removal
// KEEPS the attention entry — an omission is not a departure" is a SEMANTIC red: it objects
// to the attention clearing itself, not to object churn. The other seven are collateral —
// identity assertions correctly complaining that either patch rebuilds the state object every
// pass. I first recorded only variant A and glossed all seven of its collateral reds as
// "identity assertions", which was true of A and would have been FALSE as a description of B.
// Corrected after review re-ran B and got a red my record did not predict. The useful fact is
// the one I undersold: this harness holds a real guard on attention-vs-list, not merely a
// tripwire for churn.
//
// There is no mutation of the DOT's wiring this file can see — App.tsx is not importable here
// — stated plainly rather than left implied: L3 guards the PRECONDITION. The consequent now
// lives in `dotStateFor` in web/src/lib/sessionLights.ts, where it IS tested, rather than in
// a comment beside the <StateDot> call as it did when this note was first written.
{
  const flagged = run(initialSessionStore,
    { type: 'list', sessions: [sess('a'), sess('b')] },
    { type: 'state', id: 'b', state: 'waiting' },
    { type: 'list', sessions: [sess('a'), sess('b', { state: 'idle' })] })
  check("L3 a 'blocked' flag SURVIVES a plain list that reports the session idle",
    flagged.attention.get('b') === 'blocked' && stateOf(flagged, 'b') === 'idle',
    `attention=${flagged.attention.get('b')} state=${stateOf(flagged, 'b')}`)
}

// ── A POSITIVE FLOOR ON ASSERTIONS EXECUTED ───────────────────────────────────────────────
// Same shape, and the same reason, as MIN_TESTS in scratchpad/web-vitest-shim.mjs: without
// it, a harness whose assertions stopped running would print `0/0 passed`, exit 0, and read
// GREEN in the suite table. `fail === 0` is satisfied most easily by never checking anything.
//
// ★ IT MATTERS MORE HERE THAN IT DOES FOR THE WEB SUITE, and the reason is this file's own
// recent history. L1/L2/L3 exist because a real mutation — deleting `&& state.listLoaded`
// from the `list` case — stayed green across all 98 assertions that existed at the time. A
// harness that could silently collect zero would reopen exactly the hole those assertions
// were added to close, one level up: the guard would be present, unexecuted, and reporting
// success. A count that cannot go down is the only thing standing between those two states.
//
// RAISE THIS when you add assertions — that is the point of it. If it ever has to go DOWN,
// say why in the commit, because a quietly lowered floor and a deleted assertion are
// indistinguishable from here.
//
// MUTATIONS (measured 2026-09-04):
//   F-M1  neuter three assertions so they silently stop executing (`if (false) check(...)`)
//         → 98/99, exit 1, and THE FLOOR IS THE ONLY RED. Every remaining assertion still
//           passes, which is the whole point: nothing else in this file can notice that a
//           check stopped running, because a check that does not run cannot fail.
//   F-M2  control, unmutated → 102/102, exit 0. Included because a floor that fires on a
//         healthy run is worse than none — it trains you to ignore the red.
//
// Captured BEFORE the check below, which would otherwise count itself and make the floor
// self-satisfying by exactly one.
const MIN_ASSERTIONS = 101
const executed = pass + fail
check(`the harness executed at least ${MIN_ASSERTIONS} assertions (0/0 also exits 0)`,
  executed >= MIN_ASSERTIONS,
  { pass: `${executed} executed`,
    fail: `only ${executed} executed — assertions stopped running, and an unexecuted check reports success` })

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
