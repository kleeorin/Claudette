// readBashProcOutput — the filesystem half of GET /api/session/:id/bashProc/:toolId/output.
//
// ★ REAL FILES AND A REAL PROCESS TREE, NOT A MOCK. A mock here would return whatever it was
// told to and assert nothing: the whole difficulty of this function is paths and process
// lifetimes, so every case below writes an actual file or spawns an actual child.
//
// ★★ THE ASSERTION THAT IS NOT ABOUT FILE I/O AT ALL — "an engine that has gone away".
// Once the engine is gone, output is unretrievable for BOTH tiers, DELIBERATELY. A confined
// session's file dies with its namespace so it is genuinely impossible; an UNCONFINED session's
// file survives on the real /tmp and we refuse to read it anyway. That is a levelling DOWN: a
// panel that remembers for some sessions and forgets for others is the two-tier outcome this
// design rejected. The case below therefore writes a file that EXISTS AND IS READABLE and
// asserts we decline it — an implementation that "helpfully" returned the content would pass
// every other test in this file.
//
// MUTATIONS (measured 2026-09-23, ran=N alongside since a mutant that fails to PARSE yields
// zero failures exactly like a clean pass):
// All four measured at ran=17 — constant, which is what shows none died on a parse error.
// Red sets are AS MEASURED; two contradict what I predicted and the measurement is kept:
//   O1  drop the `!engineAlive` guard        → red=2 (the levelling-down case AND its reason
//       assertion). I predicted "alone"; the reason case reds with it, which is the better
//       signal — it shows the user-facing wording is pinned, not just the boolean.
//   O2  return the HEAD instead of the tail  → red=3, not 1: truncated, tail-not-head, AND
//       the cap assertion, because reading from offset 0 also returns more than maxBytes.
//   O3  `truncated` hardcoded false          → red=1, alone. Predicted correctly.
//   O4  innerPidOf never walks               → red=1, alone. Predicted correctly.
//   XX  a patch matching no text must REFUSE — it did, 0 matches, no run performed.
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { check, passed as pass, failed as fail } from './assert.mjs'
import { readBashProcOutput, innerPidOf, MAX_OUTPUT_BYTES } from '../server/src/claude/bashProcOutput.js'

const dir = mkdtempSync(path.join(tmpdir(), 'claudette-bpout-'))
const real = path.join(dir, 'live.output')
const absent = path.join(dir, 'never-written.output')

// An UNCONFINED session (sandboxed:false) resolves to the path itself, so these exercise the
// real read path end to end without needing a sandbox.
const live = (outputFile: string | undefined, over: Partial<Parameters<typeof readBashProcOutput>[0]> = {}) =>
  readBashProcOutput({ outputFile, engineAlive: true, enginePid: process.pid, sandboxed: false, ...over })

