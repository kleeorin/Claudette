// Test for the "Unowned-kernel escape" (SANDBOX.md): a notebook's kernel is confined
// to whatever session OWNS the notebook (KernelManager.confinementForNotebook keys off the
// owner map). The MCP notebook tools used to set an owner ONLY when they FRESHLY opened
// a notebook with focus (open_notebook, or targetDoc's open branch). Two box-reachable
// paths skipped it — `create_notebook` (never focuses) and targetDoc's "already open"
// branch — leaving the notebook UNOWNED, so a later run_cell spawned its kernel on the
// UNCONFINED `off:` server (full env incl. CLAUDETTE_TOKEN, root_dir=/): host RCE from
// inside a confined box, and a silent bypass of the venv-probe fix.
//
// The fix claims ownership for the calling session on every WRITE/RUN resolution
// (targetDoc need==='write' + create_notebook), so the kernel that later executes is
// confined to that session's box. This test drives the REAL MCP tool handlers against a
// real NotebookDocManager + KernelManager and asserts the owner is set (no Jupyter
// needed — ownership is what selects the confined vs unconfined server).
//
//   npx tsx scratchpad/sandbox-unowned-kernel-test.mts
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
import type { SandboxConfig } from '../shared/src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unowned-'))
const proj = path.join(root, 'proj')
fs.mkdirSync(proj, { recursive: true })

const SID = 'session-CONFINED'
const sandbox: SandboxConfig = { enabled: true, mounts: [{ path: proj, mode: 'rw' }] }
// The single confinement seam, wired exactly as index.ts wires it: a lookup from
// sessionId to its {sandbox, cwd}. An unknown session resolves to `deny` (fail closed).
const confinement = new SessionConfinement((id) => (id === SID ? { sandbox, cwd: proj } : undefined))

const docs = new NotebookDocManager()
const kernels = new KernelManager(docs, confinement)
const panes = new ActivePaneRegistry()
const turns = new TurnNotebookRegistry()

// Capture the registered tool handlers so we can invoke them like the MCP server would.
const handlers = new Map<string, McpTool['handler']>()
const fakeMcp = { register: (t: McpTool) => handlers.set(t.name, t.handler) } as unknown as AppControlMcpServer
registerNotebookTools(fakeMcp, docs, kernels, panes, turns,
  (sid, doc) => { kernels.setOwner(doc.notebookId, { session: sid }) },   // mirrors index.ts onFocus→setOwner
  () => {},                                                              // onFocusFile (open_file) — unused here
  confinement,
)
const call = (name: string, args: Record<string, unknown>): Promise<McpToolResult> => handlers.get(name)!(SID, args)

const nbId = (p: string) => docs.getByPath(path.resolve(p))?.notebookId

