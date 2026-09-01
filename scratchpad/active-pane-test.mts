// Active-pane steering E2E: drive the AppControl notebook tools over JSON-RPC (like
// the CLI) and prove that path-less calls target the notebook the CALLING session is
// viewing, that an explicit path to a DIFFERENT visible notebook is refused, and that
// open_notebook fires a focus for the calling session. Run:
//   npx tsx scratchpad/active-pane-test.mts
import { mkdtemp } from 'fs/promises'
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

const dir = await mkdtemp(join(tmpdir(), 'nbpane-'))
const nbA = join(dir, 'note.ipynb')
const nbB = join(dir, 'another.ipynb')

// Both sessions run unconfined (`host`): this test is about which notebook a tool call
// targets, not about the sandbox. KernelManager and the notebook tools take the
// confinement seam, and an unresolved session fails CLOSED — so it has to be supplied
// or every call here is denied before it reaches the logic under test.
const confinement = new SessionConfinement((id) => (id === 'S' || id === 'T' ? { cwd: dir } : undefined))

const docs = new NotebookDocManager()
const kernels = new KernelManager(docs, confinement)
const panes = new ActivePaneRegistry()
const turns = new TurnNotebookRegistry()
const focuses: Array<{ sid: string; path: string }> = []
const mcp = new AppControlMcpServer()
registerNotebookTools(mcp, docs, kernels, panes, turns,
  (sid, doc) => focuses.push({ sid, path: doc.path }),
  () => {},
  confinement,
)

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
ok('create note.ipynb', !(await S('create_notebook', { path: nbA })).isError)
ok('create another.ipynb', !(await S('create_notebook', { path: nbB })).isError)

// --- The user is looking at note.ipynb in session S -------------------------
// New user turn. index.ts clears the per-turn notebook pin on every 'userTurn', so a
// test that models turns has to do the same — otherwise the create_notebook calls above
// leave nbB pinned and every path-less call below targets it instead of the active pane.
turns.clear('S')
panes.set('S', { path: nbA, isNotebook: true })

let r = await S('read_active_pane')
ok(`read_active_pane → note.ipynb (${r.text})`, !r.isError && JSON.parse(r.text).path === nbA)

// Path-less edit targets the viewed notebook (note.ipynb), NOT the other one.
r = await S('edit_cell', { index: 0, source: 'IN_NOTE' })
ok(`path-less edit_cell ok: ${r.text}`, !r.isError)
r = await S('read_notebook')            // path-less read → the active notebook
const read = JSON.parse(r.text)
ok('path-less read_notebook → note.ipynb', read.path === nbA)
ok('edit landed in note.ipynb (the viewed one)', read.cells[0].source === 'IN_NOTE')
ok('another.ipynb was NOT touched', docs.getByPath(nbB)!.cells[0].source !== 'IN_NOTE')

// Explicit path to the OTHER (not-viewed) notebook is refused — the whole point.
r = await S('edit_cell', { path: nbB, index: 0, source: 'WRONG' })
ok(`explicit different-notebook path refused: ${r.text?.slice(0, 60)}…`, r.isError && /Refusing to edit/.test(r.text))
ok('refused edit did not reach another.ipynb', docs.getByPath(nbB)!.cells[0].source !== 'WRONG')

// Explicit path that MATCHES the viewed notebook is allowed.
r = await S('edit_cell', { path: nbA, index: 0, source: 'IN_NOTE_2' })
ok('explicit path == viewed notebook allowed', !r.isError && docs.getByPath(nbA)!.cells[0].source === 'IN_NOTE_2')

// --- open_notebook focuses the OTHER notebook in the calling session --------
focuses.length = 0
r = await S('open_notebook', { path: nbB })
ok(`open_notebook another.ipynb: ${r.text}`, !r.isError)
ok('open_notebook fired a focus for session S → another.ipynb', focuses.length === 1 && focuses[0].sid === 'S' && focuses[0].path === nbB)

// The client would now publish the new focus; simulate that, then the guard clears.
panes.set('S', { path: nbB, isNotebook: true })
r = await S('edit_cell', { path: nbB, index: 0, source: 'NOW_OK' })
ok('after refocus, editing another.ipynb is allowed', !r.isError && docs.getByPath(nbB)!.cells[0].source === 'NOW_OK')

// --- Degenerate active-pane states -----------------------------------------
// Each of these is a FRESH turn. The per-turn pin is deliberately sticky within a turn
// (that is the point: a mid-task tab switch must not redirect Claude's cells), so
// "path-less errors when nothing is viewed" is only true once the pin has been cleared —
// which is what a new user turn does.
turns.clear('S')
panes.set('S', null)                    // Claude tab focused, nothing open
r = await S('read_active_pane')
ok('read_active_pane errors when the Claude tab is focused', r.isError)
r = await S('add_cell', { source: 'x' })
ok('path-less edit errors when nothing is viewed', r.isError && /no `path` was given/i.test(r.text))

turns.clear('S')                        // new turn again
panes.set('S', { path: '/tmp/notes.txt', isNotebook: false })   // a TEXT file is active
r = await S('run_all')
ok('path-less tool errors when the active pane is a text file', r.isError && /text file/i.test(r.text))

// A background session that never reported a pane → path-less is an error, but an
// explicit path (nothing else visible there) is honored.
r = await T('read_notebook')
ok('session with no reported pane: path-less read errors', r.isError)
r = await T('read_notebook', { path: nbA })
ok('session with no reported pane: explicit path honored', !r.isError)

mcp.stop()
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
process.exit(failed ? 1 : 0)
