# DESIGN: the viewOf precondition + the ordering fault

Authored by Architect (planner role: Read/Grep/Glob only, no Write/Bash), relayed and
persisted by the coordinator 2026-08-23. Architect explicitly declined to spawn a
Write-capable subagent to save this itself, on the grounds that the read-only -> general
hop is an OPERATOR-VISIBLE choice and not something a session should do silently to route
around its own charter. That judgement is correct and is recorded here deliberately.

**Blocks A2. Nothing may import `boxCanReach` or `overlayPathFor` until (i) and (ii) below
have both landed.**

---

## SEQUENCING — the whole point, and it is the opposite of obvious

    (i)  extract `resolveReach` + fix `boxCanReach` to box-space;
         flip mount-shadowing-guard.mts section 4 true->false IN THE SAME COMMIT
    (ii) add `refusal` to viewOf + brand `MountView`; add section 5
    (iii) THEN A2

**Doing (ii) before (i) silently voids the only proof we have for (i).** Worked through on
the real fixture, pair `M1={logical:/a, real:/x}`, `M2={logical:/a/b, real:/y}`, host path
`/x/b/f`:

- **Today (unfiltered):** boxCanReach matches `/x/b/f` inside `M1.real` -> TRUE. That is the
  fail-open; section 4 records it as `true`.
- **After the ordering fix (box-space):** via M1, boxPath = `/a/b/f`, overmounted by M2 whose
  logical `/a/b` is deeper -> discard M1. Via M2, `/x/b/f` is not under `/y` -> no match.
  Result FALSE. Section 4 flips true->false. Clean fails-first proof.
- **If the precondition goes first:** viewOf refuses M2, only M1 participates, `/x/b/f` IS
  genuinely reachable through `/a` -> TRUE, **which is now the CORRECT answer.** Section 4
  stays green while its reason changes completely. That is passing-for-the-wrong-reason, and
  it would destroy the only fails-first evidence for the ordering fault.

Precondition-first also makes the ordering test unwritable: once viewOf always refuses, there
is no way to hand the algorithm a shadowing pair. Fix that regardless, shipping with (i):

    export function resolveReach(entries: ResolvedMount[], target: RealPath): ResolvedMount | undefined

so a test can construct the pair by hand without going through viewOf.

> **GENERAL PRINCIPLE WORTH KEEPING: the ENFORCEMENT boundary and the TESTABILITY boundary
> must be DIFFERENT FUNCTIONS.** `viewOf` enforces (closed constructor); `resolveReach`
> computes (open, pure, testable).

Both must land before A2. Neither alone suffices: the ordering fix without the precondition
leaves viewOf constructible from unrefused input; the precondition without the ordering fix
leaves boxCanReach wrong for any input that legitimately contains a nested pair.

---

## Q1. WHAT MARKING MEANS — the brand goes on the VIEW, not the MOUNT

**(1) ADDITIVE — marking is a field:**

    export interface ResolvedMount {
      mode: 'rw' | 'ro'
      logical: LogicalPath
      real: RealPath | null
      exists: boolean
      symlinked: boolean
      refusal?: RefusalReason      // NEW - present => this mount is NOT part of the box
    }

Refused entries STAY IN `entries`, carrying their reason. Every predicate skips entries with
a refusal, exactly as they already skip `!m.exists`.

**(2) ENFORCING — brand the VIEW:**

    export interface MountView {
      readonly __refusalApplied: unique symbol   // no value can supply this
      entries: ResolvedMount[]
    }

`viewOf` becomes the ONLY way to obtain a `MountView`, and it ALWAYS applies the refusal. The
precondition stops being a rule anyone can violate: there is no unfiltered path to construct.

**Why NOT a third brand on mounts (`SafeMount` vs `RefusedMount`)** — it would work, but it
solves the wrong unit. **The precondition's unit is the VIEW, not the MOUNT.** A mount-level
brand enforces "only refused mounts go into a view"; it does not stop someone assembling a
`MountView` object literal directly, so you would still need the view branded — at which point
the mount brand is redundant. Also: TS brands are erased at runtime, so a mount brand buys
nothing a view brand does not; and a mount brand FIGHTS the marking requirement, because a
`RefusedMount` excluded by type cannot sit in the same array as the safe ones, which is
precisely where we want it so it stays visible.

**Implementation inside viewOf, two passes:**

- pass 1: resolve every mount as today (logical/real/exists/symlinked).
- pass 2: `rwRoots` = pass-1 entries with `mode==='rw' && exists`, by LOGICAL path. For each
  symlinked entry, apply the same both-ways parent probe the live guard uses
  (`sandbox.ts:501-524`): refuse if EITHER the logical parent OR the realpath'd parent is
  under an rwRoot. Set `refusal` rather than removing the entry.

> **FIDELITY REQUIREMENT THAT WILL BE GOT WRONG IF NOT STATED: viewOf must be handed the SAME
> mount set the live code refuses over.** `sessionDataMounts` computes rwRoots over the
> obligatory mounts (claudeConfigDir rw, `<cwd>/.claude` rw) PLUS `cfg.mounts`. A caller doing
> `viewOf(cfg.mounts)` gets a SMALLER rwRoots and therefore UNDER-REFUSES. The ro overlays are
> safe to include or omit (mode 'ro', contribute nothing to rwRoots); the obligatory rw mounts
> are NOT optional.

