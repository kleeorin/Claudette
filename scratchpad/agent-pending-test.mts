// F4 — STALE-SCOPE DETECTION. Does a RUNNING session notice that its role definition
// changed underneath it?
//
// The gap this closes: `launch()` copies the role's systemPrompt/model/allowedTools/
// disallowedTools/readOnly into the spawn ONCE. A running engine never re-reads agents.ts,
// so narrowing a role leaves every live session on the OLD, WIDER scope and nothing could
// report it. That is not hypothetical — after `reviewer` was narrowed from bare `Bash` to
// read-only git patterns, a live reviewer session was still holding the unscoped shell.
//
// `SessionInfo` already models configured-vs-effective twice (sandbox/sandboxed +
// sandboxPending, and connectorsPending). This is the third dimension, deliberately built
// to the same shape rather than as a new concept.
//
// Deterministic: `claude` is a stub on PATH. No real CLI, no auth, no network.
//   npx tsx scratchpad/agent-pending-test.mts
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Own data dir + cwd, for the same reasons team-test.mts documents: config-exposure state
// is per-cwd and per-machine, and a checkout that has ever been exposed refuses host-mode
// launches — which would look like a bug here and is not.
process.env.CLAUDETTE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claudette-agentpending-data-'))
const work = mkdtempSync(path.join(tmpdir(), 'claudette-agentpending-cwd-'))

