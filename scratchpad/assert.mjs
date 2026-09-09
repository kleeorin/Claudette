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
// ── ★★ DO NOT ENUMERATE A POPULATION THAT WILL GROW — COUNT IT, OR QUERY IT ★★ ────────────
// The organising idea for the two blocks below, which are its consequences. It is stated
// first because it arrived LAST: three separate problems in this repo were each solved, and
// only afterwards did anyone notice they were one solution. Reading it in that order costs a
// week.
//
// The three arrivals, deliberately from unrelated parts of the codebase:
//   · "does the environment panel expose an editable control?" — the assertion COUNTS
//     `input, select, textarea` inside it and requires zero. Naming the three inputs it
//     happens to contain today would pass the moment someone adds a fourth kind.
//   · "is this settings control locked by an env var?" — driven off the `overrides` array the
//     SERVER sends, never a list of keys in the client. A client-side list is correct the day
//     it is written and silently wrong the first time a variable is added server-side, and
//     the symptom is an ENABLED CONTROL THAT DOES NOTHING.
//   · "did my assertions actually run?" — a floor on the COUNT executed, not a list of the
//     ones you remember writing. See the block below.
//
//   · "can a confined session drive a browser?" — asked of an enumeration of paths that
//     APPEAR to exist (/usr/bin/google-chrome and friends, unreachable from a box) rather
//     than of run-suite.sh, which knows where the bundled Chrome is because it uses it. The
//     answer was yes all along; the enumeration said no for a week.
//
//   · "did the screenshot capture anything?" — a headless probe exited 0 and wrote a PNG.
//     The PNG was a 417-byte BLANK: the fixture put `#4a3` in a `data:` URL, where `#` starts
//     the fragment, so the stylesheet never reached the page. Clean exit, file present,
//     content empty; the real render was 3443 bytes. THE COMMAND SUCCEEDING IS A PROXY, THE
//     ARTEFACT HAVING CONTENT IS THE PROPERTY — and a blank screenshot is exactly as green as
//     a correct one. Assert a positive property of the OUTPUT: a byte floor, a pixel sample, a
//     text probe through CDP. Never the exit code, never the file existing.
//   · "is the bundle stale?" — `run-suite.sh` answers by MTIME, so a COMMENT-ONLY edit to a
//     source file flips its banner to NO SIGNAL while the bundle's behaviour is unchanged
//     (measured 2026-09-09: banner NO SIGNAL, yet every behavioural token from that file was
//     present in the built asset). Mtime is the proxy; CONTENT is the property. The right
//     check is the one that rebuild used — grep the bundle for a string unique to the change —
//     and the banner is a cheap prompt to run it, not a verdict. Do not read NO SIGNAL as
//     "stale", nor a fresh timestamp as "contains your change".
//
// ★ THAT LAST ONE IS A STALE BELIEF RATHER THAN A STALE LIST, AND IT IS THE WORST KIND.
// A list in code can be grepped. A relayed constraint cannot: it arrives as background rather
// than as a claim, so it is never the thing under examination. Both halves are worth naming
// because neither was carelessness — one person asserted a limit they had not queried, and
// the other adopted it without checking it against work they had ALREADY DONE (they had
// driven that very binary hours earlier, and went on repeating the limit because it had been
// handed to them). A RELAYED CONSTRAINT IS AN ENUMERATION TOO, WITH THE SAME SILENT EXPIRY.
//
// ★ AND A RELAYED CONSTRAINT MAKES YOU STOP READING THE EVIDENCE AGAINST IT. `run-suite.sh`
// printed `prereqs: chrome=yes` on every run for the whole week the team believed no browser
// existed. The refutation was in the output of a command everyone ran, and nobody read it,
// because nobody was looking for a fact they already believed they had. That is the second,
// nastier half of the failure: the belief does not merely go unchecked, it makes contrary
// evidence unreadable.
//
// The countermeasure is the same as for the others: when someone hands you a limit, ask what
// would have to be true for it to be false, and whether you can QUERY that rather than accept
// the list. "No browser exists here" is falsified by one `readlink -f` and one `--version`.
//
// ★ THE SHAPE: every one of these is a question about a set whose membership changes without
// the asking code being touched. Name the members and you have written down a fact with an
// expiry date, and — the part that matters — its expiry is SILENT. A stale enumeration does
// not throw; it agrees with you about the members it knows and says nothing about the rest.
// Counting or querying the population instead makes the check correct for members that do not
// exist yet, which is the only kind of correctness worth having in a growing file.
//
// The inverse is the tell: if you are about to write a list of things to check FOR, ask what
// happens when someone adds the fourth. If the answer is "the check passes and nobody finds
// out", you want a count or a query.
//
// Its two consequences follow — the first is this rule applied to whether a check RAN, the
// second to whether it is looking in the right PLACE.
//
// ★ WHY THESE ARE IN A FILE RATHER THAN IN ANYONE'S HEAD.
// Every rule above was written by someone who then walked past an instance of it. The author
// of the population rule left an importer count in this very header and did not notice — it
// went only because an unrelated restructure happened to remove the sentence, and somebody
// else spotted it. The author of the executed-count rule had recorded seven mutation results
// without executed counts. Neither lapse was carelessness; both were the ordinary condition of
// holding a rule in mind while working on something else.
//
// So this file is the ENFORCEMENT MECHANISM, not a summary of everyone's good habits. Read it
// when you are about to write a check, not when you already suspect one is wrong — by then the
// green run has already told you what you wanted to hear.
//
// Corollary, from the count above: WHEN THE THING COUNTED KEEPS RISING, REMOVE THE COUNT
// RATHER THAN CORRECTING IT. A number in prose is an enumeration of size one, with the same
// silent expiry as any other.
//
// ── ★★ CONSEQUENCE 1: AN UNEXECUTED CHECK REPORTS SUCCESS ★★ ─────────────────────────────
// The population rule applied to the assertions themselves. This repo hit it at two different
// scopes inside a single week and wrote it down twice as separate habits before noticing.
//
// `check` counts failures. Nothing that counts failures can tell "this passed" from "this
// never ran": both produce zero. `fail === 0` is satisfied most easily by never checking
// anything at all. So every layer that reports a verdict needs a POSITIVE floor on what was
// EXECUTED, not merely an absence of red:
//
//   · THE SUITE SCOPE — assertions that quietly stop running between commits. A harness whose
//     body no longer executes prints `0/0 passed` and exits 0, which reads GREEN in the
//     table. Countered by a floor: MIN_ASSERTIONS in session-reducer-test.mts, MIN_TESTS and
//     MIN_TEST_FILES in web-vitest-shim.mjs. Raise them when you add coverage; a quietly
//     lowered floor and a deleted assertion are indistinguishable from downstream.
//   · THE MUTATION SCOPE — a mutant that never ran. A mutated copy with a syntax error (a
//     stray bracket, a shell-escaping accident) crashes before the first assertion, so the
//     run yields zero failures exactly as a clean pass does. Measured 2026-09-08:
//         clean control  → exit 0, failures 0, totals "12/12 passed"
//         crashed mutant → exit 1, failures 0, totals "?"
//     Identical failure counts; only the executed count separates them. Print `ran=N` beside
//     every mutation result. The dangerous direction is not the mutation you expect to red —
//     a crash there reads as "vacuous assertion" and you go chasing it, which self-corrects.
//     It is the CONTROL you expect to stay green, where a crash reads as a passing control,
//     silently, with nothing to chase — and a control's entire job is to prove the harness
//     still works.
//
// COROLLARY, and it is the more general lesson: prefer a check that cannot be fooled BY ITS
// SHAPE over one that is correct by diligence. The XX controls in this repo's mutation
// runners are immune to the crash above not because anyone was careful, but because they
// `return` on a pattern miss before any process starts — there is nothing to crash and no
// green to fake. When unfalsifiable-by-construction is available, take it over
// correct-by-attention every time.
//
// ── ★★ CONSEQUENCE 2: A CHECK THAT RUNS CAN STILL CHECK THE WRONG THING ★★ ───────────────
// Consequence 1 answers "how do I know my assertion ran?". This answers the next question,
// "how do I know it is looking at the right place?" — and that one has now bitten seven times
// in this repo, in three shapes that look like three different bugs and are one.
//
// ★ THE GENERAL FORM, and it is worth preferring to "test behaviour, not implementation"
// because it names WHERE TO PUT THE PROBE rather than only what to avoid:
//
//     AN ASSERTION MUST SIT ON WHAT THE CALLER RECEIVES, NOT ON AN INPUT THE
//     IMPLEMENTATION HAPPENS TO READ.
//
// Every instance below is a probe placed somewhere the defect does not have to pass through.
//
//   1. THE OMITTED KEY — a fixture that cannot exercise the rule it names.
//      An omit-means-keep merge was pinned by a fixture that left the key OUT. Spreading an
//      object without a key preserves the old value by accident, so the assertion stayed
//      green with the guard deleted: the input could not reach the state under test. The
//      fixture has to be PRESENT-AND-UNDEFINED, which is the case the rule is actually about.
//      Same family as a seeded value too small to clip and a prompt containing its own
//      expected answer — see turn-indicator.mjs and real-turn-browser-test.mjs.
//
//   2. THE WRONG BRANCH — the mutation targets a path the test never takes.
//      This one is dangerous because it MIMICS a vacuous assertion perfectly: no failures,
//      nothing to read. It is usually the mutation that is broken, not the test. Only the
//      executed count tells you which — see the section above, and note that two instances
//      were diagnosed correctly ONLY because `ran=N` was printed.
//
//   3. THE WRONG SIDE OF THE FUNCTION — asserting on the input rather than the output.
//      An assertion inspected a constant (`BUILTIN_SCOPES.gcalendar`) while the mutation it
//      was cited for changed the function that reads it (`scopesFor()`). The constant is
//      untouched by that edit, so the assertion was green and the mutation undetected — and
//      it read as a perfectly good test, because it asserted something true.
//
// ★ HOW ALL SEVEN WERE FOUND: by RUNNING mutations, never by reading assertions. Every one of
// these is invisible to review — each asserts something true, about a real value, in a test
// that passes. What exposes them is an edit that SHOULD have turned the assertion red and did
// not. If you have not watched a check fail, you do not know what it checks.
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

