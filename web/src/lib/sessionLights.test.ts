// The sidebar status-light DECISIONS. Pure, so every case is reachable without a DOM — which
// matters because the interesting cases here are the ones a render test struggles to stage:
// a stale mute on a session that has since started running, and a mute on a session that is
// asking for a permission prompt.
//
// ★ WHAT THESE TESTS EXIST TO PIN. A mute must never hide a session that wants the user. That
// is not a promise about the auto-clear effect firing in time — effects are exactly what does
// not hold under a race — it is an ORDERING inside dotState, and the tests below assert the
// ordering directly with the mute flag deliberately left set.
//
// MUTATIONS (measured 2026-09-04; re-run rather than trusting this record, and note WHICH
// edit — an edit loose enough to have variants has no reproducible result):
//   M1  dotState: move `if (attention)` BELOW the non-idle checks
//       → "attention outranks a stale mute on a RUNNING session" reds, alone. Note this is
//         NOT the red I first predicted: the idle+attention case survives, because a muted
//         idle session never reaches the reordered branch. Corrected to what was measured —
//         a predicted red-set that was never run is a guess wearing a record's clothes.
//   M2  dotState: `return muted ? 'muted' : 'idle'` → `return 'idle'`
//       → the muted-render case reds (one `it` covers both idle and muted); every safety
//         case stays green. That asymmetry is the evidence the safety tests and the feature
//         tests are not the same test written twice.
//   M3  dotState: drop `state === 'waiting'` from the non-idle list
//       → "a muted session on a PERMISSION PROMPT still shows waiting" reds ALONE. This is
//         the single failure mode that would make the feature worse than not having it.
//   M4  clearMutes: `s.state !== 'idle'` → `false`
//       → TWO reds: "running, waiting and exited each clear the mute" and "it clears only
//         the session that moved". The second was not predicted and is the more informative
//         of the pair — it shows the mute surviving on a session that started running while
//         a genuinely idle sibling is untouched.
//   M5  clearMutes: drop the `!s` (session gone) arm
//       → the closed-session case reds alone.
//   M6  clearMutes: return `new Set(muted)` instead of the same reference when unchanged
//       → the identity test reds. That test is not pedantry: the caller runs this inside a
//         setState in an effect keyed on [sessions, attention], and a fresh reference every
//         pass is an infinite render loop.
//   M7  busyKernelCount: drop `|| k === 'starting'`
//       → the starting case reds alone.
//   XX  a patch matching no text must REFUSE, not silently run the unmutated file.
//
// ⚠ METHOD NOTE, ADDED 2026-09-08 AND IT APPLIES TO EVERY MUTATION RECORD ABOVE.
// The records above name which assertions turned red. They do NOT record how many assertions
// EXECUTED, and that number is the one that tells you the run was real. A mutant that fails to
// PARSE — a stray bracket, a shell-escaping accident — produces zero failures, exactly like a
// clean pass. Counting only failures cannot tell them apart.
//
// Both directions are wrong and one is worse. On a mutation you expect to red, a crash reads
// as "this assertion is vacuous": you chase a phantom, which wastes time but corrects itself.
// On a CONTROL you expect to stay green, a crash reads as A PASSING CONTROL — silently, with
// nothing to chase — and a control's entire job is to prove the harness still works.
//
// Measured here rather than argued, by injecting a syntax error into a mutant:
//     clean control  → exit 0, failures counted 0, totals line "12/12 passed"
//     crashed mutant → exit 1, failures counted 0, totals line "?"
// The failure count is IDENTICAL. Only the executed count separates them.
//
// The runs behind the records above did print a totals line and it was read at the time, so
// they are not suspect — but the DURABLE record omits it, which leaves a future reader one
// assumption short of a proof. Stated rather than quietly relied on. New records in this
// repo should carry `ran=N` alongside the red set; `MIN_ASSERTIONS` in
// scratchpad/session-reducer-test.mts is the same instrument pointed at the suite instead of
// at a mutation run.
import { describe, it, expect } from 'vitest'
import { dotState, dotStateFor, isMuteable, clearMutes, pruneMutes, busyKernelCount } from './sessionLights'
import type { AttentionReason } from '../store/sessionReducer'
import type { KernelStatus, SessionState } from '@claudette/shared'

