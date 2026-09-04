// The init-clobber decision, tested against synthetic sample sequences — no browser, no
// server, no API calls, ~5ms.
//
//   node scratchpad/turn-indicator-test.mjs
//
// WHY THIS EXISTS SEPARATELY FROM real-turn-browser-test.mjs. That harness needs the shared
// server, a live credential and real API calls, and it runtime-skips in any session whose CLI
// is not logged in — so the one assertion everyone actually argues about could only be
// exercised by spending money in one particular session. The DECISION is pure; only the
// sampling needs a browser. Extracting it means the logic can be mutation-tested for free and
// the live harness goes back to being what it is good at: producing the samples.
//
// TEST 2 IS THE POINT OF THIS FILE — it is the recorded 2026-08-24 failure, replayed. The old
// wall-clock rule went red on it while the indicator had been up for the entire turn; the
// turn-relative rule passes it, because both events it compares are events of the turn.
// ── MUTATION RECORD — measured 2026-09-02, restamped from a report that no longer matched ──
// Recorded HERE, in the file the mutations are run against, because until now this record
// existed only in a handover: a mutation record that lives somewhere other than its file is
// one nobody re-runs. Each mutation is applied to a COPY of turn-indicator.mjs outside the
// repo, from pristine each time, and the set includes an XX control that matches no text —
// an unmatched patch silently runs the UNMUTATED file and reads as "this cannot fail".
//
//   M1  `ok: lastStop >= firstAssistant,` → `ok: true,`
//       → test 3 red. 6/7, exit 1.
//   M2  "inverted comparison", `>=` → `<`. THERE ARE TWO COMPARISON SITES and the answer
//       depends entirely on which you touch — all three variants measured:
//         M2  both sites (the `ok:` site AND the `reason:` ternary)
//             → tests 1, 2, 3 AND 4 red. 3/7, exit 1.
//         M2a the `ok:` site only   → tests 1, 2, 3 AND 4 red. 3/7, exit 1.
//         M2b the `reason:` ternary only → tests 1 and 3 red. 5/7, exit 1.
//   M3  `if (firstAssistant === -1) return { ok: false, reason: 'no-assistant-sample'`
//       → `{ ok: true, reason: 'ok'`  → test 6 red. 6/7, exit 1.
//   XX  a patch matching nothing → REFUSED, as it must.
//
// ★ THE OLD RECORD SAID "tests 1 and 3", AND IT WAS RIGHT — for M2b, which it did not name.
// I recorded it as stale on the strength of running M2 (both sites), getting four reds, and
// concluding the record no longer described the file. Measuring M2a and M2b instead of
// arguing about them showed the record was never wrong; it was UNDERSPECIFIED. "Invert the
// comparison" names one edit and admits three, and two of the three disagree with it.
// That is the correction worth keeping, because it is the more common failure of the two: a
// mutation record is not a claim about a file, it is a claim about an EDIT TO a file, and an
// edit described loosely enough to have variants has no reproducible result. Name the site.
//
// ⚠ WHAT THIS MUTATION SET DOES NOT COVER, found by the live run on 2026-09-02 and left
// standing here deliberately until it is decided: every fixture below assumes `assistant` is
// FALSE in the early samples. The live harness produces `assistant: true` from sample 0, and
// on that shape `lastStop >= firstAssistant` degenerates to `lastStop >= 0` and a clobbered
// turn returns ok:true. The mutations test the DECISION; they cannot test the PREMISE the
// decision rests on, and all three bite while the assertion is vacuous in production. Do not
// read a green mutation set as coverage of the input shape.
import { indicatorSurvivedInit, preSendSettled } from './turn-indicator.mjs'
import { check, passed as pass, failed as fail } from './assert.mjs'

const s = (stop, assistant) => ({ stop, assistant })

{
  // A healthy turn: Stop up from the start, assistant output partway through, Stop drops at
  // the end. The last Stop sample is after the first assistant sample.
  const r = indicatorSurvivedInit([
    s(true, false), s(true, false), s(true, true), s(true, true), s(false, true),
  ])
  check('1 a healthy turn passes', r.ok && r.reason === 'ok',
    { pass: `lastStop=${r.lastStop} >= firstAssistant=${r.firstAssistant}`,
      fail: `reason=${r.reason} lastStop=${r.lastStop} firstAssistant=${r.firstAssistant}` })
}