await (async () => {
  // --- 1. create_notebook claims ownership (was the primary hole) --------------
  const nb1 = path.join(proj, 'pwn.ipynb')
  const r1 = await call('create_notebook', { path: nb1 })
  check('create_notebook succeeds', !r1.error, r1.error)
  check('create_notebook OWNS the notebook for the calling session (kernel would be confined)',
    (kernels.ownerOf(nbId(nb1)!) as { session: string } | undefined)?.session === SID, `owner=${kernels.ownerOf(nbId(nb1)!)}`)

  // --- 2. A write tool on an ALREADY-OPEN notebook claims ownership ------------
  // Simulate the notebook being open but owned by nobody (the pre-fix state: opened via
  // a path the fresh-open focus branch didn't cover). Clear the owner, then edit it.
  const nb2 = path.join(proj, 'other.ipynb')
  await docs.createPath(nb2)                 // open, no owner set (bypasses the tools)
  kernels.shutdown(nbId(nb2)!)               // ensure owner is cleared for the test
  check('precondition: nb2 is unowned', kernels.ownerOf(nbId(nb2)!) === undefined)
  turns.clear(SID)
  const r2 = await call('edit_cell', { path: nb2, index: 0, source: "import os; os.system('id')" })
  check('edit_cell (already-open) succeeds', !r2.error, r2.error)
  check('edit_cell on an already-open notebook CLAIMS ownership (targetDoc write path)',
    (kernels.ownerOf(nbId(nb2)!) as { session: string } | undefined)?.session === SID, `owner=${kernels.ownerOf(nbId(nb2)!)}`)

  // --- 3. run_cell also lands ownership (defense at the exact exec point) ------
  const nb3 = path.join(proj, 'run.ipynb')
  await docs.createPath(nb3)
  kernels.shutdown(nbId(nb3)!)
  turns.clear(SID)
  // run_cell resolves via targetDoc(need='write'); the resolve claims ownership BEFORE
  // any kernel is started (we don't actually start one here — no Jupyter).
  check('precondition: nb3 is unowned', kernels.ownerOf(nbId(nb3)!) === undefined)
  await call('run_cell', { path: nb3, index: 0 }).catch(() => ({}))
  check('run_cell claims ownership at resolution (kernel starts confined)',
    (kernels.ownerOf(nbId(nb3)!) as { session: string } | undefined)?.session === SID, `owner=${kernels.ownerOf(nbId(nb3)!)}`)

  // --- 4. read_notebook does NOT steal ownership ------------------------------
  const nb4 = path.join(proj, 'readonly.ipynb')
  await docs.createPath(nb4)
  kernels.shutdown(nbId(nb4)!)
  turns.clear(SID)
  await call('read_notebook', { path: nb4 })
  check('read_notebook does NOT claim ownership (no code executes on a read)',
    kernels.ownerOf(nbId(nb4)!) === undefined, `owner=${kernels.ownerOf(nbId(nb4)!)}`)

  // --- 5. FAIL CLOSED: an UNOWNED notebook REFUSES to start a kernel ----------
  // The seam's backstop: even if some future path forgot to claim ownership, the kernel
  // is refused outright rather than silently starting on the unconfined `off:` server.
  const nb5 = path.join(proj, 'orphan.ipynb')
  await docs.createPath(nb5)          // opened directly; never claimed by any session
  kernels.shutdown(nbId(nb5)!)        // belt-and-suspenders: ensure no owner
  let refused = false
  try { await kernels.ensureKernel(nbId(nb5)!) }
  catch (e) { refused = /no resolvable owning session/.test(String(e)) }
  check('unowned notebook: ensureKernel REFUSES (never falls to the off: server)', refused)

  // --- 6. Ownership DOWNGRADE is refused (SANDBOX.md "Ownership downgrade") ----
  // Last-claimer-wins used to let a host claim take a notebook a CONFINED session owns —
  // the operator opening it session-lessly (`/api/notebook/open` with no sessionId) — and
  // the next run then restarted the kernel on the unconfined `off:` server. The claim is
  // now refused: the confined owner stands.
  const nb6 = path.join(proj, 'downgrade.ipynb')
  await docs.createPath(nb6)
  kernels.shutdown(nbId(nb6)!)
  check('setOwner: first claim by a confined session takes',
    kernels.setOwner(nbId(nb6)!, { session: SID }) === true)
  check('setOwner: host claim on a CONFINED notebook is REFUSED',
    kernels.setOwner(nbId(nb6)!, { host: true }) === false)
  check('setOwner: the confined owner still stands after the refused claim',
    (kernels.ownerOf(nbId(nb6)!) as { session: string } | undefined)?.session === SID,
    `owner=${JSON.stringify(kernels.ownerOf(nbId(nb6)!))}`)
  check('setOwner: a claim from an UNRESOLVABLE session is refused too (deny < confined)',
    kernels.setOwner(nbId(nb6)!, { session: 'session-GONE' }) === false)
  // The deliberate takeover: shut the kernel down first, then claim.
  kernels.shutdown(nbId(nb6)!)
  check('takeover: after shutdown() the host CAN claim it',
    kernels.setOwner(nbId(nb6)!, { host: true }) === true &&
    'host' in (kernels.ownerOf(nbId(nb6)!) ?? {}))

  // --- 7. RAISING confinement still works (the fix must not block the safe way) -
  // A host-owned notebook that a confined session writes to becomes confined — this is
  // the path that makes a box-reachable notebook run in its box, so it must stay open.
  check('raise: a confined session CAN claim a host-owned notebook',
    kernels.setOwner(nbId(nb6)!, { session: SID }) === true,
    `owner=${JSON.stringify(kernels.ownerOf(nbId(nb6)!))}`)
  // A stale/unclaimed notebook is claimable by anyone (a dead owner must not brick it).
  const nb7 = path.join(proj, 'stale.ipynb')
  await docs.createPath(nb7)
  kernels.shutdown(nbId(nb7)!)
  check('stale: an unowned notebook accepts a host claim (deny is replaceable)',
    kernels.setOwner(nbId(nb7)!, { host: true }) === true)
})()

kernels.destroy()
fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
