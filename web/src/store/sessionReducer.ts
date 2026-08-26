// The session store's state machine, extracted from SessionsProvider as a pure function
// so it can be tested without a DOM, a renderer, or a browser. No React import — that is
// invariant C-I3, and it is visible in the typecheck rather than merely intended.
//
// WHY A REDUCER AND NOT JUST TESTS: three pieces of state currently live in refs purely to
// dodge stale closures — prevStateRef (sessions.tsx:70, mutated inside the stateChange
// handler at :86 and read at :89), freshRef (:63) and activeRef (:60). Refs are how you
// work around the problem; a reducer is how it stops existing. The known ready-clobber bug
// (:91-97) and the attention rules (:88-89) are transitions, and transitions belong in one
// place where they can be stated and checked.
//
// ── THE SIX DOCUMENTED App.tsx ORDERING HAZARDS, each answered ────────────────
//
//  H1  App.tsx ~301-317 — `publishedRef`, a mutable dedupe cache written in one effect and
//      cleaned up in ANOTHER (:433).
//      UNAFFECTED. Different file, different state; this extraction does not reach it. It
//      is the same family this pattern is designed to remove — but saying so is not fixing
//      it.
//
//  H2  App.tsx ~441-443 — the prune effect is keyed on `sessionIdKey`, a derived string,
//      rather than on `sessions`, because "`sessions` gets a new identity on every state
//      event (running→idle, a rename, an optimistic patch)".
//      DIRECTLY IMPROVED — BUT ONLY IF THIS REDUCER PRESERVES ARRAY IDENTITY ON A NO-OP.
//      That is the root cause: sessions.tsx:75 maps the whole array unconditionally, so a
//      redundant event churns identity. patchSessions() below returns the SAME array when
//      no field actually changed, and every case returns `state` unchanged when nothing
//      moved. THIS IS A REQUIREMENT, NOT A NICETY: a reducer that always returns a fresh
//      array preserves H2 instead of helping, and would make the workaround permanent.
//
//  H3  App.tsx ~452-456 — `keep` is built from termsRef, NOT inside the setTermsBySession
//      updater, because a deferred updater with a side effect posted an empty keep-set and
//      the server killed every terminal. "Updaters must stay pure."
//      UNAFFECTED BY SCOPE, but note what this file is: a reducer is the structural
//      enforcement of exactly that sentence. If the terminal state is ever extracted the
//      same way, H3 becomes impossible rather than commented.
//
//  H4  App.tsx ~457-461 — two flags (reconcileStarted / reconciled) because one flag set
//      up front let a dependent effect fire against unvalidated state.
//      UNAFFECTED. Cross-effect gating in App.tsx; out of scope.
//
//  H5  App.tsx — the dead-session terminal-prune effect (the one whose body starts
//      `if (sessions.length === 0) return`, guarding `setTermsBySession`). The session list
//      loads async, and an empty list would otherwise prune every restored terminal before
//      the data arrives.
//      UNAFFECTED BY THIS EXTRACTION, and ALREADY GUARDED AND COMMENTED IN PLACE — the
//      effect carries its own "GUARD: the session list loads async…" note. So this entry is
//      here for the CLASS, not the instance, and it is NOT urgent.
//      THE CLASS: H5 and H3 are one failure mode reached two ways — AN EMPTY COLLECTION
//      TREATED AS AUTHORITATIVE. H3 arrives via an impure updater posting an empty keep-set;
//      H5 via an input array that has not loaded yet. Both killed every terminal. The rule
//      that carries to the NEXT prune loop is: a prune keyed on a collection must
//      distinguish "nothing to keep" from "not loaded yet". There are already further prune
//      loops nearby (the `setBySession` cleanup in that same effect, and `seenNb`'s removal
//      pass in H6) for the rule to apply to.
//      Note also that this is a CORRECTNESS invariant about the effect BODY, distinct from
//      H2's PERFORMANCE invariant about a dependency ARRAY. The two are easy to conflate.
//
//  H6  App.tsx — the notebook-restore effect (`seenNb`) *** FIXED 2026-08-26. ***
//      THE FIX AS IT LANDED: the ordering rule moved out of the effect into
//      web/src/lib/notebookAttach.ts (`attachNewNotebooks`), which marks an id seen ONLY as it
//      returns it for attaching — so marking-seen and acting are now one indivisible step
//      rather than two statements that drifted apart. App.tsx's effect keeps only the React
//      work. Extracted rather than reordered in place so the rule could be TESTED:
//      scratchpad/notebook-attach-test.mts, 5 assertions, pure, no DOM. Test 2 is the
//      regression and fails against the old ordering (verified: 2/5 with the `add` moved back
//      above the precondition).
//      NOT fixed by a React-level test: `web/src/store/sessions.test.tsx` would be the natural
//      home for one, but `vitest` is neither installed nor declared in web/package.json, so
//      that file cannot currently be executed at all. Worth knowing before adding another.
//      The description below is kept in the past tense as the record of what the bug WAS.
//      Order in the loop body WAS: `if (seenNb.current.has(id)) continue`, then
//      `seenNb.current.add(id)`, and only THEN the precondition
//      `if (activeId && notebooks.wasLocallyOpened(id))`. The effect CONSUMES its input
//      before testing whether it can act on it. Its dep array is `[openIds, activeId]`, so
//      a re-run once `activeId` arrives was deliberately provided — and the `continue`
//      defeats that retry permanently, because the id is already marked seen. In an async
//      world "precondition not yet met" is the NORMAL first pass, so the failure is silent,
//      permanent, and never retried.
//      NOT CLOSED BY THE createPath FIX. That change (notebooks.tsx, createPath returning
//      CreateResult so App.tsx's onNewNotebook focuses explicitly) made ONE CALLER immune by
//      no longer depending on this effect at all — it routed around the hazard, it did not
//      remove it. notebooks.tsx's comment describes this shape accurately and must not be
//      read as retiring it. Any future caller that depends on this effect firing hits the
//      same trap.
//      (The fix named here at the time — move the `add` after the precondition test — is what
//      was done, in the extracted form described above.)
//      This is an instance of a named pattern in this codebase — a guard that consumes its
//      input before testing its precondition. The other known instances are scrollMemory's
//      `settled` counter and the session-blind scroll key.
//
// ── AND TWO HAZARDS THIS EXTRACTION MOVES SOMEWHERE NEW ──────────────────────
//
//  N1  `prevState` moves from a ref into reducer state. The hazard changes from "a ref is
//      read at a different moment than the array it is compared against" to "the reducer
//      must be genuinely pure". That is a better home because it is MECHANICALLY CHECKED:
//      the ReadonlyMap/ReadonlySet types make mutation a type error, and React StrictMode's
//      double-invocation surfaces any impurity immediately. Every map and set below is
//      copied, never mutated in place.
//
//  N2  `fresh` moves from a ref into state, so isFresh() becomes a read of RENDERED state
//      rather than a synchronous ref read. *** THIS IS THE ONE PLACE THIS CAN REGRESS. ***
//      A caller invoking isFresh immediately after create() resolves saw `true` from the
//      ref; from state it may lag a render. Whoever lands the provider rewrite MUST check
//      every isFresh consumer. If any needs synchronous truth, leave `fresh` as a ref and
//      drop it from this reducer — it participates in no transition, so excluding it costs
//      nothing and removes N2.
import type { SessionInfo, SessionState } from '@claudette/shared'
// `import type` is erased at runtime, so this file has NO runtime dependency and a plain
// `npx tsx` runner never has to resolve the workspace alias. That is why the test can live
// in scratchpad/ alongside the server tests.