// MUTATIONS for the reason-carrying dot and its lookup (measured 2026-09-04):
//   M16 `if (reason === 'blocked') return 'waiting'` → `return 'attention'`
//       → FOUR reds, all four blocked cases. This is the regression review caught: a session
//         on a permission prompt rendering a red pulse titled "Finished — needs your
//         attention", which it had not. The finished cases stay green, which is the proof
//         that the two reasons are pinned separately rather than as one flag.
//   M17 delete the blocked arm entirely → TWO reds, both idle+blocked cases. That is the
//       ORIGINAL dark-dot bug, the one the prop split was made to fix.
//   M18 dotStateFor narrows the lookup back to `=== 'finished' ? 'finished' : undefined`
//       → the idle+blocked lookup case reds. ★ THIS IS THE ONE THAT CLOSES THE STRUCTURAL
//         GAP. That exact swap, while the lookup lived inline in App.tsx, left the reducer
//         harness at 102/102, this suite at 46/46 and typecheck clean, with a dark dot back
//         on a blocked session — because nothing in the repo imports App.tsx. It reds here.
//   M19 dotStateFor ignores the session id and takes the first entry in the map
//       → the wrong-session case reds alone.
//   XX  a patch matching no text must REFUSE.
describe('dotState — a mute can never hide a session that wants you', () => {
  it('an idle session is idle, and a muted idle session is muted', () => {
    expect(dotState('idle', false, undefined)).toBe('idle')
    expect(dotState('idle', true, undefined)).toBe('muted')
  })

  // ★ THE SAFETY CASES. `muted` is TRUE in every one of these — the point is that it is
  // ignored, not that it was cleared first.
  it('a muted session that is RUNNING shows running', () => {
    expect(dotState('running', true, undefined)).toBe('running')
  })
  it('a muted session on a PERMISSION PROMPT still shows waiting', () => {
    expect(dotState('waiting', true, undefined)).toBe('waiting')
  })
  it('a muted session that EXITED still shows exited', () => {
    expect(dotState('exited', true, undefined)).toBe('exited')
  })
  it("a 'finished' session shows the attention light, over any state and over a mute", () => {
    expect(dotState('idle', true, 'finished')).toBe('attention')
    expect(dotState('running', true, 'finished')).toBe('attention')
  })

  // ★★ THE REGRESSION THIS PAIR EXISTS FOR — caught in review, not by these tests, which is
  // why they are here now. When the third argument was a BOOLEAN meaning "any attention
  // reason", a session sitting on a permission prompt took the 'attention' arm: a red pulse
  // titled "Finished — needs your attention". It had not finished. The reason has to survive
  // the call for the dot to be able to say something true.
  it("a 'blocked' session shows WAITING, never the finished light", () => {
    expect(dotState('waiting', false, 'blocked')).toBe('waiting')
    expect(dotState('waiting', true, 'blocked')).toBe('waiting')
  })
  // …and the hazard from the other direction: 'blocked' outranks a stale idle report, so the
  // dot is LIT rather than dark. This is the reachable reducer state pinned by L3 in
  // scratchpad/session-reducer-test.mts — a plain list reporting the session idle while the
  // attention entry still says blocked.
  it("a MUTED session reported idle while still 'blocked' is not dark", () => {
    expect(dotState('idle', true, 'blocked')).toBe('waiting')
  })

  it('only a quiet dot offers the mute control', () => {
    expect(isMuteable('idle')).toBe(true)
    expect(isMuteable('muted')).toBe(true)
    for (const d of ['running', 'waiting', 'exited', 'attention'] as const) {
      expect(isMuteable(d)).toBe(false)
    }
  })
})

