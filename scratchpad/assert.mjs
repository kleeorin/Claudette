// THE ONE ASSERTION HELPER — and the argument-order guard that is the actual point of it.
//
//   import { check, failed as fail } from './assert.mjs'
//   check('the thing happened', cond, 'detail shown on the line')
//   process.exit(fail === 0 ? 0 : 1)
//
// WHY THIS EXISTS. Every harness in scratchpad/ used to define its own. A census found 84
// files doing it across SEVENTEEN mutually incompatible signatures, and — the part that
// matters — TWO OPPOSITE ARGUMENT ORDERS coexisting in one directory: `check(name, ok, …)`
// in 44 files against `check(ok, label, …)` in 7, plus an `eq()` that also exists both ways
// round.
//
// *** WHY THAT IS A FOOTGUN AND NOT MERELY UNTIDY. ***
// In a typed `.mts` harness, calling one order with the other is a compile error. In an
// UNTYPED `.mjs` harness — and run-suite.sh runs every `.mjs` under plain node, see its
// dispatch at `case "$f" in *.mts) npx tsx ;; *) node ;;` — it is not. A non-empty string
// lands in the condition slot, is truthy, and THE ASSERTION PASSES FOREVER. It never fails,
// never reports, and reads green in exactly the state it was written to catch.
//
// A survey found zero live instances of that today. Zero by luck is not zero by
// construction, and luck does not extend to files nobody has written yet. Hence:
//
// ── THE GUARD ────────────────────────────────────────────────────────────────────────────
// `check` REFUSES a call whose shape is wrong, at runtime, where `.mjs` can be reached and
// the type system cannot:
//
//   RULE 1 — the name slot must be a string. This is the one that catches a swap. Every
//   competing order in the census put a BOOLEAN where the name goes, so a wrongly-ordered
//   call cannot get past this line no matter which of the seventeen shapes it came from.
//
//   RULE 2 — the condition slot must not be a string. A swap trips rule 1 first, so this
//   catches the one-sided mistake instead: `check('found it', someText)`. That is a latent
//   bug on its own — it is truthy for "false" and for "0" — so it is worth a throw rather
//   than a pass. Pass `Boolean(x)` or `x.length > 0` and say which you meant.
//
// It throws rather than counting a failure ON PURPOSE. A miscounted failure is a result; a
// mis-shaped call is not a result at all, and printing ❌ for it would report a defect in
// the code under test that does not exist.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────────────────
// IT DOES NOT OWN THE EXIT CODE, and the 84 `process.exit(...)` lines are not an oversight.
// run-suite.sh gates suite members on containing a `process.exit(<expr>)` whose argument is
// not a bare numeric literal — it reads the argument TEXTUALLY, and it earns its keep: it
// caught two files this week whose only result-dependent exit was unreachable. A `finish()`
// that owned the exit would make 84 files opaque to that gate, and teaching the gate a new
// shape in the same change as an 84-file migration coupled a risky sweep to a modification
// of the very guard that would catch the sweep going wrong. So the counters are exported and
// the exits are left alone. `finish()` is a good idea LATER, as its own change, with the gate
// taught first and separately.
//
// The counters are exported as ESM live bindings, which is what makes that free: a harness
// writes `import { failed as fail }` and its existing `process.exit(fail === 0 ? 0 : 1)`
// keeps working, and keeps reading as the gate expects, without being touched. Verified under
// both plain node and tsx before anything was migrated onto it.

export let passed = 0
export let failed = 0
export let open = 0

// ── THE ARRAY SHAPE, for the harnesses that count with an array instead of a counter ──────
// Fourteen harnesses derive their exit from `results` rather than from a counter:
//   const passed = results.filter(Boolean).length
//   process.exit(passed === results.length ? 0 : 1)
// `results` holds ONE BOOLEAN per assertion, deliberately, and that choice is load-bearing.
//
// *** WHY NOT AN ARRAY OF {name, ok} OBJECTS, WHICH IS THE OBVIOUS CHOICE. ***
// Because `results.filter(Boolean)` is written in eleven of those files, and EVERY OBJECT IS
// TRUTHY. Unifying on objects would silently turn that line into "count them all", making
// `passed === results.length` permanently true and those eleven harnesses exit 0 forever —
// a silent always-green in browser tests nobody reads line by line. The single most
// dangerous edit available in this refactor, and it is avoided by keeping booleans rather
// than by remembering to rewrite eleven derivations correctly.
//
// The three harnesses that DID want objects only ever read `.length` off the filtered list,
// so they import `failures` instead and their exit lines are likewise untouched.
export const results = []
export const failures = []