// ── WRITING THE DETAIL, AND THE ONE WAY IT GOES WRONG ────────────────────────────────────
// `extra` is appended after an em dash. A bare STRING prints on BOTH paths:
//
//     check('rows re-fit', kb.rows < rest.rows, `rows ${a} → ${b}`)
//        ✅ rows re-fit — rows 30 → 16          ❌ rows re-fit — rows 30 → 30
//
// That is right for a MEASUREMENT, which is what the detail almost always is, and it is why
// the default was left alone. Green detail is not decoration: `0 of 4 rendered` is how a
// divider check is known to be non-vacuous, `401` is how an auth test shows it really saw a
// 401 rather than skipping, and `dock 600px of a saved 600px` is how an at-rest control
// proves a bound is conditional rather than a blanket shrink.
//
// IT GOES WRONG when the string is phrased as an EXPLANATION OF THE FAILURE, because it then
// appears beside ✅ asserting the opposite of what happened:
//
//     ✅ mid-browse, the restore DECLINES — it wrote into a box the user is browsing with
//
// Nothing is wrong; the line says something is. It is read on the day it goes red, when it
// will still be wrong. Three real instances, all one author's, all caught only by re-reading
// the actual output — knowing about the trap never once prevented writing it.
//
// So pass an OBJECT when the two genuinely differ:
//
//     check('the restore declines mid-browse', box === '',
//           { pass: 'box still empty', fail: `box holds ${JSON.stringify(box)} — it wrote into a box the user is browsing with` })
//
// ── WHY THE DEFAULT IS NOT "FAIL-ONLY", WHICH WAS PROPOSED AND REJECTED ───────────────────
// The obvious stronger fix is to make `extra` print only on failure, so a single string
// cannot lie. It was designed, adopted, and then withdrawn ON THE NUMBERS — recorded here so
// it is not re-proposed from the same three anecdotes in six months:
//
//     490 of ~1,090 green lines in the corpus carry detail        (42%)
//      11 of those 490 match a failure-phrasing keyword grep
//       0 of those 11 are actually lies — every one is a factual statement of what was
//         measured (`openPath stores resolve(path), never realpath`, `it does not guess`)
//
// So the trade was: silence ~490 informative lines, or take a 490-line restoration sweep, to
// close a class with NO live occurrences. The rule had been inferred from three self-observed
// cases and was about to be applied to ~1,264 call sites.
//
// *** THE COMPARISON THAT DECIDES IT, because the guard above ALSO had zero live instances: ***
// the argument-order footgun had none either — but its fix was FREE. A runtime check, no
// output change, no sweep, and 82 files became structurally safe. This one would have cost
// the evidence a green run provides. **Zero live instances is not an argument against a fix;
// it is an argument against a fix that COSTS something.** Weigh the cost before the elegance.
//
// ── AN ASIDE THAT IS NOT ABOUT ASSERTIONS, PUT HERE BECAUSE THIS IS THE FILE EVERY HARNESS
//    AUTHOR NOW OPENS ─────────────────────────────────────────────────────────────────────
// `pgrep -f run-suite.sh` and `pkill -f run-suite.sh` MATCH THEIR OWN COMMAND LINE. Two people
// hit this in one week: one saw a phantom survivor after killing a run, the other killed their
// own shell mid-command. Use the bracket form, which cannot match itself:
//
//     ps -eo pid,args | grep -c "[r]un-suite.sh"
//
// AND THE CAVEAT THAT MATTERS MORE: this session runs under `--unshare-pid`, so a process
// check is only ever evidence about THIS sandbox. It can never tell you whether another
// session is running something. Same family as `/tmp` looking shared while being per-session,
// and as a lock reporting "no run in flight" while another session held one: an instrument
// answering a different question than the one asked.

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
 * @param extra detail appended after an em dash. A STRING prints on both the pass and the
 *              fail path. An OBJECT `{ pass, fail }` prints whichever applies — use it when
 *              the two genuinely differ, and omit either key to print nothing on that path.
 * @param tag   optional marker; `'open'` counts separately and prints ⚠️ instead of ❌,
 *              for a defect that is MEASURED and deliberately not fixed, so the suite stays
 *              green while the finding stays visible.
 */
