import { extname } from 'path'
import type { NbCell, NbCellType, NbOutput, NotebookDoc, NotebookOp } from '@claudette/shared'
import type { NotebookDocManager } from '../notebook/notebookDocManager'
import type { KernelManager } from '../jupyter/kernelManager'
import type { ActivePaneRegistry } from './activePaneRegistry'
import type { AppControlMcpServer, McpToolResult } from './appControlServer'

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
// explicit `path` is honored, but GUARDED: if the user is viewing a *different*
// notebook, the tool refuses (a stale path from earlier context is the main
// targeting mistake); Claude can call `open_notebook` to bring the intended one
// into focus first. `read_active_pane` lets Claude ask what the user is viewing.

export function registerNotebookTools(
  mcp: AppControlMcpServer,
  docs: NotebookDocManager,
  kernels: KernelManager,
  panes: ActivePaneRegistry,
  // Steer the calling session's UI to focus a notebook (open_notebook). The doc is
  // already open server-side; this only moves the user's focus onto it.
  onFocus: (sessionId: string, doc: NotebookDoc) => void,
): void {
  // A `path` field every cell tool accepts, but should almost always OMIT. Passing a
  // stale path from earlier in the conversation (when a different notebook was in
  // focus) is the classic wrong-notebook bug — the unset default always follows the
  // user's current view.
  const pathProp = { path: { type: 'string', description: "Leave UNSET by default — the tool then targets whatever notebook the user is currently viewing (their active pane), which is almost always what you want. Set `path` (absolute, .ipynb) ONLY when the user explicitly names a DIFFERENT notebook to edit in this request. Never reuse a path from earlier in the conversation: the user may have switched notebooks since, and an unset path always follows their current focus. A path that isn't open is written straight to disk." } }

  const isErr = (x: NotebookDoc | McpToolResult): x is McpToolResult => 'error' in x

  // Open (or reuse) the notebook at an absolute .ipynb path.
  async function openByPath(path: string): Promise<NotebookDoc | McpToolResult> {
    if (!path) return { error: 'path is required (absolute .ipynb path)' }
    if (extname(path).toLowerCase() !== '.ipynb') return { error: `${path} is not a .ipynb notebook` }
    try {
      return docs.getByPath(path) ?? await docs.openPath(path)
    } catch (e) {
      return { error: `cannot open ${path}: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  // Decide which notebook a path-optional tool targets: an explicit `path` (guarded
  // against the user viewing a different notebook), else the calling session's
  // active pane. Returns the resolved path (a string) or a Claude-facing error.
  function resolveNotebook(sessionId: string, args: Record<string, unknown>): string | McpToolResult {
    const explicit = args.path != null ? String(args.path) : ''
    if (explicit) {
      if (extname(explicit).toLowerCase() !== '.ipynb') return { error: `${explicit} is not a .ipynb notebook.` }
      const active = panes.get(sessionId)
      if (active && active.isNotebook && active.path !== explicit) {
        return { error: `Refusing to edit ${explicit}: the user is currently viewing a different notebook (${active.path}), which is almost certainly the one they mean. Omit \`path\` to target the notebook they're looking at. Only edit ${explicit} if the user explicitly named that file this turn — and if so, call open_notebook(${explicit}) first so the change is visible, then retry.` }
      }
      return explicit
    }
    const p = panes.get(sessionId)
    if (!p) return { error: 'No notebook is open in the active pane, and no `path` was given. Ask the user to open a notebook (or open_notebook one), or pass an absolute `path`.' }
    if (!p.isNotebook) return { error: `The active pane is a text file (${p.path}), not a notebook. Ask the user to open a notebook, or pass an absolute .ipynb \`path\`.` }
    return p.path
  }

  // Resolve + open in one step — the entry point for every path-optional tool. When
  // a tool FRESHLY opens a notebook (not already open), focus it in the CALLING
  // session so the change lands where Claude is working — never in whatever session
  // the user happens to be viewing. `focus:false` for read (don't pop a tab just to
  // inspect). A notebook already open in the calling pane isn't re-focused.
  async function targetDoc(sessionId: string, args: Record<string, unknown>, focus = true): Promise<NotebookDoc | McpToolResult> {
    const t = resolveNotebook(sessionId, args)
    if (typeof t !== 'string') return t
    const already = docs.getByPath(t)
    if (already) return already
    const doc = await openByPath(t)
    if (isErr(doc)) return doc
    if (focus) onFocus(sessionId, doc)
    return doc
  }

  // Resolve a 0-based index against the doc → cellId (with a clear out-of-range error).
  function cellIdAt(doc: NotebookDoc, index: unknown): string | McpToolResult {
    const i = Number(index)
    if (!Number.isInteger(i) || i < 0 || i >= doc.cells.length) {
      return { error: `index ${index} out of range (notebook has ${doc.cells.length} cells: 0..${doc.cells.length - 1})` }
    }
    return doc.cells[i].id
  }

  // Apply a mutation op then persist; map an op failure to an MCP error.
  async function applyAndSave(doc: NotebookDoc, op: NotebookOp): Promise<McpToolResult> {
    const r = docs.applyOp(op, 'claude')
    if (!r.ok) return { error: r.error }
    await docs.save(doc.notebookId)
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
      const doc = await openByPath(String(args.path ?? ''))
      if (isErr(doc)) return doc
      onFocus(sid, doc)
      return { text: `Opened and focused ${doc.path} in the current session.` }
    },
  })

  mcp.register({
    name: 'read_notebook',
    description: 'Read a notebook (the active pane unless `path` is given): returns each cell with its 0-based index, type, source, and a summary of its outputs. Use this to see the current authoritative state (including run outputs) before editing by index.',
    inputSchema: { type: 'object', properties: { ...pathProp }, required: [] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args, false)   // reading shouldn't pop a tab
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
      return applyAndSave(doc, { op: 'editCell', notebookId: doc.notebookId, cellId: id, source: String(args.source ?? '') })
    },
  })

  mcp.register({
    name: 'add_cell',
    description: "Append a new cell to the end of a notebook (the active pane unless `path` is given). type = 'code' (default), 'markdown', or 'raw'. Optional source. Live if the notebook is open, else written to disk.",
    inputSchema: { type: 'object', properties: { ...pathProp, type: { type: 'string' }, source: { type: 'string' } }, required: [] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      return applyAndSave(doc, { op: 'addCell', notebookId: doc.notebookId, cellType: cellType(args.type), source: strOrUndef(args.source) })
    },
  })

  mcp.register({
    name: 'insert_cell',
    description: 'Insert a new cell before the given 0-based `index` in a notebook (the active pane unless `path` is given). type = code/markdown/raw. Optional source. Live if open, else written to disk.',
    inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' }, type: { type: 'string' }, source: { type: 'string' } }, required: ['index'] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      return applyAndSave(doc, { op: 'insertCell', notebookId: doc.notebookId, index: Number(args.index), cellType: cellType(args.type), source: strOrUndef(args.source) })
    },
  })

  mcp.register({
    name: 'delete_cell',
    description: 'Delete the cell at the given 0-based `index` in a notebook (the active pane unless `path` is given). Live if open, else written to disk.',
    inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' } }, required: ['index'] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      const id = cellIdAt(doc, args.index); if (typeof id !== 'string') return id
      return applyAndSave(doc, { op: 'deleteCell', notebookId: doc.notebookId, cellId: id })
    },
  })

  mcp.register({
    name: 'move_cell',
    description: 'Move a cell from one 0-based index (`from`) to another (`to`) in a notebook (the active pane unless `path` is given). Live if open, else written to disk.',
    inputSchema: { type: 'object', properties: { ...pathProp, from: { type: 'number' }, to: { type: 'number' } }, required: ['from', 'to'] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      const id = cellIdAt(doc, args.from); if (typeof id !== 'string') return id
      return applyAndSave(doc, { op: 'moveCell', notebookId: doc.notebookId, cellId: id, toIndex: Number(args.to) })
    },
  })

  mcp.register({
    name: 'set_cell_type',
    description: "Change a cell's type (code/markdown/raw) by 0-based `index` in a notebook (the active pane unless `path` is given). Clears its outputs. Live if open, else written to disk.",
    inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' }, type: { type: 'string' } }, required: ['index', 'type'] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      const id = cellIdAt(doc, args.index); if (typeof id !== 'string') return id
      return applyAndSave(doc, { op: 'setCellType', notebookId: doc.notebookId, cellId: id, cellType: cellType(args.type) })
    },
  })

  mcp.register({
    name: 'create_notebook',
    description: "Create a new, empty .ipynb at an absolute `path` (fails if it already exists). Populate it with the cell tools, then run cells with run_cell / run_all. To also bring it into the user's view, open_notebook it.",
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path ending in .ipynb' } }, required: ['path'] },
    handler: async (_sid, args) => {
      const path = String(args.path ?? '')
      if (!path) return { error: 'path is required' }
      if (extname(path).toLowerCase() !== '.ipynb') return { error: 'path must end in .ipynb' }
      try { await docs.createPath(path); return { text: `created ${path}` } }
      catch (e) { return { error: e instanceof Error ? e.message : String(e) } }
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
        await docs.save(doc.notebookId)
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
        await docs.save(doc.notebookId)
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
function asText(v: unknown): string {
  return Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : ''
}
