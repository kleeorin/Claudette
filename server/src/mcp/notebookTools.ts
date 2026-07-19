import { extname, resolve, dirname, basename } from 'path'
import { realpathSync } from 'fs'
import { nbText as asText } from '@claudette/shared'
import type { NbCell, NbCellType, NbOutput, NotebookDoc, NotebookOp } from '@claudette/shared'
import type { NotebookDocManager } from '../notebook/notebookDocManager'
import type { KernelManager } from '../jupyter/kernelManager'
import type { ActivePaneRegistry } from './activePaneRegistry'
import type { TurnNotebookRegistry } from './turnNotebookRegistry'
import type { AppControlMcpServer, McpToolResult } from './appControlServer'
import type { SessionConfinement } from '../claude/sessionConfinement'

// AppControl notebook tools. The KEY ClaudeMaster fix: handlers mutate the
// authoritative doc DIRECTLY via NotebookDocManager (no UI round-trip) — an edit to
// an open notebook broadcasts back over `notebook:update`, so the user's view stays
// live, and a not-open notebook is written straight to disk. Cells are addressed by
// 0-based INDEX (Claude reasons in positions); the handler resolves index→cellId.
//
// ACTIVE-PANE STEERING (the CM behavior restored here): a cell/read/run tool's
// `path` is OPTIONAL. Omitted, it targets the notebook the CALLING session is
// currently viewing — the one the user is looking at — read from the per-session
// ActivePaneRegistry (published by the web client on tab/session switch). This is
// what makes "add a cell here" unambiguous when several notebooks are open. An
// explicit `path` is honored, but GUARDED: if the turn is anchored to a *different*
// notebook, the tool refuses (a stale path from earlier context is the main
// targeting mistake); Claude can call `open_notebook` to bring the intended one
// into focus first. `read_active_pane` lets Claude ask what the user is viewing.
//
// PER-TURN PIN (TurnNotebookRegistry): active-pane steering re-reads the live pane
// on every call, which redirects a multi-cell task if the user switches tabs mid-
// task. So the FIRST notebook a turn resolves is PINNED and reused by every later
// path-unset call that turn — the task stays on its notebook even if the user
// navigates away or closes it. open_notebook/create_notebook re-pin (Claude's
// explicit choice); the pin resets at the next user turn (SessionManager 'userTurn').

