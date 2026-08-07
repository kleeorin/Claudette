// Tests for stopping ONE subagent without killing the turn that spawned it
// (the tray's ■ button → session:stopTask → CLI control_request `stop_task`).
//
// The thing that makes this non-trivial: `stop_task` is keyed by the CLI's OWN task id,
// which is NOT the Task tool-use id the tray is built around. Both appear on the wire —
// `system/task_started` carries the pair — so the registry has to capture and pair them,
// or there is nothing to send. These tests pin that pairing and the control frame.
//
// Deterministic: the "CLI" is a stub that echoes each stdin line back as an event, so the
// exact bytes the engine writes are observable. No real `claude`, no network, no auth.
//   npx tsx scratchpad/stop-task-test.mts
import { ClaudeEngine } from '../server/src/claude/claudeEngine'
import { parseTaskStarted, taskIdOfNotification } from '../shared/src/tasks'
import type { ClaudeEvent } from '../shared/src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- 1. The wire parsers pair task_id with tool_use_id -----------------------
// Shapes copied from the CLI's own zod schemas:
//   task_started:      { task_id, tool_use_id?, description, subagent_type?, prompt, … }
//   task_notification: { task_id, tool_use_id?, status, output_file, summary, … }
const started = parseTaskStarted({
  type: 'system', subtype: 'task_started',
  task_id: 'task_abc', tool_use_id: 'toolu_123', description: 'Audit the server',
} as unknown as ClaudeEvent)
check('task_started yields the CLI task id', started?.taskId === 'task_abc', String(started?.taskId))
check('task_started yields the tool_use id it pairs with', started?.toolUseId === 'toolu_123', String(started?.toolUseId))

// tool_use_id is OPTIONAL in the schema. Without it there is no card to attach to, so the
// pairing must come back undefined rather than inventing one.
const noTool = parseTaskStarted({ type: 'system', subtype: 'task_started', task_id: 'task_x' } as unknown as ClaudeEvent)
check('task_started without a tool_use_id still parses', noTool?.taskId === 'task_x')
check('...but pairs with nothing (button stays hidden)', noTool?.toolUseId === undefined)

check('a non-task system event is ignored',
  parseTaskStarted({ type: 'system', subtype: 'init' } as unknown as ClaudeEvent) === null)
check('an event with no task_id is rejected',
  parseTaskStarted({ type: 'system', subtype: 'task_started', tool_use_id: 't' } as unknown as ClaudeEvent) === null)

// Late pickup: an agent already running when we attached has no task_started on our
// stream, but its terminal notification carries the same pair.
const settled = taskIdOfNotification({
  type: 'system', subtype: 'task_notification',
  task_id: 'task_late', tool_use_id: 'toolu_late', status: 'completed',
} as unknown as ClaudeEvent)
check('task_notification also carries the pair', settled?.taskId === 'task_late' && settled?.toolUseId === 'toolu_late')
check('task_notification without a tool_use_id yields nothing to attach',
  taskIdOfNotification({ type: 'system', subtype: 'task_notification', task_id: 'x' } as unknown as ClaudeEvent) === null)

// --- 2. The engine emits a well-formed stop_task control_request -------------
// Stub CLI: echo every line we write back out, wrapped so the engine surfaces it as an
// event. That makes the exact frame assertable.
const ECHO = `require('readline').createInterface({input:process.stdin})
  .on('line', l => console.log(JSON.stringify({ type: 'system', subtype: 'echo', raw: l })))`

const engine = new ClaudeEngine({
  command: process.execPath, args: ['-e', ECHO],
  cwd: process.cwd(), env: process.env as Record<string, string>,
})
const frames: Record<string, unknown>[] = []
engine.on('event', (e: ClaudeEvent) => {
  const o = e as { subtype?: string; raw?: unknown }
  if (o.subtype === 'echo' && typeof o.raw === 'string') {
    try { frames.push(JSON.parse(o.raw)) } catch { /* not our frame */ }
  }
})
engine.start()
await wait(400)