const HOUSE = { pass: '✅', fail: '❌', open: '⚠️ ', gap: ' ', indent: '', sep: ' — ' }

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
  // A bare string prints on BOTH paths, byte-identically to before. An object is the opt-in
  // for when the two genuinely differ — see "WRITING THE DETAIL" in the header.
  const detail = extra && typeof extra === 'object' ? (cond ? extra.pass : extra.fail) : extra
  console.log(`${marks.indent ?? ''}${mark}${marks.gap ?? ' '}${tag ? `[${tag}] ` : ''}${name}${detail ? (marks.sep ?? ' — ') + detail : ''}`)
}

/**
 * Record one assertion.
 *
 * @param name  what is being asserted — MUST be a string (rule 1)
 * @param cond  whether it holds — must NOT be a string (rule 2)
 * @param extra detail appended after an em dash. A STRING prints on both the pass and the
 *              fail path. An OBJECT `{ pass, fail }` prints whichever applies — use it when
 *              the two genuinely differ, and omit either key to print nothing on that path.
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
// `gap`, `indent` and `sep` all exist for the same reason: harnesses differ in the spacing
// around the mark, before the line, and before the em dash — five of them write `  — ` with two
// spaces. Preserved rather than tidied, so their output stays byte-identical and the diff that
// verifies this refactor stays readable rather than drowning in whitespace churn.
export function withMarks(marks) {
  return (name, cond, extra = '', tag = '') => record({ ...HOUSE, ...marks }, name, cond, extra, tag)
}