try {
  writeFileSync(real, 'LINE-ONE\n')
  const r1 = live(real)
  check('a real file is retrievable and returns its contents',
    r1.retrievable === true && r1.output === 'LINE-ONE\n', JSON.stringify(r1))
  check('…and is not marked truncated', r1.retrievable === true && r1.truncated === false, JSON.stringify(r1))

  // Appends are picked up — this is a live log, not a snapshot taken at launch.
  writeFileSync(real, 'LINE-ONE\nLINE-TWO\n')
  const r2 = live(real)
  check('an appended file reads back the NEW contents',
    r2.retrievable === true && r2.output.includes('LINE-TWO'), JSON.stringify(r2))

  // ── TRUNCATION: the TAIL, because a user opening this wants the latest output ────────────
  const big = path.join(dir, 'big.output')
  writeFileSync(big, 'HEAD-MARKER\n' + 'x'.repeat(MAX_OUTPUT_BYTES) + '\nTAIL-MARKER\n')
  const r3 = live(big)
  check('an oversized file is marked truncated', r3.retrievable === true && r3.truncated === true, JSON.stringify({ ...r3, output: '<omitted>' }))
  check('★ truncation keeps the TAIL and drops the head',
    r3.retrievable === true && r3.output.includes('TAIL-MARKER') && !r3.output.includes('HEAD-MARKER'),
    r3.retrievable === true ? `head=${r3.output.includes('HEAD-MARKER')} tail=${r3.output.includes('TAIL-MARKER')}` : 'not retrievable')
  check('…and returns no more than the cap', r3.retrievable === true && Buffer.byteLength(r3.output) <= MAX_OUTPUT_BYTES, 'over cap')

  // An empty file is a real, ordinary state: retrievable, just empty.
  const empty = path.join(dir, 'empty.output')
  writeFileSync(empty, '')
  const r4 = live(empty)
  check('an empty file is retrievable with empty output, not an error',
    r4.retrievable === true && r4.output === '' && r4.truncated === false, JSON.stringify(r4))

  // ── THE UNRETRIEVABLE CASES, each with a reason written for a user ──────────────────────
  const r5 = live(absent)
  check('a file that was never written is NOT retrievable', r5.retrievable === false, JSON.stringify(r5))
  check('…and says nothing has been written yet',
    r5.retrievable === false && /written/i.test(r5.reason), JSON.stringify(r5))

  const r6 = live(undefined)
  check('a record with no outputFile is NOT retrievable', r6.retrievable === false, JSON.stringify(r6))
  check('…and says no output file has been reported',
    r6.retrievable === false && /output file/i.test(r6.reason), JSON.stringify(r6))

  // ★ THE TWO "not yet" REASONS MUST NEVER COLLAPSE INTO ONE STRING.
  // Both render as a blank pane, and they tell the user opposite things: "no output file has
  // been reported" means the launch acknowledgement has not arrived, so keep waiting; "nothing
  // has been written" means the file exists and the command has printed nothing, so the
  // command itself may be the slow part. The regex cases above pass for either wording and so
  // cannot see a merge — only comparing them can. Restored after a rewrite of this file
  // dropped it; the regexes alone left the distinction untested.
  check('★ the two "not yet" reasons are DISTINCT, not one string serving both',
    r5.retrievable === false && r6.retrievable === false && r5.reason !== r6.reason,
    `${(r5 as { reason: string }).reason} vs ${(r6 as { reason: string }).reason}`)

  // ★★ THE LEVELLING-DOWN CASE. The file EXISTS and is READABLE; we decline it anyway.
  const r7 = live(real, { engineAlive: false })
  check('★★ a READABLE file is refused once the engine is gone (both tiers level down)',
    r7.retrievable === false, JSON.stringify(r7))
  check('…and the reason names the stopped engine, so a user knows it is not coming back',
    r7.retrievable === false && /engine/i.test(r7.reason) && /stopped|no longer/i.test(r7.reason), JSON.stringify(r7))

  // A confined session with no live process cannot be reached at all.
  const r8 = readBashProcOutput({ outputFile: real, engineAlive: true, enginePid: undefined, sandboxed: true })
  check('a sandboxed record with no engine pid is NOT retrievable', r8.retrievable === false, JSON.stringify(r8))

  // ── innerPidOf, against a REAL process tree ─────────────────────────────────────────────
  // `sh -c 'exec sleep 5'` would exec in place and leave no child, so spawn a shell that
  // genuinely forks: the outer is the shell, the inner is sleep.
  const outer = spawn('sh', ['-c', 'sleep 5 & wait'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 400))
  const inner = innerPidOf(outer.pid!)
  check('★ innerPidOf walks from the outer process to its child',
    inner !== outer.pid && inner > 0, `outer=${outer.pid} inner=${inner}`)
  outer.kill('SIGKILL')

  // A process with NO children is its own inner pid — the right answer for an UNSANDBOXED
  // session, where the spawned command is `claude` itself and no walk is wanted.
  // `sleep` spawned directly (not via a shell) genuinely has no children; an earlier version
  // of this case asked about `process.pid` and OR'd in `> 0`, which passed for essentially any
  // return value and asserted nothing — this tsx process has children of its own.
  const childless = spawn('sleep', ['5'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 400))
  check('innerPidOf returns the pid UNCHANGED when the process has no child',
    innerPidOf(childless.pid!) === childless.pid, `pid=${childless.pid} got=${innerPidOf(childless.pid!)}`)
  childless.kill('SIGKILL')

  // A dead pid must not throw.
  check('innerPidOf on a dead pid returns it unchanged rather than throwing',
    innerPidOf(2147483600) === 2147483600, String(innerPidOf(2147483600)))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
