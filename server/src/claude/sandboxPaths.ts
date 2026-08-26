// The one place that resolves a path, and the one place that answers a containment question.
// Once the migration completes, nothing else in sandbox.ts may call path.resolve,
// realpathSync or startsWith(path.sep) — that is invariant A1, and it is grep-checkable.
//
// HOW TO READ THIS HEADER.
// Sentences prefixed `STATUS:` are claims about what the tree currently does. They can rot
// without this file being edited, so they are marked to be grep-able and re-verifiable AS A
// SET in one pass. Everything unmarked is MECHANISM — why a thing must have the shape it has —
// and cannot rot.
// STATUS: 14 such claims follow this one. `grep -c 'STATUS:'` over the landed file reports 15 —
// this sentence is the DEFINITION and is excluded from the published figure, per this file's
// convention that a grep-counted marker publishes its own count. If the grep and this number ever
// disagree, a claim was added or removed without the SET being re-verified — re-verify all of
// them, not just the new one. Last re-counted 2026-08-26, after migration step (i).
// Code is cited BY FUNCTION NAME, not by line number. Every line reference in an earlier draft
// of this header went stale inside a single working session (a ~56-line insertion moved
// everything below it), and one STATUS claim shipped false because it was written before a fix
// landed and never revisited. A line number is an assertion whose truth-value changes without
// the file being edited — the exact defect this file exists to design against.
//
// WHY THIS EXISTS. sandbox.ts asked containment questions in SIX places, and each one
// independently chose a resolution policy for the TARGET and another for the MOUNT ROOTS.
// Three of them disagreed, and those three were the shell-injection finding and the two
// realpath-vs-logical findings. STATUS: all three are point-fixed in the tree. THIS FILE EXISTS
// BECAUSE POINT FIXES LEAVE THE DISAGREEMENT ITSELF IN PLACE. There are exactly TWO legitimate
// questions here and they need OPPOSITE policies, which is why mixing them is not a slip but
// the predictable result of nobody having written the two questions down:
//
//   Q1 REACH — "if the box performs an I/O at host path P, does it succeed?"
//      The kernel follows symlinks, so BOTH SIDES MUST BE REAL.   -> boxCanReach
//
//   Q2 PROVENANCE — "could a confined session have placed or redirected the thing at P?"
//      The TARGET MUST NOT BE REALPATH'D. A link the box planted at <cwd>/x is inside the rw
//      cwd LEXICALLY even though it points elsewhere; resolving it loses that fact AND opens
//      a TOCTOU window before the exec.              -> refuseIfBoxCouldHavePlaced
//
//   Q3 EMISSION — "where must a protective overlay be BOUND so the box actually hits it?"
//      = logicalMount + (target relative to realMount).            -> overlayPathFor
//
// HONEST PRICING, and this was accepted on this basis rather than despite it.
// STATUS: after the point fixes, this layer closes ZERO live holes. Its value is (a) the latent
// fourth instance below and (b) stopping the three fixed sites drifting apart again. It is a
// debt-and-drift argument, not an incident argument. Schedule it as refactoring, and do not let
// it be re-sold as security work.
//
// THE LATENT FOURTH INSTANCE — the single most valuable thing in this header.
// pathInWritableMount documents its logical-only contract correctly and is NOT the defect. What
// is undocumented is the CALLER CHAIN's obligation to hand it a LOGICAL target:
// notebookDocManager.openPath stores doc.path with resolve(), and dirname/join downstream in
// KernelManager.serverFor and jupyterManager.findNearestPython are lexical, so the pairing
// holds — by nothing more than habit. NOTHING DECLARES IT. Add one realpathSync to openPath,
// which reads like a hardening and is exactly what a security pass proposes, and with a
// symlinked project root the logical rw root no longer prefixes the real candidate, the guard
// returns false, and the planted interpreter executes on the HOST. Same irony as the shell
// finding: the mitigation is what creates the exposure.
// STATUS: pinned behaviourally by scratchpad/venv-probe-chain-guard.mts, which asserts that
// openPath stores a logical path and that the discovered interpreter is still recognised as
// box-placeable. If that guard is ever relaxed, brand pathInWritableMount's PARAMETER as
// LogicalPath instead — or the escape is back.
//
// WHY Q2 IS A REFUSAL AND NOT A BOOLEAN. The function OVER-approximates: it refuses whenever it
// cannot rule the box out. That makes `refusal !== undefined` safe by construction, AND makes
// `refusal === undefined` a SOUND negative — anything doubtful would already have been
// refused — so acting on the ABSENCE of a refusal is safe too. BOTH BRANCHES ARE SOUND, where
// `if (couldHavePlaced) grant()` would have read as a grant condition with nothing in the type
// objecting. Do not "simplify" this back to a predicate. Same move sessionConfinement.ts
// already makes twice, with `Confinement` and `Owner`.
//
// WHY Q3 EXISTS — AND WHY THE BOTH-WAYS PROBE IN overlayDestFor MUST NOT BE SIMPLIFIED AWAY.
// If the rw mount is ~/proj -> /srv/app and the app source is /srv/app/server, the box reaches
// that source at ~/proj/server, NOT at /srv/app/server. An --ro-bind emitted at the CANONICAL
// spelling therefore binds a path nothing else binds: it materializes an EMPTY directory inside
// the box while the real subtree stays writable through the mount. Detection fixed, protection
// absent — and it would LOOK fixed, which is the worst property a protection can have.
// STATUS: the live code already gets this right, and this paragraph exists so that it stays
// that way. overlayDestFor computes exactly logicalMount + (target relative to realMount),
// probing the mount root BOTH ways — logical and realpath'd — and appSourceProtections calls it
// per mount. Verified against the EMITTED ARGV on the layout above: the ro-bind dest is the
// box-visible /home/proj/server, and no argument containing /srv/app appears at all.
// overlayPathFor below is that same formula, extracted so it stops being re-derived per site.
// The mechanism is written down because the both-ways probe READS AS REDUNDANT to anyone who
// has not hit this: drop either spelling and the overlay lands somewhere the box never looks,
// silently and with no warning.
//
// THE REFUSAL TYPE.
//   export interface Refusal<Code extends string, Subject = string> {
//     code: Code
//     message: string      // human-readable, ready for the console.warn every site already emits
//     subject: Subject     // what it is about — a mount path here, a capability field elsewhere
//   }
//   export type RefusalReason = Refusal<'box-writable-mount', LogicalPath>
// Generic in Subject so the brand survives; a plain shared interface would flatten LogicalPath
// to string. The trust-boundary work's `widens()` returns the same shape and will reuse it.
// *** EXACTLY THREE FIELDS, AND IT DOES NOT GROW. If a second user needs a fourth field, that
// is the signal the unification was wrong and it should FORK, not accrete. *** Two users is
// thin justification for a generic; it is here only because the cost is two lines while this
// file has no production importers, and it will never be that cheap again.
//
// PRECONDITION ON viewOf — A2 MUST NOT PROCEED WITHOUT IT.
// The live code is safe from a whole class of bug BY ACCIDENT OF A WEAK TYPE: SandboxMount
// carries ONE path and bwrapBaseArgs emits `--bind m.path m.path`, so dest and source are the
// same string BY CONSTRUCTION and a mount whose real root differs from its dest is not
// expressible. ResolvedMount INTRODUCES EXACTLY THAT EXPRESSIVENESS. The accident that protects
// us today is removed by this file.
// Concretely: with M1={logical:/a, real:/x} and M2={logical:/a/b, real:/y}, the box sees /a/b
// as /y, so host path /x/b/f is SHADOWED AND UNREACHABLE — yet boxCanReach returns reachable,
// because /x/b/f is inside M1's real root. THAT FAILS OPEN: an out-of-band write authorized for
// a path the box itself cannot touch.
// STATUS: RESOLVED in migration step (i). mount-shadowing-guard.mts section 4 no longer records
// this reachability as `true` — it was REPLACED (not flipped) with hand-built ResolvedMount[]
// fixtures run against resolveReach, which resolves in box space and returns NO survivor for the
// shadowed path. The replacement needs no filesystem, and it had to happen in the same change as
// the extraction: once step (ii) refuses M2, /x/b/f becomes genuinely reachable through /a, so the
// old recorded `true` would have become the CORRECT answer and the fails-first evidence would have
// evaporated with nothing going red. STATUS: that mount pair is currently unreachable in production because
// isUnsafeSymlinkMount refuses it, and that refusal is STRUCTURAL rather than incidental: it
// probes the LOGICAL parent, and a nested mount's logical parent IS the outer rw mount, so the
// under-an-rwRoot test fires for every nested arrangement.
// SO THE INVARIANT IS: A MountView MAY ONLY EXIST WITH THE SYMLINK REFUSAL ALREADY APPLIED.
// Enforce it by construction, not by convention:
//   - `MountView` carries a brand field so it cannot be built as an object literal; viewOf is
//     its only constructor and viewOf ALWAYS applies the refusal.
//   - `MountView` exposes TWO arrays, not one: `active` (exists and not refused) and
//     `excluded` (each carrying its ExclusionReason). Predicates iterate `active` only.
//     STATUS: REVISED 2026-08-25, before this header was ever landed, so no landed version ever
//     said otherwise. The superseded form was `ResolvedMount.refusal?`, with predicates skipping
//     refused entries "exactly as they already skip `!exists`". Splitting rather than flagging is
//     deliberate: a `refusal?` field relies on ALL THREE predicates remembering to skip it, and
//     forgetting one is a SILENT FAIL-OPEN — the same shape as the A4 hazard, where a missing
//     overlay is indistinguishable from a mount that needed none. The split removes the
//     remembering: reaching a refused mount requires naming `excluded`, which is not something
//     you type without meaning it. It also folds in `exists`, the second thing every predicate
//     had to remember.
//     MARK, DO NOT DROP still holds, and `excluded` is how — invariant A3 declares that Q2
//     over-approximates, and a design that over-approximates and then deletes the evidence
//     cannot measure by how much. Dropping would also make "every mount the box binds appears in
//     `active`" untestable: you cannot assert the absence of something you deleted.
//     THE COST, NAMED RATHER THAN HIDDEN: this makes check #20's judgement call ("a non-existent
//     mount contributes nothing to provenance") STRUCTURAL rather than per-predicate, so
//     re-deriving it later — which #20 is explicitly flagged as a call to re-derive rather than
//     flip — becomes more work. Accepted because the silent-forget risk is live and the #20 risk
//     is hypothetical.
//   - THE SIGNATURE:
//       viewOf(mounts: SandboxMount[], session: { cfg: SandboxConfig; cwd: string }): MountView
//     TWO INPUTS ON PURPOSE. The mount set being VIEWED is legitimately caller-specific —
//     bwrapBaseArgs views the DNS and runtime-install baseline, sessionDataMounts deliberately
//     excludes it ("no user files there"), and that difference must survive. The rwRoots that
//     define the REFUSAL are NOT caller-specific: they take only mode==='rw', and the
//     DNS/runtime baseline and every appSourceProtections overlay are ro, so rwRoots is always
//     exactly the rw entries of obligatoryMounts(cwd) + cfg.mounts. Deriving it from `session`
//     makes under-refusal impossible without collapsing two sets that differ for good reason.
//     A caller may still be wrong about what it is VIEWING; it can no longer be wrong about
//     what is REFUSED, and only the second is a safety property.
//     IMPLEMENTATION TRAP: compute rwRoots AFTER dedupeMounts, which promotes ro→rw when the
//     same path appears both ways — otherwise a folder mounted both ways is missed.
// Until this is done, nothing may import boxCanReach or overlayPathFor. STATUS: nothing does;
// the gate is shut because there are ZERO CALLERS, not because the precondition holds. That
// guarantee is vacuous and evaporates at the first import.
//
// ORDERING FAULT — STATUS: FIXED in migration step (i). boxCanReach now delegates to
// resolveReach, which resolves in BOX SPACE and in which depth plays no part; viewOf's sort is
// retained and commented, because it is what produces the emission order the rule reads.
// An earlier draft of this line said "fix with A2". That was wrong in a way worth recording: it
// CONTRADICTED the MIGRATION section below, which assigns this to step (i) — before (ii) and
// (iii)/A2 — and "fix with A2" is the reading that defers the work indefinitely. The paragraph
// that follows describes the fault AS IT WAS, and is kept because the mechanism is why the shape
// is what it is. Note overlayPathFor still matches on entry.REAL, which remains correct: it
// answers Q3 (emission), not Q1 (reach).
// viewOf sorted by depth(entry.LOGICAL) while boxCanReach and overlayPathFor matched on
// entry.REAL. Precedence on one spelling, matching on another — the identical mismatch that
// exists between sortShallowFirst (which sorts on the raw path) and sandboxPathAccess (which
// matches on the canonicalized one). It was carried forward into the file meant to eliminate
// it. The two orderings are NOT interchangeable and conflating them is the error:
//   - NEITHER OF THEM IS ABOUT DEPTH, and an earlier draft of this header said otherwise. bwrap
//     applies binds in ARGV ORDER, and a bind covers its dest AND EVERYTHING BENEATH IT, so a
//     later bind covers an earlier one — INCLUDING AN EARLIER DEEPER ONE. Mounting /a after /a/b
//     covers /a/b. The owner of any box path is therefore simply the LAST entry in emission order
//     whose logical root contains it. DEPTH NEVER ENTERS.
//   - overlayPathFor: takes the last entry whose REAL root contains the target, which is correct
//     only because viewOf emits in argv order. It READS like "deepest wins" and is not.
//   - boxCanReach: needs the box-space algorithm — map the host path into box space
//     (boxPath = m.logical + target-relative-to-m.real), drop any mount that is not the OWNER of
//     its own boxPath, and grant if ANY survivor grants. Decide in box space, because that is
//     the space bwrap resolves in.
//     ANY-GRANTS, NOT LAST-WINS: two unrelated mountpoints can expose the same real bytes and
//     NEITHER shadows the other — both are live in the box at once — so "the last one decides"
//     silently denies a write the box CAN perform. STATUS: measured live against real bwrap —
//     the box wrote the file while sandboxPathAccess returned write:false, pinned by
//     scratchpad/authorizer-box-divergence-guard.mts. It fails CLOSED, so the symptom is an
//     inexplicable permission error on a legitimate write, NOT a breach; do not let a red there
//     be reported as a sandbox escape.
//   - viewOf's SORT MUST NOT BE DELETED once resolveReach stops mentioning depth. THE SORT IS
//     WHAT MAKES `entries` EQUAL bwrap's ARGV ORDER, and "last containing entry" is meaningful
//     only in that order — without it the rule is "last in some arbitrary order". It will look
//     like dead code to whoever reads resolveReach and finds no depth arithmetic. It is not.
// refuseIfBoxCouldHavePlaced is unaffected: it returns the FIRST match, so ordering changes
// only WHICH reason you get, never WHETHER you refuse.
// EXTRACT the box-space resolution as a pure function over ResolvedMount[] — e.g.
// resolveReach(entries, target) — so a test can construct a shadowing pair by hand without
// going through viewOf. THE ENFORCEMENT BOUNDARY AND THE TESTABILITY BOUNDARY MUST BE DIFFERENT
// FUNCTIONS: viewOf enforces via a closed constructor, resolveReach computes and stays open.
//
// NARROWER THAN THE LIVE CODE — A4 MUST NOT REGRESS THIS.
// overlayPathFor returns ONE dest. STATUS: the live appSourceProtections loops EVERY dataMount
// and emits an overlay per mount, deduped by dest, so two mountpoints exposing the same source
// dir correctly pin BOTH spellings. A4 must call overlayPathFor PER MOUNT, not once, or it
// silently drops a protection.
// STATUS: and note what appSourceProtections is HANDED — an UNREFUSED mount list at BOTH call
// sites. bwrapBaseArgs calls it before its own symlink filter loop, and sessionDataMounts calls
// it before its own filter too. So the A4 hazard is not a quirk of one code path; it is how the
// function is used everywhere. THIS IS THE STRONGEST ARGUMENT FOR THE REFUSAL LIVING INSIDE
// viewOf: a precondition enforced at call sites would be broken by A4 specifically, and broken
// SILENTLY, because a missing overlay is indistinguishable from a mount that needed none.
//
// OPEN, UNRESOLVED — a fail-open judgement call, which is the class that produced three of the
// four escapes. A mount whose path does NOT exist contributes nothing to provenance (asserted
// as check #20 in scratchpad/sandbox-paths-test.mts, "a non-existent mount cannot make anything
// box-placeable"). That is correct today because bwrap will not bind it. But if a caller ever
// asks about a path under a mount that is ABOUT TO BE CREATED, the answer is wrong AND FAILS
// OPEN. If that check ever looks inconvenient, re-derive it rather than flip it.
//
// MIGRATION. The enabling constraint — STATUS: the sandbox tests assert on EXPORTED NAMES and
// on ARGV, not internals. Keep every export's name and signature and change only bodies; for a
// non-symlinked layout the argv is byte-identical and they stay green untouched.
//   (i)   Fix the ORDERING FAULT first: extract resolveReach, move boxCanReach to box-space,
//         and REPLACE mount-shadowing-guard section 4 with hand-built ResolvedMount[] fixtures
//         run against resolveReach, IN THE SAME COMMIT — not merely flip its expectation. The
//         constructor-mediated version becomes MEANINGLESS once (ii) refuses M2, because `true`
//         then becomes the CORRECT answer and the evidence evaporates without anything going
//         red. Hand-built fixtures need no filesystem at all, which is a real simplification.
//         The replacement must include an ORDER-NOT-DEPTH case (a later shallower bind owning a
//         path an earlier deeper one would have claimed) and an ANY-GRANTS case (two unrelated
//         mounts over one tree, rw among them wins) — without the second, "return nothing when
//         unsure" passes the shadowing assertion and denies every legitimate write.
//   (ii)  Then the PRECONDITION: refusal inside viewOf, brand MountView, add the marking
//         assertions to that guard.
//   (iii) Then A2.
//   *** ORDER (i) BEFORE (ii) IS LOAD-BEARING. Doing the precondition first makes section 4
//   stay GREEN while its reason changes completely — once M2 is refused, /x/b/f becomes
//   genuinely reachable through /a, so the recorded `true` is then the CORRECT answer and the
//   only fails-first evidence for the ordering fault silently evaporates. ***
//   A2  sandboxPathAccess -> boxCanReach; pathInWritableMount -> !refuseIfBoxCouldHavePlaced;
//       pathVisibleInSandbox -> boxCanReach(..., 'read')
//   A3  isUnsafeSymlinkMount -> refuseIfBoxCouldHavePlaced(view, dirname(mount))
//   A4  appSourceProtections -> refuseIfBoxCouldHavePlaced + overlayPathFor, PER MOUNT
//   A5  wrapCommand takes an ABSOLUTE program path, so it stops calling which() on
//       caller-supplied input. which() itself STAYS — probe() needs its builtin detection (A4).
//   A6  the grep enforcing invariant A1
// Do NOT start the trust-boundary work before A2 lands: its mount-widening rule needs these
// containment semantics and has no defensible order without them.
//
// INVARIANTS.
//   A1  path.resolve / realpathSync / startsWith(path.sep) appear nowhere in sandbox.ts outside
//       this file. Grep-checkable. Note the grep must NOT include "no shell": `which` keeps one
//       on purpose (see A4), so a blanket shell grep is a permanent false positive and would
//       train A6's reader to ignore it.
//   A2  Exactly three predicates. A FOURTH QUESTION MEANS THE TAXONOMY IS WRONG and needs
//       revising, not patching.
//   A3  Q2 over-approximates, in the refusing direction only.
//   A4  No path string is INTERPOLATED into a shell command. `which` deliberately retains
//       `sh -c 'command -v -- "$1"'`: the shell stays because probe() depends on `command -v`
//       reporting a BUILTIN as a bare word, which a Node-side PATH walk cannot reproduce. The
//       path travels as a positional ARGUMENT, never as script text. INTERPOLATION is the
//       defect; a shell is not.
//   R1  resolveReach's `entries` are in bwrap EMISSION ORDER. *** THIS PRECONDITION CANNOT BE
//       CLOSED BY CONSTRUCTION *** — the order is genuine SEMANTIC INPUT, and sorting internally
//       would destroy the information, making the function unable to model the very case it
//       exists to model. Recorded honestly rather than pretended away: mitigate by NAMING the
//       parameter `entriesInEmissionOrder`, so the obligation sits at every call site, and by
//       keeping viewOf the only production producer.
//       FALSIFIER: a caller assembling entries some other way, or someone "helpfully" sorting
//       inside resolveReach.
//       ESCAPE: none. If this needs to change, the design is wrong, not the invariant.
//       CHECK: the order-not-depth fixture in mount-shadowing-guard — a later SHALLOWER bind
//       must own a path an earlier deeper one would have claimed. Every other fixture in that
//       file passes under the wrong (depth-based) rule, which is why this one exists.

