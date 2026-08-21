// E2E for the notebook RUN-STATE surface Claude sees. The bug: the MCP tools exposed
// none of the execution state the server already tracks, so a notebook that was merely
// busy read to Claude as a stuck one —
//   • read_notebook's `kernel` was `doc.kernelId ? 'running' : 'none'` (i.e. "a kernel is
//     bound"), so an IDLE kernel reported "running" and a BUSY one reported the same;
//   • a cell mid-execution was byte-identical to a finished one — same stale outputs,
//     same executionCount — so polling looked like nothing was happening;
//   • run_cell on an already-executing cell was silently ignored by KernelManager and the
//     handler returned the PREVIOUS run's outputs as if they were this run's result.
// Now: kernel/busy/runningCells on read_notebook + read_active_pane, a `running: true`
// flag per cell, a dedicated notebook_status poll, `started: false` for a duplicate run,
// and interrupt_kernel for a genuinely wedged cell.
//
// Drives the REAL tool handlers against a real NotebookDocManager + KernelManager, with a
// real Jupyter kernel (a sleeping cell is the only honest way to observe "busy").
//
//   npx tsx scratchpad/notebook-runstate-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager'
import { KernelManager } from '../server/src/jupyter/kernelManager'
import { ActivePaneRegistry } from '../server/src/mcp/activePaneRegistry'
import { TurnNotebookRegistry } from '../server/src/mcp/turnNotebookRegistry'
import { registerNotebookTools } from '../server/src/mcp/notebookTools'
import { SessionConfinement } from '../server/src/claude/sessionConfinement'
import type { AppControlMcpServer, McpTool, McpToolResult } from '../server/src/mcp/appControlServer'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runstate-'))
const SID = 'session-1'
// Unconfined (`host`) session: this test is about run-state reporting, not the sandbox,
// and a host session runs its kernel on the shared Jupyter server.
const confinement = new SessionConfinement((id) => (id === SID ? { cwd: dir } : undefined))

const docs = new NotebookDocManager()
const kernels = new KernelManager(docs, confinement)
const panes = new ActivePaneRegistry()
const turns = new TurnNotebookRegistry()