// Why a session's light is lit. `finished` = a turn ended while you were not watching, and
// viewing it IS the response. `blocked` = it is sitting on a permission prompt and cannot
// proceed until you answer; viewing it changes nothing, so it clears on the transition out
// of `waiting` instead.
export type AttentionReason = 'finished' | 'blocked'

export interface SessionStoreState {
  sessions: SessionInfo[]
  activeId: string | null
  // WHY a reason and not a boolean. The light used to mean exactly one thing — "a turn
  // finished while you were not watching" — so a session BLOCKED on a permission prompt was
  // never flagged at all. That is not hypothetical: a teammate on this team sat blocked
  // twice in one session, unnoticed both times. The two states also differ in how they
  // CLEAR, which a boolean cannot express: viewing a finished session is the whole response
  // to it, while viewing a blocked one answers nothing.
  attention: ReadonlyMap<string, AttentionReason>
  // Was prevStateRef: the state each session was in BEFORE the current one, so a finished
  // turn can be told apart from an idle session merely being re-reported.
  prevState: ReadonlyMap<string, SessionState>
  // Was freshRef: sessions created in this app load (not restored), kept out of the
  // auto-resume path so a brand-new session starts empty. See N2.
  fresh: ReadonlySet<string>
  // Sessions we added OPTIMISTICALLY in `created` that no server `list` has confirmed yet.
  // Distinct from `fresh`, and NOT foldable into it: `fresh` is life-of-session ("created
  // this app load, so never auto-resume it" — ChatView's only consumer), whereas this
  // clears the instant the server acknowledges the row. Its sole job is to let `list` tell
  // "the server never had this session yet" apart from "the server no longer has it", which
  // otherwise look identical — both are an active id absent from the incoming list — and
  // which must be handled in OPPOSITE directions: keep the selection vs. move it.
  unacked: ReadonlySet<string>
}