import { existsSync, realpathSync } from 'fs'
import path from 'path'
import type { SandboxMount } from '@claudette/shared'

export type LogicalPath = string & { readonly __logical: unique symbol }
export type RealPath = string & { readonly __real: unique symbol }

export function logical(p: string): LogicalPath {
  return path.resolve(p) as LogicalPath
}

export function real(p: string): RealPath | null {
  const abs = path.resolve(p)
  try { return realpathSync(abs) as RealPath } catch { /* not present; try the parent */ }
  try {
    return path.join(realpathSync(path.dirname(abs)), path.basename(abs)) as RealPath
  } catch { return null }
}

export interface ResolvedMount {
  mode: 'rw' | 'ro'
  logical: LogicalPath
  real: RealPath | null
  exists: boolean
  symlinked: boolean
}

export interface MountView { entries: ResolvedMount[] }

export function viewOf(mounts: SandboxMount[]): MountView {
  const entries = mounts.map((m): ResolvedMount => {
    const lg = logical(m.path)
    const rl = real(m.path)
    return { mode: m.mode, logical: lg, real: rl, exists: existsSync(lg), symlinked: rl !== null && (rl as string) !== (lg as string) }
  })
  // *** THIS SORT MUST NOT BE DELETED. *** It is what makes `entries` equal bwrap's ARGV
  // ORDER, and resolveReach's "last containing entry wins" is meaningful ONLY in that order —
  // without it the rule degrades to "last in some arbitrary order". Now that resolveReach
  // contains no depth arithmetic this will read like dead code to the next person. It is not:
  // the depth here is not a precedence rule, it is how the emission order is PRODUCED.
  const depth = (p: string): number => { let n = 0; for (let i = 0; i < p.length; i++) if (p[i] === path.sep) n++; return n }
  entries.sort((a, b) => depth(a.logical) - depth(b.logical) || a.logical.localeCompare(b.logical))
  return { entries }
}

