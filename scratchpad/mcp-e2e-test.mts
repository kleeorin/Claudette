// Full MCP path E2E (P1.5): drive the AppControl server over JSON-RPC like the CLI
// does, proving tools mutate the doc + run kernels directly. Run:
//   npx tsx scratchpad/mcp-e2e-test.mts
import { mkdtemp, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager.ts'
import { KernelManager } from '../server/src/jupyter/kernelManager.ts'
import { AppControlMcpServer } from '../server/src/mcp/appControlServer.ts'
import { registerNotebookTools } from '../server/src/mcp/notebookTools.ts'
import { ActivePaneRegistry } from '../server/src/mcp/activePaneRegistry.ts'
import { TurnNotebookRegistry } from '../server/src/mcp/turnNotebookRegistry.ts'
import { SessionConfinement } from '../server/src/claude/sessionConfinement.ts'

import { check as ok, failed } from './assert.mjs'

const dir = await mkdtemp(join(tmpdir(), 'nbmcp-'))
const path = join(dir, 'mcp.ipynb')

// Unconfined (`host`) session: this test is about the MCP tool surface, not the sandbox.
// The confinement seam fails CLOSED on an unresolved session, so it must be supplied.
const confinement = new SessionConfinement((id) => (id === 'sess-1' ? { cwd: dir } : undefined))

const docs = new NotebookDocManager()
const kernels = new KernelManager(docs, confinement)
const mcp = new AppControlMcpServer()
// Empty active-pane registry: with no session viewing anything, explicit `path`
// calls below are honored as-is (the stale-path guard only fires when the caller is
// viewing a DIFFERENT notebook). Active-pane steering itself is covered by
// active-pane-test.mts.
const panes = new ActivePaneRegistry()
const turns = new TurnNotebookRegistry()
registerNotebookTools(mcp, docs, kernels, panes, turns, () => {}, () => {}, confinement)

const port = await mcp.start()
// configFor mints a session-attributed token URL — exactly what --mcp-config gives Claude.
const cfg = JSON.parse(mcp.configFor('sess-1'))
const url: string = cfg.mcpServers.app.url
ok('configFor returns a token URL on the MCP port', url.startsWith(`http://127.0.0.1:${port}/mcp/`))

let rpcId = 0
async function call(method: string, params?: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json,text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  if (res.status === 202) return null
  return (await res.json() as any).result
}
const callTool = async (name: string, args: Record<string, unknown>) => {
  const r = await call('tools/call', { name, arguments: args })
  return { text: r.content?.[0]?.text as string, isError: !!r.isError }
}

// initialize + tools/list
const init = await call('initialize', { protocolVersion: '2025-06-18' })
ok('initialize → claudette-app', init?.serverInfo?.name === 'claudette-app')
const list = await call('tools/list')
const toolNames = new Set((list.tools as any[]).map((t) => t.name))
ok('tools/list has the notebook tools', ['read_notebook', 'edit_cell', 'add_cell', 'run_cell', 'run_all', 'create_notebook'].every((n) => toolNames.has(n)))

// create_notebook → add code cell → run it, all via MCP
let r = await callTool('create_notebook', { path })
ok(`create_notebook: ${r.text}`, !r.isError)
r = await callTool('edit_cell', { path, index: 0, source: 'x = 6 * 7\nprint(x)' })
ok('edit_cell cell 0', !r.isError)
r = await callTool('add_cell', { path, type: 'markdown', source: '# notes' })
ok('add_cell markdown', !r.isError)

console.log('running cell via MCP (starts kernel)…')
r = await callTool('run_cell', { path, index: 0 })
console.log('   run_cell result:', JSON.stringify(r).slice(0, 400))
ok('run_cell → output contains 42', !r.isError && r.text.includes('42'))

// read_notebook reflects the run output + the markdown cell
r = await callTool('read_notebook', { path })
const view = JSON.parse(r.text)
ok('read_notebook: 2 cells, cell 1 is markdown', view.cells.length === 2 && view.cells[1].type === 'markdown')
// KernelStatus is none|starting|idle|busy|dead — there is no 'running'. The run above
// has finished, so a LIVE kernel reports 'idle'; the property worth pinning is that a
// bound kernel never reads as 'none' once a cell has executed.
ok(`read_notebook: kernel is live and idle after the run (got ${view.kernel})`, view.kernel === 'idle')

// the direct-to-disk write-through: the .ipynb on disk has the output + stable ids
const disk = JSON.parse(await readFile(path, 'utf8'))
ok('disk .ipynb has the run output (write-through)', disk.cells[0].outputs.some((o: any) => (o.text ?? '').includes('42')))
ok('disk cell has a stable id', typeof disk.cells[0].id === 'string')

// error surfaced as an MCP result error (out-of-range index)
r = await callTool('edit_cell', { path, index: 99, source: 'nope' })
ok('out-of-range index → tool error', r.isError && r.text.includes('out of range'))

kernels.destroy()
mcp.stop()
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
