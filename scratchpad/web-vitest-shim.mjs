// Runs the WEB vitest suite (web/src/**/*.test.{ts,tsx}) as one suite member.
//
// WHY A SHIM AT ALL. run-suite.sh dispatches a scratchpad file to `npx tsx` or `node` and
// reads its exit code; it has no concept of a second test runner. So every vitest file in
// web/ was invisible to the suite — they ran only when somebody typed the command by hand.
// That is precisely the state registration-lint.mts exists to prevent ("a test absent from
// the suite is indistinguishable from a test that passes"), reached one level up: the lint
// scans scratchpad/ for unregistered FILES and cannot see an unregistered RUNNER.
//
// WHY IT DOES NOT JUST TRUST THE EXIT CODE. Three ways `npx vitest run` exits 0 while
// verifying nothing, all of them silent:
//   * the binary is absent — `npx` may fetch, prompt, or fail in a way that is not obviously
//     a test failure. Handled by probing for the local binary FIRST and failing closed.
//   * the include glob matches nothing — vitest is happy to run zero files. Handled by
//     asserting a POSITIVE test count, not merely "no failures".
//   * the count silently shrinks — a renamed or moved test file stops being collected and
//     the run stays green. Handled by MIN_TESTS below, which must be raised deliberately.
// The third is the reason this asserts a floor rather than just `numFailedTests === 0`.
//
// AND A FOURTH THE FLOOR STRUCTURALLY CANNOT CATCH, which is why the placement check below
// exists. `web/vitest.config.ts` collects `src/**/*.test.{ts,tsx}` and `web/tsconfig.json`
// includes `["src"]` — deliberately the SAME set, so tests are typechecked. The sharp edge
// is that a test file placed ANYWHERE ELSE under web/ is collected by nothing and
// typechecked by nothing, and because that is PURELY ADDITIVE the count never drops: it
// stays at MIN_TESTS, the suite reads green, and the test has never executed once. A floor
// detects deletion, never non-arrival. So the file set is checked directly against the
// filesystem rather than inferred from a number.
//
// Deliberately NOT parsing the human reporter's "Tests  14 passed" line: that is display
// text and has changed shape across vitest majors. `--reporter=json` is the contract.

import { existsSync, readdirSync } from 'fs'
import { execFileSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { check, failed as fail } from './assert.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const web = path.join(repo, 'web')
const bin = path.join(repo, 'node_modules', '.bin', 'vitest')

// The floor. RAISE THIS when you add web tests — that is the point of it. If it ever has to
// go DOWN, say in the commit why the coverage left, because a quietly lowered floor and a
// deleted test look identical from here.
// Raised 14 → 18 on 2026-09-04 with ConnectorGrants.test.tsx (4 cases): a granted connector
// that cannot work yet must still say what to do about it. Raised in the SAME change as the
// tests, per the note above — a floor left behind is exactly the case that note warns about.
const MIN_TESTS = 18

// THE DETECTOR IS DELIBERATELY WIDER THAN THE RUNNER, and that relationship is the whole
// point of it. `web/vitest.config.ts` collects exactly `src/**/*.test.{ts,tsx}`. A detector
// built from that same glob could only ever confirm what the runner already found — it
// would be blind to precisely the files the runner is blind to, which is the only thing
// worth detecting. So this matches anything TEST-SHAPED by any common convention, then
// asks whether the runner would actually collect it.
//
// Two ways a file goes invisible, both purely additive so the MIN_TESTS floor cannot see
// either (a floor detects deletion, never non-arrival):
//   * WRONG PLACE — outside src/, so neither vitest nor tsc looks there.
//   * WRONG NAME  — `.spec.ts` rather than `.test.ts`. This is not a hypothetical: vitest's
//     OWN default include covers both `.test.` and `.spec.`, so an author following the
//     framework's documentation writes `.spec.ts` and this repo's narrowed include silently
//     drops it. Measured 2026-09-02: a `.spec.ts` under web/src asserting `expect(1).toBe(2)`
//     — a test that CANNOT pass — was collected by nothing and reported by nothing.
// A third instance of the same family would be extension (`.test.js` in a TS-only include),
// so the shapes below cover that too rather than waiting for someone to hit it.
const TEST_SHAPED = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/
const COLLECTED = /^src\/.*\.test\.(ts|tsx)$/

// node_modules holds other packages' tests; dist is build output. Neither is ours to police.
function testShapedUnder(dir, rel = '') {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...testShapedUnder(path.join(dir, e.name), r))
    else if (TEST_SHAPED.test(e.name)) out.push(r)
  }
  return out
}

