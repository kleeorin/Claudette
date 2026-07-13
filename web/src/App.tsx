import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SessionsProvider, useSessions } from './store/sessions'
import { ChatProvider } from './store/chat'
import { NotebooksProvider, useNotebooks } from './store/notebooks'
import { ChatView } from './components/ChatView'
import { NotebookView } from './components/NotebookView'
import { TerminalView } from './components/TerminalView'
import { GitPanelView } from './components/GitPanelView'
import { FileManager } from './components/FileManager'
import { FileEditorView } from './components/FileEditorView'
import { FileBrowser } from './components/FileBrowser'
import { AuthGate } from './components/AuthGate'
import { api } from './api/client'
import type { SessionInfo, ActivePane } from '@claudette/shared'

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

function Shell() {
  const { sessions, activeId } = useSessions()
  const notebooks = useNotebooks()
  const [drawer, setDrawer] = useState(false)

  // Content panes per session — switching sessions swaps the whole tab set + focus.
  const [bySession, setBySession] = useState<Record<string, Pane>>({})
  // Live refs for callbacks that must see the current session / notebook store
  // without re-subscribing (the WS focus handler below runs with `[]` deps).
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId
  const notebooksRef = useRef(notebooks); notebooksRef.current = notebooks

  // Docks.
  const [dock, setDock] = useState<'files' | 'git' | null>(null)
  const [termOpen, setTermOpen] = useState(false)
  const [termMounted, setTermMounted] = useState(false)

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
  const termCwd = activeSession?.cwd ?? DEFAULT_CWD

  // --- content tab management (per session) ----------------------------------
  const pane = (activeId ? bySession[activeId] : null) ?? EMPTY_PANE
  const active = pane.active
  const setPane = (sid: string, fn: (p: Pane) => Pane) =>
    setBySession((prev) => ({ ...prev, [sid]: fn(prev[sid] ?? EMPTY_PANE) }))

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
    if (t.kind === 'notebook') notebooks.setActive(t.id)
  }
  const closeTab = (t: Content) => {
    if (t.kind === 'notebook') { notebooks.close(t.id); return }  // the effect prunes it from all panes
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
      if (activeId) setPane(activeId, (p) => ({
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

  // On session switch, mirror the session's active notebook into the store.
  useEffect(() => {
    const a = activeId ? bySession[activeId]?.active : null
    if (a?.kind === 'notebook') notebooks.setActive(a.id)
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

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
      if (sid === activeIdRef.current) notebooksRef.current.setActive(notebookId)
    })
  }, [])

  const toggleTerm = () => { if (!termOpen) setTermMounted(true); setTermOpen((v) => !v) }
  const toggleDock = (which: 'files' | 'git') => setDock((d) => (d === which ? null : which))

  // Tab strip for the CURRENT session's pane, enriched with live doc metadata.
  const tabs: Tab[] = pane.tabs.map((t) => {
    if (t.kind === 'notebook') {
      const d = notebooks.open.find((o) => o.notebookId === t.id)
      return { key: `nb:${t.id}`, kind: 'notebook', id: t.id, label: d ? (d.path.split('/').pop() ?? d.path) : 'notebook', path: d?.path ?? '', dirty: d?.dirty ?? false }
    }
    return { key: `f:${t.path}`, kind: 'file', id: '', label: t.path.split('/').pop() ?? t.path, path: t.path, dirty: false }
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

        <div className="flex-1 min-h-0 flex">
          {/* Main column: tabs + (Claude | content) + terminal dock. */}
          <div className="flex-1 min-w-0 flex flex-col">
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
            />

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

            {/* Bottom dock: Terminal (spans the main column). Mounted once opened. */}
            {termMounted && termOpen && (
              <div
                {...dividerProps({ axis: 'y', get: () => termH, set: setTermH, sign: -1, min: 120, max: () => 700 })}
                title="Drag to resize"
                className="shrink-0 h-1 cursor-row-resize bg-ctp-surface0 hover:bg-ctp-accent/60 active:bg-ctp-accent transition-colors touch-none"
              />
            )}
            {termMounted && (
              <div className={termOpen ? 'shrink-0 flex flex-col border-t border-ctp-surface0' : 'hidden'} style={termOpen ? { height: termH } : undefined}>
                <div className="h-7 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
                  <span className="text-[11px] font-medium text-ctp-subtext">Terminal</span>
                  <span className="text-[10px] text-ctp-overlay font-mono truncate">{prettyPath(termCwd)}</span>
                  <button onClick={toggleTerm} title="Hide terminal" className="ml-auto text-ctp-overlay hover:text-ctp-text p-0.5">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <TerminalView key={termCwd} cwd={termCwd} visible={termOpen} />
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
                  onOpenNotebook={(p) => void notebooks.openPath(p)}
                  onOpenFile={openFile}
                  onNewNotebook={notebooks.createPath}
                  onClose={() => setDock(null)}
                />
              ) : (
                <GitPanelView key={termCwd} cwd={termCwd} onClose={() => setDock(null)} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

type Tab = { key: string; kind: 'notebook' | 'file'; id: string; label: string; path: string; dirty: boolean }

// Tab strip: Chat + one tab per open content item, then the dock toggles (Files /
// Git / Terminal) and the companion-orientation control.
function MainTabs({ tabs, active, onSelectChat, onSelectTab, onCloseTab, layout, onSetLayout, showLayout, dock, onToggleDock, termOpen, onToggleTerm }: {
  tabs: Tab[]
  active: Content | null
  onSelectChat: () => void
  onSelectTab: (t: Tab) => void
  onCloseTab: (t: Tab) => void
  layout: 'side' | 'stack'; onSetLayout: (l: 'side' | 'stack') => void; showLayout: boolean
  dock: 'files' | 'git' | null; onToggleDock: (w: 'files' | 'git') => void
  termOpen: boolean; onToggleTerm: () => void
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
    <div className="shrink-0 h-8 flex items-stretch gap-0 px-2 bg-ctp-mantle border-b border-ctp-surface0 overflow-x-auto">
      <button className={tab(active === null)} onClick={onSelectChat}>Chat</button>
      {tabs.map((t) => (
        <span key={t.key} className={tab(isOn(t))}>
          <span className="shrink-0">{t.kind === 'notebook' ? '📓' : '📄'}</span>
          <button onClick={() => onSelectTab(t)} className="truncate max-w-[150px]" title={t.path}>
            {t.label}{t.dirty && <span className="text-ctp-yellow"> ●</span>}
          </button>
          <button onClick={() => onCloseTab(t)} className="text-ctp-overlay hover:text-ctp-red" title="Close">✕</button>
        </span>
      ))}
      <div className="flex-1" />

      {/* Companion orientation (only meaningful when a content tab is open). */}
      {showLayout && (
        <div className="flex items-center gap-0.5 rounded-md bg-ctp-surface0/40 p-0.5 mr-1 self-center" title="Where Claude sits">
          <button className={`w-7 h-6 flex items-center justify-center rounded ${layout === 'side' ? 'bg-ctp-surface1 text-ctp-text' : 'text-ctp-overlay hover:text-ctp-subtext'}`} onClick={() => onSetLayout('side')} title="Claude beside">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="2.5" width="4.5" height="9" rx="1" /><rect x="8" y="2.5" width="4.5" height="9" rx="1" /></svg>
          </button>
          <button className={`w-7 h-6 flex items-center justify-center rounded ${layout === 'stack' ? 'bg-ctp-surface1 text-ctp-text' : 'text-ctp-overlay hover:text-ctp-subtext'}`} onClick={() => onSetLayout('stack')} title="Claude under">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2.5" y="1.5" width="9" height="4.5" rx="1" /><rect x="2.5" y="8" width="9" height="4.5" rx="1" /></svg>
          </button>
        </div>
      )}

      {/* Dock toggles. */}
      <div className="flex items-center gap-1 self-center">
        <button className={toggle(dock === 'files')} onClick={() => onToggleDock('files')} title="Files browser">Files</button>
        <button className={toggle(dock === 'git')} onClick={() => onToggleDock('git')} title="Git panel">Git</button>
        <button className={toggle(termOpen)} onClick={onToggleTerm} title="Terminal">Terminal</button>
      </div>
    </div>
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

const DEFAULT_CWD = '/home/kleeorin/Work/Projects/Claudette'

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
  const { sessions, activeId, setActive, destroy, connected } = useSessions()
  const [showNew, setShowNew] = useState(false)
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
            <SessionRow key={s.id} session={s} active={s.id === activeId} onSelect={() => pick(s.id)} onClose={() => void destroy(s.id)} />
          ))}
        </div>

        <div className="border-t border-ctp-surface0 p-3 shrink-0">
          <button onClick={() => setShowNew(true)} className="w-full flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-2.5 rounded-md bg-ctp-accent text-ctp-base hover:brightness-110 active:brightness-95 transition">
            <span className="text-base leading-none">+</span> New session
          </button>
        </div>

        {showNew && <NewSessionDialog onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); onClose() }} />}
      </aside>
    </>
  )
}