export function registerNotebookTools(
  mcp: AppControlMcpServer,
  docs: NotebookDocManager,
  kernels: KernelManager,
  panes: ActivePaneRegistry,
  // Per-turn "working notebook" pin: the first notebook a turn resolves sticks for
  // the rest of that turn (see TurnNotebookRegistry), so mid-task tab switches by
  // the user don't redirect Claude's cells to the wrong notebook.
  turns: TurnNotebookRegistry,
  // Steer the calling session's UI to focus a notebook (open_notebook). The doc is
  // already open server-side; this only moves the user's focus onto it.
  onFocus: (sessionId: string, doc: NotebookDoc) => void,
  // The confinement seam (SANDBOX.md): gates the tools' UNSANDBOXED file I/O to the
  // calling session's own mounts. A session that can't be resolved fails closed (deny),
  // so the tools can't be tricked into acting for an unknown session.
  confinement: SessionConfinement,
): void {
  // Gate a path the tools are about to read/write to the calling session's sandbox AND
  // capture its TOCTOU write-guard in the SAME filesystem observation (SANDBOX.md
  // "Notebook-MCP escape" + G1). A confined session must not reach a notebook outside its
  // mounts through the server process; and because the containment decision and the guard
  // both derive from one `realpath(dirname)`, a symlink swap can't slip between "authorized"
  // and "guard captured". Returns a Claude-facing error when out of bounds (or the session
  // is unresolved — fail closed), else `{ guard }`: the canonical parent dir to pin for the
  // open/write (undefined for an unconfined host session, which needs no guard).
  function gate(sessionId: string, absPath: string, need: 'read' | 'write'): McpToolResult | { guard: string | undefined } {
    const realDir = dirGuard(absPath)
    if (confinement.authorizeResolved(sessionId, realDir ?? null, basename(absPath), need)) return { guard: realDir }
    return { error: `${absPath} is outside this session's sandbox — ${need} not permitted. The notebook tools honor the same mounts as the session; only a path under a ${need === 'write' ? 'read-write' : 'mounted'} sandbox path can be ${need === 'write' ? 'written' : 'read'}. Ask the user to add it as a mount (the sandbox control) if it should be reachable.` }
  }
  const isGateErr = (x: McpToolResult | { guard: string | undefined }): x is McpToolResult => 'error' in x
  // A `path` field every cell tool accepts, but should almost always OMIT. Passing a
  // stale path from earlier in the conversation (when a different notebook was in
  // focus) is the classic wrong-notebook bug — the unset default always follows the
  // user's current view.
  const pathProp = { path: { type: 'string', description: "Leave UNSET by default — the tool then targets whatever notebook the user is currently viewing (their active pane), which is almost always what you want. Set `path` (absolute, .ipynb) ONLY when the user explicitly names a DIFFERENT notebook to edit in this request. Never reuse a path from earlier in the conversation: the user may have switched notebooks since, and an unset path always follows their current focus. A path that isn't open is written straight to disk." } }

  const isErr = (x: NotebookDoc | McpToolResult): x is McpToolResult => 'error' in x

  // Open (or reuse) the notebook at an absolute .ipynb path. `guard` (from gate()) pins the
  // canonical parent so a fresh-open READ refuses if the dir was relinked since authorization
  // (SANDBOX.md G1). An already-open doc reads from memory (no fs touch).
  async function openByPath(path: string, guard?: string): Promise<NotebookDoc | McpToolResult> {
    if (!path) return { error: 'path is required (absolute .ipynb path)' }
    if (extname(path).toLowerCase() !== '.ipynb') return { error: `${path} is not a .ipynb notebook` }
    try {
      return docs.getByPath(path) ?? await docs.openPath(path, guard)
    } catch (e) {
      return { error: `cannot open ${path}: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  // Decide which notebook a path-optional tool targets, and pin it for the turn:
  //   • explicit `path` — honored, but GUARDED against the notebook the turn is
  //     already anchored to (the pin once established, else the user's active pane):
  //     a mismatch is almost always a stale path, so refuse.
  //   • no `path` — the pinned working notebook if the turn has established one
  //     (stick to it even if the user has since switched tabs or closed it), else
  //     the calling session's active pane (which then becomes the pin).
  // Returns the resolved path (a string) or a Claude-facing error.
  function resolveNotebook(sessionId: string, args: Record<string, unknown>): string | McpToolResult {
    const explicit = args.path != null ? String(args.path) : ''
    const pinned = turns.get(sessionId)
    if (explicit) {
      if (extname(explicit).toLowerCase() !== '.ipynb') return { error: `${explicit} is not a .ipynb notebook.` }
      // What this turn is "about": the pinned working notebook once one exists, else
      // whatever the user is viewing. Normalize BOTH sides before comparing so a
      // non-canonical-but-equivalent `explicit` (relative, `..`, redundant `.`)
      // pointing at the very same notebook doesn't trip the guard.
      const active = panes.get(sessionId)
      const anchor = pinned ?? (active && active.isNotebook ? active.path : undefined)
      if (anchor && resolve(anchor) !== resolve(explicit)) {
        return { error: pinned
          ? `Refusing to edit ${explicit}: this turn is already working in ${pinned}, which is almost certainly the intended notebook. Omit \`path\` to keep targeting it. Only switch to ${explicit} if the user explicitly named that file this turn — and if so, call open_notebook(${explicit}) first so it's visible and becomes the working notebook, then retry.`
          : `Refusing to edit ${explicit}: the user is currently viewing a different notebook (${anchor}), which is almost certainly the one they mean. Omit \`path\` to target the notebook they're looking at. Only edit ${explicit} if the user explicitly named that file this turn — and if so, call open_notebook(${explicit}) first so the change is visible, then retry.` }
      }
      if (!pinned) turns.set(sessionId, explicit)   // first target of the turn → pin it
      return explicit
    }
    // Established working notebook wins over the live pane — the whole point of the
    // pin: a mid-task tab switch (or closing the notebook) must not move the target.
    if (pinned) return pinned
    const p = panes.get(sessionId)
    if (!p) return { error: 'No notebook is open in the active pane, and no `path` was given. Ask the user to open a notebook (or open_notebook one), or pass an absolute `path`.' }
    if (!p.isNotebook) return { error: `The active pane is a text file (${p.path}), not a notebook. Ask the user to open a notebook, or pass an absolute .ipynb \`path\`.` }
    turns.set(sessionId, p.path)   // first target of the turn → pin it
    return p.path
  }

  // Resolve + open in one step — the entry point for every path-optional tool. When
  // a tool FRESHLY opens a notebook (not already open), focus it in the CALLING
  // session so the change lands where Claude is working — never in whatever session
  // the user happens to be viewing. `focus:false` for read (don't pop a tab just to
  // inspect). A notebook already open in the calling pane isn't re-focused.
  async function targetDoc(sessionId: string, args: Record<string, unknown>, focus = true, need: 'read' | 'write' = 'write'): Promise<NotebookDoc | McpToolResult> {
    const t = resolveNotebook(sessionId, args)
    if (typeof t !== 'string') return t
    const g = gate(sessionId, resolve(t), need)
    if (isGateErr(g)) return g
    const already = docs.getByPath(t)
    if (already) { claimOwnership(sessionId, already, need); return already }
    const doc = await openByPath(t, g.guard)
    if (isErr(doc)) return doc
    claimOwnership(sessionId, doc, need)
    if (focus) onFocus(sessionId, doc)
    return doc
  }

  // SECURITY (SANDBOX.md "Unowned-kernel escape"): a notebook's kernel is confined to
  // whatever session OWNS the notebook (KernelManager.confinementForNotebook keys off the
  // owner). A notebook that no session has claimed runs its kernel on the UNCONFINED
  // `off:` server — so a confined box that creates/opens a notebook purely through these
  // MCP tools (which don't otherwise set an owner) could execute cell code outside its
  // box, with the server's env. So whenever a session MUTATES or RUNS a notebook here,
  // make it the owner: the kernel that later executes is then confined to THAT session's
  // box. Read-only access never claims ownership — it executes nothing and shouldn't
  // steal a live kernel from the session that owns it.
  function claimOwnership(sessionId: string, doc: NotebookDoc, need: 'read' | 'write'): void {
    if (need === 'write') kernels.setOwner(doc.notebookId, sessionId)
  }

  // Resolve a 0-based index against the doc → cellId (with a clear out-of-range error).
  function cellIdAt(doc: NotebookDoc, index: unknown): string | McpToolResult {
    const i = Number(index)
    if (!Number.isInteger(i) || i < 0 || i >= doc.cells.length) {
      return { error: `index ${index} out of range (notebook has ${doc.cells.length} cells: 0..${doc.cells.length - 1})` }
    }
    return doc.cells[i].id
  }

  // Validate a positional index used for insert/move (0..max) — rejects NaN / negative
  // / non-integer instead of letting applyOp silently clamp it to 0.
  function boundedIndex(n: unknown, max: number, label: string): number | McpToolResult {
    const i = Number(n)
    if (!Number.isInteger(i) || i < 0 || i > max) {
      return { error: `${label} ${n} out of range (must be an integer 0..${max})` }
    }
    return i
  }

  // The canonical parent dir of a path (one realpath), used by gate() as the containment
  // basis AND the TOCTOU write-guard so the two can't diverge (SANDBOX.md G1). Undefined if
  // it can't be resolved — gate() then denies (confined) or allows unguarded (host).
  function dirGuard(absPath: string): string | undefined {
    try { return realpathSync(dirname(absPath)) } catch { return undefined }
  }

  // Apply a mutation op then persist. The save is re-authorized-and-guarded on the doc's
  // path AT WRITE TIME (SANDBOX.md G1) — bound to the actual write, not the earlier open —
  // so a symlink swap of the notebook's directory between open and save can't redirect it.
  async function applyAndSave(sessionId: string, doc: NotebookDoc, op: NotebookOp): Promise<McpToolResult> {
    const g = gate(sessionId, doc.path, 'write')
    if (isGateErr(g)) return g
    const r = docs.applyOp(op, 'claude')
    if (!r.ok) return { error: r.error }
    await docs.save(doc.notebookId, g.guard)
    return { text: 'ok' }
  }

  mcp.register({
    name: 'read_active_pane',
    description: 'Report which notebook (or text file) the user is currently looking at in the calling session — the active content tab beside Claude. Returns { path, isNotebook }, or an error when the Claude tab is focused (no file visible). Use this to confirm the target before editing when several notebooks are open.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (sid) => {
      const p = panes.get(sid)
      if (!p) return { error: "No file is open in this session's active pane (the Claude tab is focused). Ask the user to open a notebook, or work by explicit `path`." }
      return { text: JSON.stringify(p) }
    },
  })

  mcp.register({
    name: 'open_notebook',
    description: 'Open a notebook (absolute .ipynb `path`) and FOCUS it in the calling session, so it becomes the notebook the user is looking at. Use this to show the user a notebook before working on it — and as the way to switch focus when you must edit a notebook other than the one currently visible (the edit tools refuse a different notebook otherwise).',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the .ipynb notebook.' } }, required: ['path'] },
    handler: async (sid, args) => {
      const p = String(args.path ?? '')
      const g = p ? gate(sid, resolve(p), 'read') : { guard: undefined }
      if (isGateErr(g)) return g
      const doc = await openByPath(p, g.guard)
      if (isErr(doc)) return doc
      onFocus(sid, doc)
      // Claude explicitly chose this notebook to work on → make it the turn's pinned
      // working notebook (overriding any earlier pin), so path-unset tools follow it.
      turns.set(sid, doc.path)
      return { text: `Opened and focused ${doc.path} in the current session.` }
    },
  })

  mcp.register({
    name: 'read_notebook',
    description: 'Read a notebook (the active pane unless `path` is given): returns each cell with its 0-based index, type, source, and a summary of its outputs. Use this to see the current authoritative state (including run outputs) before editing by index.',
    inputSchema: { type: 'object', properties: { ...pathProp }, required: [] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args, false, 'read')   // reading shouldn't pop a tab
      if (isErr(doc)) return doc
      return { text: JSON.stringify({ path: doc.path, kernel: doc.kernelId ? 'running' : 'none', cells: doc.cells.map(describeCell) }, null, 1) }
    },
  })

  mcp.register({
    name: 'edit_cell',
    description: "Replace the source of a cell (0-based `index`) in a notebook (the active pane unless `path` is given). If that notebook is open it updates live; if not, it's written to disk. Clears the cell's outputs.",
    inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' }, source: { type: 'string' } }, required: ['index', 'source'] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      const id = cellIdAt(doc, args.index); if (typeof id !== 'string') return id
      return applyAndSave(sid, doc, { op: 'editCell', notebookId: doc.notebookId, cellId: id, source: String(args.source ?? '') })
    },
  })

  mcp.register({
    name: 'add_cell',
    description: "Append a new cell to the end of a notebook (the active pane unless `path` is given). type = 'code' (default), 'markdown', or 'raw'. Optional source. Live if the notebook is open, else written to disk.",
    inputSchema: { type: 'object', properties: { ...pathProp, type: { type: 'string' }, source: { type: 'string' } }, required: [] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      return applyAndSave(sid, doc, { op: 'addCell', notebookId: doc.notebookId, cellType: cellType(args.type), source: strOrUndef(args.source) })
    },
  })

  mcp.register({
    name: 'insert_cell',
    description: 'Insert a new cell before the given 0-based `index` in a notebook (the active pane unless `path` is given). type = code/markdown/raw. Optional source. Live if open, else written to disk.',
    inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' }, type: { type: 'string' }, source: { type: 'string' } }, required: ['index'] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      const index = boundedIndex(args.index, doc.cells.length, 'index'); if (typeof index !== 'number') return index
      return applyAndSave(sid, doc, { op: 'insertCell', notebookId: doc.notebookId, index, cellType: cellType(args.type), source: strOrUndef(args.source) })
    },
  })

  mcp.register({
    name: 'delete_cell',
    description: 'Delete the cell at the given 0-based `index` in a notebook (the active pane unless `path` is given). Live if open, else written to disk.',
    inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' } }, required: ['index'] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      const id = cellIdAt(doc, args.index); if (typeof id !== 'string') return id
      return applyAndSave(sid, doc, { op: 'deleteCell', notebookId: doc.notebookId, cellId: id })
    },
  })

  mcp.register({
    name: 'move_cell',
    description: 'Move a cell from one 0-based index (`from`) to another (`to`) in a notebook (the active pane unless `path` is given). Live if open, else written to disk.',
    inputSchema: { type: 'object', properties: { ...pathProp, from: { type: 'number' }, to: { type: 'number' } }, required: ['from', 'to'] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      const id = cellIdAt(doc, args.from); if (typeof id !== 'string') return id
      const to = boundedIndex(args.to, doc.cells.length - 1, 'to'); if (typeof to !== 'number') return to
      return applyAndSave(sid, doc, { op: 'moveCell', notebookId: doc.notebookId, cellId: id, toIndex: to })
    },
  })

  mcp.register({
    name: 'set_cell_type',
    description: "Change a cell's type (code/markdown/raw) by 0-based `index` in a notebook (the active pane unless `path` is given). Clears its outputs. Live if open, else written to disk.",
    inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' }, type: { type: 'string' } }, required: ['index', 'type'] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      const id = cellIdAt(doc, args.index); if (typeof id !== 'string') return id
      return applyAndSave(sid, doc, { op: 'setCellType', notebookId: doc.notebookId, cellId: id, cellType: cellType(args.type) })
    },
  })

  mcp.register({
    name: 'create_notebook',
    description: "Create a new, empty .ipynb at an absolute `path` (fails if it already exists). Populate it with the cell tools, then run cells with run_cell / run_all. To also bring it into the user's view, open_notebook it.",
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path ending in .ipynb' } }, required: ['path'] },
    handler: async (sid, args) => {
      const path = String(args.path ?? '')
      if (!path) return { error: 'path is required' }
      if (extname(path).toLowerCase() !== '.ipynb') return { error: 'path must end in .ipynb' }
      const g = gate(sid, resolve(path), 'write')
      if (isGateErr(g)) return g
      try {
        const doc = await docs.createPath(path, g.guard)
        // Own it for THIS session now (SANDBOX.md "Unowned-kernel escape"): a freshly
        // created notebook has no owner, so a later run_cell would spawn its kernel on
        // the UNCONFINED server. Claiming it here confines that kernel to this box.
        kernels.setOwner(doc.notebookId, sid)
        // Claude just made this notebook to populate it → pin it as the turn's working
        // notebook so the following path-unset cell tools land here, not in whatever
        // the user happens to be viewing.
        turns.set(sid, path)
        return { text: `created ${path}` }
      } catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
    },
  })

  mcp.register({
    name: 'run_cell',
    description: 'Execute the code cell at 0-based `index` in a notebook (the active pane unless `path` is given) on its kernel (started on first run), then return the cell outputs. Outputs are saved to disk.',
    inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' } }, required: ['index'] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      const id = cellIdAt(doc, args.index); if (typeof id !== 'string') return id
      try {
        await kernels.runCell(doc.notebookId, id)
        const g = gate(sid, doc.path, 'write'); if (isGateErr(g)) return g
        await docs.save(doc.notebookId, g.guard)
        const idx = doc.cells.findIndex((c) => c.id === id)
        return { text: JSON.stringify(describeCell(doc.cells[idx], idx), null, 1) }
      } catch (e) { return { error: `run failed: ${e instanceof Error ? e.message : String(e)}` } }
    },
  })

  mcp.register({
    name: 'run_all',
    description: 'Execute every code cell top-to-bottom in a notebook (the active pane unless `path` is given) on its kernel, then return all cells with their outputs. Saved to disk.',
    inputSchema: { type: 'object', properties: { ...pathProp }, required: [] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      try {
        await kernels.runAll(doc.notebookId)
        const g = gate(sid, doc.path, 'write'); if (isGateErr(g)) return g
        await docs.save(doc.notebookId, g.guard)
        return { text: JSON.stringify(doc.cells.map(describeCell), null, 1) }
      } catch (e) { return { error: `run_all failed: ${e instanceof Error ? e.message : String(e)}` } }
    },
  })
}

