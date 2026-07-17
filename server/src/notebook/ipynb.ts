// nbformat v4.5 reader/writer for the server-owned notebook doc. Ported from
// ClaudeMaster's renderer codec (`renderer/lib/ipynb.ts`), with two changes for
// Claudette's authoritative-doc model:
//   1. Cell ids are PERSISTED (nbformat 4.5 `cell.id`), not memory-only — this is
//      what makes cellId addressing stable across reload / restart.
//   2. Outputs are kept nbformat-native (`NbOutput`), not translated into a
//      normalized union. The server doc mirrors the .ipynb faithfully; the kernel
//      client (P1.9) produces the same nbformat output dicts, so there is no lossy
//      round-trip.
import { randomUUID } from 'crypto'
import { nbText } from '@claudette/shared'
import type { NbCell, NbCellType, NbOutput } from '@claudette/shared'

export interface NotebookMeta {
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

// Split a string into nbformat's line array (each line keeps its trailing "\n"
// except the last). An empty string serializes to [].
function splitLines(s: string): string[] {
  if (s === '') return []
  const parts = s.split('\n')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (i < parts.length - 1) out.push(parts[i] + '\n')
    else if (parts[i] !== '') out.push(parts[i])
  }
  return out
}

function cellTypeOf(raw: unknown): NbCellType {
  return raw === 'markdown' ? 'markdown' : raw === 'raw' ? 'raw' : 'code'
}

export function parseNotebook(text: string): { cells: NbCell[]; meta: NotebookMeta } {
  let nb: Record<string, unknown>
  try { nb = JSON.parse(text) as Record<string, unknown> } catch { nb = {} }

  const rawCells = Array.isArray(nb.cells) ? nb.cells : []
  const seenIds = new Set<string>()
  const cells: NbCell[] = rawCells.map((raw) => {
    const c = raw as Record<string, unknown>
    const cellType = cellTypeOf(c.cell_type)
    // Preserve a disk-provided 4.5 id; mint one when absent (older 4.0–4.4 files) OR
    // when it collides with an already-seen id — duplicate ids would make cellId
    // addressing resolve to the wrong cell (silent wrong-cell edit/delete/move).
    const diskId = typeof c.id === 'string' && c.id ? c.id : ''
    const id = diskId && !seenIds.has(diskId) ? diskId : randomUUID()
    seenIds.add(id)
    const cell: NbCell = {
      id,
      cellType,
      source: nbText(c.source),
      metadata: c.metadata && typeof c.metadata === 'object' ? (c.metadata as Record<string, unknown>) : {},
    }
    // Markdown/raw cells may carry an `attachments` dict (inline images); keep it so
    // an edit-then-save round-trips losslessly.
    if (cellType !== 'code' && c.attachments && typeof c.attachments === 'object') {
      cell.attachments = c.attachments as Record<string, unknown>
    }
    if (cellType === 'code') {
      // Outputs kept verbatim (already nbformat output dicts); execution_count as-is.
      cell.outputs = Array.isArray(c.outputs) ? (c.outputs as NbOutput[]) : []
      cell.executionCount = typeof c.execution_count === 'number' ? c.execution_count : null
    }
    return cell
  })
  if (cells.length === 0) cells.push(emptyCodeCell())

  return {
    cells,
    meta: {
      metadata: nb.metadata && typeof nb.metadata === 'object' ? (nb.metadata as Record<string, unknown>) : {},
      nbformat: typeof nb.nbformat === 'number' ? nb.nbformat : 4,
      // Force >= 5 on read so a loaded 4.0–4.4 file round-trips WITH the cell ids
      // we just minted (ids are only valid in nbformat 4.5+).
      nbformat_minor: typeof nb.nbformat_minor === 'number' && nb.nbformat_minor >= 5 ? nb.nbformat_minor : 5,
    },
  }
}

export function serializeNotebook(cells: NbCell[], meta: NotebookMeta): string {
  const nb = {
    cells: cells.map((c) => {
      const out: Record<string, unknown> = {
        cell_type: c.cellType,
        id: c.id,                       // persist the stable id (4.5)
        metadata: c.metadata ?? {},
        source: splitLines(c.source),
      }
      if (c.cellType === 'code') {
        out.execution_count = c.executionCount ?? null
        out.outputs = c.outputs ?? []   // already nbformat output dicts
      } else if (c.attachments) {
        out.attachments = c.attachments  // preserve inline-image attachments
      }
      return out
    }),
    metadata: meta.metadata,
    nbformat: meta.nbformat,
    nbformat_minor: meta.nbformat_minor,
  }
  // Jupyter writes notebooks with single-space indentation + a trailing newline.
  return JSON.stringify(nb, null, 1) + '\n'
}

export function emptyCodeCell(source = ''): NbCell {
  return { id: randomUUID(), cellType: 'code', source, outputs: [], executionCount: null, metadata: {} }
}

// A fresh notebook (one empty code cell, python3 kernelspec) as nbformat text.
export function emptyNotebookText(): string {
  return serializeNotebook([emptyCodeCell()], {
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  })
}
