import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SessionsProvider, useSessions } from './store/sessions'
import { ChatProvider, useChat, countRunningAgents } from './store/chat'
import { NotebooksProvider, useNotebooks } from './store/notebooks'
import { ChatView } from './components/ChatView'
import { NotebookView } from './components/NotebookView'
import { TerminalView } from './components/TerminalView'
import { GitPanelView } from './components/GitPanelView'
import { FileManager } from './components/FileManager'
import { PermissionsPanel } from './components/PermissionsPanel'
import { SandboxPanel } from './components/SandboxPanel'
import { FileEditorView } from './components/FileEditorView'
import { FileBrowser } from './components/FileBrowser'
import { ConfirmDialog } from './components/ConfirmDialog'
import { AuthGate } from './components/AuthGate'
import { api } from './api/client'
import { useNotifications, type NotificationsApi } from './lib/notifications'
import { basename, prettyPath } from './lib/paths'
import type { SessionInfo, ActivePane, AgentInfo, SandboxConfig, SandboxMount } from '@claudette/shared'

// App shell. Claude is the permanent anchor: it is always on screen. Notebooks and
// file editors open as CONTENT tabs beside it (a companion split); Files and Git
// live in a narrow, toggleable RIGHT DOCK; the Terminal is a toggleable BOTTOM DOCK
// spanning the main column. Nothing ever hides Claude.
export function App() {
  return (
    <AuthGate>
      <SessionsProvider>
        <ChatProvider>
          <NotebooksProvider>
            <Shell />
          </NotebooksProvider>
        </ChatProvider>
      </SessionsProvider>
    </AuthGate>
  )
}

// A content tab opened beside Claude: an open notebook or a file editor.
type Content = { kind: 'notebook'; id: string } | { kind: 'file'; path: string }
// The set of content tabs + the focused one, tracked PER SESSION so panes travel
// with the session you switch to.
type Pane = { tabs: Content[]; active: Content | null }
const EMPTY_PANE: Pane = { tabs: [], active: null }

// A session's terminal dock: its open/closed state, its tabbed terminals, and which
// tab is focused. Tracked PER SESSION (keyed by session id) so terminals follow the
// session you switch to.
type TermPane = { open: boolean; terms: { id: string; cwd: string }[]; active: string | null }
const EMPTY_TERM: TermPane = { open: false, terms: [], active: null }