function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep)
}

// Which mounts actually expose `target` INSIDE THE BOX — the box-space resolution, pulled
// out as a pure function over ResolvedMount[] so a test can construct a shadowing pair by
// hand. THE ENFORCEMENT BOUNDARY AND THE TESTABILITY BOUNDARY ARE DELIBERATELY DIFFERENT
// FUNCTIONS: viewOf enforces (and will get a closed constructor in step (ii)); this computes
// and stays open. The order-not-depth case cannot be produced through viewOf at all — viewOf
// sorts shallow-first, so in production a deeper mount is always emitted later and depth and
// order coincide. That coincidence is exactly what hid this fault, and it is why the fixture
// proving it has to be hand-built.
//
// R1 — `entriesInEmissionOrder` IS SEMANTIC INPUT. The name carries the obligation to every
// call site. Do NOT sort inside this function: that would destroy the very information it
// exists to read, and make it unable to model the case it was written for.
//
// The rule, in two steps, and NEITHER of them is about depth:
//   1. OWNER. bwrap applies binds in argv order and a bind covers its dest AND everything
//      beneath it, so a later bind covers an earlier one INCLUDING AN EARLIER DEEPER ONE.
//      The owner of a box path is simply the LAST entry whose LOGICAL root contains it.
//   2. ANY-GRANTS, NOT LAST-WINS. Two unrelated mountpoints can expose the same real bytes
//      with neither shadowing the other — both are live in the box at once — so asking only
//      "the last one" silently denies a write the box CAN perform. Measured against real
//      bwrap: the box wrote the file while the old code returned write:false.
export function resolveReach(entriesInEmissionOrder: ResolvedMount[], target: RealPath): ResolvedMount[] {
  // A mount bwrap will not bind contributes nothing — it cannot expose and it cannot shadow.
  const live = entriesInEmissionOrder.filter((m) => m.exists && m.real !== null)
  const out: ResolvedMount[] = []
  for (const m of live) {
    if (!contains(m.real as string, target as string)) continue
    // Map the host path into box space through THIS mount.
    const rel = (target as string) === (m.real as string)
      ? ''
      : (target as string).slice((m.real as string).length + 1)
    const boxPath = rel ? path.join(m.logical, rel) : (m.logical as string)
    // Step 1: is this mount still the owner of its own box path, or has a later bind
    // covered it? Depth never enters — only position in emission order.
    let owner: ResolvedMount | undefined
    for (const c of live) if (contains(c.logical, boxPath)) owner = c
    if (owner === m) out.push(m)
  }
  return out
}

