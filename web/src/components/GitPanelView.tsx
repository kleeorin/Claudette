import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitStatus, GitFileStatus, GitCommit } from '@claudette/shared'
import { api } from '../api/client'
import { DockShell } from './DockShell'
import { useScrollMemory } from '../lib/scrollMemory'

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

  // ── Scroll memory ────────────────────────────────────────────────────────────────
  // Mounted as <GitPanelView key={termCwd} cwd={termCwd}> (App.tsx), so this panel is
  // torn down whenever you close the dock or switch to a session with a DIFFERENT cwd.
  // Both drop you back at the top of a long changed-files list or a long diff.
  //
  // Keyed by CWD, NOT by session — a deliberate divergence from every other consumer of this
  // hook (`file:`/`nb:`/`agent:` are all `${sessionId}:`). Those key by session because ONE
  // component instance is reused across sessions showing the same path, so two readers need two
  // offsets. This panel is different: the mount site already keys by cwd, so two sessions
  // sharing a cwd share this instance and its single DOM node.
  // The reason is CONSISTENCY WITH THE REST OF THIS PANEL'S STATE. Nothing else here is
  // session-scoped — the mode, the selected file, the loaded diff and the commit-message draft
  // all persist untouched across a same-cwd session switch, because nothing remounts. If the
  // scroll offset alone became session-scoped, switching session would scroll the view while the
  // selection, the diff under it and the message you were typing all stayed put. One panel, one
  // position. scroll-memory-check [3g] reds if you session-scope this.
  // NOT the reason, though it reads like one: "session-scoping would invent a scroll jump."
  // MEASURED FALSE — a key nobody has stored yet has target 0, and the hook only forces an
  // offset when target > 0, so the first switch is a no-op either way. It takes a session that
  // has already left its own offset behind to tell the two schemes apart, which is why [3g] is
  // shaped the way it is and why [3e] alone was not evidence for anything.
  const changesRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<HTMLDivElement>(null)
  // Pass null while a container isn't rendered rather than letting the hook poll a `getEl`
  // that cannot resolve: it stops looking after ATTACH_MS and never retries, so a mode
  // switch later than that would silently stop restoring. null → key re-runs the effect.
  // Same idiom as FileEditorView's image container.
  useScrollMemory(mode === 'changes' ? `git:${cwd}:changes` : null, () => changesRef.current)
  useScrollMemory(mode === 'log' ? `git:${cwd}:log` : null, () => logRef.current)
  // The diff pane's subject is the specific patch, so it belongs in the key: read file A's
  // diff, look at B, come back to A and you are where you left off. Staged and unstaged are
  // two different patches for one path, hence the side.
  const diffSubject = selectedCommit ? `c:${selectedCommit}`
    : selected ? `${selected.staged ? 's' : 'u'}:${selected.path}`
    : null
  useScrollMemory(diffSubject && `git:${cwd}:diff:${diffSubject}`, () => diffRef.current)

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

  // Select a commit and load its patch into the shared diff pane. `showReq` drops a
  // late reply from an earlier click: pick A then B quickly and A could resolve last,
  // leaving row B highlighted above A's patch. The working-tree path below has the
  // same guard as a `cancelled` flag; this one is a click handler, so it counts.
  const showReq = useRef(0)
  const selectCommit = useCallback(async (hash: string) => {
    const req = ++showReq.current
    setSelected(null)
    setSelectedCommit(hash)
    const d = await api.git.show(cwd, hash)
    if (req !== showReq.current) return
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

  // Returns whether the operation SUCCEEDED, so callers with follow-up state (the
  // commit box) can tell "git said no" apart from "the call returned".
  const run = useCallback(async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (!r.ok) setError(r.error ?? 'git error')
      await refresh()
      return r.ok
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const doCommit = useCallback(async () => {
    // Clear the box ONLY on success. A commit refused by a pre-commit hook, a bad
    // identity, or "nothing staged" resolves normally here (run only sets `error`), and
    // the unconditional clear threw away the message the user had just written —
    // precisely when they need it to fix the error and retry.
    if (await run(() => api.git.commit(cwd, message))) setMessage('')
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

  // --- Remote ------------------------------------------------------------------

  const doFetch = useCallback(async () => {
    await run(() => api.git.fetch(cwd))
  }, [run, cwd])

  // Pull can land new commits, so refresh the log if it's showing.
  const doPull = useCallback(async () => {
    await run(() => api.git.pull(cwd))
    if (modeRef.current === 'log') loadLog()
  }, [run, cwd, loadLog])

  // setUpstream publishes a branch that has no tracking ref yet (push -u origin).
  const doPush = useCallback(async (setUpstream: boolean) => {
    await run(() => api.git.push(cwd, setUpstream))
  }, [run, cwd])

  if (status && status.repo === false) {
    return (
      <DockShell>
        <Header onRefresh={() => { refresh() }} onClose={onClose} disabled />
        <div className="flex-1 flex items-center justify-center p-4 text-center text-xs text-ctp-overlay">
          Not a git repository.
        </div>
      </DockShell>
    )
  }
  if (status && status.repo === 'error') {
    return (
      <DockShell>
        <Header onRefresh={() => { refresh() }} onClose={onClose} disabled />
        <div className="flex-1 flex items-center justify-center p-4 text-center text-xs text-ctp-red">
          {status.error}
        </div>
      </DockShell>
    )
  }

  const branch = status && status.repo === true ? status.branch : ''
  const upstream = status && status.repo === true ? status.upstream : null
  const ahead = status && status.repo === true ? status.ahead : 0
  const behind = status && status.repo === true ? status.behind : 0

  return (
    <DockShell>
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
        {/* Remote: pull ↓, push/publish ↑, fetch. Counts come from status. */}
        {branch && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => void doPull()}
              disabled={busy || !upstream}
              title={upstream ? (behind > 0 ? `Pull ${behind} commit(s) from ${upstream}` : `Pull from ${upstream}`) : 'No upstream to pull from'}
              className={`flex items-center gap-0.5 px-1 text-[10px] leading-none tabular-nums disabled:opacity-40 ${behind > 0 ? 'text-ctp-blue' : 'text-ctp-overlay hover:text-ctp-text'}`}
            >
              ↓{behind > 0 ? behind : ''}
            </button>
            <button
              onClick={() => void doPush(!upstream)}
              disabled={busy}
              title={upstream ? (ahead > 0 ? `Push ${ahead} commit(s) to ${upstream}` : `Push to ${upstream}`) : 'Publish branch (push -u origin)'}
              className={`flex items-center gap-0.5 px-1 text-[10px] leading-none tabular-nums disabled:opacity-40 ${ahead > 0 || !upstream ? 'text-ctp-green' : 'text-ctp-overlay hover:text-ctp-text'}`}
            >
              ↑{upstream ? (ahead > 0 ? ahead : '') : '·'}
            </button>
            <button
              onClick={() => void doFetch()}
              disabled={busy}
              title="Fetch from remote"
              className="text-ctp-overlay hover:text-ctp-text disabled:opacity-40 leading-none p-0.5"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v4h-4" />
              </svg>
            </button>
          </div>
        )}
        <button onClick={() => { refresh(); loadLog() }} title="Refresh (local status)" className="text-ctp-overlay hover:text-ctp-text text-xs leading-none">⟳</button>
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
      <div ref={changesRef} className="shrink-0 max-h-[45%] overflow-y-auto px-1.5 py-1.5 space-y-2 border-b border-ctp-surface0">
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
        <div ref={logRef} className="shrink-0 max-h-[45%] overflow-y-auto py-1 border-b border-ctp-surface0">
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
          <div ref={diffRef} className="flex-1 min-h-0 overflow-auto">
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
    </DockShell>
  )
}

// A minimal header used only for the not-a-repo / error states (the main render
// inlines its own richer header with the branch menu).
function Header({ onRefresh, onClose, disabled }: {
  onRefresh: () => void; onClose: () => void; disabled?: boolean
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
