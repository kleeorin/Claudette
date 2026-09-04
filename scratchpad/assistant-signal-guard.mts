// IS THE "ASSISTANT PRODUCED OUTPUT" SIGNAL TURN-RELATIVE? — a static guard over the corpus.
//
//   npx tsx scratchpad/assistant-signal-guard.mts
//
// GROUP C: no browser, no server, no ports, no API calls. Reads source text only.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────
// real-turn-browser-test.mjs asks "did the assistant produce output?" and for a long time
// answered it with `[...document.querySelectorAll('[data-kind="text"]')].some(el => el.innerText)`
// — "is there assistant text on screen?". That is TRUE BEFORE THE PROMPT IS SENT, because the
// harness creates its session in a fixed cwd, the CLI keeps history per directory, and
// Claudette replays it (`fromReplay` in chat.tsx emits kind:'text' items). Measured
// 2026-09-02 by a pre-prompt probe that sent nothing: three non-empty [data-kind="text"]
// items already present, containing this harness's own answers from previous runs.
//
// The consequences were two vacuous assertions in one file: "turn actually completed" could
// not fail, and "indicator SURVIVED init" degenerated to `lastStop >= 0`, which is identical
// to the sawStop assertion above it — so a CLOBBERED turn passed. Both were green the whole
// time, and the live run that exposed it cost real API calls on the operator's account.
//
// ── WHY A GUARD RATHER THAN A COMMENT ────────────────────────────────────────────────────
// The fix lives in real-turn-browser-test.mjs (capture a baseline before the send, require an
// increase). turn-indicator-test.mjs's tests 8 and 9 pin the DECISION module's limit, but
// they are in a different file and structurally cannot see someone deleting the harness's
// baseline. A comment and a log line are not enforcement. Re-verifying by hand costs a live
// API turn, which is precisely the cost that let the original defect survive so long — so the
// check has to be free, and static is the only free option.
//
// ── IT IS DELIBERATELY WIDER THAN THE FILE IT PROTECTS ───────────────────────────────────
// Same principle as web-vitest-shim.mjs asserting a per-case floor rather than trusting exit
// 0: a detector scoped to exactly the known instance only confirms what that instance already
// reports, and cannot see the defect's SECOND occurrence. This file had two occurrences and
// the second was created by repairing the first, so a narrow detector is not hypothetically
// insufficient here — it is demonstrably so. Rule [A] therefore scans EVERY harness for the
// vacuous shape, not just this one; rules [B]/[C] are the specific structural requirements.
//
// ── MUTATIONS THAT MUST RED IT ───────────────────────────────────────────────────────────
// Measured 2026-09-02 against a COPY of the harness, each patch applied from pristine. The
// EDIT is named precisely, not just its effect: the M2 lesson from turn-indicator-test.mjs is
// that a record describing an edit loosely enough to have variants has no reproducible result.
//   MA  sampler `.filter(...).length` → `.some(...)`, and `assistant: n > ${BASELINE}` → `n`
//       → [A] and [D] red. 4 passed / 2 failed, exit 1.
//   MB  delete the `const BASELINE = await evaluate(...)` line outright
//       → [B] and [C] red. 4 passed / 2 failed, exit 1.
//   MC  move that same line to AFTER the Enter dispatch, changing nothing else
//       → [C] ALONE red. 5 passed / 1 failed, exit 1. ★ This is the mutation that justifies
//         rule [C] existing: a check that merely asked "does the file mention BASELINE?"
//         passes here, and the harness measures the wrong instant with nothing to say so.
//   XX  a patch matching no text → REFUSED, as it must.
//
// Added 2026-09-04 with the marking/settle rules [D]-[G]:
//   MD  sampler: `all.filter(el => !el.hasAttribute('data-pre-send')).length` → `all.length`
//       → [D] red. 8 passed / 1 failed, exit 1.
//       ★ ON ITS FIRST RUN THIS PRODUCED NO RED AT ALL, and that is the most useful line in
//       this record. [D] tested the whole file for `!el.hasAttribute('data-pre-send')`, and
//       the string ALSO occurs in the completion check below the sampler — so deleting the
//       filter from the sampler left the file still matching and the guard still green, in
//       exactly the state it exists to catch. Fixed by extracting the SAMPLE block and
//       matching inside it, with [D-pre] refusing if the block cannot be delimited. Nothing
//       but a mutation would have found this: the rule read correctly and passed correctly.
//   ME  completion check: drop `&& !el.hasAttribute('data-pre-send')` → [E] red. 8/1, exit 1.
//   MF  replace the settle probe with `{ settled: true }` → [F] and [G] red. 7/2, exit 1.
//   MG  move the `preSendSettled` call to AFTER the Enter dispatch, changing nothing else
//       → [G] ALONE red. 8/1, exit 1. The ordering rule earns its place here for the same
//       reason [C] does: the call is still present, so any presence-only check passes.
//
// ⚠ KNOWN LIMIT OF RULE [A], found while mutating this guard and recorded rather than hidden.
// It scans SOURCE TEXT and strips line comments, but it cannot tell code from a STRING
// LITERAL that quotes the forbidden shape. It first fired on the mutation runner itself,
// which held the vacuous form in a template literal — a true positive about the text and a
// false one about the behaviour. The repo has hit this before: a blind regex once matched
// `check(s) failed` inside a template literal, and the standing note is that a
// source-rewriting tool needs a string-aware scanner rather than a regex. Two mitigations
// here: the mutation runner now lives OUTSIDE the scanned directory, and this file exempts
// itself by name since it necessarily quotes what it forbids. It FAILS CLOSED — the failure
// mode is a refusal to pass, never a silent green — so a future false positive costs someone
// a minute of reading and cannot let the defect through.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { check, passed as pass, failed as fail } from './assert.mjs'