export function boxCanReach(view: MountView, p: string, need: 'read' | 'write'): boolean {
  const target = real(p)
  if (target === null) return false
  // Step 2: ANY survivor grants. Not "the last survivor decides".
  const reach = resolveReach(view.entries, target)
  return need === 'write' ? reach.some((m) => m.mode === 'rw') : reach.length > 0
}

export interface RefusalReason {
  code: 'box-writable-mount'
  message: string
  mount: LogicalPath
}

export function refuseIfBoxCouldHavePlaced(view: MountView, p: string): RefusalReason | undefined {
  const target = logical(p)
  for (const m of view.entries) {
    if (m.mode !== 'rw' || !m.exists) continue
    const viaLogical = contains(m.logical, target)
    const viaReal = m.real !== null && contains(m.real, target)
    if (!viaLogical && !viaReal) continue
    return {
      code: 'box-writable-mount',
      mount: m.logical,
      message: `${target} lies inside the box-writable mount ${m.logical}`
        + (m.symlinked && m.real ? ` (which binds ${m.real})` : ''),
    }
  }
  return undefined
}

export function overlayPathFor(view: MountView, target: RealPath): LogicalPath | null {
  let best: ResolvedMount | undefined
  for (const m of view.entries) {
    if (!m.exists || m.real === null) continue
    if (contains(m.real, target)) best = m
  }
  if (!best || best.real === null) return null
  if ((target as string) === (best.real as string)) return best.logical
  const rel = (target as string).slice((best.real as string).length + 1)
  return path.join(best.logical, rel) as LogicalPath
}