{
  // ★ THE RECORDED 2026-08-24 FAILURE, replayed.
  // A SHORT but entirely healthy turn: Stop was up the whole time and the assistant answered
  // before the old 2500ms threshold. The old rule had no sample with stop=true after 2.5s and
  // called that a broken indicator. The turn-relative rule sees Stop still up at and after the
  // first assistant sample and passes — which is the correct verdict, and it is the entire
  // reason for the change.
  const r = indicatorSurvivedInit([s(true, false), s(true, true), s(false, true)])
  check('2 a turn shorter than the old wall-clock threshold is NOT a failure', r.ok,
    { pass: 'short healthy turn passes — the model\'s speed no longer decides the verdict',
      fail: `reason=${r.reason} — this is the 2026-08-24 false red, back again` })
}

{
  // ★ THE REAL BUG. Init clobbers `running`: Stop goes down early, and the turn then carries
  // on and produces assistant output afterwards. This is what the assertion exists to catch.
  const r = indicatorSurvivedInit([
    s(true, false), s(false, false), s(false, true), s(false, true),
  ])
  check('3 the init clobber is caught', !r.ok && r.reason === 'indicator-died-before-output',
    { pass: 'Stop died before any assistant output — reported as the clobber',
      fail: `reason=${r.reason} — the regression this file exists for went UNDETECTED` })
}

{
  // A long turn where Stop dies mid-stream — a clobber that arrives late rather than at init.
  // Still caught, because the rule is an ordering, not a deadline: assistant output continued
  // after the last Stop sample.
  const r = indicatorSurvivedInit([
    s(true, false), s(true, true), s(false, true), s(false, true),
  ])
  check('4 a LATE clobber (after output began) is NOT caught — stated, not hidden',
    r.ok,
    { pass: 'passes: the rule asks whether Stop survived UNTIL output began, not beyond it — a mid-stream drop is out of its scope and would need a different assertion',
      fail: `reason=${r.reason}` })
}

{
  // Inconclusive, not failing: the sampler never caught Stop at all.
  const r = indicatorSurvivedInit([s(false, false), s(false, true)])
  check('5 never seeing Stop is INCONCLUSIVE, not a clobber report',
    r.reason === 'no-stop-sample',
    { pass: 'reason=no-stop-sample — distinct from the clobber verdict',
      fail: `reason=${r.reason} — an unobserved run is being reported as a defect` })
}

{
  // Inconclusive the other way: the turn never produced observable assistant output, so the
  // comparison has nothing to compare against. Must not read as a pass OR as a clobber.
  const r = indicatorSurvivedInit([s(true, false), s(true, false)])
  check('6 never seeing assistant output is INCONCLUSIVE, not a pass',
    r.reason === 'no-assistant-sample' && !r.ok,
    { pass: 'reason=no-assistant-sample — an auth-failure or dead turn cannot pass this by default',
      fail: `reason=${r.reason} ok=${r.ok}` })
}

{
  const r = indicatorSurvivedInit([])
  check('7 an empty sample set is inconclusive', r.reason === 'no-stop-sample' && !r.ok,
    { fail: `reason=${r.reason}` })
}

// ★★ 8 AND 9 PIN THE PREMISE, NOT THE DECISION. THIS IS THE MOST IMPORTANT PAIR IN THE FILE
// AND THE EASIEST TO "SIMPLIFY" BACK INTO A LIE. ★★
//
// Tests 1-7 all encode `assistant: false` in their early samples. THE LIVE PRODUCT DOES NOT
// PRODUCE THAT SHAPE. Measured 2026-09-02 against a real turn: the verdict line read
//   → lastStop=43 firstAssistant=0 reason=ok
// and `assistant` was true in all 44 samples including sample 0 — because the harness creates
// its session in a fixed CWD, the CLI keeps history per directory, and Claudette REPLAYS it,
// so this harness's own answers from previous runs are on screen before the prompt is sent.
// A pre-prompt probe that sent nothing confirmed it directly: three non-empty
// [data-kind="text"] items already present, two complete prior turns.
//
// On that shape `lastStop >= firstAssistant` becomes `lastStop >= 0` — true whenever Stop was
// seen at all — and the CLOBBER GOES UNREPORTED. The decision logic was correct for the
// fixtures and the fixtures were wrong about the world; 7/7 green and three biting mutations
// gave real confidence about the wrong proposition. The mutations could never have caught it:
// they test the DECISION, and this is the PREMISE the decision rests on.
//
// So test 9 is a fixture that must FAIL, and its value is entirely in that. If someone
// "tidies" these two into the same shape as 1-7, the harness can go green through the exact
// regression it exists to catch, and nothing in this file will say so.
{
  // The live-observed shape, healthy: assistant text on screen from sample 0 (replayed), and
  // Stop stays up throughout. Must still pass — the fix must not break the good case.
  const r = indicatorSurvivedInit([
    s(true, true), s(true, true), s(true, true), s(false, true),
  ])
  check('8 the LIVE sample shape (assistant true from sample 0) still passes when healthy', r.ok,
    { pass: 'a healthy turn under replayed history is not a false red',
      fail: `reason=${r.reason} — the real-world shape now fails on a healthy turn` })
}

