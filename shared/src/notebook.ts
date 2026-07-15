// Claudette's authoritative notebook document model (server-owned; see PLAN §4).
// The server holds one of these per OPEN notebook; the UI is a pure view of it,
// and Claude mutates it through the same ops API. All addressing is by stable
// `notebookId` + `cellId` — never "the active pane".

export type NbCellType = 'code' | 'markdown' | 'raw'

// Kernel lifecycle as surfaced to the UI (mirrors Jupyter's execution_state plus
// our starting/dead bookends). 'none' = no kernel started yet (or shut down) — the
// default before the first run, so the UI shows "No kernel" instead of a bogus idle.
export type KernelStatus = 'none' | 'starting' | 'idle' | 'busy' | 'dead'

// An available Jupyter kernelspec (for the kernel picker). `name` is the id passed
// to POST /api/kernels; `displayName`/`language` are for the UI.
export interface KernelSpec {
  name: string
  displayName: string
  language: string
}

// nbformat output kept loose (stream / execute_result / display_data / error).
export interface NbOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error'
  [k: string]: unknown
}

export interface NbCell {
  id: string                 // stable cell id (nbformat 4.5 `cell.id`)
  cellType: NbCellType
  source: string
  outputs?: NbOutput[]       // code cells only
  executionCount?: number | null
  metadata?: Record<string, unknown>  // preserved verbatim so cells round-trip losslessly
}

export interface NotebookDoc {
  notebookId: string         // server-assigned stable id for the open notebook
  path: string               // .ipynb path (may be remote-encoded, see remotePath)
  cells: NbCell[]
  metadata: Record<string, unknown>
  version: number            // bumped on every applied op (optimistic concurrency)
  dirty: boolean             // unsaved changes vs disk
  conflict?: boolean         // disk changed under us while we had unsaved edits
  kernelId?: string          // bound kernel, if any
  kernelName?: string        // selected kernelspec name (e.g. 'python3'); undefined = default
  canUndo?: boolean          // undo history has an entry (drives the toolbar button)
  canRedo?: boolean          // redo history has an entry
}

// Ops — the ONLY way to mutate a doc, from the UI or from Claude (same path).
export type NotebookOp =
  | { op: 'editCell'; notebookId: string; cellId: string; source: string }
  | { op: 'addCell'; notebookId: string; cellType: NbCellType; source?: string; afterCellId?: string }
  | { op: 'insertCell'; notebookId: string; index: number; cellType: NbCellType; source?: string }
  | { op: 'deleteCell'; notebookId: string; cellId: string }
  | { op: 'moveCell'; notebookId: string; cellId: string; toIndex: number }
  | { op: 'setCellType'; notebookId: string; cellId: string; cellType: NbCellType }
  | { op: 'runCell'; notebookId: string; cellId: string }
  | { op: 'runAll'; notebookId: string }

export type NotebookOpResult =
  | { ok: true; version: number }
  | { ok: false; error: string; code?: 'locked' | 'not_found' | 'conflict' }

// Cell locks (see PLAN §4.2). A lock is held by the human; Claude's edits to a
// held cell are hard-denied by the server.
export type LockReason = 'focus' | 'dirty' | 'pin'
export interface CellLock {
  notebookId: string
  cellId: string
  reason: LockReason
}