const stopPromise = engine.stopTask('task_abc')
await wait(400)

const req = frames.find((f) => (f.request as { subtype?: string } | undefined)?.subtype === 'stop_task')
check('engine wrote a stop_task control_request', !!req)
check('...typed as a control_request', req?.type === 'control_request')
check('...carrying the CLI task id (NOT the tool_use id)',
  (req?.request as { task_id?: string } | undefined)?.task_id === 'task_abc',
  JSON.stringify(req?.request))
check('...with a request_id so the response can be matched', typeof req?.request_id === 'string' && !!req?.request_id)

// The stub never answers, so the promise must settle on its own timeout rather than
// hanging a caller forever.
const settledResult = await Promise.race([stopPromise, wait(7000).then(() => 'HUNG' as const)])
check('an unanswered stop_task times out instead of hanging',
  settledResult !== 'HUNG' && typeof settledResult === 'object' && settledResult.ok === false,
  JSON.stringify(settledResult))

engine.kill()
await wait(400)

// A stop against a dead engine must resolve, not throw — a stale click from a second
// device lands here routinely.
const afterExit = await engine.stopTask('task_abc')
check('stop_task on a stopped engine resolves ok:false', afterExit.ok === false, JSON.stringify(afterExit))

// --- 3. The registry pairs the two ids onto the tray card -------------------
// recordTask is private (it runs off the engine's event tap); reach it directly so the
// pairing can be tested without a live `claude` turn that happens to spawn an agent.
const { SessionManager } = await import('../server/src/claude/sessionManager')
const sm = new SessionManager()
const feed = (e: unknown) => (sm as unknown as { recordTask(id: string, e: ClaudeEvent): void })
  .recordTask('S1', e as ClaudeEvent)

// The assistant's Task tool_use registers the card (this is what the tray renders).
feed({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'toolu_123', name: 'Task', input: { subagent_type: 'general-purpose', description: 'Audit the server' } }] },
})
check('registry: the Task tool_use registers a card', sm.tasksOf('S1').length === 1)
check('registry: a fresh card has no task id yet (nothing to stop by)', sm.tasksOf('S1')[0]?.taskId === undefined)

// task_started arrives next and supplies the stoppable handle.
feed({ type: 'system', subtype: 'task_started', task_id: 'task_abc', tool_use_id: 'toolu_123', description: 'Audit the server' })
check('registry: task_started attaches the CLI task id to that card',
  sm.tasksOf('S1')[0]?.taskId === 'task_abc', String(sm.tasksOf('S1')[0]?.taskId))
check('registry: the tool id is untouched (the two are distinct handles)',
  sm.tasksOf('S1')[0]?.toolId === 'toolu_123')

// A task_started for an agent we never saw a tool_use for must not invent a card.
feed({ type: 'system', subtype: 'task_started', task_id: 'task_ghost', tool_use_id: 'toolu_ghost' })
check('registry: task_started for an unknown card creates nothing', sm.tasksOf('S1').length === 1)

// Late pickup via the terminal notification, for an agent whose start we missed.
feed({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'toolu_late', name: 'Agent', input: { description: 'Late one' } }] },
})
feed({ type: 'system', subtype: 'task_notification', task_id: 'task_late', tool_use_id: 'toolu_late', status: 'completed', summary: 'done' })
const late = sm.tasksOf('S1').find((t) => t.toolId === 'toolu_late')
check('registry: a missed start is still paired from the notification', late?.taskId === 'task_late', String(late?.taskId))
check('registry: and that card settles as done', late?.status === 'done', String(late?.status))

// stopTask must refuse cleanly rather than throw, for every "can't stop that" shape.
const noSession = await sm.stopTask('NOPE', 'toolu_123')
check('stopTask: unknown session resolves ok:false', noSession.ok === false, JSON.stringify(noSession))
const noCard = await sm.stopTask('S1', 'toolu_nonexistent')
check('stopTask: unknown card resolves ok:false', noCard.ok === false)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
