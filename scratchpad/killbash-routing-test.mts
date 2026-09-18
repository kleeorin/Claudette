// session:killBash — the transport hop and the REGISTRY it resolves against.
//
// ★ THE BUG THIS EXISTS TO CATCH, STATED PRECISELY. `SessionManager.stopTask(id, toolId)` and
// `SessionManager.stopBashProc(id, toolId)` take identically-shaped arguments and consult
// DIFFERENT maps: stopTask looks `toolId` up in the SUBAGENT registry (`tasks`), stopBashProc
// in the BACKGROUND-SHELL registry (`bashProcs`). A background shell is never in the subagent
// map, so wiring the kill button to stopTask — the obvious-looking reuse, and one line away —
// declines EVERY kill with "this agent has no stoppable task id" before the CLI is ever asked.
// The symptom reads like a dead session rather than a lookup in the wrong map, which is what
// makes it worth a dedicated guard rather than a comment.
//
// ★ WHY THIS IS NOT A LIVE-PROCESS TEST, AND WHY THAT IS NOT A GAP. The question here is "which
// id reaches the CLI", which is fully decided by server code and is asserted at the wire
// boundary: the fake engine below records exactly what `engine.stopTask()` was handed. The
// OTHER half — "does the CLI actually kill a shell when given a shell id" — is CLI behaviour,
// and it is ALREADY SETTLED BY MEASUREMENT, so nothing here needs to re-prove it:
//
//   .claude/plans/background-processes-panel.md, "Q1 — Does stop_task accept a background-shell
//   id? YES." Verified by PROCESS DEATH (marker pids present before, absent after), deliberately
//   checked by artefact rather than by the response, because the CLI answers a stop for an
//   unknown or already-finished task with SUCCESS.
//
// The two halves rest on different evidence and neither re-proves the other's: Q1 established
// that the CLI kills given the right id; this file establishes that the right id is what gets
// there. Taken ALONE, though, a green run here is still compatible with a CLI that ignores
// stop_task entirely — so cite Q1 alongside it rather than reading this file as end-to-end proof.
//
// ⚠ A related note for anyone extending this with a live check: `ps`/`pgrep` are
// PID-namespace-blind inside a confined session, so a process-liveness probe run from a box is
// evidence only about that box and will report a surviving host process as gone. It must be run
// unconfined. And verify a kill by the process being GONE, never by a return value — the engine
// answers a stop for an already-finished or unknown task with SUCCESS, so `ok:true` is not
// evidence that anything died.

import { check, failed as fail } from './assert.mjs'
import { SessionManager } from '../server/src/claude/sessionManager.js'
import { handleSessionClientMessage } from '../server/src/session/sessionApi.js'

// What the fake engine was asked to stop, in order. This is the wire boundary: engine.stopTask
// is the last thing server code controls before the CLI sees a control_request.
const stopped: string[] = []
const fakeEngine = {
  stopTask: async (taskId: string) => { stopped.push(taskId); return { ok: true as const } },
}

const SESSION = 's1'
const TOOL = 'toolu_shared_by_both_registries'
const SHELL_ID = 'btxytcvrw'          // what the CLI's background ack carries
const SUBAGENT_TASK_ID = 'task-abc'   // what the subagent registry holds for the SAME tool id

// Reaching into the private maps rather than driving a real turn: the method under test is the
// LOOKUP, so the fixture has to be able to put deliberately different values in the two
// registries — which a real session can never do and which is exactly the confusion being
// guarded against.
function freshManager(): SessionManager {
  stopped.length = 0
  const m = new SessionManager()
  const priv = m as unknown as {
    sessions: Map<string, unknown>
    tasks: Map<string, Map<string, unknown>>
    bashProcs: Map<string, Map<string, unknown>>
  }
  priv.sessions.set(SESSION, { engine: fakeEngine })
  return m
}

// ── 1. THE CORE DISCRIMINATION ────────────────────────────────────────────────────────────
// The same tool id in BOTH registries, mapped to DIFFERENT ids. If stopBashProc read the wrong
// map this assertion fails with the other id in hand, naming the bug rather than just failing.
{
  const m = freshManager()
  const priv = m as unknown as { tasks: Map<string, Map<string, unknown>>; bashProcs: Map<string, Map<string, unknown>> }
  priv.tasks.set(SESSION, new Map([[TOOL, { toolId: TOOL, taskId: SUBAGENT_TASK_ID }]]))
  priv.bashProcs.set(SESSION, new Map([[TOOL, { toolId: TOOL, shellId: SHELL_ID, status: 'running' }]]))

  const r = await m.stopBashProc(SESSION, TOOL)
  check('stopBashProc succeeds for a registered shell', r.ok === true, JSON.stringify(r))
  check('★ and it sends the SHELL id to the engine, not the subagent task id',
    stopped.length === 1 && stopped[0] === SHELL_ID,
    `engine was asked to stop ${JSON.stringify(stopped)} — expected [${SHELL_ID}]`)

  // The CONTROL that makes the assertion above mean something: stopTask on the same tool id
  // must reach the OTHER id. Without this, both registries could hold the shell id and the
  // test above would pass for the wrong reason.
  stopped.length = 0
  const t = await m.stopTask(SESSION, TOOL)
  check('CONTROL: stopTask on the same tool id resolves the SUBAGENT id instead',
    t.ok === true && stopped[0] === SUBAGENT_TASK_ID,
    `engine was asked to stop ${JSON.stringify(stopped)} — expected [${SUBAGENT_TASK_ID}]`)
}

