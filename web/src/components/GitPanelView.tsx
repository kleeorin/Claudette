import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitStatus, GitFileStatus, GitCommit } from '@claudette/shared'
import { api } from '../api/client'

// Git panel (Phase 2). Ported from ClaudeMaster's GitPanelView, adapted to
// Claudette's tab model: it's a full main-area view keyed to the active session's
// cwd (git runs there), and its "close" returns to Chat rather than closing a
// right-side dock. The CM "open diff in an editor tab" affordance is dropped until
// a virtual file pane exists — the diff renders inline here.

type Mode = 'changes' | 'log'

interface Props {
  cwd: string       // session root — git commands run here
  onClose: () => void
}

// A selected file plus which side (staged/unstaged) its diff should show.
interface Selected {
  path: string
  staged: boolean
}

const STATUS_LABEL: Record<string, string> = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'unmerged', '?': 'untracked', T: 'typechange',
}

// Colour the single-letter status badge by kind.
function badgeClass(code: string): string {
  switch (code) {
    case 'A': case '?': return 'text-ctp-green'
    case 'M': case 'T': return 'text-ctp-yellow'
    case 'D': return 'text-ctp-red'
    case 'R': case 'C': return 'text-ctp-blue'
    case 'U': return 'text-ctp-peach'
    default: return 'text-ctp-overlay'
  }
}

function FileRow({
  file, side, selected, onSelect, onStage, onUnstage,
}: {
  file: GitFileStatus
  side: 'staged' | 'unstaged'
  selected: boolean
  onSelect: () => void
  onStage: () => void
  onUnstage: () => void
}) {
  const code = side === 'staged' ? file.index : (file.untracked ? '?' : file.worktree)
  return (
    <div
      onClick={onSelect}
      title={(file.orig ? `${file.orig} → ` : '') + file.path + ` — ${STATUS_LABEL[code] ?? code}`}
      className={`group flex items-center gap-2 px-2 py-1 rounded cursor-pointer text-xs ${
        selected ? 'bg-ctp-surface0 text-ctp-text' : 'text-ctp-subtext hover:bg-ctp-surface0/50 hover:text-ctp-text'
      }`}
    >
      <span className={`shrink-0 w-3 text-center font-mono ${badgeClass(code)}`}>{code}</span>
      <span className="flex-1 truncate">{file.path}</span>
      <button
        onClick={(e) => { e.stopPropagation(); side === 'staged' ? onUnstage() : onStage() }}
        title={side === 'staged' ? 'Unstage' : 'Stage'}
        className="opacity-0 group-hover:opacity-100 shrink-0 px-1 leading-none text-ctp-overlay hover:text-ctp-text"
      >
        {side === 'staged' ? '−' : '+'}
      </button>
    </div>
  )
}