const handlers = new Map<string, McpTool['handler']>()
const fakeMcp = { register: (t: McpTool) => handlers.set(t.name, t.handler) } as unknown as AppControlMcpServer
registerNotebookTools(fakeMcp, docs, kernels, panes, turns,
  (sid, doc) => { kernels.setOwner(doc.notebookId, { session: sid }) },
  () => {},
  confinement,
)
const call = (name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> => handlers.get(name)!(SID, args)
const json = async (name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const r = await call(name, args)
  if (r.error) throw new Error(`${name} failed: ${r.error}`)
  return JSON.parse(r.text!)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Poll notebook_status the way Claude is now told to. Doubles as the assertion that the
// tool is cheap and safe to call WHILE a run is in flight.
async function waitFor(pred: (s: any) => boolean, label: string, timeoutMs = 90_000): Promise<any> {
  const t0 = Date.now()
  for (;;) {
    const s = await json('notebook_status')
    if (pred(s)) return s
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(s)})`)
    await sleep(150)
  }
}

const nb = path.join(dir, 'run.ipynb')

await (async () => {
  const created = await call('create_notebook', { path: nb })
  check('create_notebook succeeds', !created.error, created.error)
  // Cell 0 sleeps long enough to observe; cell 1 exists so run_all has something QUEUED
  // behind it (queued cells are `running` too — that's what the UI's `[*]` means).
  await call('edit_cell', { index: 0, source: "import time\ntime.sleep(6)\nprint('slept')" })
  await call('add_cell', { type: 'code', source: "print('second')" })

  // --- 1. Idle notebook, before anything has run ------------------------------
  const idle0 = await json('notebook_status')
  check('idle notebook reports kernel "none", not "running"', idle0.kernel === 'none', `kernel=${idle0.kernel}`)
  check('idle notebook is not busy', idle0.busy === false && idle0.runningCells.length === 0)
  const rIdle = await call('interrupt_kernel')
  check('interrupt_kernel on an idle notebook reports nothing to interrupt',
    !rIdle.error && /nothing to interrupt/.test(rIdle.text ?? ''), rIdle.text)

  // --- 2. While a run is in flight --------------------------------------------
  console.log('\n[run_all in flight]')
  const running = json('run_all')            // deliberately NOT awaited
  const busy = await waitFor((s) => s.busy, 'the kernel to go busy')
  check('notebook_status reports busy while cells run', busy.busy === true)
  check('notebook_status names the running/queued cells', JSON.stringify(busy.runningCells) === '[0,1]', JSON.stringify(busy.runningCells))
  check('notebook_status carries the "working, not stuck" note', /not stuck/.test(busy.note ?? ''))
  check('kernel status is the real one (busy/starting), never "none" while cells run',
    ['busy', 'starting'].includes(busy.kernel), `kernel=${busy.kernel}`)

  const readBusy = await json('read_notebook')
  check('read_notebook flags the executing cell with running: true', readBusy.cells[0].running === true)
  check('read_notebook flags the QUEUED cell too', readBusy.cells[1].running === true)
  check('read_notebook reports busy + runningCells', readBusy.busy === true && JSON.stringify(readBusy.runningCells) === '[0,1]')

  // The old silent no-op: a second run_cell on a cell that's already executing came back
  // instantly carrying the previous run's outputs, reading as a completed run.
  const dup = await json('run_cell', { index: 0 })
  check('run_cell on an already-running cell reports started: false', dup.started === false)
  check('run_cell refusal does NOT hand back stale outputs as a result', dup.outputs === undefined && dup.executionCount === undefined)
  const dupAll = await json('run_all')
  check('run_all refuses to overlap a run already in flight', dupAll.started === false)

  // --- 3. After it finishes ----------------------------------------------------
  const finished = await running
  check('run_all eventually returns the real outputs', /slept/.test(JSON.stringify(finished)), JSON.stringify(finished).slice(0, 160))
  check('finished cells are no longer flagged running', finished.every((c: any) => c.running === undefined))
  const idle1 = await waitFor((s) => !s.busy, 'the kernel to go idle')
  check('notebook_status returns to idle when the run completes', idle1.busy === false && idle1.kernel === 'idle', `kernel=${idle1.kernel}`)
  check('an idle notebook carries no busy note', idle1.note === undefined)

  // --- 4. read_active_pane carries the same state ------------------------------
  panes.set(SID, { path: nb, isNotebook: true })
  const pane = await json('read_active_pane')
  check('read_active_pane reports the notebook kernel state', pane.kernel === 'idle' && pane.busy === false, JSON.stringify(pane))

  // --- 5. interrupt_kernel on a genuinely wedged cell ---------------------------
  console.log('\n[interrupt]')
  await call('edit_cell', { index: 0, source: "import time\ntime.sleep(300)\nprint('never')" })
  const wedged = json('run_cell', { index: 0 })   // not awaited
  await waitFor((s) => s.busy, 'the wedged cell to start')
  const ri = await call('interrupt_kernel')
  check('interrupt_kernel reports what it interrupted', !ri.error && /Interrupt sent/.test(ri.text ?? ''), ri.error ?? ri.text)
  const after = await wedged
  check('the interrupted cell comes back with a KeyboardInterrupt output',
    /KeyboardInterrupt/.test(JSON.stringify(after.outputs ?? [])), JSON.stringify(after.outputs))
  const idle2 = await waitFor((s) => !s.busy, 'the kernel to settle after the interrupt')
  check('kernel is idle again after the interrupt', idle2.busy === false)
})().catch((e) => { fail++; console.log(`❌ threw: ${e?.message ?? e}`) })

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`)
kernels.destroy()
fs.rmSync(dir, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