// ★★ THE WIRING — the one safety-critical line that had no test at any layer. ★★
// Nothing in the repo imports App.tsx, so while this lookup lived inline at the SessionRow
// call site it could be swapped back to `attention.get(id) === 'finished'` with the reducer
// harness still 102/102, the web suite still 46/46 and typecheck still clean — and a dark dot
// back on a blocked session. These pin the lookup itself.
describe('dotStateFor — the map lookup, where the regression actually lived', () => {
  const S = (id: string, state: SessionState) => ({ id, state })
  it('reads THIS session reason, not another one', () => {
    const att = new Map<string, AttentionReason>([['other', 'finished']])
    expect(dotStateFor(S('mine', 'idle'), true, att)).toBe('muted')
    expect(dotStateFor(S('other', 'idle'), true, att)).toBe('attention')
  })
  it("a 'blocked' entry at state idle does not yield 'muted'", () => {
    const att = new Map<string, AttentionReason>([['a', 'blocked']])
    expect(dotStateFor(S('a', 'idle'), true, att)).toBe('waiting')
  })
  it("a 'blocked' entry at state waiting is not the finished light", () => {
    const att = new Map<string, AttentionReason>([['a', 'blocked']])
    expect(dotStateFor(S('a', 'waiting'), false, att)).toBe('waiting')
  })
  it('no entry at all leaves the mute intact', () => {
    expect(dotStateFor(S('a', 'idle'), true, new Map())).toBe('muted')
  })
})

describe('clearMutes — what counts as a new interaction', () => {
  const att = new Map<string, string>()
  it('a session still idle stays muted', () => {
    const m = new Set(['a'])
    expect([...clearMutes(m, [{ id: 'a', state: 'idle' }], att)]).toEqual(['a'])
  })
  it('running, waiting and exited each clear the mute', () => {
    for (const state of ['running', 'waiting', 'exited'] as const) {
      expect([...clearMutes(new Set(['a']), [{ id: 'a', state }], att)]).toEqual([])
    }
  })
  it('an attention flag clears the mute even while idle', () => {
    const flagged = new Map([['a', 'finished']])
    expect([...clearMutes(new Set(['a']), [{ id: 'a', state: 'idle' }], flagged)]).toEqual([])
  })
  // REFRAMED 2026-09-04. This used to read "a session that no longer exists is dropped" and
  // passed `[]` as the session list — which is ALSO the boot condition, before the list has
  // loaded. Same inputs, two opposite meanings, and the test named only the harmless one, so
  // it blessed the bug that erased the persisted store on every page load. The list is
  // non-empty here so the two situations cannot be conflated: 'gone' is absent from a list
  // that demonstrably arrived. The unloaded case is not clearMutes' to answer at all — it is
  // pinned against pruneMutes below, which is the only layer that can tell them apart.
  it('a session missing from a POPULATED list is dropped', () => {
    expect([...clearMutes(new Set(['gone']), [{ id: 'other', state: 'idle' }], att)]).toEqual([])
  })
  it('it clears only the session that moved', () => {
    const out = clearMutes(new Set(['a', 'b']), [{ id: 'a', state: 'running' }, { id: 'b', state: 'idle' }], att)
    expect([...out]).toEqual(['b'])
  })
  // Identity, not equality: the caller runs this inside a setState in an effect keyed on
  // [sessions, attention]. A new Set every pass would re-render forever.
  it('returns the SAME reference when nothing changed', () => {
    const m = new Set(['a'])
    expect(clearMutes(m, [{ id: 'a', state: 'idle' }], att)).toBe(m)
    const empty = new Set<string>()
    expect(clearMutes(empty, [], att)).toBe(empty)
  })
})

