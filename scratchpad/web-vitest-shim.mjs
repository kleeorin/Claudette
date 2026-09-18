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
// Raised 18 → 42 the same day with the sidebar status lights: sessionLights.test.ts (17) and
// StateDot.test.tsx (7). The mute feature's whole safety argument is an ORDERING inside
// dotState, so those cases are the guarantee that a mute cannot hide a session asking for the
// user — losing them silently is precisely what this floor exists to prevent.
// Raised 42 → 46 the same day: pruneMutes' four call-site cases, added after review found the
// mute store was erased on every page load. The boot case is the only test in the file that
// can see that class of defect — every clearMutes test stays green under the mutation that
// reintroduces it — so losing it silently is exactly what this floor is for.
// Raised 46 → 51 the same day: the dot now carries the attention REASON rather than a
// boolean, plus dotStateFor — the map lookup extracted out of App.tsx. Nothing in the repo
// imports App.tsx, so while that lookup lived inline it was the one safety-critical line in
// the feature with no test at any layer; these five are what make reverting it a red.
// Raised 51 → 67 on 2026-09-08 with the connector OAuth UI: connectorAuth.test.ts (9) and
// ConnectorOAuth.test.tsx (7). The multi-account cases are the ones worth not losing — the
// server REFUSES to dial when two accounts are authorized, and a UI that says nothing turns
// that deliberate refusal into an invisible failure.
// Raised 67 → 85 on 2026-09-08 with the app-settings panel: settingsLogic.test.ts (11) and
// SettingsPanel.test.tsx (7). The override-disables-the-control cases are the ones worth not
// losing — an editable control the environment is already dictating is a silent no-op, and
// this repo has corrected that exact class three times.
// 85 → 86 the same day: `save` became SET-ONLY and clears route to /reset, so one more case
// pins that EVERY clearable control agrees on the verb. The risk is not all four reverting
// together — it is one reverting and failing only for the field nobody clears often.
// 86 → 88 on 2026-09-08: authState now consumes the server's `oauthClientReady` instead of
// inferring from the ref's presence, so two cases pin it — a SET ref with ready=false must
// report needs-client, and the ref fallback survives only where the field is absent.
// 88 → 96 on 2026-09-09: the OAuth gate missed DYNAMIC-CLIENT-REGISTRATION connectors
// entirely. Confluence carries no requiresOAuthClient, so the server emits no needsSetup, no
// oauthClientRef and no oauthClientReady — the three fields the gate read. It rendered no
// Connect button for the one connector that needs no operator setup, and reported it 'ready'
// while holding no token. These cases pin both halves.
// 96 → 97 on 2026-09-10: the muted dot became a filled black disc and the idle dot gained a
// touch-visible press cue, so one case pins that the two states render DIFFERENT treatments.
// 97 → 120 on 2026-09-10 with the background-processes panel: bashProcLights.test.ts (23).
// The two worth not losing are the ones that pin claims the UI makes ABOUT THE USER'S OWN
// BUILD. First, 'unknown' must never render as a failure — a background shell killed by a
// server restart has no knowable outcome, and painting it red tells the user their test run
// broke when it may well have passed. Second, a running process must never fall out of the
// badge, because a panel that answers "is my build still going?" confidently and wrongly is
// worse than no panel. Both are asserted over the WHOLE state population queried from
// BASH_PROC_STATES rather than over a hand-written list, so a fifth lifecycle state reds
// this file on arrival instead of falling through a default arm nobody looked at.
// Mutation-tested the same day: 12 mutants, 12 killed, ran=120 on every one, and the XX
// control (a patch matching no text) refused rather than silently running unmutated source.
// 120 → 124 the same day, when 'stopped' arrived as a FIFTH lifecycle state (measured as the
// second most common shell outcome in the corpus: completed 15, stopped 12, failed 2). The
// population rule did its job — two cases reded on the growth without anyone editing them —
// but one of the four new cases exists because of what did NOT red. "gives every state a dot
// and a status word" PASSED for the unrecognised state, since the default arm returns a
// well-shaped grey dot and String(status); shape checks cannot tell a DESIGNED state from one
// that fell through. So a uniqueness case was added: 'stopped' and 'unknown' share a grey dot
// deliberately, which makes the WORD the only channel distinguishing "you stopped it" from
// "we lost track of it", and two states rendering identically in every channel is a defect
// however it arose.
// 126 → 134 the same day, after review. The eight with teeth:
//   * TWO MALFORMED-RECORD cases. Every other fixture in that file is built by a `proc()`
//     helper that always supplies `command` and `startedAt`, which is exactly why a record
//     missing `command` — which THREW during render and blanked the whole sidebar, not just
//     its own row — stayed invisible to 23 passing tests. Typecheck cannot cover it either:
//     the record arrives via JSON.parse off a socket, so `command: string` is an assertion
//     about a server rather than a fact about a value.
//   * THE KILL GATE, over the population × shellId present/absent. It is the only destructive
//     control here and its rule was previously written inline TWICE — in App.tsx, which
//     nothing imports, and in a component with no test file at all.
//   * THREE DEFAULT-ARM cases, reachable only by cast. These close a blind spot the
//     population rule ITSELF creates: iterating BASH_PROC_STATES can never reach a `default:`,
//     so the "fails in the safe direction" claims in those branches had zero coverage — the
//     comments asserted a behaviour nothing checked. One is load-bearing beyond documentation:
//     an unrecognised state must be LIVE for the badge (so it cannot vanish) and NOT killable
//     (so we never offer to destroy what we do not understand). Opposite defaults from one
//     input — which is why bashProcKillable does not reuse isLiveBashProc, and why rewriting
//     it to do so (a tidy-looking simplification, identical for every state that exists
//     today) reds that single case and nothing else.
// 134 → 138 the same day: store/chat.test.tsx, closing a gap I had flagged rather than hidden.
// CLEAR used to delete `bashProcs` alongside the transcript, which reads as obviously right
// and is a category error: agent cards are REBUILT from the transcript, whereas bashProcs is a
// server-owned registry the client never derives. And CLEAR is not "the user typed /clear" —
// ChatView dispatches it from five places including the AUTO-RESUME effect, which is no user
// action at all. Because the registry refills only on a change broadcast or a per-connect
// snapshot, the wipe hid a live 20-minute build for the rest of its run.
// Tested through the PROVIDER rather than by exporting the reducer: exporting would widen the
// module's API for testing alone and would prove the arm correct without proving that
// clearTranscript still reaches it, and wiring is this repo's recurring defect class.
// The fourth case is the counterweight — a snapshot with no bashProcs field must still EMPTY
// the panel. Without it "never clear the registry" would be the wrong lesson, and a stale
// "still running" row could never be retracted at all.
// 138 → 143 on 2026-09-10: api/client.test.ts, after a USER-REPORTED crash. Opening Settings
// showed "Cannot read properties of undefined (reading 'host')" and took the panel out. Cause
// was not in the panel: `get()` did `return (await fetch(path)).json()` with no status check,
// and every error this server returns is valid JSON — so a 404 body resolved, was cast to the
// success type by the signature's `as T`, passed the panel's truthy `if (!data)` guard, and
// blew up on the first field access. The panel already had "Could not load settings." written
// for exactly this; it was unreachable, because the failure never presented as one.
// The fifth case is the counterweight and is why this is not just "reject more": a fix that
// rejected everything would make every call site equally "safe" and be useless.
// 143 → 154 on 2026-09-10: autoResume.test.ts (9) plus two more, after a USER report that a
// restarted subsession loaded its PARENT's context. Auto-resume identified a session's
// conversation as "the newest one in this cwd", which is a sound identification only while the
// directory holds ONE session — and SessionInfo.cwd's own comment says a subsession SHARES its
// parent's cwd, so every subsession broke it by construction. It was not only a display fault:
// the caller follows the lookup with resumeInto, which REPOINTS the engine, so the wrong guess
// moved a session's real context onto another session's conversation and overrode a restore
// the server had already done correctly.
// The rule now lives in lib/autoResume.ts because NOTHING IMPORTS ChatView either — inline, it
// had no coverage at any layer, which is how it shipped. The guard asks "can this directory
// tell me which conversation is mine?" rather than "is this a subsession?", because the
// parent/child case is merely the guaranteed instance; two ROOT sessions in one directory
// collide identically and would have survived the narrower guard.
// 138 → 154 on 2026-09-10. TWO of those are mine and the rest arrived with other sessions'
// files (api/client.test.ts and the ChatView auto-resume cases), which had left the floor
// below the real count — a floor under the true number cannot detect a deletion down to it,
// so it is raised to what is actually there rather than to 140.
// My two are the USER-REPORTED Settings crash and its shadow, and the pair is the point:
//   * `get()` returning a non-2xx body as if it were the success type meant the failure never
//     presented as a failure to the COMPONENT (fixed in client.ts, covered by client.test.ts).
//   * Even once it did, the panel could not present it to the USER: a failed load leaves
//     `data` null, and the early `if (!data)` returned only "Loading settings…", so the
//     "Could not load settings." branch inside the main return was unreachable. Fixing the
//     first silence only moved it. A permanent "Loading…" tells the user the opposite of the
//     truth, and nothing retries.
//   * The second case pins that a response missing `environment` degrades instead of throwing.
//     That matters more than it looks: the only ErrorBoundary is at the ROOT, wrapping <App/>,
//     so a throw in this panel blanks the WHOLE APPLICATION rather than one panel.
// 154 → 167 on 2026-09-10: auto-resume now identifies each session's OWN conversation instead
// of guessing "the newest file in this cwd", which was wrong for every subsession by
// construction (a subsession shares its parent's cwd) and did not merely DISPLAY the wrong
// history — the follow-up `resumeInto` repointed the engine onto it.
// The cases worth not losing:
//   * autoResumePlan returns byId for a session sharing its directory — the exact shape the
//     cwd guard had to refuse, and the reason a restored subsession came back empty.
//   * byId must NOT repoint the engine. The id comes from the engine's own init, so it is
//     already there; re-issuing resumeInto is what caused the original damage.
//   * ★ THE STORE WIRING, in chat.test.tsx, and specifically the SNAPSHOT path. `session:ready`
//     carries the same id but is broadcast once at engine start and never replayed to a later
//     socket — so in the scenario this fixes (server restarts, THEN the browser opens) the only
//     source is the init event replayed in the connect snapshot. An implementation wired to the
//     live path alone passes a live-path test and fixes nothing for the user.
//   * claudeSessionIdFromEvents rejects an EMPTY session_id. A truthiness-free check would send
//     readConversation('') — a request that can only fail, made INSTEAD of the cwd fallback
//     that would have worked.
// 154 → 173 on 2026-09-10, raised to MEASURED reality rather than to my own increment: several
// sessions were adding tests concurrently and the floor had fallen behind the true count more
// than once. A floor UNDER the real count cannot detect a deletion down to it, which is the
// one thing it exists for — so it is set from a counted run, not from arithmetic.
// Six of the new cases are lib/permissionBadge.test.ts: a user found a teammate session in
// "allow all" they never granted, and the sidebar said NOTHING — the mode was visible only
// after opening the session. Those cases pin that an elevated session cannot be silent. They
// are a MITIGATION and say so: the defect is server-side (restore() replays a persisted
// elevated mode with trusted:true), and no client test can assert the elevation was legitimate.
// 173 → 176 on 2026-09-15: ConnectorCatalog.test.tsx, added after review found that making
// `get()` throw on non-2xx had REGRESSED four unaudited call sites. The sharpest was this
// panel: `refresh()` had no catch and cleared `loading` only on the happy path, so an
// expired token left "Loading catalog…" on screen forever — byte-for-byte the SettingsPanel
// defect the same changeset was written to remove. Fixing one instance of a class while
// creating three more is the pattern this floor exists to make expensive.
// The second case asserts the server's own words reach the screen, and the third is the
// counterweight — a panel that errored unconditionally would pass the first two and be
// useless.
// 2026-09-15: NO change to the count — MIN_TESTS was already 176 and a counted run measures
// 176, so the floor is level with reality and this note records only what the same change did
// to the test FILES. (Recorded rather than dropped because the first draft of this line
// claimed a 173 → 176 bump that never happened: the 173 came from a stale brief, not from
// reading this file. A floor history that logs bumps which did not occur is worse than no
// history, because the next person reconstructs intent from it.)
// That change retired web/src/lib/permissionBadge.fixture.ts — it
// held a LOCAL copy of the PermissionMode population, with its own note saying to delete it
// the moment @claudette/shared exported a runtime list. `PERMISSION_MODES` now exists, so the
// badge test iterates the real union instead of a copy that could silently fall behind it.
// 176 → 196 on 2026-09-17: fileSort.test.ts (20), for the file panel's new Sort control.
// Sorting is all edge cases — ties, missing extensions, unreadable stats — which is exactly
// the shape that looks right on the happy path and is wrong on a real directory. The three
// worth not losing:
//   * FOLDERS STAY FIRST in every key and both directions, asserted over the whole key
//     population rather than for one key. Navigation must not depend on a display preference,
//     and a "Z → A" that sends folders to the bottom makes moving around the tree do exactly
//     that.
//   * THE INPUT IS NEVER MUTATED. `entries` is React state and Array.sort is in-place, so a
//     comparator applied to it directly reorders state outside a setter.
//   * TIES BREAK BY NAME, and the fallback is NOT reversed with the direction. Equal mtimes
//     are routine (anything written by one command); without the fallback the order comes from
//     whatever the server returned, so an unrelated refresh reshuffles the list — and
//     reversing the fallback too would make equal rows swap purely from toggling direction,
//     which reads as the sort being broken rather than reversed.
// It deliberately does not name Tailwind tokens — pinning `bg-black` would go red on a rename
// that changed nothing visible, and GREEN on a change that made the two identical.
const MIN_TESTS = 196

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
// Raised 9 → 10 on 2026-09-10 (bashProcLights.test.ts), in the same change as the tests.
// Raised 10 → 11 the same day (store/chat.test.tsx — the CLEAR wiring).
// Raised 11 → 13 the same day: api/client.test.ts and the ChatView auto-resume file, both
// from other sessions, which had arrived without the floor moving.
// Raised 11 → 12 the same day (api/client.test.ts — the Settings-crash regression).
// Raised 12 → 13 the same day (lib/autoResume.test.ts — the subsession-context regression).
const MIN_TEST_FILES = 16

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
