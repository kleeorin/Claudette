// The background-bash wire parsers, against VERBATIM transcript strings.
//
// GROUP C: no browser, no server, no ports, no API calls. Pure string work.
//
// ★ WHY VERBATIM MATTERS HERE MORE THAN USUAL. The plan's §1 quoted these shapes from memory
// and was wrong twice — it recorded the status vocabulary as "completed and failed only" and
// documented a single-<task-id> envelope. Testing against the paraphrase would have confirmed
// the paraphrase. Every fixture below was pulled out of ~/.claude/projects/*.jsonl and is
// reproduced character-for-character, including the sentence's trailing full stop and the
// em-dashes in the orphan summary.
//
// MUTATIONS (measured 2026-09-10), each with ran=N per scratchpad/assert.mjs:
//   B1  parseBackgroundAck: `([A-Za-z0-9_-]+)` → `(\S+)`
//       → the ack test reds. That is not a hypothetical regression: a probe of mine captured
//         `bajjb5k0n.` with the trailing period and sent it to the CLI, and the resulting
//         no-op read as "the CLI rejects shell ids".
//   B2  parseBashNotification: matchAll → a single match on <task-id>
//       → TWO reds, not the one I predicted: the multi-id test AND the sentinel test. With
//         only the first id read, the sentinel is never in the list to be filtered, so that
//         assertion fails for a second reason. Recorded as measured. This is the defect that
//         would strand every process after the first as running forever.
//   B3  shellIdsOf: drop the sentinel filter
//       → the sentinel test reds; the single-id tests stay green, because they carry none.
//   B4  bashStatusFrom: `case 'stopped'` removed (falls through to unknown)
//       → the stopped-mapping test reds. `stopped` is the second most common shell outcome,
//         so this is the mapping most likely to be "simplified" away by someone reading the
//         original four-state spec.
//   B5  exit-code regex `/exit code (\d+)/` → `/\(exit code (\d+)\)/`
//       → the `failed with exit code 1` test reds, the `completed (exit code 0)` one stays
//         green — the asymmetry showing the two prose forms are pinned separately.
//   XX  a patch matching no text must REFUSE, not silently run the unmutated file.
import {
  parseBackgroundAck, parseBashNotification, shellIdsOf, bashStatusFrom,
  isOrphanSentinel, BASH_PROC_STATES,
} from '../shared/src/index'
import { check, passed as pass, failed as fail } from './assert.mjs'

// ── verbatim fixtures ────────────────────────────────────────────────────────────────────
const ACK = 'Command running in background with ID: btxytcvrw. Output is being written to: /tmp/claude-1000/-home-kleeorin-Work-Projects-Claudette/a4226728-7e02-4638-9b10-391737fae769/tasks/btxytcvrw.output. You will be notified when it completes. To check interim output, use Read on that file path.\nSession cwd remains /home/kleeorin/Work/Projects/Claudette; directory changes made by the backgrounded command do not apply to subsequent commands.'

const COMPLETED = '<task-notification>\n<task-id>b4mf80lqp</task-id>\n<tool-use-id>toolu_01PjSYEZWqTS7wvrkjZezmtg</tool-use-id>\n<output-file>/tmp/claude-1000/-home-kleeorin-Work-Projects-Claudette/62fb1b27-9edf-4904-aa94-ae5929b296cd/tasks/b4mf80lqp.output</output-file>\n<status>completed</status>\n<summary>Background command "Run the full suite baseline" completed (exit code 0)</summary>\n</task-notification>'

const FAILED = '<task-notification>\n<task-id>b4x5ti1bg</task-id>\n<tool-use-id>toolu_018E47N4mMQgqUpnRvWCNo1T</tool-use-id>\n<output-file>/tmp/claude-1000/-home-kleeorin-Work-Projects-Claudette/62fb1b27-9edf-4904-aa94-ae5929b296cd/tasks/b4x5ti1bg.output</output-file>\n<status>failed</status>\n<summary>Background command "Take the baseline on a clean tree with a fresh log dir" failed with exit code 1</summary>\n</task-notification>'