describe('busyKernelCount', () => {
  const of = (map: Record<string, KernelStatus>) => (id: string) => map[id] ?? 'none'
  it('counts busy kernels', () => {
    expect(busyKernelCount(['n1', 'n2'], of({ n1: 'busy', n2: 'idle' }))).toBe(1)
  })
  it('counts STARTING as working — the user cannot run a cell yet', () => {
    expect(busyKernelCount(['n1'], of({ n1: 'starting' }))).toBe(1)
  })
  it('idle, dead, none and unknown ids are not activity', () => {
    expect(busyKernelCount(['a', 'b', 'c', 'd'], of({ a: 'idle', b: 'dead', c: 'none' }))).toBe(0)
  })
  it('counts only THIS session notebooks, not every open one', () => {
    expect(busyKernelCount(['mine'], of({ mine: 'idle', theirs: 'busy' }))).toBe(0)
  })
})

// ★★ THE CALL-SITE LAYER — where the reload bug actually lived. ★★
// The session list arrives asynchronously, so at mount `sessions` is `[]`. clearMutes cannot
// tell that from a loaded-and-empty server, and it should not try: the caller owns the
// precondition. These pin that it does. The FIRST test is the one that would have caught the
// shipped bug, and it asserts a NEGATIVE — that nothing was written — which is why `save` is
// injected rather than reaching for localStorage.
//
// MUTATIONS (measured 2026-09-04):
//   M12 pruneMutes: delete the `if (!args.listLoaded) return args.muted` guard
//       → "does not touch the store before the list has loaded" reds on BOTH its assertions
//         (a write happened, and the set was emptied). Every other test in this file stays
//         green — including the whole clearMutes block, which is the proof that the unit
//         layer structurally cannot see this class of defect.
//   M13 pruneMutes: `if (next === args.muted) return args.muted` → always save
//       → "does not write when nothing changed" reds alone.
//   M14 pruneMutes: gate on `args.sessions.length > 0` instead of `listLoaded`
//       → "prunes a closed session even when the server now reports none" reds. That is the
//         tempting wrong fix: it looks like it solves the boot case, and it silently breaks
//         pruning for a server whose last session was just closed.
describe('pruneMutes — the boot case that erased the store', () => {
  const att = new Map<string, string>()

  it('does not touch the store before the list has loaded', () => {
    const saved: string[][] = []
    const muted = new Set(['sess-A', 'sess-B'])
    const out = pruneMutes({ muted, sessions: [], attention: att, listLoaded: false, save: (ids) => saved.push(ids) })
    expect(saved).toEqual([])        // nothing written — the assertion that would have caught it
    expect(out).toBe(muted)          // and the caller's setState is a no-op
  })

  it('prunes and persists once the list has arrived', () => {
    const saved: string[][] = []
    const out = pruneMutes({
      muted: new Set(['a', 'b']),
      sessions: [{ id: 'b', state: 'idle' }],
      attention: att, listLoaded: true, save: (ids) => saved.push(ids),
    })
    expect([...out]).toEqual(['b'])
    expect(saved).toEqual([['b']])
  })

  // The distinction the guard has to make: a server that really has no sessions must still
  // prune. Gating on `sessions.length > 0` would pass the boot test and break this one.
  it('prunes a closed session even when the server now reports none', () => {
    const saved: string[][] = []
    const out = pruneMutes({ muted: new Set(['a']), sessions: [], attention: att, listLoaded: true, save: (ids) => saved.push(ids) })
    expect([...out]).toEqual([])
    expect(saved).toEqual([[]])
  })

  it('does not write when nothing changed', () => {
    const saved: string[][] = []
    const muted = new Set(['a'])
    const out = pruneMutes({ muted, sessions: [{ id: 'a', state: 'idle' }], attention: att, listLoaded: true, save: (ids) => saved.push(ids) })
    expect(saved).toEqual([])
    expect(out).toBe(muted)
  })
})
