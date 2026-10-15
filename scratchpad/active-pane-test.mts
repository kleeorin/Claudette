// Active-pane steering E2E: drive the AppControl notebook tools over JSON-RPC (like
// the CLI) and prove that path-less calls target the notebook the CALLING session is
// viewing, that an explicit path to a DIFFERENT visible notebook is refused, and that
// open_notebook fires a focus for the calling session. Run:
//   npx tsx scratchpad/active-pane-test.mts
import { mkdtemp, writeFile, readFile } from 'fs/promises'
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

// ★ CONTRACT CHANGED 2026-10-06 (F2). This used to assert that an explicit path to the
// not-VIEWED notebook is refused. That was half the reported wrong-notebook bug: with the
// turn pin cleared, a CORRECT explicit path was rejected in favour of whatever pane the user
// had switched to. An explicit path naming a notebook that is OPEN is now the strongest
// statement of intent available and is HONOURED. The stale-path protection it replaced is
// case 3 below — a path naming a notebook that is NOT open is still refused.
r = await S('edit_cell', { path: nbB, index: 0, source: 'RIGHT' })
ok(`2. explicit path for an OPEN notebook is HONOURED: ${r.text?.slice(0, 48)}…`, !r.isError)
ok('2a. …and the edit reached that notebook, not the viewed one',
   docs.getByPath(nbB)!.cells[0].source === 'RIGHT')
ok('2b. …and the viewed notebook was NOT touched',
   docs.getByPath(nbA)!.cells[0].source !== 'RIGHT')

// ── 1. THE REPORTED BUG: a TEAM turn must NOT drop the pin ──────────────────────────────
// Pin to note.ipynb, let a teammate message arrive, then have the user switch panes. The
// turn's next path-less call must still hit note.ipynb. Before the fix the team turn cleared
// the pin and the call re-bound to the new pane — the edit landed in the wrong notebook.
turns.clear('S')
panes.set('S', { path: nbA, isNotebook: true })
await S('edit_cell', { index: 0, source: 'PINNED' })          // pins note.ipynb
turns.onUserTurn('S', 'team')                                  // teammate message arrives
panes.set('S', { path: nbB, isNotebook: true })                // user switches panes
r = await S('edit_cell', { index: 0, source: 'STILL_NOTE' })
ok('1. ★ a TEAM turn does not drop the pin — the edit stays on the original notebook',
   !r.isError && docs.getByPath(nbA)!.cells[0].source === 'STILL_NOTE')
ok('1a. …and the pane the user switched to was NOT touched',
   docs.getByPath(nbB)!.cells[0].source !== 'STILL_NOTE')

// ── 6. A HUMAN turn still clears the pin ────────────────────────────────────────────────
// The other half of the contract: a fresh human turn does follow the user's eyes, so the
// pin must drop and the next call re-bind to the live pane. Without this case, "never clear"
// would pass case 1 while breaking the feature the pin exists for.
turns.onUserTurn('S', 'user')
r = await S('edit_cell', { index: 0, source: 'FOLLOWS_EYES' })
ok('6. ★ a HUMAN turn DOES clear the pin — the next call follows the live pane',
   !r.isError && docs.getByPath(nbB)!.cells[0].source === 'FOLLOWS_EYES')

// Re-establish the viewed notebook for the cases below.
turns.clear('S')
panes.set('S', { path: nbA, isNotebook: true })

// ── 3. A path naming a NOT-OPEN notebook is still refused ────────────────────────────────
// The stale-path case the old assertion was really protecting: a path copied from earlier in
// the conversation, naming something nobody is looking at.
// ★ THE FILE MUST EXIST ON DISK BUT NOT BE OPEN. An earlier version of this case used a
// path to a file that did not exist at all, and it passed for the wrong reason: the open
// failed on ENOENT no matter how F2 was scoped, so the mutant that honours a NOT-OPEN path
// survived it. Measured — that mutant went from red=0 to red=1 once the file was real.
const nbClosed = join(dir, 'closed.ipynb')
const nbClosed2 = join(dir, 'closed2.ipynb')
await writeFile(nbClosed, JSON.stringify({ cells: [{ cell_type: 'code', source: ['OLD'], metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }))
await writeFile(nbClosed2, JSON.stringify({ cells: [{ cell_type: 'code', source: ['OLD2'], metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }))
ok('3. (precondition) closed.ipynb exists on disk and is NOT open', !docs.getByPath(nbClosed))
r = await S('edit_cell', { path: nbClosed, index: 0, source: 'NOPE' })
ok('3a. explicit path for a NOT-OPEN notebook is still refused', r.isError)
ok('3b. …and nothing was written to it', (await readFile(nbClosed, 'utf8')).includes('OLD'))

// ── 4. `expect` ─────────────────────────────────────────────────────────────────────────
r = await S('edit_cell', { path: nbB, index: 0, source: 'X', expect: nbA })
ok('4. expect MISMATCH refuses', r.isError && /expect/.test(r.text))
ok('4a. …naming both sides', r.text.includes(nbA) && r.text.includes(nbB))
ok('4b. …and the edit did not land', docs.getByPath(nbB)!.cells[0].source !== 'X')
r = await S('edit_cell', { path: nbB, index: 0, source: 'MATCHED', expect: nbB })
ok('4c. expect MATCH proceeds', !r.isError && docs.getByPath(nbB)!.cells[0].source === 'MATCHED')
r = await S('edit_cell', { path: nbB, index: 0, source: 'Y', expect: 'another.ipynb' })
ok('4d. expect by NAME matches', !r.isError)

// ── 5. Every mutating result echoes the absolute path ───────────────────────────────────
r = await S('edit_cell', { path: nbB, index: 0, source: 'ECHO' })
ok('5. a mutating result echoes name + absolute path', !r.isError && r.text.includes(nbB) && r.text.includes('another.ipynb'))

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

// ★ THE OTHER NOT-OPEN BRANCH, previously untested — and the two together are what the
// `path` description has to state. resolveNotebook refuses a not-open explicit path only when
// an ANCHOR exists and differs (a pin, or a notebook in the active pane): that is the stale
// -path case. With NO anchor there is nothing to be stale against, so the path is honoured and
// opened straight from disk. The case above used an already-OPEN notebook and so could not
// tell the two apart; this one uses a notebook that exists on disk and is NOT open.
// Clear T's pin first: the read above pinned nbA, and a pin IS an anchor — without this the
// call below refuses for that reason and tells us nothing about the no-anchor branch.
turns.clear('T')
ok('(precondition) closed2.ipynb is on disk and not open', !docs.getByPath(nbClosed2))
ok('(precondition) T has no pin and no pane', !panes.get('T'))
r = await T('read_notebook', { path: nbClosed2 })
ok('★ no anchor + NOT-open explicit path: honoured and opened from disk', !r.isError)
ok('…and it is now open', !!docs.getByPath(nbClosed2))

mcp.stop()
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED')
process.exit(failed ? 1 : 0)