export const initialSessionStore: SessionStoreState = {
  sessions: [], activeId: null, attention: new Map(), prevState: new Map(), fresh: new Set(), unacked: new Set(),
}

export type SessionStoreAction =
  | { type: 'list'; sessions: SessionInfo[] }
  | { type: 'state'; id: string; state: SessionState }
  | { type: 'ready'; id: string }
  | { type: 'exit'; id: string; failed: boolean; error: string }
  | { type: 'patch'; id: string; fields: Partial<SessionInfo> }
  | { type: 'created'; session: SessionInfo }
  | { type: 'destroyed'; id: string }
  | { type: 'markBusy'; id: string }
  | { type: 'setActive'; id: string | null }
  // The WS came back up. Only meaning: whatever we were waiting for the server to acknowledge,
  // we are no longer waiting for — the next `list` is authoritative. See the `reconnected` case.
  | { type: 'reconnected' }

// Patch one session, PRESERVING ARRAY IDENTITY when no field actually changes. See H2 —
// this is the whole reason the App.tsx prune effect needs a derived key today.
function patchSessions(sessions: SessionInfo[], id: string, fields: Partial<SessionInfo>): SessionInfo[] {
  const i = sessions.findIndex((s) => s.id === id)
  if (i < 0) return sessions
  const cur = sessions[i] as unknown as Record<string, unknown>
  const f = fields as Record<string, unknown>
  let changed = false
  for (const k of Object.keys(f)) if (cur[k] !== f[k]) { changed = true; break }
  if (!changed) return sessions
  const next = sessions.slice()
  next[i] = { ...sessions[i], ...fields }
  return next
}

// Is this incoming list field-for-field what we already hold? `session:list` is by far the
// most frequent action — index.ts:158 broadcasts it on every `changed`, and SessionManager
// emits `changed` from 17 sites including recordTask, which fires on every subagent-registry
// tick during a turn. Taking the incoming array unconditionally handed the store a new
// `sessions` identity on each of those, which churned spawnSubsession's identity, which
// churned the context `value` memo, which re-rendered every useSessions() consumer in the
// app. The rest of this file is careful about identity; this is the path where it mattered
// most and was not.
function sameSessions(a: SessionInfo[], b: SessionInfo[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as unknown as Record<string, unknown>
    const y = b[i] as unknown as Record<string, unknown>
    if (x === y) continue
    const kx = Object.keys(x)
    if (kx.length !== Object.keys(y).length) return false
    for (const k of kx) if (x[k] !== y[k]) return false
  }
  return true
}

// Drop a departed session from every side table. `exit` and `destroyed` removed the row but
// left the id in attention/prevState/fresh forever — unbounded growth in a long-lived tab,
// with prevState the worst since `state` writes to it on every transition. No correctness
// impact today (ids are UUIDs, so nothing is ever reused, and a stale attention id renders
// nothing), but a reducer extraction exists precisely to make this easy to get right.
function forget(state: SessionStoreState, id: string): SessionStoreState {
  const inAttention = state.attention.has(id)
  const inPrev = state.prevState.has(id)
  const inFresh = state.fresh.has(id)
  const inUnacked = state.unacked.has(id)
  if (!inAttention && !inPrev && !inFresh && !inUnacked) return state
  const attention = inAttention ? new Map(state.attention) : state.attention
  if (inAttention) (attention as Map<string, AttentionReason>).delete(id)
  const prevState = inPrev ? new Map(state.prevState) : state.prevState
  if (inPrev) (prevState as Map<string, SessionState>).delete(id)
  const fresh = inFresh ? new Set(state.fresh) : state.fresh
  if (inFresh) (fresh as Set<string>).delete(id)
  // Must be forgotten here too, or a session destroyed before the server ever listed it
  // would stay permanently "unacknowledged" — and `list` would then refuse to move the
  // selection off it, which is the exact dangling-selection bug this set exists to prevent.
  const unacked = inUnacked ? new Set(state.unacked) : state.unacked
  if (inUnacked) (unacked as Set<string>).delete(id)
  return { ...state, attention, prevState, fresh, unacked }
}