// Shim BEFORE importing SessionManager — it spawns the literal command `claude`.
//
// BOTH the shim AND the stub it runs live INSIDE `work`, which is the session's cwd and
// therefore the one directory bwrap mounts. Sandbox is ON BY DEFAULT here (no config ⇒
// `{enabled:true, mounts:[cwd rw]}`), so a stub referenced at its scratchpad/ path dies
// inside the box with MODULE_NOT_FOUND — the engine exits, `s.engine` goes undefined, and
// `agentPending` reads false for a reason that has nothing to do with what is being tested.
// That failure looks exactly like "the feature does not work", which is why it is spelled
// out here rather than fixed silently.
copyFileSync(path.join(here, 'fake-claude-team.mjs'), path.join(work, 'fake-claude.mjs'))
const shim = path.join(work, 'claude')
writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(path.join(work, 'fake-claude.mjs'))} "$@"\n`)
chmodSync(shim, 0o755)
process.env.PATH = `${work}${path.delimiter}${process.env.PATH ?? ''}`
process.env.FAKE_TURN_MS = '50'

const { SessionManager } = await import('../server/src/claude/sessionManager')
const { AGENTS, agentKey } = await import('../server/src/claude/agents')

import { check, passed as pass, failed as fail } from './assert.mjs'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const sessions = new SessionManager({})
const pendingOf = (id: string) => sessions.get(id)?.agentPending

try {
  // --- 1. agentKey: what it is and is not sensitive to -----------------------
  const before = agentKey('reviewer')
  check('agentKey is stable across calls', agentKey('reviewer') === before)
  check('different roles get different keys', agentKey('reviewer') !== agentKey('planner'))

  // Display-only fields must NOT flip it, or every copy edit reports a pending relaunch.
  const savedDesc = AGENTS.reviewer.description
  AGENTS.reviewer.description = 'a totally different description'
  check('a DESCRIPTION edit does not change the key (display-only)', agentKey('reviewer') === before)
  AGENTS.reviewer.description = savedDesc

  // Each of the five fields launch() actually reads MUST flip it.
  const savedTools = AGENTS.reviewer.allowedTools
  AGENTS.reviewer.allowedTools = [...(savedTools ?? []), 'Bash']
  check('an allowedTools edit DOES change the key (this is the reviewer/Bash case)',
    agentKey('reviewer') !== before)
  AGENTS.reviewer.allowedTools = savedTools
  check('restoring the definition restores the key', agentKey('reviewer') === before)

  // --- 2. The lifecycle: launch → mutate → flips → relaunch → clears ---------
  const id = sessions.create('rev', work, work, undefined, false, undefined, 'reviewer')
  const other = sessions.create('plan', work, work, undefined, false, undefined, 'planner')
  await wait(400)   // let both engines spawn; agentPending is false while there is no engine

  check('a freshly launched session is NOT pending', pendingOf(id) === false, String(pendingOf(id)))
  check('…and neither is the second one', pendingOf(other) === false, String(pendingOf(other)))

  // THE CASE. Narrow the role out from under the running session — the session's OWN config is
  // untouched; only the shared role changed.
  //
  // ★ CORRECTED 2026-08-25. This comment used to read "exactly as editing agents.ts does". IT IS
  // NOT. What follows simulates a RUNTIME MUTATION of the in-memory role table, which is a real
  // trigger and the one this file covers. It is NOT the same as editing `agents.ts` on disk:
  // `AGENTS` is a module-level constant captured at first import and Node caches the module for
  // the process lifetime, so an on-disk edit cannot change what a running process sees. In that
  // case `agentKey()` returns the OLD digest, it equals `appliedAgentKey`, and agentPending stays
  // FALSE — stale compared against stale. A restart discharges it instead, so there is no regime
  // in which an on-disk edit lights this flag.
  // WHY THE CORRECTION MATTERS MORE THAN A WRONG SUITE BANNER: a wrong banner misleads whoever
  // reads run-suite.sh; a wrong comment inside a PASSING test misleads whoever reads the test to
  // learn what is actually guaranteed. This file is green, so nothing else will contradict it.
  // NOT COVERED HERE, both known: the on-disk case above, and the setAgent window — an ordinary
  // role switch assigns `session.agentId`, emits 'changed', and only THEN relaunches, so the
  // broadcast in between carries agentPending=true. MEASURED: exactly one broadcast, settling to
  // false once the relaunch lands (idle session; mid-turn not measured).
  // See "no per-session key can detect the process is older than the code on disk" in HANDOVER.md.
  AGENTS.reviewer.allowedTools = [...(savedTools ?? []), 'Bash']
  check('★ mutating the ROLE DEFINITION flips agentPending on the running session',
    pendingOf(id) === true, String(pendingOf(id)))
  check('★ …and does NOT flip a session holding a DIFFERENT role (no false alarm)',
    pendingOf(other) === false, String(pendingOf(other)))

  // The session's agentId never changed — which is precisely why keying on the id alone
  // could not have detected this.
  check('the session still reports the same agentId (the id did not change, the definition did)',
    sessions.get(id)?.agentId === 'reviewer', String(sessions.get(id)?.agentId))

  // Relaunch re-reads the definition and re-snapshots the key.
  sessions.relaunchApply(id)
  await wait(400)
  check('★ relaunching CLEARS agentPending', pendingOf(id) === false, String(pendingOf(id)))

  // And it clears against the NEW definition, not by reverting to the old one.
  check('the cleared session is running the NEW scope', (() => {
    AGENTS.reviewer.allowedTools = savedTools          // put the old one back
    return pendingOf(id) === true                       // now the OLD definition is the pending one
  })(), String(pendingOf(id)))
  AGENTS.reviewer.allowedTools = [...(savedTools ?? []), 'Bash']
  check('…and restoring what it launched with clears it again', pendingOf(id) === false)
  AGENTS.reviewer.allowedTools = savedTools

  // --- 3. Negative control: no engine, no pending ----------------------------
  // agentPending is gated on a RUNNING engine — a session with none has no stale scope to
  // report, and claiming otherwise would light the chip for every exited session.
  sessions.destroy(other)
  await wait(200)
  check('a destroyed session reports no pending flag at all', pendingOf(other) === undefined,
    String(pendingOf(other)))
} finally {
  try { sessions.shutdown?.() } catch { /* best effort */ }
  await wait(150)
  try { sessions.killHard?.() } catch { /* best effort */ }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