export function GitPanelView({ cwd, onClose }: Props) {
  const [mode, setMode] = useState<Mode>('changes')
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [selected, setSelected] = useState<Selected | null>(null)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null)
  const [diff, setDiff] = useState<string>('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branchMenu, setBranchMenu] = useState(false)
  const [branchList, setBranchList] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [newBranch, setNewBranch] = useState('')

  const modeRef = useRef(mode)
  modeRef.current = mode

  const refresh = useCallback(async () => {
    const s = await api.git.status(cwd)
    setStatus(s)
  }, [cwd])

  const loadLog = useCallback(async () => {
    const r = await api.git.log(cwd, 100)
    setCommits(r.ok ? r.commits : [])
  }, [cwd])

  // Refresh on mount / session switch, and poll while open so changes Claude makes
  // in the terminal show up without a manual reload. The log only needs pulling
  // while its tab is showing.
  useEffect(() => {
    refresh()
    const t = setInterval(() => {
      refresh()
      if (modeRef.current === 'log') loadLog()
    }, 2500)
    return () => clearInterval(t)
  }, [refresh, loadLog])

  // (Re)load commits whenever the Log tab becomes active.
  useEffect(() => {
    if (mode === 'log') loadLog()
  }, [mode, loadLog])

  const files = status && status.repo === true ? status.files : []
  const staged = useMemo(() => files.filter((f) => f.staged), [files])
  const unstaged = useMemo(() => files.filter((f) => f.unstaged), [files])
  const hasUntracked = useMemo(() => unstaged.some((f) => f.untracked), [unstaged])

  // Select a working-tree file (clears any commit selection).
  const selectFile = useCallback((path: string, isStaged: boolean) => {
    setSelectedCommit(null)
    setSelected({ path, staged: isStaged })
  }, [])

  // Select a commit and load its patch into the shared diff pane.
  const selectCommit = useCallback(async (hash: string) => {
    setSelected(null)
    setSelectedCommit(hash)
    const d = await api.git.show(cwd, hash)
    setDiff(d.ok ? d.diff : `# ${d.error}`)
  }, [cwd])

  // Keep the selected file's diff in sync with the latest status. Clear the
  // selection if that file/side no longer has changes. Skipped while a commit
  // is selected (its diff is fetched directly in selectCommit).
  const selRef = useRef(selected)
  selRef.current = selected
  useEffect(() => {
    const sel = selRef.current
    if (!sel) { if (!selectedCommit) setDiff(''); return }
    const list = sel.staged ? staged : unstaged
    const file = list.find((f) => f.path === sel.path)
    if (!file) { setSelected(null); setDiff(''); return }
    let cancelled = false
    api.git.diff(cwd, file.path, sel.staged, file.untracked).then((d) => {
      if (!cancelled) setDiff(d.ok ? d.diff : `# ${d.error}`)
    })
    return () => { cancelled = true }
  }, [selected, selectedCommit, staged, unstaged, cwd])

  const run = useCallback(async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (!r.ok) setError(r.error ?? 'git error')
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const doCommit = useCallback(async () => {
    await run(() => api.git.commit(cwd, message))
    setMessage('')
  }, [run, cwd, message])

  // --- Branches ----------------------------------------------------------------

  const loadBranches = useCallback(async () => {
    const r = await api.git.branches(cwd)
    setBranchList(r.ok ? r.branches : [])
  }, [cwd])

  const toggleBranchMenu = useCallback(() => {
    setBranchMenu((open) => {
      if (!open) { setCreating(false); setNewBranch(''); void loadBranches() }
      return !open
    })
  }, [loadBranches])

  // Checkout clears any open diff (it belongs to the old branch's worktree).
  const doCheckout = useCallback(async (name: string) => {
    setBranchMenu(false)
    await run(() => api.git.checkoutBranch(cwd, name))
    setSelected(null)
    setSelectedCommit(null)
    if (modeRef.current === 'log') loadLog()
  }, [run, cwd, loadLog])

  const doCreate = useCallback(async () => {
    const name = newBranch.trim()
    setCreating(false)
    setNewBranch('')
    if (!name) return
    setBranchMenu(false)
    await run(() => api.git.createBranch(cwd, name))
  }, [run, cwd, newBranch])

  const doMerge = useCallback(async (name: string) => {
    setBranchMenu(false)
    if (!window.confirm(`Merge "${name}" into the current branch?`)) return
    await run(() => api.git.mergeBranch(cwd, name))
  }, [run, cwd])

  // Plain delete first; if git refuses an unmerged branch, offer a force-delete.
  const doDeleteBranch = useCallback(async (name: string) => {
    if (!window.confirm(`Delete branch "${name}"?`)) return
    setBusy(true)
    setError(null)
    try {
      let r = await api.git.deleteBranch(cwd, name, false)
      if (!r.ok && /not fully merged/i.test(r.error)) {
        if (window.confirm(`"${name}" isn't fully merged. Force-delete and lose its unmerged commits?`)) {
          r = await api.git.deleteBranch(cwd, name, true)
        } else { return }
      }
      if (!r.ok) setError(r.error)
      await loadBranches()
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [cwd, loadBranches, refresh])

  if (status && status.repo === false) {
    return (
      <Shell>
        <Header branch="" ahead={0} behind={0} onRefresh={() => { refresh() }} onClose={onClose} disabled />
        <div className="flex-1 flex items-center justify-center p-4 text-center text-xs text-ctp-overlay">
          Not a git repository.
        </div>
      </Shell>
    )
  }
  if (status && status.repo === 'error') {
    return (
      <Shell>
        <Header branch="" ahead={0} behind={0} onRefresh={() => { refresh() }} onClose={onClose} disabled />
        <div className="flex-1 flex items-center justify-center p-4 text-center text-xs text-ctp-red">
          {status.error}
        </div>
      </Shell>
    )
  }

  const branch = status && status.repo === true ? status.branch : ''
  const ahead = status && status.repo === true ? status.ahead : 0
  const behind = status && status.repo === true ? status.behind : 0

  return (
    <Shell>
      {/* Header: branch + ahead/behind + refresh */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ctp-mauve shrink-0">
          <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" />
          <path d="M6 8.5v7M18 11.5a6 6 0 0 1-6 6H8" />
        </svg>
        <div className="relative flex-1 min-w-0">
          <button
            onClick={toggleBranchMenu}
            disabled={!branch}
            title={branch ? `Branch: ${branch} — click to switch` : 'No branch'}
            className="flex items-center gap-1 text-xs text-ctp-text disabled:opacity-60 max-w-full"
          >
            <span className="truncate">{branch || '…'}</span>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="shrink-0 text-ctp-overlay">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          {branchMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setBranchMenu(false)} />
              <div className="absolute z-50 left-0 top-7 w-60 max-h-80 overflow-y-auto bg-ctp-surface0 border border-ctp-surface1 rounded shadow-lg py-1 text-xs">
                {branchList.length === 0 ? (
                  <div className="px-3 py-1.5 text-ctp-overlay">No branches</div>
                ) : (
                  branchList.map((b) => {
                    const current = b === branch
                    return (
                      <div key={b} className="group flex items-center gap-1 pl-2 pr-1 py-1 hover:bg-ctp-surface1">
                        <span className={`shrink-0 w-3 text-center ${current ? 'text-ctp-green' : 'text-transparent'}`}>●</span>
                        <button
                          onClick={() => { if (!current) void doCheckout(b) }}
                          disabled={current || busy}
                          title={current ? 'Current branch' : `Switch to ${b}`}
                          className="flex-1 min-w-0 truncate text-left text-ctp-text disabled:cursor-default"
                        >
                          {b}
                        </button>
                        {!current && (
                          <>
                            <button onClick={() => void doMerge(b)} disabled={busy} title={`Merge ${b} into current`} className="shrink-0 opacity-0 group-hover:opacity-100 px-1 text-[10px] text-ctp-overlay hover:text-ctp-blue">merge</button>
                            <button onClick={() => void doDeleteBranch(b)} disabled={busy} title={`Delete ${b}`} className="shrink-0 opacity-0 group-hover:opacity-100 px-1 text-ctp-overlay hover:text-ctp-red">✕</button>
                          </>
                        )}
                      </div>
                    )
                  })
                )}
                <div className="mx-2 my-0.5 border-t border-ctp-surface1" />
                {creating ? (
                  <input
                    autoFocus
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void doCreate() }
                      else if (e.key === 'Escape') { setCreating(false); setNewBranch('') }
                    }}
                    onBlur={() => { setCreating(false); setNewBranch('') }}
                    placeholder="new-branch-name"
                    className="block w-[calc(100%-1rem)] mx-2 my-1 bg-ctp-base text-ctp-text px-2 py-1 rounded outline-none border border-ctp-blue"
                  />
                ) : (
                  <button onClick={() => setCreating(true)} className="w-full text-left px-3 py-1.5 text-ctp-text hover:bg-ctp-surface1">+ New branch…</button>
                )}
              </div>
            </>
          )}
        </div>
        {(ahead > 0 || behind > 0) && (
          <span className="text-[10px] text-ctp-overlay tabular-nums">
            {ahead > 0 && `↑${ahead}`} {behind > 0 && `↓${behind}`}
          </span>
        )}
        <button onClick={() => { refresh(); loadLog() }} title="Refresh" className="text-ctp-overlay hover:text-ctp-text text-xs leading-none">⟳</button>
        <button onClick={onClose} title="Close (back to Chat)" className="text-ctp-overlay hover:text-ctp-text p-1">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Changes / Log tabs */}
      <div className="shrink-0 flex bg-ctp-mantle border-b border-ctp-surface0 text-xs">
        {(['changes', 'log'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-1.5 capitalize transition-colors ${
              mode === m ? 'text-ctp-text border-b-2 border-ctp-mauve' : 'text-ctp-overlay hover:text-ctp-subtext border-b-2 border-transparent'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {error && (
        <div className="shrink-0 px-3 py-1.5 text-[11px] text-ctp-red bg-ctp-red/10 border-b border-ctp-surface0 break-words">
          {error}
        </div>
      )}

      {/* File lists (Changes tab) */}
      {mode === 'changes' && (
      <div className="shrink-0 max-h-[45%] overflow-y-auto px-1.5 py-1.5 space-y-2 border-b border-ctp-surface0">
        <Section
          title={`Staged (${staged.length})`}
          actions={staged.length ? [{ label: 'Unstage all', onClick: () => run(() => api.git.unstageAll(cwd)) }] : undefined}
        >
          {staged.map((f) => (
            <FileRow
              key={`s:${f.path}`} file={f} side="staged"
              selected={selected?.path === f.path && selected.staged}
              onSelect={() => selectFile(f.path, true)}
              onStage={() => run(() => api.git.stage(cwd, f.path))}
              onUnstage={() => run(() => api.git.unstage(cwd, f.path))}
            />
          ))}
          {!staged.length && <Empty>Nothing staged</Empty>}
        </Section>

        <Section
          title={`Changed (${unstaged.length})`}
          actions={unstaged.length ? [
            // `git add -u` — only tracked files; shown only when it would differ
            // from "Stage all" (i.e. there's at least one untracked file to skip).
            ...(hasUntracked ? [{ label: 'Stage tracked', title: 'Stage modified & deleted tracked files only (git add -u)', onClick: () => run(() => api.git.stageTracked(cwd)) }] : []),
            { label: 'Stage all', onClick: () => run(() => api.git.stageAll(cwd)) },
          ] : undefined}
        >
          {unstaged.map((f) => (
            <FileRow
              key={`u:${f.path}`} file={f} side="unstaged"
              selected={selected?.path === f.path && !selected.staged}
              onSelect={() => selectFile(f.path, false)}
              onStage={() => run(() => api.git.stage(cwd, f.path))}
              onUnstage={() => run(() => api.git.unstage(cwd, f.path))}
            />
          ))}
          {!unstaged.length && <Empty>No changes</Empty>}
        </Section>
      </div>
      )}

      {/* Commit list (Log tab) */}
      {mode === 'log' && (
        <div className="shrink-0 max-h-[45%] overflow-y-auto py-1 border-b border-ctp-surface0">
          {commits.map((c) => (
            <div
              key={c.hash}
              onClick={() => selectCommit(c.hash)}
              title={`${c.short} · ${c.author} · ${c.date}`}
              className={`px-3 py-1 cursor-pointer ${
                selectedCommit === c.hash ? 'bg-ctp-surface0' : 'hover:bg-ctp-surface0/50'
              }`}
            >
              <div className="flex items-center gap-2 text-xs">
                <span className="shrink-0 font-mono text-ctp-peach">{c.short}</span>
                <span className="flex-1 truncate text-ctp-text">{c.subject}</span>
              </div>
              <div className="text-[10px] text-ctp-overlay truncate">{c.author} · {c.date}</div>
            </div>
          ))}
          {!commits.length && <Empty>No commits yet</Empty>}
        </div>
      )}

      {/* Diff (shared by both tabs) */}
      <div className="flex-1 min-h-0 flex flex-col bg-ctp-base">
        {selected || selectedCommit ? (
          <div className="flex-1 min-h-0 overflow-auto">
            <DiffView text={diff} />
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-ctp-overlay">
            {mode === 'log' ? 'Select a commit to view its diff' : 'Select a file to view its diff'}
          </div>
        )}
      </div>

      {/* Commit (Changes tab only) */}
      {mode === 'changes' && (
      <div className="shrink-0 p-2 border-t border-ctp-surface0 bg-ctp-mantle space-y-1.5">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doCommit() }}
          placeholder="Commit message  (⌘/Ctrl+Enter)"
          rows={2}
          className="w-full resize-none rounded bg-ctp-base border border-ctp-surface0 focus:border-ctp-mauve outline-none px-2 py-1 text-xs text-ctp-text placeholder:text-ctp-overlay"
        />
        <button
          onClick={doCommit}
          disabled={busy || !message.trim() || staged.length === 0}
          className="w-full px-3 py-1.5 text-xs rounded bg-ctp-mauve/20 text-ctp-mauve hover:bg-ctp-mauve/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Commit {staged.length > 0 ? `${staged.length} file${staged.length > 1 ? 's' : ''}` : ''}
        </button>
      </div>
      )}
    </Shell>
  )
}