const DIR = new URL('.', import.meta.url).pathname
const HARNESS = 'real-turn-browser-test.mjs'
const src = readFileSync(join(DIR, HARNESS), 'utf8')

// Strip line comments before pattern-matching. Without this the guard reads its OWN
// quoted examples above — and every explanatory comment in the harness — as live code, which
// is the mistake that makes a source-scanning check report confident nonsense. Block comments
// are not used for code in these files; string literals are handled by the fact that every
// pattern below must ALSO satisfy a structural ordering test, which a quoted example cannot.
const stripComments = (s: string) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

console.log('── [A] no harness decides "assistant produced output" with a bare .some() ──')
// Corpus-wide. The vacuous shape is: query [data-kind="text"], then .some(...) to get a
// boolean, with nothing establishing WHEN. A count compared to a baseline is fine.
const files = readdirSync(DIR).filter((f) => f.endsWith('.mjs') || f.endsWith('.mts'))
const offenders: string[] = []
for (const f of files) {
  if (f === 'assistant-signal-guard.mts') continue   // this file quotes the shape it forbids
  const body = stripComments(readFileSync(join(DIR, f), 'utf8'))
  if (!body.includes('data-kind="text"')) continue
  // `.some(` applied to a [data-kind="text"] query, on one line or wrapped across two.
  const flat = body.replace(/\s+/g, ' ')
  if (/querySelectorAll\('\[data-kind="text"\]'\)\]\s*\.some\(/.test(flat)) offenders.push(f)
}
check('[A] no harness uses .some() on [data-kind="text"] to decide the assistant signal',
  offenders.length === 0,
  { pass: `${files.filter((f) => readFileSync(join(DIR, f), 'utf8').includes('data-kind="text"')).length} file(s) reference the marker; none use the vacuous shape`,
    fail: `vacuous shape found in: ${offenders.join(', ')} — replayed history makes this TRUE before the prompt is sent` })

console.log(`\n── [B]/[C] ${HARNESS} baselines the count BEFORE it sends ──`)
const code = stripComments(src)