// Identity preservation here is A REQUIREMENT, NOT A NICETY (see the note on patchSessions):
// a session re-reporting `waiting` must not churn the map, or every consumer memoised on it
// re-renders for no change. Note the guard is on the REASON, not on presence — a session
// going blocked→finished must produce a new map, because the meaning changed.
function flagAttention(
  attention: ReadonlyMap<string, AttentionReason>, id: string, reason: AttentionReason,
): ReadonlyMap<string, AttentionReason> {
  if (attention.get(id) === reason) return attention
  const next = new Map(attention)
  next.set(id, reason)
  return next
}

// Change the active session AND clear its attention flag in the SAME transition. In the
// provider this was a useEffect on activeId (sessions.tsx:188-190), which ran after render
// — so there was a frame where the newly-active session still showed its dot — and which
// caught every path (click, create, default-select, exit) only because they all happened to
// route through activeId. Here it is one function every path calls on purpose.
function withActive(state: SessionStoreState, id: string | null): SessionStoreState {
  // CLEARS `finished` ONLY. A `blocked` entry SURVIVES being viewed, and that asymmetry is
  // the point of carrying a reason at all: looking at a blocked session does not answer its
  // permission prompt, so a light that went out on view would be an alarm that lies — it
  // would report "handled" for something still waiting on you. `blocked` is cleared by the
  // session actually leaving `waiting`, in the `state` case below, and nowhere else.
  const needsClear = id !== null && state.attention.get(id) === 'finished'
  if (state.activeId === id && !needsClear) return state
  let attention = state.attention
  if (needsClear) { const n = new Map(state.attention); n.delete(id as string); attention = n }
  return { ...state, activeId: id, attention }
}