const ORPHAN = '<task-notification>\n<task-id>bbp2ym0hx</task-id>\n<task-id>bzj1c4nwh</task-id>\n<task-id>bd4rs0rnr</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>3 background shell command task(s) from the previous session have no completion record. They may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or they may have been running when the previous Claude Code process exited. They have been marked stopped.</summary>\n</task-notification>'

// ── the ack ──────────────────────────────────────────────────────────────────────────────
{
  const a = parseBackgroundAck(ACK)
  check('1 the ack yields the shell id WITHOUT the sentence full stop',
    a?.shellId === 'btxytcvrw',
    { pass: `shellId=${a?.shellId}`, fail: `shellId=${JSON.stringify(a?.shellId)} — \\S+ eats the trailing '.'` })
  check('2 …and the output path, stopping at .output rather than at whitespace',
    a?.outputFile?.endsWith('/tasks/btxytcvrw.output') === true, { pass: a?.outputFile ?? '' })
  check('3 a tool_result that is not an ack yields null',
    parseBackgroundAck('Command completed successfully.') === null)
}

// ── the settle envelopes ─────────────────────────────────────────────────────────────────
{
  const n = parseBashNotification(COMPLETED)!
  check('4 a completed envelope: one id, tool-use id, status and exit code',
    n.taskIds.length === 1 && n.taskIds[0] === 'b4mf80lqp'
      && n.toolUseId === 'toolu_01PjSYEZWqTS7wvrkjZezmtg'
      && n.status === 'completed' && n.exitCode === 0,
    { pass: `ids=${n.taskIds.join(',')} status=${n.status} exit=${n.exitCode}` })
  check('5 completed maps to done', bashStatusFrom(n.status) === 'done')
}

{
  const n = parseBashNotification(FAILED)!
  // ★ THE SECOND PROSE FORM. `failed with exit code 1` has no parentheses; a regex written
  // only against `(exit code 0)` reads undefined here and the detail view loses the number.
  check('6 the OTHER exit-code phrasing parses — "failed with exit code 1"',
    n.exitCode === 1 && n.status === 'failed',
    { pass: `exit=${n.exitCode}`, fail: `exit=${n.exitCode} — only the parenthesised form is matched` })
  check('7 failed maps to failed', bashStatusFrom(n.status) === 'failed')
}

// ── the multi-id orphan round-up — the shape the spec did not have ───────────────────────
{
  const n = parseBashNotification(ORPHAN)!
  check('8 EVERY task-id is read, not the first',
    n.taskIds.length === 4,
    { pass: `${n.taskIds.length} ids: ${n.taskIds.join(',')}`,
      fail: `${n.taskIds.length} id(s) — the rest are stranded as running forever` })
  check('9 the sentinel is filtered out of the shell ids',
    shellIdsOf(n).length === 3 && !shellIdsOf(n).some(isOrphanSentinel),
    { pass: shellIdsOf(n).join(','), fail: `${shellIdsOf(n).join(',')} — __orphan_summary__ renders as a phantom row` })
  check('10 the orphan round-up carries no tool-use id and no output file',
    n.toolUseId === undefined && n.outputFile === undefined)
  check('11 stopped maps to stopped — NOT unknown, and not failed',
    bashStatusFrom(n.status) === 'stopped',
    { pass: 'the CLI knows it was stopped; unknown would discard that',
      fail: `mapped to ${bashStatusFrom(n.status)}` })
  check('12 no exit code is invented when the summary carries none',
    n.exitCode === undefined,
    { fail: `exit=${n.exitCode} — defaulting to 0 would claim a clean exit nobody observed` })
}

// ── degradation ──────────────────────────────────────────────────────────────────────────
{
  check('13 text with no envelope yields null', parseBashNotification('just a normal turn') === null)
  check('14 an unrecognised CLI status degrades to unknown, not to failed',
    bashStatusFrom('someNewStatus') === 'unknown')
  // Queried, not listed — a sixth state must show up here without this file being edited.
  check('15 stopped is part of the exported state set',
    (BASH_PROC_STATES as readonly string[]).includes('stopped'),
    { pass: BASH_PROC_STATES.join(',') })
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