const baselineAt = code.search(/const\s+BASELINE\s*=\s*await\s+evaluate\(/)
check('[B] a baseline is captured with an explicit evaluate()', baselineAt !== -1,
  { fail: 'no `const BASELINE = await evaluate(...)` — nothing is captured, so nothing can be compared against it' })

// The send is the Enter keydown dispatch. Named by its effect, not by a line number, because
// line numbers in this repo drift by hundreds.
const sendAt = code.search(/KeyboardEvent\('keydown',\s*\{\s*key:\s*'Enter'/)
check('[C-pre] the send site is still recognisable (Enter keydown dispatch)', sendAt !== -1,
  { fail: 'could not locate the Enter dispatch — this guard cannot order what it cannot find, and MUST NOT pass by default' })

// ★ THE ORDERING IS THE POINT. A baseline captured after the send measures the wrong instant
// and would silently include this turn's own first tokens. A check that merely asked "does
// the file mention BASELINE?" would pass on that, which is why this compares positions.
check('[C] the baseline is captured BEFORE the prompt is sent',
  baselineAt !== -1 && sendAt !== -1 && baselineAt < sendAt,
  { pass: `baseline at char ${baselineAt}, send at char ${sendAt} — captured first`,
    fail: `baseline at ${baselineAt}, send at ${sendAt} — a baseline taken at or after the send includes this turn's own output and measures nothing` })

// [D]/[E] UPDATED 2026-09-04: the reference moved from a COUNT to a MARKED SET. A count is
// still a predicate over an unbounded surface — an item arriving after the count is taken
// raises it and reads as this turn's output — so the harness now marks pre-existing nodes and
// counts only unmarked ones. These rules moved with it deliberately: a guard left pinning the
// old shape would have gone red on the correct code and been "fixed" by relaxing it.
// ★ SCOPED TO THE SAMPLER, and that scoping is the whole rule. Written first as a
// whole-file test for `!el.hasAttribute('data-pre-send')`, it could not fail: the string also
// occurs in the completion check further down, so deleting the filter FROM THE SAMPLER left
// the file still matching and the guard still green. Caught by mutation MD, which produced no
// red at all. A file-wide grep answers "does this text exist somewhere", and the question here
// is "does this code run in THIS block" — the same distinction that makes a citation accurate
// and unreachable. So the sampler is extracted and matched in isolation, and a failure to
// extract it is a REFUSAL rather than a pass.
const sampleStart = code.indexOf('const SAMPLE = ')
const sampleEnd = code.indexOf('const samples = []')
const sampler = sampleStart !== -1 && sampleEnd > sampleStart ? code.slice(sampleStart, sampleEnd) : ''
check('[D-pre] the sampler block could be isolated (this guard must not match the wrong region)',
  sampler.length > 0,
  { fail: 'could not delimit the SAMPLE block — [D] would otherwise be testing the whole file, which is how it was wrong before' })

check('[D] the sampler counts UNMARKED nodes — a set difference, not a count comparison',
  /!el\.hasAttribute\('data-pre-send'\)/.test(sampler) && /assistant:\s*fresh\s*>\s*0/.test(sampler),
  { pass: 'the SAMPLE block filters on !hasAttribute(data-pre-send) and sets assistant: fresh > 0',
    fail: 'the sampler no longer distinguishes pre-existing nodes from this turn\'s — late replay would count as output' })

check('[E] the "turn actually completed" assertion also counts only UNMARKED nodes',
  /answeredCount\s*>\s*0/.test(code) && /answeredCount[\s\S]{0,240}data-pre-send/.test(code),
  { pass: 'asserts answeredCount > 0 over nodes excluded by data-pre-send',
    fail: 'the completion check no longer excludes pre-send nodes — this is the assertion that was repaired from the \'hello\' vacuity INTO a second vacuity; do not let it acquire a third' })

// ★ [F] THE MARKING IS PRECISE, NOT EARLY, AND ONLY THIS MAKES IT SOUND. Marking says WHICH
// nodes pre-date the send; it does not establish that replay had FINISHED when the mark was
// taken. An item landing after it is unmarked and counts — the same vacuity, one layer down.
// The settle probe is what closes it, and `preSendSettled` refuses on a single probe because
// two reads of the same instant are always equal.
check('[F] a settle probe establishes replay had finished before the reference was taken',
  /preSendSettled\(/.test(code),
  { pass: 'harness calls preSendSettled before sending',
    fail: 'no settle probe — the marked reference may have been taken while replay was still streaming, and a late item would read as this turn\'s output' })

const settleAt = code.search(/preSendSettled\(/)
check('[G] …and it runs BEFORE the prompt is sent',
  settleAt !== -1 && sendAt !== -1 && settleAt < sendAt,
  { pass: `settle probe at char ${settleAt}, send at char ${sendAt}`,
    fail: `settle probe at ${settleAt}, send at ${sendAt} — a stability check after the send measures the wrong interval entirely` })

console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