/**
 * Record one assertion.
 *
 * @param name  what is being asserted — MUST be a string (rule 1)
 * @param cond  whether it holds — must NOT be a string (rule 2)
 * @param extra detail appended after an em dash
 * @param tag   optional marker; `'open'` counts separately and prints ⚠️ instead of ❌,
 *              for a defect that is MEASURED and deliberately not fixed, so the suite stays
 *              green while the finding stays visible.
 */
const HOUSE = { pass: '✅', fail: '❌', open: '⚠️ ', gap: ' ', indent: '' }

// The one place an assertion is recorded. `check` and any vocabulary from `withMarks` both
// come through here, so the guard, the counters, the array shape and the line format cannot
// drift apart between them.
function record(marks, name, cond, extra, tag) {
  if (typeof name !== 'string') {
    throw new TypeError(
      `check(): the first argument must be the assertion NAME (a string), got ${typeof name}. ` +
      `This is almost certainly a swapped argument order — the shape is check(name, cond, extra). ` +
      `Received: (${typeof name}, ${typeof cond}).`,
    )
  }
  if (typeof cond === 'string') {
    throw new TypeError(
      `check(${JSON.stringify(name)}): the second argument must be the CONDITION, not a string. ` +
      `A non-empty string is always truthy, so this assertion could never fail. ` +
      `Pass Boolean(x) or an explicit comparison such as x.length > 0.`,
    )
  }
  const isOpen = !cond && tag === 'open'
  if (cond) passed++
  else if (isOpen) open++
  else failed++
  results.push(Boolean(cond))
  if (!cond && !isOpen) failures.push({ name })
  // Byte-identical to the call sites this replaced, deliberately: the migration is verified by
  // diffing per-entry output, and a changed separator would bury a real difference under
  // hundreds of cosmetic ones.
  const mark = cond ? marks.pass : isOpen ? (marks.open ?? HOUSE.open) : marks.fail
  console.log(`${marks.indent ?? ''}${mark}${marks.gap ?? ' '}${tag ? `[${tag}] ` : ''}${name}${extra ? ' — ' + extra : ''}`)
}

/**
 * Record one assertion.
 *
 * @param name  what is being asserted — MUST be a string (rule 1)
 * @param cond  whether it holds — must NOT be a string (rule 2)
 * @param extra detail appended after an em dash
 * @param tag   optional marker; `'open'` counts separately and prints ⚠️ instead of ❌, for a
 *              defect that is MEASURED and deliberately not fixed, so the suite stays green
 *              while the finding stays visible.
 */
export function check(name, cond, extra = '', tag = '') {
  record(HOUSE, name, cond, extra, tag)
}

/** Reset the counters and the arrays. For a harness running several rounds in one process. */
export function reset() {
  passed = 0
  failed = 0
  open = 0
  results.length = 0
  failures.length = 0
}

// ── A DIFFERENT MARK VOCABULARY, kept explicit rather than normalised away ────────────────
// Two security harnesses print `✅ blocked` / `🚨 SUCCEEDED` instead of ✅ / ❌, because for
// them the mark IS the finding: the assertion is "the escape was refused", and a reader
// skimming a run must not see a bare ✅ where the file meant "blocked". Restyling them to the
// house marks would have been the quiet kind of behaviour change — output that still looks
// right and no longer says the same thing. So the vocabulary is a parameter, not a default,
// and each harness names its own at the point of use.
//
// `gap` exists because those two separate mark from name by TWO spaces, and `indent` because
// several harnesses indent the whole line by two. Both are preserved rather than tidied, so
// their output stays byte-identical and the diff that verifies this refactor stays readable.
export function withMarks(marks) {
  return (name, cond, extra = '', tag = '') => record({ ...HOUSE, ...marks }, name, cond, extra, tag)
}
