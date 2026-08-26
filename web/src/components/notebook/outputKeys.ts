// A stable React key per cell output.
//
// WHY NOT THE ARRAY INDEX: outputs are dropped from the FRONT when a cell exceeds
// MAX_OUTPUTS (the splice at notebookDocManager.ts:474 is the ONLY index-shifting
// operation — clearCellOutputs sets [], which should remount). After a drop, index 5
// becomes index 4, so an index key hands output N's mounted node to output N+1.
//
// THIS IS LATENT TODAY, NOT LIVE, AND THE DISTINCTION DECIDES THE SEQUENCING. <Output>
// (Output.tsx:97) is a pure function of props with no hooks, and MimeContent's two useMemos
// (:67-68) are keyed on the content itself — so React reconciles in place and every memo
// dep changes correctly. Nothing is wrong right now. It STOPS being harmless the moment a
// renderer holds an instance in a ref, which is exactly what a bundled plotly/vega renderer
// needs: then key={4}'s div keeps its chart instance and is handed a different chart's data.
// SO THIS MUST LAND BEFORE THE RENDERER, NOT ALONGSIDE IT.
//
// One running count is enough precisely because drops are front-only: every surviving
// output keeps the ordinal it was born with.

export interface KeyedOutputs {
  outputs?: unknown[]
  // Count of outputs dropped from the FRONT of this cell over its lifetime. Absent on any
  // cell the server has not yet annotated — see the SEQUENCING note below.
  outputsDropped?: number
}

export function outputKeys(cell: KeyedOutputs): string[] {
  const dropped = cell.outputsDropped ?? 0
  return (cell.outputs ?? []).map((_, i) => `o${dropped + i}`)
}

// SEQUENCING — WHY THIS CAN SHIP BEFORE THE SERVER HALF:
// `outputsDropped` defaults to 0 when absent, so before the server half exists this
// produces o0, o1, o2… — exactly the array index, rendered as a string. The behaviour is
// therefore IDENTICAL to today's key={i}, and this file plus its Cell.tsx wiring is a
// no-op until notebookDocManager starts maintaining the counter. The blocked half is
// purely ADDITIVE, so the reachable half can land now and sit harmlessly until it
// arrives — no second web change needed. That shape is worth looking for anywhere else
// work straddles a boundary.
//
// THE SERVER HALF: increment a per-cell counter by the same amount the splice removes at
// notebookDocManager.ts:474, and carry it on the wire cell.
// CONSTRAINT ALREADY VERIFIED: it must NOT go in NbCell.metadata, which is "preserved
// verbatim so cells round-trip losslessly" (shared/src/notebook.ts:42) and would serialize
// to disk; nor as a key on the output dicts, which have an index signature (:33) but are
// deliberately stored nbformat-native (Output.tsx:6-7). A non-persisted field on the wire
// cell, stripped at save, is the intended home — whoever lands it must confirm the
// serializer drops it.
