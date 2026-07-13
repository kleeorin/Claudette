// Active-pane steering E2E: drive the AppControl notebook tools over JSON-RPC (like
// the CLI) and prove that path-less calls target the notebook the CALLING session is
// viewing, that an explicit path to a DIFFERENT visible notebook is refused, and that
// open_notebook fires a focus for the calling session. Run:
//   npx tsx scratchpad/active-pane-test.mts
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { NotebookDocManager } from '../server/src/notebook/notebookDocManager.ts'
import { JupyterManager } from '../server/src/jupyter/jupyterManager.ts'
import { KernelManager } from '../server/src/jupyter/kernelManager.ts'
import { AppControlMcpServer } from '../server/src/mcp/appControlServer.ts'
import { registerNotebookTools } from '../server/src/mcp/notebookTools.ts'
import { ActivePaneRegistry } from '../server/src/mcp/activePaneRegistry.ts'

let failed = 0
const ok = (c: unknown, m: string) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++ }

const dir = await mkdtemp(join(tmpdir(), 'nbpane-'))
const nbA = join(dir, 'note.ipynb')
const nbB = join(dir, 'another.ipynb')

const docs = new NotebookDocManager()
const jupyter = new JupyterManager()
const kernels = new KernelManager(docs, jupyter)
const panes = new ActivePaneRegistry()
const focuses: Array<{ sid: string; path: string }> = []
const mcp = new AppControlMcpServer()
registerNotebookTools(mcp, docs, kernels, panes, (sid, doc) => focuses.push({ sid, path: doc.path }))

const port = await mcp.start()
// Two sessions: S (the one the user is looking at) and T (a background session that
// has never reported an active pane).
const urlS: string = JSON.parse(mcp.configFor('S')).mcpServers.app.url
const urlT: string = JSON.parse(mcp.configFor('T')).mcpServers.app.url

let rpcId = 0
async function callOn(url: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  })
  const r = (await res.json() as any).result
  return { text: r.content?.[0]?.text as string, isError: !!r.isError }
}
const S = (name: string, args: Record<string, unknown> = {}) => callOn(urlS, name, args)
const T = (name: string, args: Record<string, unknown> = {}) => callOn(urlT, name, args)

// Two empty notebooks, each with a cell 0 (explicit path — registry still empty so
// no guard fires yet).
ok(!(await S('create_notebook', { path: nbA })).isError, 'create note.ipynb')
ok(!(await S('create_notebook', { path: nbB })).isError, 'create another.ipynb')

// --- The user is looking at note.ipynb in session S -------------------------
panes.set('S', { path: nbA, isNotebook: true })

let r = await S('read_active_pane')
ok(!r.isError && JSON.parse(r.text).path === nbA, `read_active_pane → note.ipynb (${r.text})`)

// Path-less edit targets the viewed notebook (note.ipynb), NOT the other one.
r = await S('edit_cell', { index: 0, source: 'IN_NOTE' })
ok(!r.isError, `path-less edit_cell ok: ${r.text}`)
r = await S('read_notebook')            // path-less read → the active notebook
const read = JSON.parse(r.text)
ok(read.path === nbA, 'path-less read_notebook → note.ipynb')
ok(read.cells[0].source === 'IN_NOTE', 'edit landed in note.ipynb (the viewed one)')
ok(docs.getByPath(nbB)!.cells[0].source !== 'IN_NOTE', 'another.ipynb was NOT touched')

// Explicit path to the OTHER (not-viewed) notebook is refused — the whole point.
r = await S('edit_cell', { path: nbB, index: 0, source: 'WRONG' })
ok(r.isError && /Refusing to edit/.test(r.text), `explicit different-notebook path refused: ${r.text?.slice(0, 60)}…`)
ok(docs.getByPath(nbB)!.cells[0].source !== 'WRONG', 'refused edit did not reach another.ipynb')

// Explicit path that MATCHES the viewed notebook is allowed.
r = await S('edit_cell', { path: nbA, index: 0, source: 'IN_NOTE_2' })
ok(!r.isError && docs.getByPath(nbA)!.cells[0].source === 'IN_NOTE_2', 'explicit path == viewed notebook allowed')

// --- open_notebook focuses the OTHER notebook in the calling session --------
focuses.length = 0
r = await S('open_notebook', { path: nbB })
ok(!r.isError, `open_notebook another.ipynb: ${r.text}`)
ok(focuses.length === 1 && focuses[0].sid === 'S' && focuses[0].path === nbB, 'open_notebook fired a focus for session S → another.ipynb')

// The client would now publish the new focus; simulate that, then the guard clears.
panes.set('S', { path: nbB, isNotebook: true })
r = await S('edit_cell', { path: nbB, index: 0, source: 'NOW_OK' })
ok(!r.isError && docs.getByPath(nbB)!.cells[0].source === 'NOW_OK', 'after refocus, editing another.ipynb is allowed')

// --- Degenerate active-pane states -----------------------------------------
panes.set('S', null)                    // Claude tab focused, nothing open
r = await S('read_active_pane')
ok(r.isError, 'read_active_pane errors when the Claude tab is focused')
r = await S('add_cell', { source: 'x' })
ok(r.isError && /no `path` was given/i.test(r.text), 'path-less edit errors when nothing is viewed')

panes.set('S', { path: '/tmp/notes.txt', isNotebook: false })   // a TEXT file is active
r = await S('run_all')
ok(r.isError && /text file/i.test(r.text), 'path-less tool errors when the active pane is a text file')

// A background session that never reported a pane → path-less is an error, but an
// explicit path (nothing else visible there) is honored.
r = await T('read_notebook')
ok(r.isError, 'session with no reported pane: path-less read errors')
r = await T('read_notebook', { path: nbA })
ok(!r.isError, 'session with no reported pane: explicit path honored')

mcp.stop()
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
process.exit(failed ? 1 : 0)