// ── 2. THE PRODUCTION SHAPE: a shell is in ONE registry only ──────────────────────────────
// This is what a real background shell looks like — present in bashProcs, absent from tasks.
// It demonstrates the actual consequence of the wrong wiring rather than an artificial clash.
{
  const m = freshManager()
  const priv = m as unknown as { bashProcs: Map<string, Map<string, unknown>> }
  priv.bashProcs.set(SESSION, new Map([[TOOL, { toolId: TOOL, shellId: SHELL_ID, status: 'running' }]]))

  const viaBash = await m.stopBashProc(SESSION, TOOL)
  check('a real shell (in bashProcs only) CAN be stopped via stopBashProc', viaBash.ok === true,
    JSON.stringify(viaBash))

  stopped.length = 0
  const viaTask = await m.stopTask(SESSION, TOOL)
  check('★ …and routing that same shell through stopTask would DECLINE it',
    viaTask.ok === false, JSON.stringify(viaTask))
  check('★ …without the CLI ever being asked (the kill never leaves the server)',
    stopped.length === 0, `engine saw ${JSON.stringify(stopped)}`)
}

// ── 3. THE GUARDS ─────────────────────────────────────────────────────────────────────────
{
  const m = freshManager()
  const priv = m as unknown as { bashProcs: Map<string, Map<string, unknown>>; sessions: Map<string, unknown> }
  // A shell whose background ack has not arrived yet (or was never replayed into a resumed
  // conversation) legitimately has no shellId. It must not become a stop for `undefined`.
  priv.bashProcs.set(SESSION, new Map([[TOOL, { toolId: TOOL, status: 'running' }]]))
  const noId = await m.stopBashProc(SESSION, TOOL)
  check('a shell with no shellId yet is declined', noId.ok === false, JSON.stringify(noId))
  check('…and nothing is sent to the engine (never a stop for undefined)',
    stopped.length === 0, `engine saw ${JSON.stringify(stopped)}`)

  check('an unknown tool id is declined', (await m.stopBashProc(SESSION, 'nope')).ok === false, '')
  check('an unknown session is declined', (await m.stopBashProc('nosuch', TOOL)).ok === false, '')

  // A session whose engine has exited is relaunchable, so its records outlive the process.
  priv.sessions.set(SESSION, { engine: null })
  const dead = await m.stopBashProc(SESSION, TOOL)
  check('a session whose engine has exited is declined rather than throwing',
    dead.ok === false, JSON.stringify(dead))
}

// ── 4. THE WS DISPATCH HOP ────────────────────────────────────────────────────────────────
// handleSessionClientMessage must CLAIM session:killBash (return true) and route it to
// stopBashProc. Returning false would fall through to the caller's other handlers and the
// message would be silently dropped — which is the state this whole task started in.
{
  const calls: string[] = []
  const stub = {
    stopBashProc: async (_id: string, toolId: string) => { calls.push(`bash:${toolId}`); return { ok: true as const } },
    stopTask: async (_id: string, toolId: string) => { calls.push(`task:${toolId}`); return { ok: true as const } },
  } as unknown as SessionManager
  const hub = { broadcast: () => {}, send: () => {} } as never

  const claimed = handleSessionClientMessage(stub, { type: 'session:killBash', id: SESSION, toolId: TOOL }, hub)
  check('session:killBash is CLAIMED by the dispatcher (not dropped through to default)',
    claimed === true, `returned ${claimed}`)
  // The handler is fire-and-forget, so the call lands on a microtask.
  await new Promise((r) => setImmediate(r))
  check('★ …and it is routed to stopBashProc, not stopTask',
    calls.length === 1 && calls[0] === `bash:${TOOL}`,
    `calls were ${JSON.stringify(calls)}`)

  // CONTROL: the dispatcher must be able to return false, or "returns true" proves nothing.
  const unknown = handleSessionClientMessage(stub, { type: 'ping' } as never, hub)
  check('CONTROL: an unrelated message type still returns false',
    unknown === false, `returned ${unknown}`)
}

process.exit(fail === 0 ? 0 : 1)