function Shell() {
  const { sessions, activeId, setActive, homeDir } = useSessions()
  const notebooks = useNotebooks()
  const [drawer, setDrawer] = useState(false)

  // Background-session signals: sound (default on) + optional desktop notifications.
  const notif = useNotifications(sessions, activeId, setActive)

  // Content panes per session — switching sessions swaps the whole tab set + focus.
  const [bySession, setBySession] = useState<Record<string, Pane>>({})

  // Pending "save before closing?" prompt for a dirty / still-running notebook tab.
  const [closeNb, setCloseNb] = useState<{ id: string; name: string; dirty: boolean; running: boolean } | null>(null)

  // Docks.
  const [dock, setDock] = useState<'files' | 'git' | 'permissions' | 'sandbox' | null>(null)
  // Terminals are PER SESSION — each session owns its own tabbed set of terminals
  // and its own dock open/closed state, so switching sessions swaps the whole
  // terminal dock (and every session's ptys keep running in the background). Each
  // terminal captures its cwd at creation. Terminal ids are globally unique (via the
  // shared `termSeq`) so every session's terminals can be mounted at once.
  const [termsBySession, setTermsBySession] = useState<Record<string, TermPane>>({})
  const termSeq = useRef(0)

  // Companion orientation for the content split (phones default to stacked).
  const [layout, setLayout] = useState<'side' | 'stack'>(
    () => (typeof window !== 'undefined' && window.innerWidth < 768 ? 'stack' : 'side'),
  )

  // Resizable sizes (px). sideW/stackH = Claude companion size; dockW = right dock;
  // termH = bottom dock; sidebarW = session sidebar.
  const [sideW, setSideW] = useState(420)
  const [stackH, setStackH] = useState(280)
  const [dockW, setDockW] = useState(320)
  const [termH, setTermH] = useState(240)
  const [sidebarW, setSidebarW] = useState(288)
  const splitRef = useRef<HTMLDivElement>(null)

  // One generic pointer-drag divider: startSize captured on down, then
  // startSize + sign*delta, clamped to [min, max()].
  const drag = useRef<{ axis: 'x' | 'y'; start: number; startSize: number; sign: number; min: number; max: () => number; set: (n: number) => void } | null>(null)
  const onDown = (cfg: { axis: 'x' | 'y'; get: () => number; set: (n: number) => void; sign: number; min: number; max: () => number }) => (e: React.PointerEvent) => {
    drag.current = { axis: cfg.axis, start: cfg.axis === 'x' ? e.clientX : e.clientY, startSize: cfg.get(), sign: cfg.sign, min: cfg.min, max: cfg.max, set: cfg.set }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const cur = d.axis === 'x' ? e.clientX : e.clientY
    d.set(Math.max(d.min, Math.min(d.max(), d.startSize + d.sign * (cur - d.start))))
  }
  const onUp = (e: React.PointerEvent) => { drag.current = null; (e.currentTarget as Element).releasePointerCapture?.(e.pointerId) }
  const dividerProps = (cfg: Parameters<typeof onDown>[0]) => ({ onPointerDown: onDown(cfg), onPointerMove: onMove, onPointerUp: onUp })

  const activeSession = sessions.find((s) => s.id === activeId)
  const termCwd = activeSession?.cwd || homeDir

  // --- content tab management (per session) ----------------------------------
  const pane = (activeId ? bySession[activeId] : null) ?? EMPTY_PANE
  const active = pane.active
  const setPane = (sid: string, fn: (p: Pane) => Pane) =>
    setBySession((prev) => ({ ...prev, [sid]: fn(prev[sid] ?? EMPTY_PANE) }))

  // --- terminals (per session) -----------------------------------------------
  // The active session's terminal dock, plus a flat list of EVERY session's
  // terminals so they can all stay mounted (ptys survive session switches).
  const termPane = (activeId ? termsBySession[activeId] : null) ?? EMPTY_TERM
  const termOpen = termPane.open
  const terms = termPane.terms
  const activeTerm = termPane.active
  const allTerms = Object.entries(termsBySession).flatMap(([sid, st]) => st.terms.map((t) => ({ ...t, sid })))
  const dockShown = termOpen && terms.length > 0   // the active session's dock is visible
  const setTermPane = (sid: string, fn: (p: TermPane) => TermPane) =>
    setTermsBySession((prev) => ({ ...prev, [sid]: fn(prev[sid] ?? EMPTY_TERM) }))

  const openFile = (path: string) => {
    if (!activeId) return
    setPane(activeId, (p) => ({
      tabs: p.tabs.some((t) => t.kind === 'file' && t.path === path) ? p.tabs : [...p.tabs, { kind: 'file', path }],
      active: { kind: 'file', path },
    }))
  }
  const selectChat = () => { if (activeId) setPane(activeId, (p) => ({ ...p, active: null })) }
  const selectTab = (t: Content) => {
    if (!activeId) return
    setPane(activeId, (p) => ({ ...p, active: t }))
  }
  const closeTab = (t: Content) => {
    if (t.kind === 'notebook') {
      const doc = notebooks.open.find((d) => d.notebookId === t.id)
      const dirty = doc?.dirty ?? false
      const running = notebooks.isBusy(t.id)
      // Clean + idle → close straight away; otherwise ask before losing work. (The
      // store.close → effect prunes the tab from all panes.)
      if (!dirty && !running) notebooks.close(t.id)
      else setCloseNb({ id: t.id, name: doc ? basename(doc.path) : 'notebook', dirty, running })
      return
    }
    if (!activeId) return
    setPane(activeId, (p) => {
      const tabs = p.tabs.filter((x) => !(x.kind === 'file' && x.path === t.path))
      const nextActive = p.active?.kind === 'file' && p.active.path === t.path ? (tabs[tabs.length - 1] ?? null) : p.active
      return { tabs, active: nextActive }
    })
  }

  // A newly-opened notebook (user click / create / Claude via MCP) attaches to the
  // CURRENT session and focuses it; a closed notebook is pruned from every session.
  // Files live entirely in `bySession` above.
  const seenNb = useRef<Set<string>>(new Set())
  const openIds = notebooks.open.map((d) => d.notebookId).join(',')
  useEffect(() => {
    const ids = notebooks.open.map((d) => d.notebookId)
    for (const id of ids) {
      if (seenNb.current.has(id)) continue
      seenNb.current.add(id)
      // Only a notebook THIS user opened attaches to the session they're viewing.
      // A notebook a Claude tool opened arrives pushed from the server; it attaches
      // to the CALLING session via `focusPane` below — never leaks into whatever
      // session you happen to be looking at.
      if (activeId && notebooks.wasLocallyOpened(id)) setPane(activeId, (p) => ({
        tabs: p.tabs.some((t) => t.kind === 'notebook' && t.id === id) ? p.tabs : [...p.tabs, { kind: 'notebook', id }],
        active: { kind: 'notebook', id },
      }))
    }
    for (const id of [...seenNb.current]) {
      if (ids.includes(id)) continue
      seenNb.current.delete(id)
      setBySession((prev) => {
        const next: Record<string, Pane> = {}
        for (const [sid, p] of Object.entries(prev)) {
          const tabs = p.tabs.filter((t) => !(t.kind === 'notebook' && t.id === id))
          const a = p.active?.kind === 'notebook' && p.active.id === id ? (tabs[tabs.length - 1] ?? null) : p.active
          next[sid] = { tabs, active: a }
        }
        return next
      })
    }
  }, [openIds, activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Publish each session's active pane (the file it's viewing, or null for the
  // Claude tab) to the server, so the app-control notebook tools target what the
  // user is looking at. Diff against the last publish so we only send on change; a
  // notebook whose doc hasn't loaded yet is skipped until its path is known.
  const publishedRef = useRef<Record<string, string>>({})
  useEffect(() => {
    for (const [sid, p] of Object.entries(bySession)) {
      let out: ActivePane | null = null
      const a = p.active
      if (a?.kind === 'file') out = { path: a.path, isNotebook: false }
      else if (a?.kind === 'notebook') {
        const doc = notebooks.open.find((o) => o.notebookId === a.id)
        if (!doc) continue  // path unknown until the doc loads — publish next round
        out = { path: doc.path, isNotebook: true }
      }
      const key = out ? `${out.isNotebook ? 'n' : 'f'}:${out.path}` : 'null'
      if (publishedRef.current[sid] === key) continue
      publishedRef.current[sid] = key
      api.session.setActivePane(sid, out)
    }
  }, [bySession, openIds]) // eslint-disable-line react-hooks/exhaustive-deps

  // Claude asked (open_notebook) to focus a notebook in a specific session: open a
  // tab for it there and make it active. Mark it seen so the effect above doesn't
  // ALSO attach it to whatever session is currently on screen.
  useEffect(() => {
    return api.on.focusPane((sid, notebookId) => {
      seenNb.current.add(notebookId)
      const nb: Content = { kind: 'notebook', id: notebookId }
      setBySession((prev) => {
        const p = prev[sid] ?? EMPTY_PANE
        const tabs = p.tabs.some((t) => t.kind === 'notebook' && t.id === notebookId)
          ? p.tabs : [...p.tabs, nb]
        return { ...prev, [sid]: { tabs, active: nb } }
      })
    })
  }, [])

  const addTerm = (cwd: string) => {
    if (!activeId) return
    const id = `t${++termSeq.current}`   // globally unique across sessions
    setTermPane(activeId, (p) => ({ open: true, terms: [...p.terms, { id, cwd }], active: id }))
  }
  const closeTerm = (id: string) => {
    if (!activeId) return
    setTermPane(activeId, (p) => {
      const rest = p.terms.filter((t) => t.id !== id)   // unmounting its TerminalView tears the pty down
      return {
        open: rest.length > 0 ? p.open : false,         // last one → dock closes (as before first open)
        terms: rest,
        active: p.active === id ? (rest[rest.length - 1]?.id ?? null) : p.active,
      }
    })
  }
  const selectTerm = (id: string) => { if (activeId) setTermPane(activeId, (p) => ({ ...p, active: id })) }
  const hideTerm = () => { if (activeId) setTermPane(activeId, (p) => ({ ...p, open: false })) }
  // Toggle the active session's dock: opening with no terminals yet spawns the first.
  const toggleTerm = () => {
    if (!activeId) return
    if (termOpen) { hideTerm(); return }
    if (terms.length === 0) addTerm(termCwd)
    else setTermPane(activeId, (p) => ({ ...p, open: true }))
  }
  const toggleDock = (which: 'files' | 'git' | 'permissions' | 'sandbox') => setDock((d) => (d === which ? null : which))

  // When a session goes away, drop its terminal dock — unmounting those
  // TerminalViews tears down the ptys the session owned.
  useEffect(() => {
    const ids = new Set(sessions.map((s) => s.id))
    setTermsBySession((prev) => {
      let changed = false
      const next: Record<string, TermPane> = {}
      for (const [sid, st] of Object.entries(prev)) {
        if (ids.has(sid)) next[sid] = st
        else changed = true
      }
      return changed ? next : prev
    })
  }, [sessions])

  // Tab strip for the CURRENT session's pane, enriched with live doc metadata.
  const tabs: Tab[] = pane.tabs.map((t) => {
    if (t.kind === 'notebook') {
      const d = notebooks.open.find((o) => o.notebookId === t.id)
      return { key: `nb:${t.id}`, kind: 'notebook', id: t.id, label: d ? basename(d.path) : 'notebook', path: d?.path ?? '', dirty: d?.dirty ?? false }
    }
    return { key: `f:${t.path}`, kind: 'file', id: '', label: basename(t.path), path: t.path, dirty: false }
  })

  const contentNode = active?.kind === 'notebook'
    ? <NotebookView key={active.id} notebookId={active.id} />
    : active?.kind === 'file'
      ? <FileEditorView key={active.path} path={active.path} />
      : null

  return (
    <div className="flex h-full bg-ctp-base overflow-hidden">
      <Sidebar open={drawer} onClose={() => setDrawer(false)} width={sidebarW} />
      <div
        {...dividerProps({ axis: 'x', get: () => sidebarW, set: setSidebarW, sign: 1, min: 200, max: () => 560 })}
        title="Drag to resize"
        className="hidden md:block shrink-0 w-1 cursor-col-resize bg-ctp-surface0 hover:bg-ctp-accent/60 active:bg-ctp-accent transition-colors touch-none"
      />

      {/* Everything right of the sidebar: main column + right dock. */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Mobile top bar. */}
        <div className="md:hidden shrink-0 h-12 flex items-center gap-2 px-3 border-b border-ctp-surface0 bg-ctp-mantle">
          <button onClick={() => setDrawer(true)} aria-label="Open sessions" className="w-9 h-9 flex items-center justify-center rounded-md text-ctp-subtext hover:bg-ctp-surface0 -ml-1">
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <Mark className="w-4 h-4 text-ctp-accent" />
          <span className="text-sm font-medium text-ctp-text truncate">{activeSession?.name ?? 'Claudette'}</span>
        </div>

        {/* Content tabs + a PINNED toolbar (Files/Git/Terminal/sound/bell). This bar
            spans the FULL width ABOVE the main-column|dock row, so the toolbar stays
            fixed in the top-right corner — opening the right dock slides in below this
            bar and never nudges the toggles. */}
        <MainTabs
          tabs={tabs}
          active={active}
          onSelectChat={selectChat}
          onSelectTab={(t) => selectTab(t.kind === 'notebook' ? { kind: 'notebook', id: t.id } : { kind: 'file', path: t.path })}
          onCloseTab={(t) => closeTab(t.kind === 'notebook' ? { kind: 'notebook', id: t.id } : { kind: 'file', path: t.path })}
          layout={layout}
          onSetLayout={setLayout}
          showLayout={active !== null}
          dock={dock}
          onToggleDock={toggleDock}
          termOpen={termOpen}
          onToggleTerm={toggleTerm}
          notif={notif}
        />

        <div className="flex-1 min-h-0 flex">
          {/* Main column: (Claude | content) + terminal dock. */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Upper region: Claude, plus content beside it when a tab is active. */}
            <div ref={splitRef} className={`flex-1 min-h-0 relative flex ${active && layout === 'side' ? 'flex-row' : 'flex-col'}`}>
              {active && (
                <div className={`flex-1 min-h-0 min-w-0 ${layout === 'side' ? 'order-3' : ''}`}>
                  {contentNode}
                </div>
              )}

              {active && (
                <div
                  {...(layout === 'side'
                    ? dividerProps({ axis: 'x', get: () => sideW, set: setSideW, sign: 1, min: 300, max: () => (splitRef.current?.getBoundingClientRect().width ?? 1200) - 320 })
                    : dividerProps({ axis: 'y', get: () => stackH, set: setStackH, sign: -1, min: 160, max: () => (splitRef.current?.getBoundingClientRect().height ?? 800) - 200 }))}
                  title="Drag to resize"
                  className={`shrink-0 bg-ctp-surface0 hover:bg-ctp-accent/60 active:bg-ctp-accent transition-colors touch-none ${layout === 'side' ? 'w-1 cursor-col-resize order-2' : 'h-1 cursor-row-resize'}`}
                />
              )}

              {/* Claude — always present. Full width alone; fixed-size companion when a tab is open. */}
              <div
                className={active ? `shrink-0 min-h-0 min-w-0 ${layout === 'side' ? 'border-r order-1' : 'border-t'} border-ctp-surface0` : 'flex-1 min-h-0 min-w-0'}
                style={active ? (layout === 'side' ? { width: sideW } : { height: stackH }) : undefined}
              >
                {activeId ? <ChatView key={activeId} sessionId={activeId} isActive /> : <Empty />}
              </div>
            </div>

            {/* Bottom dock: tabbed terminals for the ACTIVE session (span the main
                column). Every session's terminals stay mounted (see the bodies
                below) so ptys + scrollback survive session switches; the tab strip
                and sizing only apply to the active session's dock. */}
            {dockShown && (
              <div
                {...dividerProps({ axis: 'y', get: () => termH, set: setTermH, sign: -1, min: 120, max: () => 700 })}
                title="Drag to resize"
                className="shrink-0 h-1 cursor-row-resize bg-ctp-surface0 hover:bg-ctp-accent/60 active:bg-ctp-accent transition-colors touch-none"
              />
            )}
            {allTerms.length > 0 && (
              <div className={dockShown ? 'shrink-0 flex flex-col border-t border-ctp-surface0' : 'hidden'} style={dockShown ? { height: termH } : undefined}>
                {/* Tab strip: one tab per terminal in the ACTIVE session (× to close), + to add, hide on the right. */}
                <div className="h-7 shrink-0 flex items-stretch gap-1 px-2 bg-ctp-mantle border-b border-ctp-surface0 overflow-x-auto">
                  {terms.map((t, i) => (
                    <div
                      key={t.id}
                      onClick={() => selectTerm(t.id)}
                      title={t.cwd}
                      className={`group flex items-center gap-1.5 pl-2 pr-1 shrink-0 cursor-pointer text-[11px] border-b-2 ${activeTerm === t.id ? 'border-ctp-accent text-ctp-text' : 'border-transparent text-ctp-subtext hover:text-ctp-text'}`}
                    >
                      <span className="text-ctp-overlay">❯</span>
                      <span>Terminal {i + 1}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); closeTerm(t.id) }}
                        title="Close terminal"
                        className="opacity-0 group-hover:opacity-100 text-ctp-overlay hover:text-ctp-red p-0.5 rounded leading-none"
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
                      </button>
                    </div>
                  ))}
                  <button onClick={() => addTerm(termCwd)} title="New terminal" className="shrink-0 self-center text-ctp-overlay hover:text-ctp-text px-1.5 text-sm leading-none">+</button>
                  <span className="ml-auto self-center text-[10px] text-ctp-overlay font-mono truncate max-w-[45%]">{prettyPath(terms.find((t) => t.id === activeTerm)?.cwd ?? termCwd)}</span>
                  <button onClick={hideTerm} title="Hide terminal" className="shrink-0 self-center text-ctp-overlay hover:text-ctp-text p-0.5">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                </div>
                {/* Bodies: EVERY session's terminals stay mounted here (this container
                    persists across session switches, so ptys + scrollback survive);
                    only the active session's active terminal is shown. */}
                <div className="flex-1 min-h-0 relative">
                  {allTerms.map((t) => {
                    const show = t.sid === activeId && dockShown && activeTerm === t.id
                    return (
                      <div key={t.id} className={show ? 'absolute inset-0' : 'hidden'}>
                        <TerminalView cwd={t.cwd} visible={show} sessionId={t.sid} />
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Right dock: Files or Git (narrow, resizable, full height). */}
          {dock && (
            <div
              {...dividerProps({ axis: 'x', get: () => dockW, set: setDockW, sign: -1, min: 240, max: () => 640 })}
              title="Drag to resize"
              className="shrink-0 w-1 cursor-col-resize bg-ctp-surface0 hover:bg-ctp-accent/60 active:bg-ctp-accent transition-colors touch-none"
            />
          )}
          {dock && (
            <div className="shrink-0 min-h-0 border-l border-ctp-surface0" style={{ width: dockW }}>
              {dock === 'files' ? (
                <FileManager
                  key={termCwd}
                  initialPath={termCwd}
                  onOpenNotebook={(p) => void notebooks.openPath(p, activeId ?? undefined).then((id) => {
                    // Focus the notebook's tab — including when it was already open,
                    // where the newly-seen effect above wouldn't fire.
                    if (id && activeId) setPane(activeId, (pane) => ({
                      tabs: pane.tabs.some((t) => t.kind === 'notebook' && t.id === id) ? pane.tabs : [...pane.tabs, { kind: 'notebook', id }],
                      active: { kind: 'notebook', id },
                    }))
                  })}
                  onOpenFile={openFile}
                  onNewNotebook={(p) => notebooks.createPath(p, activeId ?? undefined)}
                  onClose={() => setDock(null)}
                />
              ) : dock === 'git' ? (
                <GitPanelView key={termCwd} cwd={termCwd} onClose={() => setDock(null)} />
              ) : !activeSession ? (
                <div className="h-full flex items-center justify-center p-4 text-center text-xs text-ctp-overlay">
                  No session selected.
                </div>
              ) : dock === 'sandbox' ? (
                <SandboxPanel key={activeSession.id} session={activeSession} onClose={() => setDock(null)} />
              ) : (
                <PermissionsPanel key={activeSession.id} session={activeSession} onClose={() => setDock(null)} />
              )}
            </div>
          )}
        </div>
      </div>

      {closeNb && (
        <CloseNotebookDialog
          target={closeNb}
          onChoose={(action) => {
            if (action !== 'cancel') notebooks.close(closeNb.id, action === 'save')
            setCloseNb(null)
          }}
        />
      )}
    </div>
  )
}

// Confirm before closing a notebook tab that has unsaved work or a running cell.
// Dirty + idle → Save / Don't Save / Cancel. Running → Close (finish + save in the
// background) / Cancel — the kernel keeps going and its output is saved when done.
function CloseNotebookDialog({ target, onChoose }: {
  target: { id: string; name: string; dirty: boolean; running: boolean }
  onChoose: (action: 'save' | 'discard' | 'cancel') => void
}) {
  const { name, dirty, running } = target
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onChoose('cancel') }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onChoose])
  const btn = 'text-xs px-3 py-1.5 rounded-md transition'
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" onClick={() => onChoose('cancel')}>
      <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border border-ctp-surface1 bg-ctp-mantle shadow-pop p-5" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold text-ctp-text mb-1 truncate">
          {running ? `“${name}” is still running` : `Save changes to “${name}”?`}
        </div>
        <div className="text-xs text-ctp-subtext mb-4">
          {running
            ? <>The kernel keeps running in the background; its output{dirty ? ' and your unsaved changes' : ''} will be saved when it finishes.</>
            : <>Your unsaved changes will be lost if you don’t save.</>}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={() => onChoose('cancel')} className={`${btn} text-ctp-subtext hover:bg-ctp-surface0`}>Cancel</button>
          {running ? (
            <button onClick={() => onChoose('save')} className={`${btn} bg-ctp-accent text-ctp-base font-medium hover:brightness-110`}>Close</button>
          ) : (
            <>
              <button onClick={() => onChoose('discard')} className={`${btn} text-ctp-red hover:bg-ctp-surface0`}>Don’t Save</button>
              <button onClick={() => onChoose('save')} className={`${btn} bg-ctp-accent text-ctp-base font-medium hover:brightness-110`}>Save</button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

type Tab = { key: string; kind: 'notebook' | 'file'; id: string; label: string; path: string; dirty: boolean }

// Tab strip: Chat + one tab per open content item, then the dock toggles (Files /
// Git / Terminal) and the companion-orientation control.
function MainTabs({ tabs, active, onSelectChat, onSelectTab, onCloseTab, layout, onSetLayout, showLayout, dock, onToggleDock, termOpen, onToggleTerm, notif }: {
  tabs: Tab[]
  active: Content | null
  onSelectChat: () => void
  onSelectTab: (t: Tab) => void
  onCloseTab: (t: Tab) => void
  layout: 'side' | 'stack'; onSetLayout: (l: 'side' | 'stack') => void; showLayout: boolean
  dock: 'files' | 'git' | 'permissions' | 'sandbox' | null; onToggleDock: (w: 'files' | 'git' | 'permissions' | 'sandbox') => void
  termOpen: boolean; onToggleTerm: () => void
  notif: NotificationsApi
}) {
  const tab = (on: boolean) =>
    `px-3 h-8 flex items-center gap-1.5 text-xs border-b-2 -mb-px whitespace-nowrap transition-colors ${
      on ? 'border-ctp-accent text-ctp-text' : 'border-transparent text-ctp-overlay hover:text-ctp-subtext'}`
  const isOn = (t: Tab) => {
    if (!active) return false
    return t.kind === 'notebook' ? active.kind === 'notebook' && active.id === t.id : active.kind === 'file' && active.path === t.path
  }
  const toggle = (on: boolean) =>
    `px-2.5 h-6 rounded text-[11px] transition-colors ${on ? 'bg-ctp-surface1 text-ctp-text' : 'text-ctp-overlay hover:text-ctp-subtext hover:bg-ctp-surface0'}`

  return (
    <div className="shrink-0 h-8 flex items-stretch gap-0 px-2 bg-ctp-mantle border-b border-ctp-surface0">
      {/* Tabs scroll in their OWN region so growing/overflowing tabs never push the
          toolbar. */}
      <div className="flex items-stretch min-w-0 flex-1 overflow-x-auto">
        <button className={tab(active === null)} onClick={onSelectChat}>Chat</button>
        {/* Where Claude sits relative to open content — a SINGLE toggle that lives
            next to the Chat tab (so it reads as "Claude's position"), flipping
            beside ⇄ under. Only meaningful once a content tab is open. */}
        {showLayout && (
          <button
            onClick={() => onSetLayout(layout === 'side' ? 'stack' : 'side')}
            title={layout === 'side' ? 'Claude is beside — click to put it under' : 'Claude is under — click to put it beside'}
            aria-label="Toggle where Claude sits"
            className="self-center shrink-0 mx-1 w-6 h-6 flex items-center justify-center rounded text-ctp-overlay hover:text-ctp-subtext hover:bg-ctp-surface0 transition-colors"
          >
            {layout === 'side'
              ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="2.5" width="4.5" height="9" rx="1" /><rect x="8" y="2.5" width="4.5" height="9" rx="1" /></svg>
              : <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2.5" y="1.5" width="9" height="4.5" rx="1" /><rect x="2.5" y="8" width="9" height="4.5" rx="1" /></svg>}
          </button>
        )}
        {tabs.map((t) => (
          <span key={t.key} className={tab(isOn(t))}>
            <span className="shrink-0">{t.kind === 'notebook' ? '📓' : '📄'}</span>
            <button onClick={() => onSelectTab(t)} className="truncate max-w-[150px]" title={t.path}>
              {t.label}{t.dirty && <span className="text-ctp-yellow"> ●</span>}
            </button>
            <button onClick={() => onCloseTab(t)} className="text-ctp-overlay hover:text-ctp-red" title="Close">✕</button>
          </span>
        ))}
      </div>

      {/* Pinned toolbar: sits outside the scroll region and stays put. The companion
          control appears at its LEFT edge, so the dock toggles keep a fixed offset
          from the right edge and don't shift when a pane opens. */}
      <div className="shrink-0 flex items-center gap-1 self-center pl-2">
        <button className={toggle(dock === 'files')} onClick={() => onToggleDock('files')} title="Files browser">Files</button>
        <button className={toggle(dock === 'git')} onClick={() => onToggleDock('git')} title="Git panel">Git</button>
        <button className={toggle(dock === 'permissions')} onClick={() => onToggleDock('permissions')} title="Permissions — what this session's Claude can do">Permissions</button>
        <button className={toggle(dock === 'sandbox')} onClick={() => onToggleDock('sandbox')} title="Sandbox — filesystem confinement + mounts for this session">Sandbox</button>
        <button className={toggle(termOpen)} onClick={onToggleTerm} title="Terminal">Terminal</button>
        <SoundToggle notif={notif} />
        <NotifyBell notif={notif} />
      </div>
    </div>
  )
}

// Completion-sound toggle (on by default; no permission needed). A background
// session finishing / needing input chimes unless muted here.
function SoundToggle({ notif }: { notif: NotificationsApi }) {
  const on = notif.soundOn
  return (
    <button
      onClick={notif.toggleSound}
      title={on ? 'Completion sound on — click to mute' : 'Completion sound muted — click to unmute'}
      aria-label={on ? 'Mute completion sound' : 'Unmute completion sound'}
      aria-pressed={on}
      className={`w-6 h-6 flex items-center justify-center rounded transition-colors hover:bg-ctp-surface0 ${on ? 'text-ctp-accent' : 'text-ctp-overlay hover:text-ctp-subtext'}`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 5 6 9H2v6h4l5 4V5z" />
        {on
          ? <><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" /></>
          : <path d="M22 9l-6 6M16 9l6 6" />}
      </svg>
    </button>
  )
}

// Toggle for background-session desktop notifications (needs OS permission). The
// sound + sidebar light work without this; the bell adds system notifications that
// pop even when the app tab is focused (for a session you're not looking at).
function NotifyBell({ notif }: { notif: NotificationsApi }) {
  const blocked = notif.permission === 'denied' || notif.permission === 'unsupported'
  const title = notif.permission === 'unsupported'
    ? 'Desktop notifications not supported by this browser'
    : notif.permission === 'denied'
      ? 'Desktop notifications blocked — allow them in your browser settings'
      : notif.enabled
        ? 'Desktop notifications on — click to turn off'
        : 'Also send a desktop notification when a background session finishes or needs input'
  const color = notif.enabled ? 'text-ctp-accent' : blocked ? 'text-ctp-overlay/50' : 'text-ctp-overlay hover:text-ctp-subtext'
  return (
    <button
      onClick={notif.toggle}
      disabled={notif.permission === 'unsupported'}
      title={title}
      aria-label={title}
      aria-pressed={notif.enabled}
      className={`w-6 h-6 flex items-center justify-center rounded transition-colors hover:bg-ctp-surface0 ${color} disabled:cursor-not-allowed`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        {(!notif.enabled || blocked) && <path d="M2 2l20 20" />}
      </svg>
    </button>
  )
}

// The Claudette mark — a warm eight-point asterisk (Claude's sunburst motif).
function Mark({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 2.5c.5 0 .9.4.9.9v5.03l3.56-3.56a.9.9 0 0 1 1.27 1.27L14.16 9.7h5.03a.9.9 0 0 1 0 1.8h-5.03l3.56 3.56a.9.9 0 1 1-1.27 1.27L12.9 12.77v5.03a.9.9 0 0 1-1.8 0v-5.03l-3.56 3.56a.9.9 0 0 1-1.27-1.27l3.56-3.56H4.8a.9.9 0 0 1 0-1.8h5.03L6.27 6.14a.9.9 0 0 1 1.27-1.27L11.1 8.43V3.4c0-.5.4-.9.9-.9z" />
    </svg>
  )
}

function Empty() {
  return (
    <div className="flex-1 h-full flex flex-col items-center justify-center gap-3 text-center px-6">
      <Mark className="w-9 h-9 text-ctp-accent/70" />
      <div className="space-y-1">
        <div className="text-ctp-text text-base font-medium">Start a session</div>
        <div className="text-ctp-overlay text-sm max-w-xs">Create a session in the sidebar to start working with Claude in this directory.</div>
      </div>
    </div>
  )
}

function Sidebar({ open, onClose, width }: { open: boolean; onClose: () => void; width: number }) {
  const { sessions, activeId, setActive, destroy, connected, attention } = useSessions()
  const { transcriptFor } = useChat()   // per-session running-agent count for the row badge
  const [showNew, setShowNew] = useState(false)
  const [confirmClose, setConfirmClose] = useState<SessionInfo | null>(null)
  const pick = (id: string) => { setActive(id); onClose() }

  return (
    <>
      {open && <div className="md:hidden fixed inset-0 z-30 bg-black/50 animate-fade-in" onClick={onClose} />}
      <aside
        style={{ width }}
        className={`z-40 h-full flex flex-col bg-ctp-mantle border-r border-ctp-surface0
          fixed inset-y-0 left-0 transition-transform duration-200 md:static md:translate-x-0 md:shrink-0
          ${open ? 'translate-x-0 shadow-pop' : '-translate-x-full'}`}
      >
        <div className="px-4 h-12 flex items-center gap-2.5 border-b border-ctp-surface0 shrink-0">
          <Mark className="w-5 h-5 text-ctp-accent" />
          <span className="text-sm font-semibold tracking-tight text-ctp-text">Claudette</span>
          <span className={`ml-auto inline-flex items-center gap-1.5 text-[10px] ${connected ? 'text-ctp-green' : 'text-ctp-red'}`} title={connected ? 'Connected to server' : 'Disconnected'}>
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-ctp-green' : 'bg-ctp-red'}`} />
            {connected ? 'online' : 'offline'}
          </span>
          <button onClick={onClose} className="md:hidden ml-1 text-ctp-overlay hover:text-ctp-text text-sm" aria-label="Close">✕</button>
        </div>

        <div className="px-3 pt-3 pb-1 flex items-center justify-between shrink-0">
          <span className="text-[10px] font-medium uppercase tracking-wider text-ctp-overlay">Sessions</span>
          <button onClick={() => setShowNew(true)} title="New session" className="text-ctp-overlay hover:text-ctp-accent text-base leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-ctp-surface0 transition-colors">+</button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {sessions.length === 0 && <div className="px-2 py-2 text-xs text-ctp-overlay">No sessions yet.</div>}
          {sessions.map((s) => (
            <SessionRow
              key={s.id} session={s} active={s.id === activeId} attention={attention.has(s.id)}
              runningAgents={s.state === 'running' ? countRunningAgents(transcriptFor(s.id)) : 0}
              onSelect={() => pick(s.id)} onClose={() => setConfirmClose(s)}
            />
          ))}
        </div>

        <div className="border-t border-ctp-surface0 p-3 shrink-0">
          <button onClick={() => setShowNew(true)} className="w-full flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-2.5 rounded-md bg-ctp-accent text-ctp-base hover:brightness-110 active:brightness-95 transition">
            <span className="text-base leading-none">+</span> New session
          </button>
        </div>

        {showNew && <NewSessionDialog onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); onClose() }} />}
        {confirmClose && (
          <ConfirmDialog
            danger
            title="Close this session?"
            body={<>Closing <b>{confirmClose.name || 'this session'}</b> ends its Claude engine and kills any kernels or terminals it owns. The conversation history is kept and can be resumed.</>}
            confirmLabel="Close session"
            onConfirm={() => { const id = confirmClose.id; setConfirmClose(null); void destroy(id) }}
            onCancel={() => setConfirmClose(null)}
          />
        )}
      </aside>
    </>
  )
}

// Centered modal for creating a session — name + working directory + role + model.
function NewSessionDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const { create, agents, sandboxAvailable, homeDir } = useSessions()
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(homeDir)
  // homeDir may resolve after this dialog mounts (health probe is async); adopt it as
  // the default the moment it arrives, unless the user has already typed a path.
  useEffect(() => { setCwd((c) => c || homeDir) }, [homeDir])
  const [agentId, setAgentId] = useState('general')
  const [model, setModel] = useState('')
  const [sb, setSb] = useState<SbState>(defaultSb())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (busy) return
    if (!cwd.trim()) { setErr('Working directory is required.'); return }
    setBusy(true); setErr(null)
    try {
      await create(name.trim() || basename(cwd.trim()) || 'session', cwd.trim(), { model: model.trim() || undefined, agentId, sandbox: sbToConfig(sb, cwd.trim()) })
      ;(onCreated ?? onClose)()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to create session.')
      setBusy(false)
    }
  }
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border border-ctp-surface1 bg-ctp-mantle shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-5 h-12 border-b border-ctp-surface0">
          <Mark className="w-4 h-4 text-ctp-accent" />
          <span className="text-sm font-semibold text-ctp-text">New session</span>
          <button onClick={onClose} className="ml-auto text-ctp-overlay hover:text-ctp-text text-sm">✕</button>
        </div>
        <div className="p-5 space-y-3.5">
          <Field label="Name" hint="optional">
            <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} placeholder="defaults to the folder name" className="modal-input" />
          </Field>
          <Field label="Working directory">
            <div className="flex gap-2">
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} onKeyDown={onEnter} placeholder="/path/to/project" className="modal-input font-mono text-[12px] flex-1" />
              <button type="button" onClick={() => setBrowsing(true)} className="text-xs px-3 rounded-md text-ctp-subtext hover:bg-ctp-surface0 border border-ctp-surface1 transition-colors whitespace-nowrap" title="Browse for a folder">Browse…</button>
            </div>
          </Field>
          <Field label="Role">
            <RolePicker agents={agents} value={agentId} onChange={setAgentId} />
          </Field>
          <Field label="Model" hint="optional">
            <input value={model} onChange={(e) => setModel(e.target.value)} onKeyDown={onEnter} placeholder="account default (e.g. sonnet, opus, haiku)" className="modal-input font-mono text-[12px]" />
          </Field>
          <Field label="Sandbox">
            <SandboxFields value={sb} onChange={setSb} cwd={cwd.trim() || homeDir} available={sandboxAvailable} />
          </Field>
          {err && <div className="text-[11px] text-ctp-red">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-ctp-surface0">
          <button onClick={onClose} className="text-xs px-3.5 py-1.5 rounded-md text-ctp-subtext hover:bg-ctp-surface0 transition-colors">Cancel</button>
          <button onClick={submit} disabled={busy} className="text-xs font-medium px-4 py-1.5 rounded-md bg-ctp-accent text-ctp-base hover:brightness-110 active:brightness-95 disabled:opacity-40 transition">
            {busy ? 'Starting…' : 'Create session'}
          </button>
        </div>
      </div>
      {browsing && (
        <FileBrowser mode="folder" initialPath={cwd.trim() || homeDir} onPick={(path) => { setCwd(path); setBrowsing(false) }} onClose={() => setBrowsing(false)} />
      )}
    </div>,
    document.body,
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline gap-1.5">
        <span className="text-[11px] font-medium text-ctp-subtext">{label}</span>
        {hint && <span className="text-[10px] text-ctp-overlay">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

// Role selector — a styled native <select> over the available agents, with the
// chosen role's one-line description shown beneath it. Falls back to a lone General
// option before /api/agents resolves.
function RolePicker({ agents, value, onChange }: { agents: AgentInfo[]; value: string; onChange: (id: string) => void }) {
  const list = agents.length ? agents : [{ id: 'general', name: 'General', description: '' }]
  const desc = list.find((a) => a.id === value)?.description
  return (
    <div className="space-y-1">
      <select value={value} onChange={(e) => onChange(e.target.value)} className="modal-input cursor-pointer">
        {list.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      {desc && <div className="text-[10px] text-ctp-overlay leading-snug">{desc}</div>}
    </div>
  )
}

// The creation dialogs edit the sandbox as three fields — enabled, how the project
// folder (cwd) is mounted (rw / ro / not at all), and a list of extra folders — rather
// than a raw mount array, so cwd stays tied to the (possibly-edited) cwd field.
type SbState = { enabled: boolean; projectMode: 'rw' | 'ro' | 'none'; extra: SandboxMount[] }
const defaultSb = (): SbState => ({ enabled: true, projectMode: 'rw', extra: [] })
// Seed the fields from an existing config relative to a cwd (subsession → parent's).
function sbFromConfig(cfg: SandboxConfig | undefined, cwd: string): SbState {
  if (!cfg) return defaultSb()
  const cwdMount = cfg.mounts.find((m) => m.path === cwd)
  return { enabled: cfg.enabled, projectMode: cwdMount?.mode ?? 'none', extra: cfg.mounts.filter((m) => m.path !== cwd) }
}
// Build the SandboxConfig to submit (cwd folded back in per projectMode).
function sbToConfig(sb: SbState, cwd: string): SandboxConfig {
  const mounts: SandboxMount[] = [
    ...(sb.projectMode !== 'none' ? [{ path: cwd, mode: sb.projectMode } as SandboxMount] : []),
    ...sb.extra,
  ]
  return { enabled: sb.enabled, mounts }
}

// Sandbox editor for the creation dialogs — enable toggle, project-folder access
// (rw/ro/none), and add/remove extra folders (each rw/ro) via the folder picker. The
// two .claude dirs are always mounted rw server-side, noted here.
function SandboxFields({ value, onChange, cwd, available }: { value: SbState; onChange: (v: SbState) => void; cwd: string; available: boolean }) {
  const [picking, setPicking] = useState(false)
  if (!available) {
    return <div className="text-[11px] text-ctp-overlay leading-snug">This host can’t sandbox (bubblewrap/user-namespaces). Sessions run <b>unconfined</b>.</div>
  }
  const set = (patch: Partial<SbState>) => onChange({ ...value, ...patch })
  const modeBtn = (on: boolean) => `px-1.5 py-0.5 rounded text-[10px] font-mono ${on ? 'bg-ctp-accent/20 text-ctp-accent' : 'text-ctp-overlay hover:bg-ctp-surface0'}`
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-[11px] text-ctp-subtext cursor-pointer select-none">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="accent-ctp-accent" />
        Confine this session (bubblewrap sandbox)
      </label>
      {value.enabled && (
        <>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-ctp-overlay shrink-0">Project</span>
            <span className="font-mono text-ctp-subtext truncate flex-1" title={cwd}>{prettyPath(cwd)}</span>
            <div className="flex gap-0.5 shrink-0">
              {(['rw', 'ro', 'none'] as const).map((m) => (
                <button key={m} type="button" onClick={() => set({ projectMode: m })} className={modeBtn(value.projectMode === m)} title={m === 'rw' ? 'Read-write' : m === 'ro' ? 'Read-only' : 'Not mounted (project invisible)'}>{m}</button>
              ))}
            </div>
          </div>
          {value.extra.map((m, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[11px]">
              <span className="font-mono text-ctp-subtext truncate flex-1" title={m.path}>{prettyPath(m.path)}</span>
              <button type="button" onClick={() => set({ extra: value.extra.map((x, k) => k === i ? { ...x, mode: x.mode === 'rw' ? 'ro' : 'rw' } : x) })} className={`px-1.5 rounded text-[10px] font-mono ${m.mode === 'rw' ? 'bg-ctp-blue/20 text-ctp-blue' : 'bg-ctp-surface0 text-ctp-subtext'}`} title={m.mode === 'rw' ? 'Writable — click for read-only' : 'Read-only — click for writable'}>{m.mode}</button>
              <button type="button" onClick={() => set({ extra: value.extra.filter((_, k) => k !== i) })} className="text-ctp-overlay hover:text-ctp-red px-0.5" title="Remove">×</button>
            </div>
          ))}
          <button type="button" onClick={() => setPicking(true)} className="w-full rounded border border-dashed border-ctp-surface2 text-[11px] text-ctp-subtext hover:text-ctp-text hover:border-ctp-overlay py-1">+ Add a folder…</button>
          <div className="text-[10px] text-ctp-overlay leading-snug"><span className="font-mono">~/.claude</span> + the project’s <span className="font-mono">.claude</span> are always mounted rw.</div>
        </>
      )}
      {picking && (
        <FileBrowser
          mode="folder"
          initialPath={cwd}
          onClose={() => setPicking(false)}
          onPick={(p) => { setPicking(false); if (p !== cwd && !value.extra.some((m) => m.path === p)) set({ extra: [...value.extra, { path: p, mode: 'ro' }] }) }}
        />
      )}
    </div>
  )
}

function SessionRow({ session, active, attention, runningAgents, onSelect, onClose }: { session: SessionInfo; active: boolean; attention: boolean; runningAgents: number; onSelect: () => void; onClose: () => void }) {
  const { sessions, agents, setAgent, rename } = useSessions()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [subOpen, setSubOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState(session.name)
  const [info, setInfo] = useState(false)
  // Guards the Enter→blur double-fire and a cancel-on-Escape from saving twice/at all.
  const renameDone = useRef(false)

  const isSub = !!session.parentId
  const roleId = session.agentId ?? 'general'
  const roleName = agents.find((a) => a.id === roleId)?.name ?? roleId
  const roleBadge = roleId !== 'general' ? roleName : null

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: r.right, y: r.bottom + 2 })
  }
  const beginRename = () => { renameDone.current = false; setRenameVal(session.name); setRenaming(true) }
  const submitRename = () => {
    if (renameDone.current) return
    renameDone.current = true
    setRenaming(false)
    const n = renameVal.trim()
    if (n && n !== session.name) void rename(session.id, n)
  }
  const cancelRename = () => { renameDone.current = true; setRenaming(false) }

  return (
    <div onClick={onSelect} className={`group relative rounded-md pr-1 py-2 cursor-pointer flex items-center gap-2.5 transition-colors ${isSub ? 'pl-5' : 'pl-2.5'} ${active ? 'bg-ctp-surface0' : 'hover:bg-ctp-surface0/50'}`}>
      {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-ctp-accent" />}
      {isSub && <span className="absolute left-2 text-ctp-overlay text-[11px] leading-none" title="Subsession">↳</span>}
      {/* A finished/errored background session gets a red attention light until viewed. */}
      {attention
        ? <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0 bg-ctp-red shadow-[0_0_8px_2px] shadow-ctp-red/60 animate-pulse" title="Finished — needs your attention" />
        : <StateDot state={session.state} />}
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            value={renameVal}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenameVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitRename() } else if (e.key === 'Escape') { e.preventDefault(); cancelRename() } }}
            onBlur={submitRename}
            className="w-full bg-ctp-base border border-ctp-surface1 rounded px-1.5 py-0.5 text-sm text-ctp-text outline-none focus:border-ctp-accent/60"
          />
        ) : (
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`truncate text-sm ${attention ? 'text-ctp-text font-medium' : active ? 'text-ctp-text' : 'text-ctp-subtext'}`} title={prettyPath(session.cwd)}>{session.name}</span>
            {roleBadge && <span className="shrink-0 text-[9px] font-medium uppercase tracking-wide px-1 py-0.5 rounded bg-ctp-accent/15 text-ctp-accent" title={`Role: ${roleBadge}`}>{roleBadge}</span>}
            {runningAgents > 0 && (
              <span className="shrink-0 flex items-center gap-1 text-[9px] text-ctp-mauve" title={`${runningAgents} subagent${runningAgents > 1 ? 's' : ''} running`}>
                <span className="w-1.5 h-1.5 rounded-full bg-ctp-mauve animate-pulse" />◈{runningAgents}
              </span>
            )}
          </div>
        )}
      </div>
      {/* Live status word — hidden while hovering so it doesn't fight the actions. */}
      <span className="md:group-hover:hidden">{attention ? <span className="text-[10px] text-ctp-red">done</span> : <StateLabel state={session.state} />}</span>
      <button onClick={openMenu} className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-ctp-overlay hover:text-ctp-text text-sm leading-none transition-opacity px-1 py-1" title="Session actions" aria-label="Session actions">⋯</button>
      <button onClick={(e) => { e.stopPropagation(); onClose() }} className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-ctp-overlay hover:text-ctp-red text-xs transition-opacity px-1 py-1" title="Close session">✕</button>

      {menu && (
        <SessionMenu
          x={menu.x} y={menu.y} session={session} agents={agents}
          onClose={() => setMenu(null)}
          onSubsession={() => setSubOpen(true)}
          onInfo={() => setInfo(true)}
          onRename={beginRename}
          onPickRole={(id) => { if (id !== roleId) void setAgent(session.id, id) }}
        />
      )}
      {info && (
        <SessionInfoDialog
          session={session}
          roleName={roleName}
          parentName={session.parentId ? (sessions.find((s) => s.id === session.parentId)?.name ?? '—') : null}
          onClose={() => setInfo(false)}
        />
      )}
      {subOpen && <SubsessionDialog parent={session} onClose={() => setSubOpen(false)} />}
    </div>
  )
}

