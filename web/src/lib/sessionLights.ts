// The sidebar's per-session status lights — the DECISIONS, extracted from App.tsx so they can
// be tested exhaustively without a DOM. The rendering stays in App.tsx; what lives here is
// every rule that decides WHICH light shows, because those are the parts with failure modes.
import type { KernelStatus, SessionState } from '@claudette/shared'
import type { AttentionReason } from '../store/sessionReducer'

// What the per-session dot should show. `muted` is the user's click-to-mute mark — "I am not
// using this session" — and it is deliberately the LAST thing consulted.
export type DotState = 'attention' | 'running' | 'waiting' | 'exited' | 'muted' | 'idle'

// ★ THE SAFETY INVARIANT OF THE MUTE FEATURE, IN ONE FUNCTION.
// A mute must never be able to hide a session that wants the user. The ordering below is what
// guarantees it, rather than a promise that the auto-clear elsewhere runs in time:
//   1. `attention` outranks everything. A finished/errored session shows its red light even
//      if the user muted it earlier and the clear has not landed yet.
//   2. Any non-idle state outranks the mute. Running, waiting on a permission prompt, and
//      exited all render their own light; `muted` is not consulted at all.
//   3. Only a genuinely quiet session can be dark.
// So the worst a stale mute can do is dim a session that really is idle — which is the
// feature. It cannot swallow "needs you", which is the one outcome that would make this
// worse than not having it.
export function dotState(state: SessionState, muted: boolean, reason: AttentionReason | undefined): DotState {
  // ★ THE REASON, NOT A BOOLEAN — and collapsing it to one was a real regression, caught in
  // review. The first version took `attention: boolean` meaning "finished", which left a
  // muted dot DARK on a blocked session. Widening it to "any reason" fixed that and traded it
  // for a worse one: a session sitting on a permission prompt rendered the 'attention' arm,
  // which is a red pulse titled "Finished — needs your attention". The session had not
  // finished — it was blocked, waiting for the user — so the dot asserted something false,
  // and it did so on the ordinary subsession-hits-a-prompt path, not a corner case.
  //
  // The narrowing that existed before was RIGHT for the reason its own comment gave; what was
  // wrong was expressing it as a boolean, because that forced 'blocked' to be either "the
  // same as finished" or "nothing at all" and both are false. Carrying the reason lets each
  // one say what is true:
  if (reason === 'finished') return 'attention'
  // A blocked session is waiting on the user whatever state the list last reported, so this
  // outranks `state`. It covers the idle+blocked hazard with a LIT dot rather than a dark
  // one, and it keeps the yellow/red distinction the 'blocked' reason exists to carry —
  // which is exactly what fixing only the tooltip string would have silently deleted.
  if (reason === 'blocked') return 'waiting'
  // ★ AN ALLOWLIST, AND THE POLARITY IS THE POINT. `muted` is reachable from exactly ONE arm.
  // An earlier version asked "is the state one of running/waiting/exited?" and kept the mute
  // otherwise — a denylist, which disagrees with clearMutes (which drops the mute unless the
  // state is exactly 'idle'). Two rules of opposite polarity agree only by coincidence on the
  // states that exist today: add a fifth, say 'starting', and the denylist would keep the dot
  // DARK WHILE THE SESSION IS BUSY while the allowlist cleared it — so the safety claim would
  // have quietly moved from "guaranteed by the ordering" to "whatever the effect got round
  // to". Both are allowlists now, and the switch is exhaustive so widening SessionState is a
  // build failure here rather than a silent dark-when-busy state.
  switch (state) {
    case 'running': return 'running'
    case 'waiting': return 'waiting'
    case 'exited': return 'exited'
    case 'idle': return muted ? 'muted' : 'idle'
    default: {
      // Unreachable while SessionState is idle|running|waiting|exited. If that union grows,
      // this line stops compiling — which is the entire purpose of it. The runtime fallback
      // is a LIT dot rather than a dark one, so even a build that somehow shipped past this
      // fails in the safe direction.
      const _exhaustive: never = state
      void _exhaustive
      return 'idle'
    }
  }
}