---

## Q2. WHY MARKING AND NOT DROPPING

A dropped mount makes boxCanReach UNDER-report reach, which fails CLOSED, which is safe — so
the real argument is elsewhere. Four reasons, increasing force:

1. **DIAGNOSIS.** The live refusal emits a `console.warn` (`sandbox.ts:521`) so the operator
   learns why a folder vanished. Dropping silently has no analogue: a session that lost a
   mount looks identical to one that never asked for it, and the operator sees "my folder
   isn't there" with nothing to act on.
2. **TESTABLE AGREEMENT.** The layer's purpose is that the authorizer and the emitted box
   agree. With marking you can assert "every mount the box binds appears UNREFUSED in the
   view, and every refused entry is bound nowhere". **You cannot test for the absence of
   something you deleted** — dropping makes the divergence check unwritable.
3. **STRONGEST: marking is what makes OVER-refusal detectable.** Invariant A3 declares that Q2
   over-approximates. A design that over-approximates and then DELETES THE EVIDENCE has no way
   to measure by how much. Not hypothetical: section 3 of `mount-shadowing-guard.mts` exists
   precisely because "refuse every symlinked mount" passes every positive test while breaking
   dotfiles farms. Dropping makes that failure mode invisible; marking makes it assertable.
4. **A CONCRETE PAYOFF THAT ALREADY EXISTS.** `sandboxSystemPrompt` (`sandbox.ts:608-651`)
   builds its mount list from `dedupeMounts([...cfg.mounts, ...obligatory])` with NO refusal
   filter — so TODAY a refused mount is still described to the session as available, and the
   session hunts for a folder it was told it has. Marking lets that be fixed without a second
   filter that can drift from the first.

---

## Q4. THE FAILS-FIRST PROOF

**Partly yes.** Section 4 IS the fails-first test for the ORDERING FAULT, and it is the
cleanest possible proof: the fix flips a recorded, measured `true` to `false`, expectation
flipping in the same commit. It was written for exactly this. **Do not let anyone flip it
without the algorithm.**

It is **NOT** a proof for the precondition — nothing currently tests that viewOf refuses
anything, because it does not. Extend `mount-shadowing-guard.mts` with a section 5:

    // 5. THE PRECONDITION ITSELF. Feed viewOf the nested pair directly. Before the fix, no
    //    entry carries a refusal - that IS the precondition being unenforced.
    const v = viewOf(nested.mounts)
    const inner = v.entries.find(e => e.logical === path.resolve(path.join(a, 'b')))
    check('viewOf MARKS the nested symlinked mount as refused', !!inner?.refusal)
    check('...and does NOT drop it (over-refusal must stay observable)', !!inner)
    check('boxCanReach SKIPS a refused entry', ...)
    // negative control, mirroring section 3: the dotfiles-farm mount must come back UNMARKED
    const farmView = viewOf([{ path: farm, mode: 'rw' }])
    check('a host-created symlinked mount is NOT marked refused', !farmView.entries[0].refusal)

The first two fail today. **The last is the one that stops "refuse everything" from passing.**

---

## Q5. THE MIGRATION CONSTRAINT — holds, more strongly than asked

The 10 sandbox tests import from `sandbox.ts` and assert on exported names and argv.
`sandboxPaths.ts` has **ZERO production importers**, and the only two files importing `viewOf`
are the guards (`sandbox-paths-test.mts`, `mount-shadowing-guard.mts`). Nothing in the emission
path calls it, so **argv is untouched by this change** — the constraint is not merely
respected, it is not even engaged.

- `ResolvedMount.refusal?` is ADDITIVE. No existing construction breaks.
- `MountView` gaining a brand field IS breaking for any hand-constructed view. Both guards were
  checked: `mount-shadowing-guard` uses `viewOf(nested.mounts)`, `sandbox-paths-test` uses a
  `view = (...mounts) => viewOf(mounts)` helper. NEITHER hand-constructs. Safe.

> **ARGUMENT FOR DOING IT NOW RATHER THAN INSIDE A2:** viewOf is "internal" in the only sense
> that matters — zero production importers — so **this is the cheapest moment its contract will
> ever be.** Changing it after A2 wires `sandboxPathAccess` to `boxCanReach` is a breaking
> change to live confinement code.

---

## STATUS OF THE GATE

**SHUT — but not for the reason that would make it safe.** The precondition is NOT enforced:
`sandboxPaths.ts:30-39` has no refusal step. `mount-shadowing-guard.mts` section 4 MEASURES the
resulting over-approximation as `true` today. Nothing is wired, so the fault is unreachable —
but the safety comes from having ZERO CALLERS, not from the precondition holding. **That is a
vacuous guarantee and it evaporates at the first import.** Do not let anyone touch a caller on
the strength of "the guard is green": the guard is green because nothing calls the function.

**A4 is the step that breaks a call-site-enforced precondition, and it breaks SILENTLY** —
`appSourceProtections`' input is not refused (`bwrapBaseArgs` filters inline at emission, AFTER
calling it), and a missing overlay looks identical to a mount that needed none. That is the
argument for putting the refusal INSIDE viewOf: it is the only version that does not depend on
whoever lands A4 remembering a rule written in a file they are not editing.