// Create a subsession under `parent`: shares the parent's cwd/root, with its own name,
// role, and sandbox (seeded from the parent's, fully editable — you choose whether the
// child inherits or diverges).
function SubsessionDialog({ parent, onClose }: { parent: SessionInfo; onClose: () => void }) {
  const { spawnSubsession, agents, sandboxAvailable } = useSessions()
  const [name, setName] = useState(`${parent.name} · sub`)
  const [agentId, setAgentId] = useState('general')
  const [sb, setSb] = useState<SbState>(() => sbFromConfig(parent.sandbox, parent.cwd))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    if (busy) return
    setBusy(true); setErr(null)
    try {
      const id = await spawnSubsession(parent.id, { name: name.trim() || undefined, agentId, sandbox: sbToConfig(sb, parent.cwd) })
      if (!id) throw new Error('Could not create the subsession.')
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to create subsession.')
      setBusy(false)
    }
  }
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border border-ctp-surface1 bg-ctp-mantle shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-5 h-12 border-b border-ctp-surface0">
          <Mark className="w-4 h-4 text-ctp-accent" />
          <span className="text-sm font-semibold text-ctp-text shrink-0">New subsession</span>
          <span className="text-[11px] text-ctp-overlay truncate">under {parent.name}</span>
          <button onClick={onClose} className="ml-auto text-ctp-overlay hover:text-ctp-text text-sm">✕</button>
        </div>
        <div className="p-5 space-y-3.5">
          <Field label="Name" hint="optional">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} className="modal-input" />
          </Field>
          <Field label="Working directory" hint="shared with parent">
            <input value={parent.cwd} readOnly className="modal-input font-mono text-[12px] opacity-70 cursor-not-allowed" />
          </Field>
          <Field label="Role">
            <RolePicker agents={agents} value={agentId} onChange={setAgentId} />
          </Field>
          <Field label="Sandbox" hint="seeded from parent">
            <SandboxFields value={sb} onChange={setSb} cwd={parent.cwd} available={sandboxAvailable} />
          </Field>
          {err && <div className="text-[11px] text-ctp-red">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-ctp-surface0">
          <button onClick={onClose} className="text-xs px-3.5 py-1.5 rounded-md text-ctp-subtext hover:bg-ctp-surface0 transition-colors">Cancel</button>
          <button onClick={submit} disabled={busy} className="text-xs font-medium px-4 py-1.5 rounded-md bg-ctp-accent text-ctp-base hover:brightness-110 active:brightness-95 disabled:opacity-40 transition">
            {busy ? 'Starting…' : 'Create subsession'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Per-session actions menu (portal to body so the sidebar's scroll never clips it).
// Two views: the main actions, and a "change role" submenu listing the agents.
function SessionMenu({ x, y, session, agents, onClose, onSubsession, onInfo, onRename, onPickRole }: {
  x: number; y: number; session: SessionInfo; agents: AgentInfo[]
  onClose: () => void; onSubsession: () => void; onInfo: () => void; onRename: () => void; onPickRole: (id: string) => void
}) {
  const [view, setView] = useState<'main' | 'roles'>('main')
  useEffect(() => {
    const close = () => onClose()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey) }
  }, [onClose])
  const item = 'w-full text-left px-3 py-1.5 hover:bg-ctp-surface0 text-ctp-text flex items-center gap-2'
  const left = Math.min(x, window.innerWidth - 200)
  const top = Math.min(y, window.innerHeight - 220)
  const curRole = session.agentId ?? 'general'
  const list = agents.length ? agents : [{ id: 'general', name: 'General', description: '' }]
  return createPortal(
    <div style={{ left, top }} onClick={(e) => e.stopPropagation()} className="fixed z-[60] w-48 rounded-md border border-ctp-surface1 bg-ctp-mantle shadow-pop py-1 text-xs">
      {view === 'main' ? (
        <>
          <button className={item} onClick={() => { onClose(); onSubsession() }}>➕ Create subsession</button>
          <button className={item} onClick={() => { onClose(); onInfo() }}>ⓘ Session info</button>
          <button className={item} onClick={() => setView('roles')}>🎭 Change role<span className="ml-auto text-ctp-overlay">›</span></button>
          <button className={item} onClick={() => { onClose(); onRename() }}>✎ Rename</button>
        </>
      ) : (
        <>
          <button className="w-full text-left px-3 py-1 text-[10px] uppercase tracking-wide text-ctp-overlay hover:text-ctp-text flex items-center gap-1" onClick={() => setView('main')}>‹ Change role</button>
          {list.map((a) => (
            <button key={a.id} className={item} onClick={() => { onClose(); onPickRole(a.id) }} title={a.description}>
              <span className="flex-1 truncate">{a.name}</span>
              {a.id === curRole && <span className="text-ctp-accent">✓</span>}
            </button>
          ))}
        </>
      )}
    </div>,
    document.body,
  )
}

// Read-only detail panel for a session (modal). Surfaces the fields that aren't
// otherwise visible: role, model, dirs, parent, permission mode, sandbox, id.
function SessionInfoDialog({ session, roleName, parentName, onClose }: {
  session: SessionInfo; roleName: string; parentName: string | null; onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const sandbox = session.sandbox?.enabled
    ? (session.sandboxed ? 'on' : 'requested — host can’t confine')
    : 'off'
  const rows: [string, React.ReactNode][] = [
    ['Role', roleName],
    ['Model', session.model || 'account default'],
    ['State', session.state],
    ['Permission', session.permissionMode ?? 'default'],
    ...(parentName ? [['Parent', parentName] as [string, React.ReactNode]] : []),
    ['Working dir', <span className="font-mono break-all">{session.cwd}</span>],
    ['Root dir', <span className="font-mono break-all">{session.rootDir}</span>],
    ['Sandbox', sandbox],
    ['Session id', <span className="font-mono break-all text-ctp-overlay">{session.id}</span>],
  ]
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border border-ctp-surface1 bg-ctp-mantle shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-5 h-12 border-b border-ctp-surface0">
          <span className="text-sm font-semibold text-ctp-text truncate">{session.name}</span>
          <button onClick={onClose} className="ml-auto text-ctp-overlay hover:text-ctp-text text-sm">✕</button>
        </div>
        <div className="p-5 grid gap-2">
          {rows.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[92px_1fr] gap-3 text-xs items-baseline">
              <span className="text-ctp-overlay">{k}</span>
              <span className="text-ctp-text min-w-0">{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function StateDot({ state }: { state: string }) {
  const map: Record<string, string> = {
    running: 'bg-ctp-green shadow-[0_0_8px_2px] shadow-ctp-green/60 animate-pulse',
    waiting: 'bg-ctp-yellow shadow-[0_0_8px_2px] shadow-ctp-yellow/60 animate-pulse',
    exited: 'bg-ctp-red',
    idle: 'bg-ctp-surface2',
  }
  return <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${map[state] ?? map.idle}`} title={state} />
}

// Tiny live status word beside a session in the sidebar — only for the states that
// mean "this session needs watching", so an active session reads at a glance.
function StateLabel({ state }: { state: string }) {
  if (state === 'running') return <span className="text-[10px] text-ctp-green shrink-0">working</span>
  if (state === 'waiting') return <span className="text-[10px] text-ctp-yellow shrink-0 animate-pulse">needs you</span>
  if (state === 'exited') return <span className="text-[10px] text-ctp-red shrink-0">exited</span>
  return null
}
