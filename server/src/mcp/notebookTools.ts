import { extname, resolve, dirname, basename, isAbsolute } from 'path'
import { errMessage } from '../util/errMessage'
import { realpath, stat } from 'fs/promises'
import { nbText as asText } from '@claudette/shared'
import type { KernelStatus, NbCell, NbCellType, NbOutput, NotebookDoc, NotebookOp } from '@claudette/shared'
import type { NotebookDocManager } from '../notebook/notebookDocManager'
import type { KernelManager } from '../jupyter/kernelManager'
import type { ActivePaneRegistry } from './activePaneRegistry'
import type { TurnNotebookRegistry } from './turnNotebookRegistry'
import type { AppControlMcpServer, McpToolResult } from './appControlServer'
import type { SessionConfinement } from '../claude/sessionConfinement'

// One place the "must be a .ipynb" check lives. `requireIpynb` returns a Claude-facing
// error result when the path isn't a notebook, else null.
function isIpynb(p: string): boolean {
  return extname(p).toLowerCase() === '.ipynb'
}
function requireIpynb(p: string): McpToolResult | null {
  return isIpynb(p) ? null : { error: `${p} is not a .ipynb notebook` }
}

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
//
// RUN STATE (what a stuck notebook actually looks like): the server tracks a kernel
// status and a per-cell executing/queued set — the UI's kernel dot and `[*]` spinners —
// and none of it used to reach Claude. `kernel` meant only "a kernel is bound", and a
// cell mid-execution was byte-identical to a finished one (its outputs and execution
// count still describe the PREVIOUS run), so a long run looked like a hung notebook and
// Claude reported it stuck. Every notebook result now carries kernel/busy/runningCells
// and flags running cells; notebook_status is the cheap poll, and interrupt_kernel the
// escape hatch for a cell that really is wedged.

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
  // The same steering for a plain file (open_file). No doc exists for one — the tab is
  // keyed by path and the client fetches the contents itself.
  onFocusFile: (sessionId: string, path: string) => void,
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
  async function gate(sessionId: string, absPath: string, need: 'read' | 'write'): Promise<McpToolResult | { guard: string | undefined }> {
    const realDir = await dirGuard(absPath)
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
    { const bad = requireIpynb(path); if (bad) return bad }
    try {
      return docs.getByPath(path) ?? await docs.openPath(path, guard)
    } catch (e) {
      return { error: `cannot open ${path}: ${errMessage(e)}` }
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
      { const bad = requireIpynb(explicit); if (bad) return bad }
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
    const g = await gate(sessionId, resolve(t), need)
    if (isGateErr(g)) return g
    const already = docs.getByPath(t)
    if (already) return claimOwnership(sessionId, already, need) ?? already
    const doc = await openByPath(t, g.guard)
    if (isErr(doc)) return doc
    const refused = claimOwnership(sessionId, doc, need)
    if (refused) return refused
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
  //
  // The claim can be REFUSED: setOwner rejects one that would lower a notebook's
  // confinement (a less-confined session grabbing a notebook owned by a tighter box).
  // Returns that refusal as a tool error so the write/run doesn't proceed reporting `ok`
  // while the kernel stays confined to somebody else's box — the invariant above says a
  // mutation makes you the owner, so if we can't own it we must not mutate it.
  function claimOwnership(sessionId: string, doc: NotebookDoc, need: 'read' | 'write'): McpToolResult | undefined {
    if (need !== 'write') return undefined
    if (kernels.setOwner(doc.notebookId, { session: sessionId })) return undefined
    return { error: `${doc.path} is owned by a more-confined session, so its kernel would execute there rather than in this one. Refusing to modify or run it. Shut that notebook's kernel down (or close the owning session) to take it over.` }
  }

  // The notebook's LIVE execution state, read from the same KernelManager the UI's kernel
  // dot and cell spinners read. Claude used to see NONE of it: read_notebook's `kernel`
  // meant only "a kernel is bound" (so an idle kernel read as "running"), and a cell
  // mid-execution was byte-identical to a finished one — same stale outputs, same
  // execution count — so polling a long run looked exactly like a hung notebook and
  // Claude concluded it was stuck. Every result that describes a notebook goes through here.
  function runState(doc: NotebookDoc): { running: Set<string>; kernel: KernelStatus; busy: boolean; runningIndexes: number[] } {
    const running = new Set(kernels.runningCells(doc.notebookId))
    const busy = running.size > 0
    const reported = kernels.kernelStatus(doc.notebookId)
    // `kernel` and `busy` must never contradict each other — a `busy: true, kernel: 'none'`
    // result is exactly the kind of thing that gets read as a broken notebook. Cells in
    // flight IS the kernel working, whatever the socket has told us so far: no status yet
    // means the kernel is still coming up ('starting'), and a stale 'idle' (between the
    // execute request and the kernel's busy event) is really 'busy'. Idle-and-not-busy
    // falls back to whether a kernel is bound, so a live one never reports 'none'.
    const kernel: KernelStatus = busy
      ? (reported === undefined ? 'starting' : reported === 'idle' ? 'busy' : reported)
      : (reported ?? (doc.kernelId ? 'idle' : 'none'))
    const runningIndexes = doc.cells.flatMap((c, i) => (running.has(c.id) ? [i] : []))
    return { running, kernel, busy, runningIndexes }
  }

  // The one sentence that stops "still executing" from being read as "stuck" — attached to
  // every busy result Claude gets back.
  function busyNote(s: { runningIndexes: number[] }): string {
    return `Cell(s) ${s.runningIndexes.join(', ')} are still executing or queued on the kernel. `
      + 'Any outputs shown for them are from their PREVIOUS run and will be replaced when the '
      + 'current one finishes — the notebook is working, not stuck. Poll notebook_status until '
      + 'the kernel is idle rather than assuming it has hung.'
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
  async function dirGuard(absPath: string): Promise<string | undefined> {
    try { return await realpath(dirname(absPath)) } catch { return undefined }
  }

  // Apply a mutation op then persist. The save is re-authorized-and-guarded on the doc's
  // path AT WRITE TIME (SANDBOX.md G1) — bound to the actual write, not the earlier open —
  // so a symlink swap of the notebook's directory between open and save can't redirect it.
  async function applyAndSave(sessionId: string, doc: NotebookDoc, op: NotebookOp): Promise<McpToolResult> {
    const g = await gate(sessionId, doc.path, 'write')
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
      // Carry the kernel state along for an OPEN notebook: "what am I looking at" and
      // "is it busy right now" are the same question when a run is in flight.
      const doc = p.isNotebook ? docs.getByPath(p.path) : undefined
      if (!doc) return { text: JSON.stringify(p) }
      const s = runState(doc)
      return { text: JSON.stringify({ ...p, kernel: s.kernel, busy: s.busy, runningCells: s.runningIndexes }) }
    },
  })

  mcp.register({
    name: 'open_notebook',
    description: 'Open a notebook (absolute .ipynb `path`) and FOCUS it in the calling session, so it becomes the notebook the user is looking at. Use this to show the user a notebook before working on it — and as the way to switch focus when you must edit a notebook other than the one currently visible (the edit tools refuse a different notebook otherwise).',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the .ipynb notebook.' } }, required: ['path'] },
    handler: async (sid, args) => {
      const raw = String(args.path ?? '')
      if (!raw) return { error: 'path is required (absolute .ipynb path)' }
      // Same contract open_file already enforces. Without it a relative path resolved
      // against the SERVER process's cwd (the Claudette checkout), so a host-mode session
      // silently opened <claudette-repo>/foo.ipynb and a confined one got a baffling
      // "outside this session's sandbox". Resolve ONCE and use that everywhere below —
      // gating on resolve(p) while opening the raw p let the two disagree.
      if (!isAbsolute(raw)) return { error: `path must be absolute (got ${raw})` }
      const p = resolve(raw)
      const g = await gate(sid, p, 'read')
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
    name: 'open_file',
    description: "Open a file (absolute `path`) and FOCUS it in the calling session, so it becomes what the user is looking at in the pane beside Claude. Use this when the user asks to SEE or OPEN a file — showing it in their editor is the point; reading it into your own context is not the same thing (use the Read tool for that, and only when you actually need the contents). A .ipynb path opens as a live notebook, exactly as open_notebook would.",
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file to show the user.' } }, required: ['path'] },
    handler: async (sid, args) => {
      const raw = String(args.path ?? '')
      if (!raw) return { error: 'path is required (absolute path to the file)' }
      if (!isAbsolute(raw)) return { error: `path must be absolute (got ${raw})` }
      const path = resolve(raw)
      const g = await gate(sid, path, 'read')
      if (isGateErr(g)) return g
      // A notebook has to open AS a notebook (live doc, cells, kernel) rather than as
      // raw JSON text, so hand .ipynb to the notebook path — pin included, since Claude
      // choosing a notebook to show is the same explicit choice open_notebook makes.
      if (isIpynb(path)) {
        const doc = await openByPath(path, g.guard)
        if (isErr(doc)) return doc
        onFocus(sid, doc)
        turns.set(sid, doc.path)
        return { text: `Opened and focused notebook ${doc.path} in the current session.` }
      }
      // Check it exists and isn't a directory first: better a clear error here than a tab
      // that pops open only to render "not found" at the user. (Not a readability check —
      // stat succeeds on a file the server can't read; that surfaces when the tab loads.)
      try {
        const st = await stat(path)
        if (st.isDirectory()) return { error: `${path} is a directory — open_file shows one file. Name a file inside it.` }
      } catch (e) { return { error: `cannot open ${path}: ${errMessage(e)}` } }
      onFocusFile(sid, path)
      return { text: `Opened and focused ${path} in the current session.` }
    },
  })

  mcp.register({
    name: 'read_notebook',
    description: "Read a notebook (the active pane unless `path` is given): returns each cell with its 0-based index, type, source, and a summary of its outputs, plus the notebook's live `kernel` status (none/starting/idle/busy/dead) and `busy`/`runningCells`. A cell still executing is flagged `running: true` and its outputs are from the PREVIOUS run — check that before reading unchanged outputs as a stuck notebook. Use this to see the current authoritative state before editing by index.",
    inputSchema: { type: 'object', properties: { ...pathProp }, required: [] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args, false, 'read')   // reading shouldn't pop a tab
      if (isErr(doc)) return doc
      const s = runState(doc)
      return { text: JSON.stringify({
        path: doc.path,
        kernel: s.kernel,
        busy: s.busy,
        runningCells: s.runningIndexes,
        ...(s.busy ? { note: busyNote(s) } : {}),
        cells: describeCells(doc.cells, s.running),
      }, null, 1) }
    },
  })

  mcp.register({
    name: 'edit_cell',
    description: "Replace the source of a cell (0-based `index`) in a notebook (the active pane unless `path` is given). If that notebook is open it updates live; if not, it's written to disk. The cell KEEPS its existing outputs and execution count (they now describe the previous source) until it is re-run.",
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
      const raw = String(args.path ?? '')
      if (!raw) return { error: 'path is required' }
      { const bad = requireIpynb(raw); if (bad) return bad }
      // Absolute, and resolved once — as in open_notebook/open_file. A relative path here
      // created the notebook under the server process's cwd (the Claudette checkout),
      // nowhere near the session's working directory.
      if (!isAbsolute(raw)) return { error: `path must be absolute (got ${raw})` }
      const path = resolve(raw)
      const g = await gate(sid, path, 'write')
      if (isGateErr(g)) return g
      try {
        const doc = await docs.createPath(path, g.guard)
        // Own it for THIS session now (SANDBOX.md "Unowned-kernel escape"): a freshly
        // created notebook has no owner, so a later run_cell would spawn its kernel on
        // the UNCONFINED server. Claiming it here confines that kernel to this box.
        // A brand-new notebook has no owner to lower confinement against, so this can't
        // refuse in practice — but an unowned notebook is exactly the escape above, so
        // report it rather than leave the caller believing the kernel is confined here.
        { const refused = claimOwnership(sid, doc, 'write'); if (refused) return refused }
        // Claude just made this notebook to populate it → pin it as the turn's working
        // notebook so the following path-unset cell tools land here, not in whatever
        // the user happens to be viewing.
        turns.set(sid, path)
        return { text: `created ${path}` }
      } catch (e) { return { error: errMessage(e) } }
    },
  })

  mcp.register({
    name: 'run_cell',
    description: "Execute the code cell at 0-based `index` in a notebook (the active pane unless `path` is given) on its kernel (started on first run), then return the cell outputs. Outputs are saved to disk. Blocks until the cell finishes, so a slow cell means a slow tool call — that is the cell working, not a hang. If the cell is ALREADY executing (the user ran it, or a run_all is in flight) it is not re-run and the call reports `started: false`.",
    inputSchema: { type: 'object', properties: { ...pathProp, index: { type: 'number' } }, required: ['index'] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      const id = cellIdAt(doc, args.index); if (typeof id !== 'string') return id
      // Already executing or queued (the user hit run, a run_all is in flight, another
      // session started it): KernelManager silently IGNORES the duplicate run, so we would
      // hand back the PREVIOUS run's outputs as this run's result — an instant "success"
      // carrying stale data, which is worse than a hang. Report what's actually happening.
      {
        const s = runState(doc)
        if (s.running.has(id)) return { text: JSON.stringify({ started: false, kernel: s.kernel, runningCells: s.runningIndexes, note: busyNote(s) }, null, 1) }
      }
      try {
        await kernels.runCell(doc.notebookId, id)
        const g = await gate(sid, doc.path, 'write'); if (isGateErr(g)) return g
        await docs.save(doc.notebookId, g.guard)
        const idx = doc.cells.findIndex((c) => c.id === id)
        // The cell can be deleted while its run is in flight (the run itself tolerates
        // that) — describing doc.cells[-1] would throw a TypeError over a benign race.
        if (idx < 0) return { text: `ran, but the cell was deleted from ${doc.path} before the run finished` }
        return { text: JSON.stringify(describeCell(doc.cells[idx], idx, runState(doc).running), null, 1) }
      } catch (e) { return { error: `run failed: ${errMessage(e)}` } }
    },
  })

  mcp.register({
    name: 'run_all',
    description: "Execute every code cell top-to-bottom in a notebook (the active pane unless `path` is given) on its kernel, then return all cells with their outputs. Saved to disk. Blocks until the whole notebook finishes — a slow return is the run working, not a hang. Refuses (reporting `started: false`) if a run is already in flight; poll notebook_status instead of retrying.",
    inputSchema: { type: 'object', properties: { ...pathProp }, required: [] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args); if (isErr(doc)) return doc
      // A second run_all over a notebook that's already running would interleave two
      // top-to-bottom passes on one kernel — cells re-run underneath the first pass, in
      // nobody's order. Refuse, and say what's in flight so the wait is an informed one.
      {
        const s = runState(doc)
        if (s.busy) return { text: JSON.stringify({ started: false, kernel: s.kernel, runningCells: s.runningIndexes, note: busyNote(s) }, null, 1) }
      }
      try {
        await kernels.runAll(doc.notebookId)
        const g = await gate(sid, doc.path, 'write'); if (isGateErr(g)) return g
        await docs.save(doc.notebookId, g.guard)
        return { text: JSON.stringify(describeCells(doc.cells, runState(doc).running), null, 1) }
      } catch (e) { return { error: `run_all failed: ${errMessage(e)}` } }
    },
  })

  mcp.register({
    name: 'notebook_status',
    description: "Report the LIVE execution state of a notebook (the active pane unless `path` is given): its kernel status (none/starting/idle/busy/dead) and which cells are executing or queued, by 0-based index. A running cell keeps showing its PREVIOUS run's outputs and execution count, so this is the only reliable way to tell 'still working' from 'finished'. Call it before ever concluding a notebook is stuck, and to poll a long run — it executes nothing and is cheap.",
    inputSchema: { type: 'object', properties: { ...pathProp }, required: [] },
    handler: async (sid, args) => {
      const doc = await targetDoc(sid, args, false, 'read')   // pure observation: no focus, no ownership claim
      if (isErr(doc)) return doc
      const s = runState(doc)
      return { text: JSON.stringify({
        path: doc.path,
        kernel: s.kernel,
        busy: s.busy,
        runningCells: s.runningIndexes,
        ...(s.busy ? { note: busyNote(s) } : {}),
      }, null, 1) }
    },
  })

  mcp.register({
    name: 'interrupt_kernel',
    description: "Interrupt a notebook's kernel (the active pane unless `path` is given) — the equivalent of Ctrl-C, raising KeyboardInterrupt in whatever cell is executing. Use it ONLY for a cell that is genuinely stuck: check notebook_status first, since a long-running cell is not a stuck one, and prefer asking the user before killing work in progress. Variables survive (this is not a restart).",
    inputSchema: { type: 'object', properties: { ...pathProp }, required: [] },
    handler: async (sid, args) => {
      // Gated as a READ, and deliberately claiming NO ownership: an interrupt executes no
      // code, so it can't move a kernel into this session's box — and taking ownership just
      // to Ctrl-C someone else's notebook would redirect where its kernel later runs.
      const doc = await targetDoc(sid, args, false, 'read')
      if (isErr(doc)) return doc
      const before = runState(doc)
      if (!before.busy) return { text: `Nothing is executing in ${doc.path} (kernel: ${before.kernel}) — nothing to interrupt.` }
      try { await kernels.interrupt(doc.notebookId) } catch (e) { return { error: `interrupt failed: ${errMessage(e)}` } }
      return { text: `Interrupt sent to the kernel of ${doc.path} (it was running cell(s) ${before.runningIndexes.join(', ')}). `
        + 'The cell should stop with a KeyboardInterrupt error output shortly — poll notebook_status to confirm the kernel is idle.' }
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

// Describe a whole notebook's cells against its live running set. Not `cells.map(
// describeCell)` — map passes the ARRAY as the third argument, which would land in
// `running`; the explicit arrow keeps that from ever being a silent type-hole.
function describeCells(cells: NbCell[], running: Set<string>): Record<string, unknown>[] {
  return cells.map((c, i) => describeCell(c, i, running))
}

// A compact, Claude-friendly view of a cell (index is positional, added by the caller).
// Outputs are summarized to text so the payload stays small. `running` is the notebook's
// live executing/queued set: a cell in it is flagged `running: true`, because its
// `outputs` and `executionCount` still describe the PREVIOUS run and are otherwise
// indistinguishable from a cell that has finished.
function describeCell(cell: NbCell, index: number, running: Set<string>): Record<string, unknown> {
  const base: Record<string, unknown> = { index, type: cell.cellType, source: cell.source }
  if (cell.cellType === 'code') {
    base.executionCount = cell.executionCount ?? null
    if (running.has(cell.id)) base.running = true
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