export function reduceSessionStore(state: SessionStoreState, action: SessionStoreAction): SessionStoreState {
  switch (action.type) {
    case 'list': {
      // Default the selection to the first session once one exists — but NEVER clobber an
      // existing selection (sessions.tsx:82 guarded on !activeRef.current).
      // Keep the array we already hold when nothing actually changed — see sameSessions.
      // Acknowledge optimistic rows the server now reports. Computed from `action.sessions`,
      // the authoritative payload — NOT from the deduped array below, which may be the old one
      // that `sameSessions` preserved for identity. Reading that would skip the ack exactly
      // when the incoming list already agrees with us, which is the common case.
      let unacked = state.unacked
      if (unacked.size > 0) {
        const next = new Set(unacked)
        for (const s of action.sessions) next.delete(s.id)
        if (next.size !== unacked.size) unacked = next
      }
      // CARRY UNACKNOWLEDGED ROWS THROUGH. A `list` that predates a create is not a denial of
      // that create, so it must not delete the optimistic row — the row and the selection have
      // to move together. Keeping the selection while taking `sessions` wholesale from the
      // payload was a real gap in the first version of this fix: for the duration of the stale
      // window `activeId` pointed at a session absent from `state.sessions`, so `activeSession`
      // was undefined and `canTerm` was true — the SAME dangling shape this case exists to
      // remove, merely transient and arrived at from the other direction.
      const orphans = unacked.size === 0 ? [] : state.sessions.filter(
        (s) => unacked.has(s.id) && !action.sessions.some((a) => a.id === s.id),
      )
      const incoming = orphans.length === 0 ? action.sessions : [...action.sessions, ...orphans]
      const sessions = sameSessions(state.sessions, incoming) ? state.sessions : incoming
      const withRows = sessions === state.sessions && unacked === state.unacked
        ? state
        : { ...state, sessions, unacked }
      // A `list` OMISSION CLEARS NOTHING. This loop once called the full `forget()`, then a
      // narrowed `forgetPresenceState()` that spared `fresh` — and both were wrong for the SAME
      // reason, which is worth stating because the second version looked like the fix.
      //
      // The argument for sparing `fresh` was: a `list` omission is NOT a departure, because a
      // session can be absent from one broadcast and present in the next. **That argument does
      // not single out `fresh`.** It is an argument about what a list omission MEANS, and it
      // applies identically to `attention` and `prevState`. Sparing one of the three and clearing
      // the other two holds two contradictory premises at once.
      //
      // The claim that justified clearing them — "they are re-established by whatever re-adds the
      // row" — is FALSE, exhaustively: `prevState` is written in exactly one place (`case 'state'`)
      // and `attention` only by `flagAttention` (from `state` and `exit`). **The event that re-adds
      // a dropped row IS a `session:list`, and `list` writes neither.** Nor will the server
      // re-supply them: `stateChange` is a TRANSITION event, so a session merely SITTING in
      // `waiting` emits nothing at all.
      //
      // Two concrete regressions this caused, both reachable — and the evidence that transient
      // omissions really happen is the `super-editor` bisection that produced the previous fix:
      //   * a `blocked` light goes out while the prompt is STILL PENDING and never returns (no
      //     `stateChange` fires for a session that has not moved) — the exact "alarm that lies"
      //     the `blocked` reason was introduced to prevent, reached by a new trigger;
      //   * a finished turn is never flagged: `prevState` is gone, so `finishedUnwatched` (which
      //     requires prev === 'running' | 'waiting') is false and no light appears.
      //
      // KNOWN AND ACCEPTED IN EXCHANGE: `attention`, `prevState` and `fresh` are not pruned when a
      // session leaves permanently via a list omission (an out-of-band destroy). They are still
      // cleared by `destroyed` and `exit`. That is a slow leak bounded by sessions-per-page-load,
      // and it is the lesser evil — an unbounded map costs memory, whereas clearing early costs
      // the operator a missed permission prompt. **Bound it at a point that is EVIDENCE of
      // departure, never at a list omission.**
      const base = withRows
      // "Never clobber an existing selection" means never steal a VALID one. It did not mean
      // keep a DEAD one, but that is what it did: the guard tested `activeId !== null` and
      // never asked whether that id was still in the list. `destroyed` clears the selection,
      // but it is dispatched only by OUR OWN destroy() call — a session destroyed out of band
      // (another tab, another client, the server, a direct POST /api/session/destroy) arrives
      // as a plain `list` broadcast instead, and the row vanished while activeId still pointed
      // at it. The dangling id then leaked everywhere downstream: `sessions.find(...)` for the
      // active session went undefined, ChatView kept a `key` for a session that no longer
      // exists, the per-session pane/terminal maps kept indexing it, and `canTerm` — which is
      // literally `activeId !== null` — left the Terminal button ENABLED with nothing to
      // attach to. That last one is what `terminal-ui-e2e` catches.
      //
      // The `unacked` term is what keeps this from trading one bug for another. A `list`
      // computed BEFORE a create can be delivered AFTER it (WS and HTTP are separate
      // channels), and it is indistinguishable from a removal by shape alone — so without
      // that term this would yank the selection off a session the user just made.
      //
      // Note the test below reads `sessions`, the MERGED array, not `action.sessions`. That is
      // deliberate and is what makes the whole case coherent: because unacknowledged rows are
      // carried through above, "is the selection still alive" and "is its row still present"
      // become THE SAME QUESTION, and there is no second `unacked.has(...)` term that could
      // ever disagree with the array. The invariant this case now maintains, stated plainly:
      // ** activeId is non-null only while a row with that id is in `sessions`. **
      const active = state.activeId
      if (active !== null && sessions.some((s) => s.id === active)) return base
      // Covers both the original job (default the selection once a session exists) and the
      // new one (replace a dead selection). `withActive` already no-ops when the id is
      // unchanged, so this preserves state identity without a second guard here.
      return withActive(base, sessions.length === 0 ? null : sessions[0].id)
    }

    case 'state': {
      const prev = state.prevState.get(action.id)
      const sessions = patchSessions(state.sessions, action.id, { state: action.state })
      // A genuinely redundant event must return `state` ITSELF, not just an unchanged
      // sessions array — otherwise the state object identity churns and the provider
      // re-renders anyway, which is the same invariant `patchSessions` exists to hold one
      // level down. Note finishedUnwatched cannot be true here: it needs prev to be
      // running/waiting AND action.state to be idle, which `prev === action.state` excludes.
      if (prev === action.state && sessions === state.sessions) return state
      const prevState = new Map(state.prevState).set(action.id, action.state)
      // A turn finished on a session you are NOT watching → flag it for attention. It must
      // have been running/waiting first: an idle→idle re-report is not a finished turn.
      const finishedUnwatched = action.state === 'idle'
        && (prev === 'running' || prev === 'waiting')
        && action.id !== state.activeId
      // A session sitting on a permission prompt is BLOCKED — it cannot proceed until a
      // human answers — and until now nothing flagged that at all: the light fired only when
      // a turn FINISHED. `waiting` is set in exactly one place in the engine (the
      // permission-prompt handler), so it is a precise signal, not a general "busy".
      const blockedUnwatched = action.state === 'waiting' && action.id !== state.activeId

      // ORDER IS LOAD-BEARING: clear first, then flag.
      // (a) leaving `waiting` retires a `blocked` entry — the prompt is no longer pending.
      //     Scoped to `blocked` on purpose: it must not touch a `finished` entry, which is
      //     cleared by viewing instead. Running this AFTER (b) with an unscoped delete would
      //     wipe the `finished` flag (b) had just set for a session that went waiting→idle.
      let attention = state.attention
      if (action.state !== 'waiting' && attention.get(action.id) === 'blocked') {
        const next = new Map(attention)
        next.delete(action.id)
        attention = next
      }
      // (b) then (c). Both go through flagAttention, so a repeat of the same reason keeps
      //     the existing map identity.
      if (finishedUnwatched) attention = flagAttention(attention, action.id, 'finished')
      if (blockedUnwatched) attention = flagAttention(attention, action.id, 'blocked')
      return { ...state, sessions, prevState, attention }
    }

    case 'ready': {
      // The CLI inits lazily, so system/init often lands AFTER the first turn already set
      // 'running'. Clobbering that to idle hid the working indicator and the interrupt for
      // the whole turn (sessions.tsx:91-97). Only settle when no turn is in flight.
      const s = state.sessions.find((x) => x.id === action.id)
      if (!s || s.state === 'running' || s.state === 'waiting') return state
      const sessions = patchSessions(state.sessions, action.id, { state: 'idle' })
      return sessions === state.sessions ? state : { ...state, sessions }
    }

    case 'exit': {
      if (action.failed) {
        // A startup failure KEEPS the row so the operator can read the error and retry.
        const sessions = patchSessions(state.sessions, action.id, { state: 'exited', exitError: action.error })
        // `finished`, not `blocked`: a startup failure is over, and reading the error is
        // the whole response to it — so it should clear on view like any finished turn.
        const attention = action.id !== state.activeId
          ? flagAttention(state.attention, action.id, 'finished')
          : state.attention
        if (sessions === state.sessions && attention === state.attention) return state
        return { ...state, sessions, attention }
      }
      const sessions = state.sessions.filter((s) => s.id !== action.id)
      if (sessions.length === state.sessions.length) return state
      const dropped = forget({ ...state, sessions }, action.id)
      return state.activeId === action.id ? withActive(dropped, null) : dropped
    }

    case 'patch': {
      const sessions = patchSessions(state.sessions, action.id, action.fields)
      return sessions === state.sessions ? state : { ...state, sessions }
    }

    case 'created': {
      // Optimistic add + select; the server's next list/state event reconciles.
      const exists = state.sessions.some((s) => s.id === action.session.id)
      const sessions = exists ? state.sessions : [...state.sessions, action.session]
      const fresh = state.fresh.has(action.session.id) ? state.fresh : new Set(state.fresh).add(action.session.id)
      // Mark it unacknowledged until a server `list` reports it, so a `list` that predates
      // this create cannot be mistaken for the session having been removed. See the `list` case.
      //
      // GATED ON `!exists`, AND THAT GUARD IS LOAD-BEARING — an unconditional add reintroduced
      // the exact bug this set prevents. `POST /api/session/create` does NOT await:
      // `sessionApi.ts`'s handler calls the synchronous `sessions.create(...)`, and
      // `SessionManager.create` runs `this.emit('changed')` on the line BEFORE `return
      // session.id`. So the `session:list` broadcast carrying the new session is emitted
      // strictly before the HTTP response is produced, and on loopback the WS frame is
      // routinely parsed first. The `list` therefore lands before this action, `c` arrives as
      // an ordinary acknowledged row, and re-marking it unacked here would mean the NEXT list
      // that omits it — an out-of-band destroy — gets read as "a list predating a create",
      // carrying a phantom row through and pinning the selection to a dead session.
      // Membership in `state.sessions` IS the acknowledgement signal, which is what makes this
      // guard correct rather than merely cheaper.
      const unacked = exists || state.unacked.has(action.session.id)
        ? state.unacked
        : new Set(state.unacked).add(action.session.id)
      // Guard the allocation too: every other identity-sensitive path here (patchSessions,
      // flagAttention, forget) returns the same object when nothing moved, and a re-dispatched
      // `created` for a session we already hold should not churn the store either.
      if (sessions === state.sessions && fresh === state.fresh && unacked === state.unacked) {
        return withActive(state, action.session.id)
      }
      return withActive({ ...state, sessions, fresh, unacked }, action.session.id)
    }

    case 'destroyed': {
      const sessions = state.sessions.filter((s) => s.id !== action.id)
      const gone = sessions.length !== state.sessions.length
      if (!gone && state.activeId !== action.id) return state
      const dropped = forget(gone ? { ...state, sessions } : state, action.id)
      return state.activeId === action.id ? withActive(dropped, null) : dropped
    }

    case 'markBusy': {
      // Only idle→running. Never override 'waiting' (a live permission prompt) and never
      // resurrect an exited session (sessions.tsx:194-196).
      const s = state.sessions.find((x) => x.id === action.id)
      if (!s || s.state !== 'idle') return state
      const sessions = patchSessions(state.sessions, action.id, { state: 'running' })
      return sessions === state.sessions ? state : { ...state, sessions }
    }

    case 'setActive':
      return withActive(state, action.id)

    case 'reconnected': {
      // BOUNDS THE ONE WAY `unacked` CAN LEAK. An id is added on `created` and removed when a
      // `list` reports it or `forget` drops it — so the single leaking path is a create the
      // server never lists and the client never destroys, i.e. the connection dropping between
      // a create and the broadcast that would have acknowledged it. A server restart is exactly
      // that, and it is not hypothetical.
      //
      // The consequence is worse since `list` began carrying unacknowledged rows through: a
      // leaked id used to cost a dangling selection whose ROW self-healed away, and now the row
      // is carried forever too — a phantom session that never disappears and never reconciles.
      //
      // Clearing on reconnect targets the precondition itself. The tempting alternative —
      // counting how many lists omitted an id and dropping it after N — was rejected because it
      // fights an existing requirement: a repeated identical `list` must return the SAME state
      // object (hazard H2, pinned by F2.7a/e), and a per-list counter churns state on exactly
      // the broadcast that must not churn it. This action changes state at most once per
      // reconnect and never during steady-state broadcasts.
      //
      // Nothing else is cleared. `fresh` must survive (it is life-of-session and suppresses
      // auto-resume), `sessions` is about to be replaced by the authoritative list anyway, and
      // the selection is deliberately left alone so a reconnect does not move the user's view —
      // the following `list` reconciles it under the invariant, which is where that belongs.
      if (state.unacked.size === 0) return state
      return { ...state, unacked: new Set() }
    }

    default: {
      // Exhaustiveness: adding an action without a case is a TYPE ERROR. The ASSIGNMENT is
      // what enforces that — returning `never` as well was a runtime hazard for no extra
      // compile-time benefit. At runtime `never` is `undefined`, so any dispatch the type
      // system did not see (a stale action shape from an older bundle in a long-lived tab, a
      // hot-reload boundary, anything reaching dispatch untyped) set the whole store to
      // undefined, and the next `store.sessions` destructure in the provider threw — a white
      // screen instead of an ignored action. Ignore it and keep running.
      const never: never = action
      void never
      return state
    }
  }
}

// Read helpers, so consumers never reach into the shape directly.
export const isFresh = (state: SessionStoreState, id: string): boolean => state.fresh.has(id)
export const needsAttention = (state: SessionStoreState, id: string): boolean => state.attention.has(id)
// WHY the light is lit, or undefined. Consumers that render text must use this rather than
// needsAttention: the sidebar says "done" / "Finished — needs your attention", which is
// actively FALSE for a blocked session. Until the rendering slice lands, App.tsx asks for
// `finished` explicitly so the UI stays exactly as it is today.
export const attentionReason = (state: SessionStoreState, id: string): AttentionReason | undefined =>
  state.attention.get(id)
