import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { DiffEditor } from './DiffEditor'
import { DiffView } from './GitPanelView'
import { useFind } from '../lib/useFind'

// What a git diff tab shows: one changed file on one side (staged: HEAD→index,
// unstaged: index→worktree), or one whole commit. A commit spans many files, so it
// keeps the unified-patch rendering; a single file gets the same merge view as the
// file-edit review, read-only.
export type GitDiffSpec =
  | { cwd: string; path: string; staged: boolean; untracked: boolean; orig?: string }
  | { cwd: string; hash: string; subject: string }

export const gitDiffKey = (s: GitDiffSpec) =>
  'hash' in s ? `gd:${s.cwd}:c:${s.hash}` : `gd:${s.cwd}:${s.staged ? 's' : 'u'}:${s.path}`

export const gitDiffLabel = (s: GitDiffSpec) =>
  'hash' in s ? s.hash.slice(0, 7) : `${s.path.split('/').pop()} (${s.staged ? 'staged' : 'diff'})`

// Same cadence as the git panel's own status poll, so the tab tracks the panel.
const POLL_MS = 2500

type Loaded =
  | { kind: 'sides'; original: string; modified: string }
  | { kind: 'patch'; text: string }
  | { kind: 'binary' }
  | { kind: 'error'; error: string }

const same = (a: Loaded | null, b: Loaded) => JSON.stringify(a) === JSON.stringify(b)

export function GitDiffTab({ spec }: { spec: GitDiffSpec }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // Bumped only when the texts actually change: rebuilding the merge view on every poll
  // would throw away the scroll position and any open find.
  const [gen, setGen] = useState(0)
  const find = useFind()
  const key = gitDiffKey(spec)

  useEffect(() => {
    let cancelled = false
    let last: Loaded | null = null
    const load = async () => {
      let next: Loaded
      if ('hash' in spec) {
        const d = await api.git.show(spec.cwd, spec.hash)
        next = d.ok ? { kind: 'patch', text: d.diff } : { kind: 'error', error: d.error }
      } else {
        const d = await api.git.sides(spec.cwd, spec.path, spec.staged, spec.untracked, spec.orig)
        next = !d.ok ? { kind: 'error', error: d.error }
          : d.binary ? { kind: 'binary' }
          : { kind: 'sides', original: d.original, modified: d.modified }
      }
      if (cancelled || same(last, next)) return
      last = next
      setLoaded(next)
      setGen((g) => g + 1)
    }
    void load().catch((e) => { if (!cancelled) setLoaded({ kind: 'error', error: String(e) }) })
    // A commit never changes; only working-tree diffs need to follow the disk.
    const t = 'hash' in spec ? 0 : window.setInterval(() => { void load().catch(() => {}) }, POLL_MS)
    return () => { cancelled = true; if (t) clearInterval(t) }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const title = 'hash' in spec ? `${spec.hash.slice(0, 7)} ${spec.subject}` : spec.path
  const filename = 'hash' in spec ? '' : spec.path
  const side = 'hash' in spec ? 'commit' : spec.untracked ? 'untracked' : spec.staged ? 'staged · HEAD → index' : 'unstaged · index → working tree'

  return (
    <div className="h-full min-h-0 flex flex-col bg-ctp-base">
      <div className="shrink-0 flex items-center gap-2 px-3 h-8 border-b border-ctp-surface0 bg-ctp-mantle">
        <span className="text-xs text-ctp-text truncate" title={title}>{title}</span>
        <span className="shrink-0 text-[10px] text-ctp-overlay">{side}</span>
      </div>
      <div className="flex-1 min-h-0">
        {!loaded ? (
          <div className="h-full flex items-center justify-center text-xs text-ctp-overlay">Loading…</div>
        ) : loaded.kind === 'error' ? (
          <div className="h-full flex items-center justify-center text-xs text-ctp-red">{loaded.error}</div>
        ) : loaded.kind === 'binary' ? (
          <div className="h-full flex items-center justify-center text-xs text-ctp-overlay">Binary file — no diff.</div>
        ) : loaded.kind === 'patch' ? (
          <div className="h-full overflow-auto"><DiffView text={loaded.text} /></div>
        ) : loaded.original === loaded.modified ? (
          <div className="h-full flex items-center justify-center text-xs text-ctp-overlay">No changes on this side any more.</div>
        ) : (
          <DiffEditor
            key={gen}
            readOnly
            original={loaded.original}
            proposed={loaded.modified}
            filename={filename}
            find={find}
            scrollKey={key}
          />
        )}
      </div>
    </div>
  )
}
