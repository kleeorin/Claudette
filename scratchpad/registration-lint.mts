// LINT: every executable file in scratchpad/ must be either REGISTERED in run-suite.sh or
// EXPLICITLY declared a non-test here. Nothing may be silently absent.
//
// Why this is inverted rather than a glob of `*-test.mts`-style suffixes. A pattern list is
// a guess about names that exist TODAY, so a file with a novel suffix is silently skipped —
// which is the same bug this lint exists to catch, one level down. Instead the rule is
// exhaustive over the directory and fails CLOSED: an unrecognised file is a violation until
// somebody classifies it. The cost is a one-line edit when a genuine helper is added; the
// benefit is that "I forgot to register it" stops being possible.
//
// This class has bitten FIVE times in one day — auth-token-containment-guard (escape 6),
// auth-path-bypass-test (escape 1, the worst of the four), teammate-blocked-signal-test,
// creds-live-resync-test and real-turn-browser-test were all written, all correct, and none
// of them ran. A protection whose alarm is not wired up is indistinguishable from no
// protection, and reads as a pass.
//
// TO ADD A NEW TEST: register it in run-suite.sh. TO ADD A HELPER: add it to NON_TESTS with
// a reason. There is deliberately no third option.
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const SELF = path.basename(fileURLToPath(import.meta.url))

// Files that are NOT tests. Each needs a reason — an unexplained entry here is how a real
// test gets quietly buried, which would defeat the whole check.
const NON_TESTS: Record<string, string> = {
  'dom-env.mts': 'DOM shim imported by other tests; asserts nothing itself',
  'turn-indicator.mjs': 'pure decision module imported by real-turn-browser-test.mjs and\n    turn-indicator-test.mjs — the init-clobber verdict, extracted so it can be exercised\n    without a live API turn. Exports one function and asserts nothing itself.',
  'assert.mjs': 'THE shared assertion helper — exports check() plus the pass/fail/open\n    counters as ESM live bindings, and asserts nothing itself. It is .mjs, not .mts, because\n    run-suite.sh runs every .mjs harness under plain node, which cannot import TypeScript;\n    this way both halves of the directory can share one helper. It deliberately does NOT own\n    process.exit — see its header — so the result-dependent-exit gate still reads every\n    harness textually.',
  'trust-gate.mjs': 'shared helper imported by the harnesses that create a session through\n    the UI — answers the "Trust this folder?" dialog and waits for the composer. Exports two\n    functions and asserts nothing itself.',
  'nested-mount-shadowing-probe.mts': 'documentation probe — prints observations and a bounded\n    hypothesis, has NO process.exit, so it can never report failure. run-suite.sh\'s gate caught\n    it when I wrongly registered it: a test that cannot fail sits green forever, which is the\n    very class this lint exists to stop.',
  'print-sandbox-prompt.mts': 'printer — emits the sandbox system prompt, no assertions',
  'fake-claude-team.mjs': 'fake `claude` CLI fixture used by the team tests',
  'real-turn-capture.mjs': 'capture utility for recording a real turn; not an assertion suite',
  'terminal-attach-diagnosis.mjs': 'one-off diagnostic written while chasing the terminal bug',
  'xterm-replay-probe.mjs': 'printer — console.logs a dozen DOM observations about the xterm\n    pane and ends in an unconditional process.exit(0). It asserts NOTHING, so registering it\n    would sit green forever; run-suite.sh\'s result-dependent-exit gate would reject it too.',
  'rt-proxy-crash.mts': 'takes a <case> argv — cannot run bare, driven by rt2-connectors',
  'rt2-proxy-crash.mts': 'takes a <case> argv — cannot run bare, driven by rt2-connectors',
  'connectors-ui-shots.mjs': 'screenshot script',
  'ui-screenshot.mjs': 'screenshot script',
  'files-shot.mjs': 'screenshot script',
  'git-shot.mjs': 'screenshot script',
  'layout-shot.mjs': 'screenshot script',
  'md-collapse-shot.mjs': 'screenshot script',
  'persession-shot.mjs': 'screenshot script',
  'redesign-shot.mjs': 'screenshot script',
  'thinking-shot.mjs': 'screenshot script',
}

const suite = readFileSync(path.join(DIR, 'run-suite.sh'), 'utf8')
// Registration is the QUOTED "<prereq>:<file>" entry in the SUITE array — not a bare
// substring of run-suite.sh. `suite.includes(f)` read comments too, and that hole runs both
// ways: it reported a NON_TESTS file as "also registered" merely because a comment named it
// (the false positive that exposed this), and — far worse — any genuinely unregistered test
// whose name appeared in ANY comment would have counted as registered and reported nothing
// forever. That is the exact failure this lint exists to prevent, living inside the lint.
const REGISTERED = new Set(
  [...suite.matchAll(/"[A-Za-z0-9+]+:([^"]+)"/g)].map((m) => m[1]),
)
const files = readdirSync(DIR)
  .filter((f) => (f.endsWith('.mts') || f.endsWith('.mjs')) && f !== SELF && !f.startsWith('.'))

const unregistered: string[] = []
const staleAllow: string[] = []
for (const f of files) {
  // Registered means it appears in the suite's own list, in any category.
  if (REGISTERED.has(f)) {
    if (NON_TESTS[f]) staleAllow.push(f)   // declared a helper AND registered — contradiction
    continue
  }
  if (NON_TESTS[f]) continue
  unregistered.push(f)
}

let violations = 0
console.log(`── registration (${files.length} executable files, ${Object.keys(NON_TESTS).length} declared non-tests) ──`)
if (unregistered.length) {
  for (const f of unregistered) {
    violations++
    console.log(`  ❌ ${f} — neither registered in run-suite.sh nor declared a non-test`)
  }
  console.log('     A test absent from the suite is indistinguishable from a test that passes.')
} else {
  console.log('  ✅ every executable file is registered or explicitly declared a non-test')
}
for (const f of staleAllow) {
  violations++
  console.log(`  ❌ ${f} — listed in NON_TESTS but ALSO registered; remove one`)
}
console.log(`\n${violations === 0 ? 'clean' : `${violations} violation(s)`}`)
process.exit(violations === 0 ? 0 : 1)