// A minimal header used only for the not-a-repo / error states (the main render
// inlines its own richer header with the branch menu).
function Header({ onRefresh, onClose, disabled }: {
  branch: string; ahead: number; behind: number; onRefresh: () => void; onClose: () => void; disabled?: boolean
}) {
  return (
    <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ctp-mauve shrink-0">
        <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" />
        <path d="M6 8.5v7M18 11.5a6 6 0 0 1-6 6H8" />
      </svg>
      <span className="flex-1 text-xs text-ctp-overlay">{disabled ? 'Git' : ''}</span>
      <button onClick={onRefresh} title="Refresh" className="text-ctp-overlay hover:text-ctp-text text-xs leading-none">⟳</button>
      <button onClick={onClose} title="Close (back to Chat)" className="text-ctp-overlay hover:text-ctp-text p-1">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col h-full bg-ctp-base overflow-hidden">{children}</div>
}

interface SectionAction { label: string; onClick: () => void; title?: string }

function Section({ title, actions, children }: { title: string; actions?: SectionAction[]; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 px-1.5 pb-0.5">
        <span className="text-[10px] font-semibold text-ctp-overlay uppercase tracking-widest">{title}</span>
        <div className="flex items-center gap-2">
          {actions?.map((a) => (
            <button key={a.label} onClick={a.onClick} title={a.title} className="text-[10px] text-ctp-overlay hover:text-ctp-text whitespace-nowrap">{a.label}</button>
          ))}
        </div>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-1 text-[11px] text-ctp-overlay">{children}</p>
}

// Minimal unified-diff colouring. Hunk headers and +/- lines get tinted; the rest
// renders as context.
function DiffView({ text }: { text: string }) {
  if (!text.trim()) return <div className="h-full flex items-center justify-center text-xs text-ctp-overlay">No textual diff</div>
  const lines = text.split('\n')
  return (
    <pre className="text-[11px] leading-[1.35] font-mono px-2 py-1">
      {lines.map((ln, i) => {
        let cls = 'text-ctp-subtext'
        if (ln.startsWith('+') && !ln.startsWith('+++')) cls = 'text-ctp-green'
        else if (ln.startsWith('-') && !ln.startsWith('---')) cls = 'text-ctp-red'
        else if (ln.startsWith('@@')) cls = 'text-ctp-blue'
        else if (ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('+++') || ln.startsWith('---')) cls = 'text-ctp-overlay'
        return <div key={i} className={cls}>{ln || ' '}</div>
      })}
    </pre>
  )
}