// A POSITIVE FLOOR ON FILES FOUND — and NOT the same quantity as MIN_TESTS, which floors
// tests COLLECTED. Both are needed because the check above is now the only thing standing
// between a never-executed test and a green suite, which makes ITS vacuity the failure mode
// that matters: a walk that finds nothing reports exactly the same all-clear as a walk that
// finds everything and approves it. If the root is ever wrong — a moved file, a refactor, a
// `web/` that is not where this thinks — the check goes silently vacuous in precisely the way
// it exists to prevent. The count cannot back it up; the whole point of the check is that the
// count is structurally blind to non-arrival. So the walk has to assert it saw something.
// Raised 2 → 3 on 2026-09-04 (ConnectorGrants.test.tsx). Moved deliberately alongside
// MIN_TESTS even though it is a different quantity: left at 2, a whole test FILE could stop
// arriving while this walk still reported an all-clear — the exact blindness the paragraph
// above exists to close.
const MIN_TEST_FILES = 3

const shaped = testShapedUnder(web)
check(`the walk found at least ${MIN_TEST_FILES} test file(s) — it is not silently looking at nothing`,
  shaped.length >= MIN_TEST_FILES, {
    pass: `walked web/ and found ${shaped.length}`,
    fail: `found ${shaped.length} — the walk root is wrong or the tree moved, so the check below approves an empty set`,
  })

const invisible = shaped.filter((f) => !COLLECTED.test(f)).map((f) => (
  f.startsWith('src/') ? `${f} (wrong name — must be .test.ts/.tsx)` : `${f} (outside src/)`
))
check('every test-shaped file under web/ is one vitest actually collects',
  invisible.length === 0, {
    pass: `${shaped.length} test file(s), all collectable`,
    fail: `collected by NOTHING and typechecked by NOTHING: ${invisible.join('; ')}`,
  })

// FAIL CLOSED, not skip. A missing runner in a workspace that DECLARES vitest as a
// devDependency is a broken checkout (`npm i` not run), not an absent optional prerequisite
// like chrome or jupyter — and reporting it as SKIP would hide every web test behind a grey
// row that nobody reads. run-suite.sh's own convention: a real prerequisite is probed there
// and reported SKIP; this is not one.
check('the vitest binary is installed (web declares it — a miss means `npm i` was not run)',
  existsSync(bin), bin)

if (existsSync(bin)) {
  let report = null
  let crashed = null
  try {
    // execFileSync throws on a non-zero exit, which is exactly what a failing test run does —
    // so the JSON still has to be read off the thrown error's stdout rather than from here.
    report = execFileSync(bin, ['run', '--reporter=json'], { cwd: web, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    report = e.stdout || ''
    if (!report.trim()) crashed = (e.stderr || String(e)).slice(-800)
  }

  let r = null
  if (!crashed) {
    // The reporter prints one JSON object; be tolerant of anything vitest logs before it.
    const i = report.indexOf('{')
    try { r = i >= 0 ? JSON.parse(report.slice(i)) : null } catch { r = null }
  }

  check('vitest produced a machine-readable report (it ran, rather than dying on startup)',
    r !== null, {
      pass: `${report.length} bytes of JSON`,
      fail: crashed ?? `could not parse a JSON report from ${report.length} bytes of output`,
    })

  if (r) {
    check(`it collected at least ${MIN_TESTS} tests (a glob that matches nothing exits 0)`,
      r.numTotalTests >= MIN_TESTS, `collected ${r.numTotalTests}`)
    check('every web test passed',
      r.numFailedTests === 0 && r.numTotalTests > 0,
      `${r.numPassedTests}/${r.numTotalTests} passed, ${r.numFailedTests} failed`)
    // Not an error, but worth surfacing: a suite that is quietly half-skipped reads as green.
    check('none of them were skipped or left as todo',
      (r.numPendingTests ?? 0) === 0 && (r.numTodoTests ?? 0) === 0,
      `${r.numPendingTests} pending, ${r.numTodoTests} todo`)
  }
}

process.exit(fail === 0 ? 0 : 1)
