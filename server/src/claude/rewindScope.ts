import type { RewindConflict } from '@claudette/shared'
import { fileEditsFrom, fileEditsSince } from './conversations'
import { repoRoot, repoRel } from '../git/shadowSnapshots'

// What a /rewind code-restore of one session may touch, and who else is in the way.
//
// `paths` is the restore set: every file THIS conversation changed with its file-edit tools
// from the target turn on (conversations.ts fileEditsFrom — see the rules there). The
// snapshot side (shadowSnapshots.ts restore/previewRestore) touches nothing outside it.
//
// `conflicts` are paths in that set which ANOTHER live session in the same repo also edited
// after the target turn. Restoring them still proceeds if the operator confirms — the point
// is that they confirm knowing whose work the restore overwrites. Turn boundaries of two
// different conversations are unrelated, so "after the target turn" is judged by wall-clock
// time against the target turn's own timestamp. Sessions in a different repo are skipped,
// and paths are compared repo-relative so two spellings of one file still collide.
export interface ScopeSession { id: string; name: string; cwd: string; claudeId?: string }

export interface RewindScope { paths: string[]; conflicts: RewindConflict[] }

export async function rewindScope(
  self: ScopeSession & { claudeId: string },
  uuid: string,
  others: ScopeSession[],
): Promise<RewindScope | null> {
  const own = await fileEditsFrom(self.cwd, self.claudeId, uuid)
  if (!own) return null
  const paths = [...new Set(own.edits.map((e) => e.path))]
  const root = await repoRoot(self.cwd)
  if (!root || !paths.length) return { paths, conflicts: [] }

  const mine = new Map<string, string>()   // repo-relative → as reported to the client
  for (const p of paths) { const r = repoRel(root, p); if (r) mine.set(r, r) }

  const byPath = new Map<string, { id: string; name: string }[]>()
  for (const o of others) {
    if (o.id === self.id || !o.claudeId) continue
    if ((await repoRoot(o.cwd)) !== root) continue
    for (const e of await fileEditsSince(o.cwd, o.claudeId, own.fromMs)) {
      const r = repoRel(root, e.path)
      if (!r || !mine.has(r)) continue
      const list = byPath.get(r) ?? []
      if (!list.some((s) => s.id === o.id)) list.push({ id: o.id, name: o.name })
      byPath.set(r, list)
    }
  }
  const conflicts = [...byPath.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, sessions]) => ({ path, sessions }))
  return { paths, conflicts }
}