// Centered modal for creating a session — name + working directory + optional model.
function NewSessionDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }) {
  const { create } = useSessions()
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState(DEFAULT_CWD)
  const [model, setModel] = useState('')
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
      await create(name.trim() || cwd.trim().split('/').pop() || 'session', cwd.trim(), { model: model.trim() || undefined })
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
          <Field label="Model" hint="optional">
            <input value={model} onChange={(e) => setModel(e.target.value)} onKeyDown={onEnter} placeholder="account default (e.g. sonnet, opus, haiku)" className="modal-input font-mono text-[12px]" />
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
        <FileBrowser mode="folder" initialPath={cwd.trim() || DEFAULT_CWD} onPick={(path) => { setCwd(path); setBrowsing(false) }} onClose={() => setBrowsing(false)} />
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

function SessionRow({ session, active, onSelect, onClose }: { session: SessionInfo; active: boolean; onSelect: () => void; onClose: () => void }) {
  return (
    <div onClick={onSelect} className={`group relative rounded-md px-2.5 py-2 cursor-pointer flex items-center gap-2.5 transition-colors ${active ? 'bg-ctp-surface0' : 'hover:bg-ctp-surface0/50'}`}>
      {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-ctp-accent" />}
      <StateDot state={session.state} />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-sm ${active ? 'text-ctp-text' : 'text-ctp-subtext'}`}>{session.name}</div>
        <div className="truncate text-[10px] text-ctp-overlay font-mono">{prettyPath(session.cwd)}</div>
      </div>
      <button onClick={(e) => { e.stopPropagation(); onClose() }} className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-ctp-overlay hover:text-ctp-red text-xs transition-opacity px-1.5 py-1" title="Close session">✕</button>
    </div>
  )
}

function StateDot({ state }: { state: string }) {
  const map: Record<string, string> = {
    running: 'bg-ctp-green shadow-[0_0_6px] shadow-ctp-green/50 animate-pulse',
    waiting: 'bg-ctp-yellow',
    exited: 'bg-ctp-red',
    idle: 'bg-ctp-surface2',
  }
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${map[state] ?? map.idle}`} title={state} />
}

// Shorten a home path to `~/…` for the sidebar.
function prettyPath(p: string): string {
  return p.replace(/^\/home\/[^/]+/, '~')
}
