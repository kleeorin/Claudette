import type { PermissionDecision } from '@claudette/shared'

// --- Inline edit-proposal helpers --------------------------------------------
// When Claude asks to Edit / MultiEdit / Write a file, we render the change as an
// inline +/- diff inside the file's own editor and let the user accept/reject per
// hunk before it lands on disk. The whole flow rides the mandatory permission
// checkpoint: the file only changes if we answer the permission `allow` with an
// `updatedInput` reconstructed from the hunks the user kept (see reconstructDecision).

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])

export const isEditTool = (name: string): boolean => EDIT_TOOLS.has(name)

// Notebooks are edited through the app-control tools (never the native file tools),
// so a .ipynb never reaches this flow — but guard anyway.
export const isNotebookPath = (p: string): boolean => /\.ipynb$/i.test(p)

export function filePathOf(input: unknown): string | undefined {
  const fp = (input as { file_path?: unknown } | null)?.file_path
  return typeof fp === 'string' ? fp : undefined
}

type Edit = { old_string?: unknown; new_string?: unknown; replace_all?: unknown }

// Apply a single Edit-style replacement to `text`. Returns null when `old_string`
// isn't found (so we can flag a preview that can't be reconstructed rather than
// silently showing a no-op diff).
function applyOne(text: string, e: Edit): string | null {
  const oldS = typeof e.old_string === 'string' ? e.old_string : ''
  const newS = typeof e.new_string === 'string' ? e.new_string : ''
  if (oldS === '') return null           // Edit requires a non-empty match
  if (e.replace_all) {
    if (!text.includes(oldS)) return null
    return text.split(oldS).join(newS)
  }
  const idx = text.indexOf(oldS)
  if (idx < 0) return null
  return text.slice(0, idx) + newS + text.slice(idx + oldS.length)
}

// Compute the PROPOSED whole-file text from the disk `base` and the tool input.
// `ok:false` means we couldn't apply the edit cleanly (a match went missing) —
// the caller falls back to the plain permission card instead of a diff view.
export function applyProposal(
  base: string,
  toolName: string,
  input: Record<string, unknown>,
): { proposed: string; ok: boolean } {
  if (toolName === 'Write') {
    return { proposed: typeof input.content === 'string' ? input.content : '', ok: true }
  }
  if (toolName === 'Edit') {
    const out = applyOne(base, input as Edit)
    return out == null ? { proposed: base, ok: false } : { proposed: out, ok: true }
  }
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? (input.edits as Edit[]) : []
    let cur = base
    for (const e of edits) {
      const out = applyOne(cur, e)
      if (out == null) return { proposed: cur, ok: false }
      cur = out
    }
    return { proposed: cur, ok: edits.length > 0 }
  }
  return { proposed: base, ok: false }
}

// Turn the user's accepted result (the merge view's current doc) back into a
// permission decision. Trick: since `base` is the exact current disk content, a
// single whole-file replacement (old_string = base → new_string = result) is
// always a valid, unique Edit/MultiEdit — so ANY subset of accepted hunks maps to
// a correct updatedInput without per-hunk bookkeeping. Write takes the result
// straight into `content`. An empty result (all hunks rejected) → deny.
export function reconstructDecision(
  toolName: string,
  input: Record<string, unknown>,
  base: string,
  result: string,
): PermissionDecision {
  if (result === base) return { behavior: 'deny', message: 'No changes accepted' }
  if (toolName === 'Write') {
    return { behavior: 'allow', updatedInput: { ...input, content: result } }
  }
  // Edit/MultiEdit on an empty file can't use a whole-file old_string match; let
  // the CLI apply the original input (its own create/edit semantics handle it).
  if (base === '') return { behavior: 'allow' }
  if (toolName === 'Edit') {
    return {
      behavior: 'allow',
      updatedInput: { ...input, old_string: base, new_string: result, replace_all: false },
    }
  }
  // MultiEdit → collapse to one whole-file edit reflecting exactly what was kept.
  return {
    behavior: 'allow',
    updatedInput: { file_path: input.file_path, edits: [{ old_string: base, new_string: result }] },
  }
}