{
  // ★ THE ONE THAT CAUGHT IT. Same live shape, but CLOBBERED: Stop dies at sample 1 and the
  // turn carries on. The bare decision cannot tell this from test 8 — both give lastStop >= 0
  // — which is why the harness must not feed it a bare "is there assistant text on screen?".
  // This asserts the LIMIT of the pure function, so the limit is written down rather than
  // rediscovered by a paid live run: it is the harness's job to supply a turn-relative
  // `assistant` (real-turn-browser-test.mjs baselines the count before sending and requires
  // an increase), and this test exists to fail loudly if anyone removes that baseline.
  const r = indicatorSurvivedInit([
    s(true, true), s(false, true), s(false, true), s(false, true),
  ])
  check('9 …and a CLOBBERED turn on that same raw shape is INDISTINGUISHABLE — the premise, not the decision, is what protects us',
    r.ok === true && r.reason === 'ok',
    { pass: 'documented limit holds: with a non-turn-relative `assistant` the clobber reads as ok — the harness MUST baseline it',
      fail: `reason=${r.reason} ok=${r.ok} — the decision changed; re-derive whether the harness still needs its baseline` })
}

// ★★ 10-12 PIN THE RACE INSIDE THE WINDOW — the defect one layer below tests 8 and 9. ★★
//
// 8 and 9 pin the shape of what is on screen BEFORE the turn. These pin whether the reference
// point itself was taken at a legitimate moment. The distinction matters because the earlier
// fix moved the observation window to exclude prompt-echo and replayed history, and this is
// the channel that opens INSIDE that window: replay is asynchronous, so an item can land after
// the reference is taken and be counted as this turn's output — the original vacuity returning
// in its original form, content not produced by this turn satisfying a predicate about it.
//
// Test 12 is the one that names the old defect directly: a SINGLE snapshot is not a stability
// measurement and must not be allowed to read as one.
//
// MUTATIONS (measured 2026-09-04):
//   M5  `counts.length < 2` → `counts.length < 1`  → test 12 reds ALONE. This is the mutation
//       that matters: it is exactly the "one snapshot is good enough" assumption the fix
//       removes, and no other test in this file can see it.
//   M6  `settled: last === prev` → `settled: true`  → test 11 reds.
//   M7  swap the comparison to `last >= prev`      → test 11 reds (a transcript that GREW
//       would read as settled, which is the live failure direction).
{
  const r = preSendSettled([3, 3])
  check('10 two probes with an unchanged count are settled', r.settled && r.reason === 'settled',
    { pass: 'count held across a real wait — replay had finished before the send',
      fail: `reason=${r.reason} last=${r.last} prev=${r.prev}` })
}

{
  // ★ THE RACE. An item arrived between the two probes, so replay was still streaming when the
  // reference would have been taken. Anything captured at that moment is already stale.
  const r = preSendSettled([3, 4])
  check('11 a count that GREW between probes is NOT settled — the race is caught',
    !r.settled && r.reason === 'still-arriving',
    { pass: 'late replay detected before the prompt was sent, rather than counted as output',
      fail: `reason=${r.reason} — an item arriving after the reference would be read as this turn's output` })
}

{
  // ★ THE ORIGINAL DEFECT, NAMED. One snapshot cannot answer a question about change, and the
  // dangerous answer is not "wrong" but "trivially true": two reads of the same instant are
  // always equal. Refusing is the only honest verdict, so this asserts the REFUSAL.
  const r = preSendSettled([3])
  check('12 a SINGLE snapshot refuses rather than reading as stable',
    !r.settled && r.reason === 'need-two-probes',
    { pass: 'one probe is not a stability measurement and does not pretend to be',
      fail: `reason=${r.reason} — a single sample is being treated as evidence of no change` })
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
