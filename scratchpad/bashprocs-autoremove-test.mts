// Background shells are REMOVED from the registry the moment they settle — the user's rule:
// no "Clear finished", no ×; a sidebar ▶ row disappears as soon as its process ends.
//
// Every settle path is driven, and each must (a) delete the record from bashProcsOf(id) and
// (b) emit 'bashProcs' + 'changed' so every client repaints:
//   1. prose <task-notification> on a user turn, keyed by tool-use-id       (completed)
//   2. the same envelope resolved by SHELL id — the CLI's orphan round-up    (stopped)
//   3. the structured system/task_notification                               (failed)
//   4. a KILL — stopBashProc mutates nothing; the shell settles through the CLI's own
//      notification with status "stopped", which is path 3 with that status
//   5. ENGINE DEATH — the exit handler's settleOpenBashProcs (a real kill/exit/relaunch of
//      the stub engine, not a direct call)
// plus the control the whole feature hangs on: a RUNNING record is never removed.
//
// Events are fed through the private recordBashProc tap (the only public way in is a real CLI
// turn that backgrounds a shell). ASSERTIONS read bashProcsOf() and the emitted events — the
// same accessor and signals the broadcast uses. Notification text is the verbatim shape from
// bash-procs-parse-test.mts with our ids substituted.
//   npx tsx scratchpad/bashprocs-autoremove-test.mts
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { check, passed as pass, failed as fail } from './assert.mjs'
import type { BashProcRecord, ClaudeEvent } from '../shared/src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.CLAUDETTE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claudette-bpauto-data-'))
const work = mkdtempSync(path.join(tmpdir(), 'claudette-bpauto-cwd-'))
copyFileSync(path.join(here, 'fake-claude-team.mjs'), path.join(work, 'fake-claude.mjs'))
const shim = path.join(work, 'claude')
writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(path.join(work, 'fake-claude.mjs'))} "$@"\n`)
chmodSync(shim, 0o755)
process.env.PATH = `${work}${path.delimiter}${process.env.PATH ?? ''}`
process.env.FAKE_TURN_MS = '20'

const { SessionManager } = await import('../server/src/claude/sessionManager.js')
const sessions = new SessionManager({})
const tap = (id: string, e: unknown) =>
  (sessions as unknown as { recordBashProc(id: string, e: ClaudeEvent): void }).recordBashProc(id, e as ClaudeEvent)

const launch = (toolId: string, command = 'npm run build') => ({
  type: 'assistant', message: { content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command, run_in_background: true } }] },
})
const ack = (toolId: string, shellId: string) => ({
  type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolId,
    content: `Command running in background with ID: ${shellId}. Output is being written to: /tmp/claude-1000/x/tasks/${shellId}.output. You will be notified when it completes.` }] },
})
const prose = (toolId: string, shellId: string) => ({
  type: 'user', message: { content: `<task-notification>\n<task-id>${shellId}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<output-file>/tmp/claude-1000/x/tasks/${shellId}.output</output-file>\n<status>completed</status>\n<summary>Background command "build" completed (exit code 0)</summary>\n</task-notification>` },
})
const orphan = (shellIds: string[]) => ({
  type: 'user', message: { content: `<task-notification>\n${shellIds.map((s) => `<task-id>${s}</task-id>\n`).join('')}<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>${shellIds.length} background shell command task(s) from the previous session have no completion record. They have been marked stopped.</summary>\n</task-notification>` },
})
const structured = (toolId: string, status: string) => ({ type: 'system', subtype: 'task_notification', tool_use_id: toolId, status, summary: `x ${status}` })

let bashEmits: { id: string; procs: BashProcRecord[] }[] = []
let changedEmits = 0
sessions.on('bashProcs', (id: string, procs: BashProcRecord[]) => bashEmits.push({ id, procs }))
sessions.on('changed', () => { changedEmits++ })
const reset = () => { bashEmits = []; changedEmits = 0 }
const ids = (sid: string) => sessions.bashProcsOf(sid).map((r) => r.toolId).sort().join(',')
// The removal was broadcast: the LAST bashProcs emit for `sid` no longer lists `toolId`.
const broadcastGone = (sid: string, toolId: string) => {
  const last = bashEmits.filter((e) => e.id === sid).at(-1)
  return !!last && !last.procs.some((r) => r.toolId === toolId) && changedEmits > 0
}

const S = 'sess-a'
try {
  // ── THE CONTROL: running records stay ────────────────────────────────────────────────────
  tap(S, launch('t1')); tap(S, launch('t2')); tap(S, launch('t3')); tap(S, launch('t4'))
  tap(S, ack('t1', 'sh1')); tap(S, ack('t2', 'sh2')); tap(S, ack('t3', 'sh3')); tap(S, ack('t4', 'sh4'))
  check('four launched + acked shells are all present while running', ids(S) === 't1,t2,t3,t4', ids(S))
  check('…all of them still "running"', sessions.bashProcsOf(S).every((r) => r.status === 'running'))

  // ── 1. prose notification by tool-use-id ─────────────────────────────────────────────────
  reset(); tap(S, prose('t1', 'sh1'))
  check('1 prose <task-notification> (completed) removes the record', ids(S) === 't2,t3,t4', ids(S))
  check('1 …and the removal is broadcast (bashProcs without it + changed)', broadcastGone(S, 't1'), `${bashEmits.length} bashProcs, ${changedEmits} changed`)

  // ── 2. orphan round-up by shell id ───────────────────────────────────────────────────────
  reset(); tap(S, orphan(['sh2']))
  check('2 orphan round-up (by shell id, stopped) removes the record', ids(S) === 't3,t4', ids(S))
  check('2 …broadcast', broadcastGone(S, 't2'))

  // ── 3. structured system/task_notification ───────────────────────────────────────────────
  reset(); tap(S, structured('t3', 'failed'))
  check('3 system/task_notification (failed) removes the record', ids(S) === 't4', ids(S))
  check('3 …broadcast', broadcastGone(S, 't3'))

  // ── 4. kill: settles through the CLI's "stopped" notification ────────────────────────────
  reset(); tap(S, structured('t4', 'stopped'))
  check('4 a killed shell (notification status "stopped") is removed', ids(S) === '', ids(S))
  check('4 …broadcast as an empty list', broadcastGone(S, 't4') && bashEmits.at(-1)!.procs.length === 0)

  // A late duplicate notification for a removed record is a no-op — no resurrection, no emit.
  reset(); tap(S, prose('t1', 'sh1')); tap(S, ack('t1', 'sh1'))
  check('a late notification/ack for a removed record does not resurrect it', ids(S) === '', ids(S))
  check('…and emits nothing', bashEmits.length === 0, String(bashEmits.length))

  // An unrelated settle must leave a running record alone (no blanket delete).
  tap(S, launch('t5')); tap(S, ack('t5', 'sh5')); tap(S, launch('t6'))
  tap(S, structured('t6', 'completed'))
  check('settling one shell leaves the other running one in place', ids(S) === 't5', ids(S))

  // ── 5. engine death, through the real exit handler ───────────────────────────────────────
  const live = sessions.create('bp', work, work, undefined, false)
  check('stub engine is up', await sessions.whenReady(live, 5000))
  tap(live, launch('d1')); tap(live, ack('d1', 'shd1')); tap(live, launch('d2'))
  check('5 two running shells on the live session', ids(live) === 'd1,d2', ids(live))
  reset()
  sessions.relaunchApply(live)               // kill → exit handler → relaunch
  check('5 relaunch completed', await sessions.whenReady(live, 5000))
  check('5 engine death removes every running record', ids(live) === '', ids(live))
  check('5 …broadcast', broadcastGone(live, 'd1') && broadcastGone(live, 'd2'), `${bashEmits.length} bashProcs, ${changedEmits} changed`)

  // ── persistence: nothing finished is saved or restored ──────────────────────────────────
  tap(live, launch('p1'))
  const saved = sessions.saved().find((x) => x.name === 'bp')
  check('saved() writes only the running record', saved?.bashProcs?.map((r) => r.toolId).join(',') === 'p1', JSON.stringify(saved?.bashProcs?.map((r) => r.toolId)))
  const rec = (toolId: string, status: BashProcRecord['status']): BashProcRecord =>
    ({ toolId, command: 'x', startedAt: 1, status, ...(status === 'running' ? {} : { endedAt: 2 }) })
  const [rid] = sessions.restore([{ name: 'restored', cwd: work, bashProcs: [
    rec('r-run', 'running'), rec('r-done', 'done'), rec('r-failed', 'failed'), rec('r-stopped', 'stopped'), rec('r-unknown', 'unknown'),
  ] }])
  check('restore(): finished records (from an older build) do not come back', !sessions.bashProcsOf(rid).some((r) => r.toolId !== 'r-run'), ids(rid))
  check('restore(): a once-running record (its shell died with the server) does not come back either', ids(rid) === '', ids(rid))
  check('…so saved() omits the registry for it', sessions.saved().find((x) => x.name === 'restored')?.bashProcs === undefined)
} finally {
  sessions.shutdown()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