// ★★ THE WIRING, EXTRACTED SO IT CAN BE ASSERTED RATHER THAN DESCRIBED. ★★
// This exists for the same reason `pruneMutes` does. The lookup used to live inline at the
// SessionRow call site in App.tsx, and NOTHING IN THE REPO IMPORTS App.tsx — so swapping it
// back to `attention.get(id) === 'finished'` left the reducer harness at 102/102, the web
// suite at 46/46 and typecheck clean, while restoring a dark dot on a blocked session. The
// one safety-critical line in the feature was the only part with no test at any layer.
// Moving the lookup here converts that comment into an assertion; the tests below it would
// also have caught the "Finished — needs your attention" regression at authoring time.
export function dotStateFor(
  session: { id: string; state: SessionState },
  muted: boolean,
  attention: ReadonlyMap<string, AttentionReason>,
): DotState {
  return dotState(session.state, muted, attention.get(session.id))
}

// Can this dot be clicked to toggle its mute? Only a quiet session — muting a running one
// would be a request to hide activity, which `dotState` would refuse to honour anyway, so
// offering the control there would be a button that visibly does nothing.
export function isMuteable(dot: DotState): boolean {
  return dot === 'idle' || dot === 'muted'
}

// WHAT COUNTS AS "A NEW INTERACTION" — the widest reading, chosen deliberately.
// Every departure from a quiet idle clears the mute: into running (new output), into waiting
// (a permission prompt), into exited, any attention flag, and the session disappearing. A
// narrower reading — say, only new assistant output — would leave a session muted while it
// sat on a permission prompt. Erring wide costs at most an un-mute nobody asked for; erring
// narrow costs the user a prompt they never saw.
//
// Returns the SAME SET REFERENCE when nothing changed, which is what lets the caller run this
// from an effect that also sets the state without looping.
// ⚠ THIS CANNOT TELL "the session is gone" FROM "the list has not loaded yet", and it must
// not try: that information does not exist in its inputs. An empty `sessions` is exactly what
// the store holds at mount, so a caller that runs this before the list arrives will prune
// every entry as vanished. The precondition belongs to the CALLER — see the `listLoaded`
// guard on the effect in App.tsx, and the note there about this being the repo's third
// instance of an empty collection treated as authoritative.
export function clearMutes(
  muted: ReadonlySet<string>,
  sessions: readonly { id: string; state: SessionState }[],
  attention: ReadonlyMap<string, unknown>,
): ReadonlySet<string> {
  if (muted.size === 0) return muted
  let next: Set<string> | null = null
  for (const id of muted) {
    const s = sessions.find((x) => x.id === id)
    if (!s || s.state !== 'idle' || attention.get(id)) {
      next ??= new Set(muted)
      next.delete(id)
    }
  }
  return next ?? muted
}

// How many of this session's notebooks have a kernel that is occupied.
// STARTING COUNTS AS WORKING: the user cannot run a cell while a kernel is coming up, so
// treating it as idle would blink the light off during the one stretch where "is it doing
// something?" is exactly the question being asked. 'none' and 'dead' are not activity, and
// 'idle' is a live kernel doing nothing.
export function busyKernelCount(notebookIds: readonly string[], kernelFor: (id: string) => KernelStatus): number {
  return notebookIds.filter((id) => {
    const k = kernelFor(id)
    return k === 'busy' || k === 'starting'
  }).length
}

// The whole call-site step: prune the mute store, and persist it ONLY if it actually changed.
// Extracted from the effect in App.tsx so the boot case is testable, because that is the case
// that shipped broken and a unit test on `clearMutes` alone structurally cannot catch it —
// `clearMutes([...], [], att)` returning `[]` is CORRECT for a loaded empty list and a
// catastrophe for an unloaded one, and nothing in its inputs distinguishes them.
//
// `save` is injected rather than calling localStorage directly so a test can assert the
// NEGATIVE — that nothing was written — which is the assertion that would have caught the bug.
// Returns the same set reference when nothing changed, so the caller's setState is a no-op.
export function pruneMutes(args: {
  muted: ReadonlySet<string>
  sessions: readonly { id: string; state: SessionState }[]
  attention: ReadonlyMap<string, unknown>
  listLoaded: boolean
  save: (ids: string[]) => void
}): ReadonlySet<string> {
  // ★ THE GUARD. Not `sessions.length > 0`: a server that genuinely has zero sessions must
  // still be able to prune a mute for a session that was closed. Only the loader knows which
  // situation this is.
  if (!args.listLoaded) return args.muted
  const next = clearMutes(args.muted, args.sessions, args.attention)
  if (next === args.muted) return args.muted
  args.save([...next])
  return next
}