// --- helpers ---------------------------------------------------------------

function cellType(t: unknown): NbCellType {
  return t === 'markdown' ? 'markdown' : t === 'raw' ? 'raw' : 'code'
}
function strOrUndef(s: unknown): string | undefined {
  return s == null ? undefined : String(s)
}

// A compact, Claude-friendly view of a cell (index is positional, added by caller
// via map()). Outputs are summarized to text so the payload stays small.
function describeCell(cell: NbCell, index: number): Record<string, unknown> {
  const base: Record<string, unknown> = { index, type: cell.cellType, source: cell.source }
  if (cell.cellType === 'code') {
    base.executionCount = cell.executionCount ?? null
    base.outputs = (cell.outputs ?? []).map(summarizeOutput)
  }
  return base
}

function summarizeOutput(o: NbOutput): unknown {
  switch (o.output_type) {
    case 'stream': return { kind: 'stream', name: o.name, text: asText(o.text) }
    case 'execute_result': return { kind: 'result', text: asText((o.data as Record<string, unknown>)?.['text/plain']) }
    case 'display_data': return { kind: 'display', mimeTypes: Object.keys((o.data as Record<string, unknown>) ?? {}) }
    case 'error': return { kind: 'error', ename: o.ename, evalue: o.evalue }
    default: return { kind: String(o.output_type) }
  }
}
