import type { RewindPreview } from '@claudette/shared'

// What the /rewind confirm dialog says about a SCOPED code restore. Pure, so the wording
// rules are tested without a DOM (see rewindPreview.test.ts).
//
// The restore touches only files THIS session edited with its file-edit tools from the turn
// on (server rewindScope.ts). Two things the operator must see before confirming:
//   · CONFLICTS — files in that set another live session in the same repo also edited after
//     the turn. Restoring overwrites that session's change, so each file is listed with WHO,
//     not summarised as a count: "2 conflicts" does not tell you whether to stop.
//   · SKIPPED — files in the set the restore will not touch (outside the repo, gitignored),
//     so "nothing to restore" is never claimed while edits are being left in place.

export interface ConflictLine { path: string; who: string }

// One line per conflicting file, naming every other session that touched it.
export function conflictLines(p: RewindPreview): ConflictLine[] {
  return (p.conflicts ?? []).map((c) => ({
    path: c.path,
    who: c.sessions.map((s) => s.name || s.id.slice(0, 8)).join(', '),
  }))
}

// True only when the restore really has nothing to do AND nothing was left out. A preview
// with skipped files is not "already matches": the session edited them and they stay as-is.
export function nothingToRestore(p: RewindPreview): boolean {
  return p.reverted.length === 0 && p.deleted.length === 0 && (p.skipped ?? []).length === 0
}
