import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Overlay } from './components/Overlay'
import { createPortal } from 'react-dom'
import { SessionsProvider, useSessions } from './store/sessions'
import { ChatProvider, useChat, collectAgents, agentKey, isAgentLive, type AgentView } from './store/chat'
import { useDismissedAgents, dismissAgents, pruneDismissed } from './store/agentDismiss'
import { NotebooksProvider, useNotebooks } from './store/notebooks'
import { ChatView, SidebarUsage } from './components/ChatView'
import { NotebookView } from './components/NotebookView'
import { TerminalView } from './components/TerminalView'
import { GitPanelView } from './components/GitPanelView'
import { FileManager } from './components/FileManager'
import { KernelsPanel } from './components/KernelsPanel'
import { PermissionsPanel } from './components/PermissionsPanel'
import { SandboxPanel } from './components/SandboxPanel'
import { ClaudetteDeck } from './components/ClaudetteDeck'
import { FileEditorView } from './components/FileEditorView'
import { AgentDetail, agentTabLabel, AgentStatusDot } from './components/AgentDetail'
import { FileBrowser } from './components/FileBrowser'
import { ConfirmDialog } from './components/ConfirmDialog'
import { AuthGate } from './components/AuthGate'
import { api } from './api/client'
import { useEscape, useDismissOnOutside } from './lib/useDismiss'
import { isEditTool, filePathOf, isNotebookPath } from './lib/proposals'
import { pruneDrafts } from './lib/drafts'
import { useNotifications, type NotificationsApi } from './lib/notifications'
import { basename, prettyPath } from './lib/paths'
import { MD_PX, usePhone } from './lib/breakpoint'
import { attachNewNotebooks } from './lib/notebookAttach'
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

// A content tab opened beside Claude: an open notebook, a file editor, or one
// subagent's full thought process. An agent tab carries the label it was opened with
// so the tab strip never has to re-derive it from the streaming transcript.
type Content =
  | { kind: 'notebook'; id: string }
  | { kind: 'file'; path: string }
  | { kind: 'agent'; id: string; label: string }
// The set of content tabs + the focused one, tracked PER SESSION so panes travel
// with the session you switch to.
type Pane = { tabs: Content[]; active: Content | null }
const EMPTY_PANE: Pane = { tabs: [], active: null }

// A session's terminal dock: its open/closed state, its tabbed terminals, and which
// tab is focused. Tracked PER SESSION (keyed by session id) so terminals follow the
// session you switch to. A terminal's `key` is a stable local id (tab identity);
// `paneId` is the server pty it's bound to — null only in the brief window between
// creating a fresh terminal and the server reporting its id. Persisting `paneId` is
// what lets a refreshed page REATTACH to the still-running shell.
type TermEntry = { key: string; paneId: string | null; cwd: string }
type TermPane = { open: boolean; terms: TermEntry[]; active: string | null }
const EMPTY_TERM: TermPane = { open: false, terms: [], active: null }

// --- layout persistence (localStorage) --------------------------------------
// The processes live server-side; only the LAYOUT (which terminals/notebooks are open
// per session, their sizes, the active tab) is persisted here so a refresh can restore
// the view and reattach. Notebooks are stored by PATH, not the volatile server-assigned
// notebookId (which changes across a server restart) — restore reopens by path.
const LS_KEY = 'claudette:layout:v1'
type PersistContentTab = { kind: 'file' | 'notebook'; path: string }
type PersistContent = { active: string | null; tabs: PersistContentTab[] }  // active = 'f:<path>' | 'n:<path>' | null
interface Persisted {
  v: 1
  layout: 'side' | 'stack'
  sizes: { sideW: number; stackH: number; dockW: number; termH: number; sidebarW: number }
  seq: number                                 // termSeq high-water, so restored keys don't collide
  terms: Record<string, TermPane>
  content: Record<string, PersistContent>
}
function loadPersisted(): Persisted | null {
  try { const raw = localStorage.getItem(LS_KEY); const p = raw ? JSON.parse(raw) : null; return p?.v === 1 ? p as Persisted : null } catch { return null }
}
function savePersisted(p: Persisted): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)) } catch { /* quota / private mode — layout just won't persist */ }
}
// Read once at module load (client-only) so useState initializers can hydrate from it.
const INITIAL = loadPersisted()

// --- phone: which SINGLE pane is on screen -------------------------------------------
// Below `md` there is no room for panes side by side, so exactly one shows at a time.
// `null` means desktop — show everything, unchanged.
export type PhonePane = 'chat' | 'content' | 'terminal' | 'dock'

// ONE pure resolver, module-scoped, rather than four `hidden` expressions scattered through
// the tree. Every hide below compares against its result, so there is a single place that
// decides which pane wins and no way for two of them to disagree.
//
// THE FALLBACK IS THE POINT, not a detail. A wanted pane whose ENTITY has gone — the content
// tab was closed, the terminal hidden, the dock toggled off — must not leave the phone showing
// nothing at all. Falling back to 'chat' makes the chat the floor of this state machine: there
// is no reachable state with zero visible panes. It is also what lets the closing handlers stay
// unwired — `hideTerm`, `closeTab` and closing a dock need no phone-pane bookkeeping, because
// removing the entity is already the signal to fall back.
export function resolvePhonePane(
  want: PhonePane,
  have: { content: boolean; terminal: boolean; dock: boolean },
): PhonePane {
  if (want === 'content') return have.content ? 'content' : 'chat'
  if (want === 'terminal') return have.terminal ? 'terminal' : 'chat'
  if (want === 'dock') return have.dock ? 'dock' : 'chat'
  return 'chat'
}

// --- the terminal dock's height, bounded by what is actually VISIBLE ------------------
// `termH` is an absolute pixel height the user DRAGGED to, and it is restored from
// localStorage — so a dock sized on a desktop arrives on a phone unchanged. The dock is
// `shrink-0` inside a shell that is `overflow-hidden`, so when it no longer fits, nothing
// scrolls and nothing shrinks: the bottom of the terminal is simply clipped away, and the
// bottom of a terminal is the prompt.
//
// Bounded against `--vvh` (lib/visualViewport.ts) rather than `100vh`/`100dvh`, because the
// case that needs it is a software keyboard: the LAYOUT viewport does not shrink when the
// keyboard comes up, so every `vh` unit keeps reporting the whole screen while ~40% of it is
// covered. `--vvh` is the only one that moves. Measured at 390x844 with a saved 600px dock:
// with the keyboard up, 176px of terminal sat below an overflow-hidden shell.
//
// EXPRESSED AS CSS, NOT AS A SUBSCRIPTION IN JS — and for ONE reason, not two. The bound needs
// no re-fit plumbing: the dock's box really changes, so the ResizeObserver already in
// useTerminal fires and FitAddon re-fits. (That observer is NOT the obstacle
// lib/visualViewport.ts describes it as — a ResizeObserver fires on height-only changes too,
// and its `contentRect.width > 0` guard is a liveness test, not a width-CHANGED test. What was
// missing was a box that changes, not a callback.)
// A SECOND REASON WAS STATED HERE AND WAS WRONG; it is recorded so nobody re-derives it. It
// claimed that because `--vvh` republishes on visualViewport `scroll` as well as `resize`,
// reading it into React state would re-render on every pan frame. `publish()` writes
// `${visibleHeight()}px` — the HEIGHT — and a pan changes `offsetTop`, not height. So a scroll
// frame rewrites an IDENTICAL string and `setState` would bail on `Object.is`. The claim was
// false, and it mattered: **a weak reason stated beside a strong one invites someone to refute
// the weak one and revert the whole change** — which is how the FitAddon misattribution above
// happened one layer down.
//
// THE RESERVE IS MEASURED, NOT DECOMPOSED — an earlier comment derived it as "the mobile top
// bar (h-12) and the tab bar (h-9), plus 80px". There is no `h-9` tab bar: `MainTabs`' root is
// `h-8`, and the only `h-9` in this file is the hamburger button and the logo. Counting the
// `border-b` each band carries gives 49 + 33 = 82, so this is ~82px of measured chrome plus
// 80px of slack, rounded. Do not present it as a decomposition it does not have.
// NOTE THE 48 IS MOBILE-ONLY: the top bar is `md:hidden`, so on desktop it contributes 0 and
// this expression over-reserves by 48px. Inert today (900 - 164 = 736 > any saved dock), but a
// short desktop window with a large saved `termH` shrinks the dock 48px earlier than needed.
//
// *** THE FLOOR IS AN ESCAPE HATCH, NOT A SAFETY NET, AND IT HAS A KNOWN THRESHOLD. *** Below
// `--vvh` = 284px the `max()` yields the floor and THE BOUND STOPS TRACKING THE VIEWPORT:
// 120 + 164 = 284 > `--vvh`, so the column exceeds the shell and the prompt is clipped again —
// the exact failure this bound exists to prevent. Reachable in real configurations: a phone in
// landscape with the keyboard up (a 320px layout viewport), and any short desktop window. The
// trade is deliberate — a 120px dock leaves ~91px of body after the `h-7` strip and border,
// about 5 rows, which beats a sliver — but the threshold is written down here because
// otherwise the failure returns silently at 284px with nothing saying so.
// 164, NOT 162, AND DELIBERATELY LEFT AS IT WAS. The honest reading is ~82px of measured chrome
// plus ~82px of slack; the terms below are a convenient spelling of a MEASURED total, not a
// derivation. Changing it to match a freshly-constructed decomposition would be a behaviour
// change smuggled in as a comment fix — and the fails-first evidence for this bound (6 red → 0)
// was measured against 164.
const DOCK_RESERVE_PX = 164
const DOCK_MIN_PX = 120

// THE STACKED COLUMN'S OWN RESERVE — why the flat one above is not enough there.
//
// In 'stack' with a content tab open, the Claude column is sized `stackH + dock + 1` and is
// `shrink-0`, so the dock is no longer competing only with the viewport: it shares a budget
// with `stackH` and with the content pane above it. Measured at 900x844 with a saved 600px
// dock: 32 chrome + 0 content + 4 divider + 881 column = 917 against an 844px shell, clipping
// the bottom 73px of the terminal, and 153px with a keyboard up.
//
// *** THE CAUSE IS NOT EITHER TERM. IT IS TWO INDEPENDENT BOUNDS ON ONE SHARED BUDGET. ***
// The dock's bound is `--vvh - 164`: viewport-aware, but blind to `stackH` and to the content
// pane. `stackH`'s drag max is `splitRef.height - 200`: content-pane-aware, but blind to the
// dock. Each is individually satisfiable and their SUM is not, so neither shows up as the
// culprit when you look at it alone — and neither alone can clip (a maximal dock with no
// stackH fits; a maximal stackH with no dock fits).
//
// The content pane cannot be the one that gives way, because IT ALREADY DID: it is the only
// elastic term here and it measured 0px in both states before anything was clipped. By the
// time the terminal is being cut off, the file editor above it is already gone entirely.
//
// So the DOCK gives way, and it is the right term for three reasons: it is the only one that
// already has a viewport-aware bound (this is one more subtrahend, not a new mechanism); it
// has a designed floor (DOCK_MIN_PX), so "gives way" has a defined stopping point; and the
// bound is transient CSS, so the user's dragged `termH` survives in state and re-expands when
// there is room — clamping the persisted `stackH` instead would fight a saved preference and
// need un-clamping later.
//
// 200 is not a new number: it is the same content-pane reserve `stackH`'s own drag max already
// uses, so the two bounds now agree about what the content pane is owed instead of disagreeing.
const STACK_CONTENT_MIN_PX = 200
// MainTabs (h-8) + the drag divider (h-1) + the column's 1px top border. The mobile top bar is
// `md:hidden` and this path is >= md only, so it is deliberately NOT counted. Measured, not
// assumed: chrome 32, divider 4.
const STACK_CHROME_PX = 32 + 4 + 1

const boundedDockH = (px: number, reservePx: number = DOCK_RESERVE_PX) =>
  `min(${px}px, max(${DOCK_MIN_PX}px, calc(var(--vvh, 100vh) - ${reservePx}px)))`

function Shell() {
  const { sessions, activeId, setActive, homeDir } = useSessions()
  const notebooks = useNotebooks()
  const [drawer, setDrawer] = useState(false)

  // Background-session signals: sound (default on) + optional desktop notifications.
  const notif = useNotifications(sessions, activeId, setActive)

  // Auto-open a file's editor to show Claude's proposed edit when the file is closed
  // (default on). An already-open file always shows its diff regardless — this only
  // gates popping a new tab for a closed one. Persisted; read via a ref in the
  // permission effect (subscribed once).
  const [autoOpenEdits, setAutoOpenEdits] = useState(() => {
    try { return localStorage.getItem('claudette.autoOpenEdits') !== '0' } catch { return true }
  })
  const autoOpenEditsRef = useRef(autoOpenEdits); autoOpenEditsRef.current = autoOpenEdits
  const toggleAutoOpenEdits = () => setAutoOpenEdits((v) => {
    const n = !v
    try { localStorage.setItem('claudette.autoOpenEdits', n ? '1' : '0') } catch { /* private mode */ }
    return n
  })

  // Content panes per session — switching sessions swaps the whole tab set + focus.
  // Hydrate FILE tabs synchronously from the saved layout; notebook tabs are reopened
  // by path in an effect below (their ids must be re-minted after a reload).
  const [bySession, setBySession] = useState<Record<string, Pane>>(() => {
    const c = INITIAL?.content
    if (!c) return {}
    const out: Record<string, Pane> = {}
    for (const [sid, pc] of Object.entries(c)) {
      const tabs: Content[] = pc.tabs.filter((t) => t.kind === 'file').map((t) => ({ kind: 'file', path: t.path }))
      const active: Content | null = pc.active?.startsWith('f:') ? { kind: 'file', path: pc.active.slice(2) } : null
      out[sid] = { tabs, active }
    }
    return out
  })

  // Pending "save before closing?" prompt for a dirty / still-running notebook tab.
  const [closeNb, setCloseNb] = useState<{ id: string; name: string; dirty: boolean; running: boolean } | null>(null)

  // Docks.
  const [dock, setDock] = useState<'files' | 'git' | 'permissions' | 'sandbox' | null>(null)
  const [filesTab, setFilesTab] = useState<'files' | 'kernels'>('files')  // sub-tab of the Files dock
  // Terminals are PER SESSION — each session owns its own tabbed set of terminals
  // and its own dock open/closed state, so switching sessions swaps the whole
  // terminal dock (and every session's ptys keep running in the background). Each
  // terminal captures its cwd at creation. Terminal ids are globally unique (via the
  // shared `termSeq`) so every session's terminals can be mounted at once.
  const [termsBySession, setTermsBySession] = useState<Record<string, TermPane>>(() => INITIAL?.terms ?? {})
  // Seed past the highest restored key so freshly-opened terminals never collide with a
  // restored one. Ref mirror lets the reconcile effect read current terms synchronously.
  const termSeq = useRef<number>(INITIAL?.seq ?? 0)
  const termsRef = useRef(termsBySession); termsRef.current = termsBySession

  const isPhone = usePhone()
  // The pane the USER last asked for. NOT derived from `active` — see the comment on the
  // handlers below, which is the single most important decision in this slice.
  //
  // DELIBERATELY NOT PERSISTED: `LS_KEY` stays at v1 and `Persisted` does not gain a field.
  // Persisting it would mean a migration, and "which pane was I on" is session-scoped attention
  // rather than layout the user arranged.
  const [phonePane, setPhonePane] = useState<PhonePane>('chat')

  // Companion orientation for the content split (phones default to stacked).
  const [layout, setLayout] = useState<'side' | 'stack'>(
    () => INITIAL?.layout ?? (typeof window !== 'undefined' && window.innerWidth < MD_PX ? 'stack' : 'side'),
  )

  // Resizable sizes (px). sideW/stackH = Claude companion size; dockW = right dock;
  // termH = bottom dock; sidebarW = session sidebar. Restored from the saved layout.
  const [sideW, setSideW] = useState(INITIAL?.sizes.sideW ?? 420)
  const [stackH, setStackH] = useState(INITIAL?.sizes.stackH ?? 280)
  const [dockW, setDockW] = useState(INITIAL?.sizes.dockW ?? 320)
  const [termH, setTermH] = useState(INITIAL?.sizes.termH ?? 240)
  const [sidebarW, setSidebarW] = useState(INITIAL?.sizes.sidebarW ?? 288)
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
  // Session MEMBERSHIP as a stable string, for effects that only care who exists —
  // `sessions` itself turns over on every state event.
  const sessionIdKey = sessions.map((s) => s.id).sort().join(',')

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
  // The pane ids this tab holds, as a stable string. `allTerms` is rebuilt by flatMap on
  // every render, so an effect keyed on it never matched and ran constantly; this is the
  // value the claim effect actually cares about.
  const claimKey = allTerms.map((t) => t.paneId).filter(Boolean).join(',')
  const dockShown = termOpen && terms.length > 0   // the active session's dock is visible

  // The resolved pane: `null` on desktop (show everything), one of the four at phone.
  const shownPane: PhonePane | null = isPhone
    ? resolvePhonePane(phonePane, { content: active !== null, terminal: dockShown, dock: dock !== null })
    : null
  // The terminal dock is the one pane that is ALSO gated by desktop state (`dockShown`), so it
  // gets a named flag both the container and each TerminalView's `visible` prop read — keeping
  // that prop truthful is what stops xterm from fitting to a zero box.
  const dockVisible = dockShown && (!isPhone || shownPane === 'terminal')
  // Computed ONCE and used at BOTH sites below. Computing it twice is exactly how the column
  // came to reserve a different height than the dock occupied — a gap below the terminal
  // instead of a clipped one. Keeping it a single value makes that divergence unrepresentable.
  const dockHeightCss = boundedDockH(
    termH,
    active && layout === 'stack' ? STACK_CHROME_PX + STACK_CONTENT_MIN_PX + stackH : DOCK_RESERVE_PX,
  )
  const setTermPane = (sid: string, fn: (p: TermPane) => TermPane) =>
    setTermsBySession((prev) => ({ ...prev, [sid]: fn(prev[sid] ?? EMPTY_TERM) }))

  // *** THE PHONE PANE IS WIRED ONLY INTO THESE — THE USER-INITIATED HANDLERS. ***
  // It would be a smaller diff to drive the phone's chat/content choice off `active` directly
  // (`selectChat` already sets `active: null`), and it would be wrong. THREE effects in this
  // component open a content tab MACHINE-side: notebook-opened, file-opened, and the
  // proposed-edit auto-open. If a machine-opened tab could displace the chat pane at phone,
  // then the moment Claude proposes an edit the file editor would cover the permission card
  // approving THAT VERY EDIT — the card is a sibling of the transcript INSIDE the chat pane.
  // The user would be looking at the diff with no way to approve it.
  //
  // So a machine-opened tab appears in the strip UNHIGHLIGHTED: a notification, not a yank.
  // The consequence to keep in mind when reading the render: `active` and `shownPane` can
  // legitimately disagree, which is why MainTabs highlights from `shownPane` at phone.
  //
  // Only OPENING is wired. Closing needs nothing — resolvePhonePane falls back to 'chat' the
  // moment the entity is gone.
  const openFile = (path: string) => {
    if (!activeId) return
    setPhonePane('content')
    setPane(activeId, (p) => ({
      tabs: p.tabs.some((t) => t.kind === 'file' && t.path === path) ? p.tabs : [...p.tabs, { kind: 'file', path }],
      active: { kind: 'file', path },
    }))
  }
  // Focus an already-open notebook's tab (adding it if somehow absent) — used by the
  // Files dock's open-notebook and by the Kernels tab's notebook list.
  const focusNotebook = (id: string) => {
    if (!activeId) return
    setPhonePane('content')
    setPane(activeId, (p) => ({
      tabs: p.tabs.some((t) => t.kind === 'notebook' && t.id === id) ? p.tabs : [...p.tabs, { kind: 'notebook', id }],
      active: { kind: 'notebook', id },
    }))
  }
  // Open (or focus) a subagent's thought-process tab. Panes are per session, so
  // clicking an agent belonging to a background session switches to that session first.
  const openAgent = (sid: string, id: string, label: string) => {
    setActive(sid)
    setPhonePane('content')
    setPane(sid, (p) => ({
      tabs: p.tabs.some((t) => t.kind === 'agent' && t.id === id) ? p.tabs : [...p.tabs, { kind: 'agent', id, label }],
      active: { kind: 'agent', id, label },
    }))
  }
  const selectChat = () => { setPhonePane('chat'); if (activeId) setPane(activeId, (p) => ({ ...p, active: null })) }
  const selectTab = (t: Content) => {
    if (!activeId) return
    setPhonePane('content')
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
    if (t.kind === 'agent') {
      setPane(activeId, (p) => {
        const tabs = p.tabs.filter((x) => !(x.kind === 'agent' && x.id === t.id))
        const nextActive = p.active?.kind === 'agent' && p.active.id === t.id ? (tabs[tabs.length - 1] ?? null) : p.active
        return { tabs, active: nextActive }
      })
      return
    }
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
    // H6 (store/sessionReducer.ts): this loop used to mark an id seen BEFORE testing whether it
    // could act on it, which permanently defeated the retry its own `[openIds, activeId]` dep
    // array was there to provide. The decision — and the marking, which must be the same event
    // as the acting — now lives in lib/notebookAttach.ts, where it is unit-tested. Only a
    // notebook THIS user opened attaches to the session they're viewing; one a Claude tool
    // opened arrives pushed from the server and attaches to the CALLING session via `focusPane`
    // below, so it never leaks into whatever session you happen to be looking at.
    // Guarded rather than asserted with `!`: attachNewNotebooks returns ids only when activeId
    // is set, but that guarantee lives in another file, and a non-null assertion here would be
    // load-bearing on it silently. This costs nothing — with no activeId the call returns [].
    if (activeId) for (const id of attachNewNotebooks(ids, seenNb.current, { activeId, wasLocallyOpened: notebooks.wasLocallyOpened })) {
      setPane(activeId, (p) => ({
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

  // Claude asked (open_file) to focus a plain file in a specific session: open a tab
  // for it there and make it active. Unlike the edit-proposal effect below, this is an
  // explicit "show the user this file", so it always opens — no auto-open setting.
  useEffect(() => {
    return api.on.focusFile((sid, path) => {
      const tab: Content = { kind: 'file', path }
      setBySession((prev) => {
        const p = prev[sid] ?? EMPTY_PANE
        const tabs = p.tabs.some((t) => t.kind === 'file' && t.path === path) ? p.tabs : [...p.tabs, tab]
        return { ...prev, [sid]: { tabs, active: tab } }
      })
    })
  }, [])

  // Claude asked to Edit/MultiEdit/Write a (non-notebook) file: surface its inline +/-
  // diff for review. If the file is ALREADY open in the calling session, we focus that
  // tab so the diff shows. If it's CLOSED, we only auto-open it when "auto-open edits"
  // is on (autoOpenEditsRef) — otherwise it's left to the chat permission card, so
  // background edits don't keep popping editor tabs. FileEditorView reads the same
  // pending permission and renders the diff either way.
  useEffect(() => {
    return api.on.permission((sid, req) => {
      if (!isEditTool(req.toolName)) return
      const fp = filePathOf(req.input)
      if (!fp || isNotebookPath(fp)) return
      const tab: Content = { kind: 'file', path: fp }
      setBySession((prev) => {
        const p = prev[sid] ?? EMPTY_PANE
        const isOpen = p.tabs.some((t) => t.kind === 'file' && t.path === fp)
        if (!isOpen && !autoOpenEditsRef.current) return prev  // closed + toggle off → chat card only
        const tabs = isOpen ? p.tabs : [...p.tabs, tab]
        return { ...prev, [sid]: { tabs, active: tab } }
      })
    })
  }, [])

  const addTerm = (cwd: string) => {
    if (!activeId) return
    const key = `t${++termSeq.current}`   // globally unique across sessions
    setTermPane(activeId, (p) => ({ open: true, terms: [...p.terms, { key, paneId: null, cwd }], active: key }))
  }
  // A TerminalView in create mode reports the server pty id once spawned; record it so
  // the layout persists it (for reattach) and closeTerm can destroy the right pty.
  const setTermPaneId = (sid: string, key: string, paneId: string) =>
    setTermsBySession((prev) => {
      const st = prev[sid]
      if (!st) return prev
      return { ...prev, [sid]: { ...st, terms: st.terms.map((t) => (t.key === key ? { ...t, paneId } : t)) } }
    })
  const closeTerm = (key: string) => {
    if (!activeId) return
    setTermPane(activeId, (p) => {
      const entry = p.terms.find((t) => t.key === key)
      if (entry?.paneId) void api.pane.destroy(entry.paneId)   // explicit close kills the pty (refresh does NOT)
      const rest = p.terms.filter((t) => t.key !== key)
      return {
        open: rest.length > 0 ? p.open : false,         // last one → dock closes (as before first open)
        terms: rest,
        active: p.active === key ? (rest[rest.length - 1]?.key ?? null) : p.active,
      }
    })
  }
  const selectTerm = (key: string) => { if (activeId) setTermPane(activeId, (p) => ({ ...p, active: key })) }
  const hideTerm = () => { if (activeId) setTermPane(activeId, (p) => ({ ...p, open: false })) }
  // Toggle the active session's dock: opening with no terminals yet spawns the first.
  const toggleTerm = () => {
    if (!activeId) return
    if (termOpen) { hideTerm(); return }
    setPhonePane('terminal')
    if (terms.length === 0) addTerm(termCwd)
    else setTermPane(activeId, (p) => ({ ...p, open: true }))
  }
  // Rewritten from `setDock((d) => …)` to read `dock` directly: the phone pane has to be set
  // in the same handler, and calling setPhonePane from inside a setState UPDATER makes the
  // updater impure — React invokes updaters twice under StrictMode, so the side effect would
  // fire twice and, worse, would be the kind of thing that only misbehaves in development.
  const toggleDock = (which: 'files' | 'git' | 'permissions' | 'sandbox') => {
    const opening = dock !== which
    setDock(opening ? which : null)
    if (opening) setPhonePane('dock')
  }

  // When a session goes away, drop its terminal dock. The server already reaped the
  // ptys it owned (sessions.on('destroyed') → panes.destroyForSession), so this is
  // pure client-state cleanup. GUARD: the session list loads async, so skip while it's
  // empty — otherwise a refresh with restored terminals would drop them all before the
  // list arrives.
  useEffect(() => {
    if (sessions.length === 0) return
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
    // Same for its content tabs. This effect cleaned terminals and dismissed-agent keys
    // but skipped the pane map, so a closed session's file/notebook tabs stayed in memory
    // AND were re-persisted to the layout key on every layout change, forever.
    setBySession((prev) => {
      let changed = false
      const next: Record<string, Pane> = {}
      for (const [sid, p] of Object.entries(prev)) {
        if (ids.has(sid)) next[sid] = p
        else { changed = true; delete publishedRef.current[sid] }   // its last-published active pane goes too
      }
      return changed ? next : prev
    })
    // Same for the cleared-agent keys it owned — a closed session's list is gone, so
    // its clears would otherwise sit in localStorage forever.
    pruneDismissed([...ids])
    pruneDrafts([...ids])   // and the composer text it never sent
    // Keyed on the id SET, not the session array: `sessions` gets a new identity on every
    // state event (running→idle, a rename, an optimistic patch), and this body walks the
    // whole localStorage keyspace via pruneDrafts. Only membership can make it do work.
  }, [sessionIdKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- refresh survival: reconcile, persist, restore notebooks ----------------
  // ONCE on load: reconcile the restored terminal layout against the ptys the server
  // actually still has. Drop terminals whose pty is gone (e.g. the server restarted and
  // cleared them), then CLAIM the rest — which also sweeps ptys no tab claims (the
  // "headless" orphans left by past refreshes).
  //
  // `keep` is built from termsRef, NOT inside the setTermsBySession updater. React may
  // defer an updater past the call that follows it, and this one had a side effect
  // (pushing into `keep`) that the prune below depended on: whenever the updater ran
  // late, prune posted an EMPTY keep-set and the server killed every terminal — the
  // "shell exited" that struck at random on reload. Updaters must stay pure.
  // Two flags, not one: `started` stops StrictMode's double-mount from listing twice,
  // while `reconciled` — the gate the claim effect below reads — flips only once the
  // reconcile has actually LANDED. Setting the single old flag up front meant the claim
  // effect fired on mount and pruned against the unvalidated restored set, ahead of the
  // reconcile's own prune; harmless only by accident of the server's spawn grace.
  const reconcileStarted = useRef(false)
  const reconciled = useRef(false)
  useEffect(() => {
    if (reconcileStarted.current) return
    reconcileStarted.current = true
    void api.pane.list().then(({ panes }) => {
      const live = new Set(panes.map((p) => p.id))
      const keep: string[] = []
      const next: Record<string, TermPane> = {}
      for (const [sid, st] of Object.entries(termsRef.current)) {
        const terms = st.terms.filter((t) => t.paneId == null || live.has(t.paneId))
        for (const t of terms) if (t.paneId) keep.push(t.paneId)
        const active = terms.some((t) => t.key === st.active) ? st.active : (terms[terms.length - 1]?.key ?? null)
        next[sid] = { open: terms.length > 0 ? st.open : false, terms, active }
      }
      setTermsBySession(next)
      void api.pane.prune(keep)
    }).catch(() => { /* server not up yet; nothing to reconcile */ })
      .finally(() => { reconciled.current = true })
  }, [])

  // Keep the claim current: every time this tab's terminal set changes, re-post the ids
  // it holds. Without this, a pane spawned after load is claimed by nobody and the next
  // tab to load would sweep it. Runs only after the initial reconcile, so it can't race
  // the restore with a half-built claim.
  useEffect(() => {
    if (!reconciled.current) return
    void api.pane.prune(claimKey ? claimKey.split(',') : [])
  }, [claimKey])

  // ONCE on load: reopen the notebooks that were open per session (by path → fresh id),
  // rebuilding each session's content tabs in their saved order. Reopening reconnects
  // the still-running kernel server-side. Mark each seen so the newly-opened effect
  // above doesn't ALSO attach it to whatever session is currently active.
  useEffect(() => {
    const c = INITIAL?.content
    if (!c) return
    let cancelled = false
    void (async () => {
      for (const [sid, pc] of Object.entries(c)) {
        const nbTabs = pc.tabs.filter((t) => t.kind === 'notebook')
        if (nbTabs.length === 0) continue
        const pathToId = new Map<string, string>()
        await Promise.all(nbTabs.map(async (t) => {
          const id = await notebooks.openPath(t.path, sid)
          if (id) { pathToId.set(t.path, id); seenNb.current.add(id) }
        }))
        if (cancelled) return
        setBySession((prev) => {
          const tabs: Content[] = []
          for (const t of pc.tabs) {
            if (t.kind === 'file') tabs.push({ kind: 'file', path: t.path })
            else { const id = pathToId.get(t.path); if (id) tabs.push({ kind: 'notebook', id }) }
          }
          let active: Content | null = null
          if (pc.active?.startsWith('f:')) active = { kind: 'file', path: pc.active.slice(2) }
          else if (pc.active?.startsWith('n:')) { const id = pathToId.get(pc.active.slice(2)); if (id) active = { kind: 'notebook', id } }
          return { ...prev, [sid]: { tabs, active } }
        })
      }
    })()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the layout on every change. Notebooks are recorded by PATH (skip a tab whose
  // doc hasn't loaded yet — it saves on the next round once the path is known; a session
  // with such a tab carries over its previous save so nothing is transiently lost).
  //
  // All this needs from the notebook store is notebookId → path, so that is what it keys
  // on. `notebooks.open` gets a fresh identity on every notebook:update — once per
  // appended output frame — and the body does a JSON.parse plus a JSON.stringify and a
  // synchronous localStorage.setItem, so a cell printing in a loop re-serialized the
  // entire layout dozens of times a second. That was the jank during long runs.
  const nbPathKey = notebooks.open.map((o) => `${o.notebookId}\u0000${o.path}`).join('\u0001')
  const nbPathById = useMemo(() => {
    const m = new Map<string, string>()
    for (const o of notebooks.open) m.set(o.notebookId, o.path)
    return m
  }, [nbPathKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const prev = loadPersisted()
    const content: Record<string, PersistContent> = {}
    for (const [sid, p] of Object.entries(bySession)) {
      const out: PersistContentTab[] = []
      let pending = false
      for (const t of p.tabs) {
        // Agent tabs are NOT persisted: they point into a live transcript, which a
        // reload may not have (a session only replays once its conversation resumes).
        if (t.kind === 'agent') continue
        if (t.kind === 'file') { out.push({ kind: 'file', path: t.path }); continue }
        const path = nbPathById.get(t.id)
        if (!path) { pending = true; break }
        out.push({ kind: 'notebook', path })
      }
      if (pending) { if (prev?.content[sid]) content[sid] = prev.content[sid]; continue }
      let active: string | null = null
      const a = p.active
      if (a?.kind === 'file') active = `f:${a.path}`
      else if (a?.kind === 'notebook') { const path = nbPathById.get(a.id); active = path ? `n:${path}` : null }
      if (out.length || active) content[sid] = { active, tabs: out }
    }
    savePersisted({
      v: 1, layout,
      sizes: { sideW, stackH, dockW, termH, sidebarW },
      seq: termSeq.current,
      terms: termsBySession,
      content,
    })
  }, [termsBySession, bySession, sideW, stackH, dockW, termH, sidebarW, layout, nbPathById])

  // Tab strip for the CURRENT session's pane, enriched with live doc metadata.
  const tabs: Tab[] = pane.tabs.map((t) => {
    if (t.kind === 'notebook') {
      const d = notebooks.open.find((o) => o.notebookId === t.id)
      return { key: `nb:${t.id}`, kind: 'notebook', id: t.id, label: d ? basename(d.path) : 'notebook', path: d?.path ?? '', dirty: d?.dirty ?? false }
    }
    if (t.kind === 'agent') return { key: `a:${t.id}`, kind: 'agent', id: t.id, label: t.label, path: t.label, dirty: false }
    return { key: `f:${t.path}`, kind: 'file', id: '', label: basename(t.path), path: t.path, dirty: false }
  })

  const contentNode = active?.kind === 'notebook'
    ? <NotebookView key={active.id} notebookId={active.id} sessionId={activeId ?? undefined} />
    : active?.kind === 'file'
      ? <FileEditorView key={active.path} path={active.path} sessionId={activeId ?? undefined} />
      : active?.kind === 'agent' && activeId
        ? <AgentDetail key={active.id} sessionId={activeId} agentId={active.id} />
        : null

  // `data-phone` is for the HARNESS ONLY, never for styling — and note it is an ATTRIBUTE:
  // this div's className stays byte-for-byte as it was, because index.css owns shell sizing
  // (`#root { height: var(--vvh) }`) and this is the shell wrapper it sizes.
  return (
    <div data-phone={isPhone ? 'true' : 'false'} className="flex h-full bg-ctp-base overflow-hidden">
      <Sidebar open={drawer} onClose={() => setDrawer(false)} width={sidebarW} notif={notif} autoOpenEdits={autoOpenEdits} onToggleAutoOpenEdits={toggleAutoOpenEdits} onOpenAgent={openAgent} />
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
          onSelectTab={(t) => selectTab(tabToContent(t))}
          onCloseTab={(t) => closeTab(tabToContent(t))}
          layout={layout}
          onSetLayout={setLayout}
          showLayout={active !== null}
          dock={dock}
          onToggleDock={toggleDock}
          termOpen={termOpen}
          onToggleTerm={toggleTerm}
          canTerm={activeId !== null}
          phonePane={shownPane}
        />

        <div className="flex-1 min-h-0 flex">
          {/* Main column: Claude (with the terminal dock under it) | content. At phone the
              right dock replaces this column outright rather than sharing the row with it. */}
          <div className={`flex-1 min-w-0 flex flex-col ${shownPane === 'dock' ? 'hidden' : ''}`}>
            {/* Upper region: Claude, plus content beside it when a tab is active. */}
            <div ref={splitRef} className={`flex-1 min-h-0 relative flex ${active && layout === 'side' ? 'flex-row' : 'flex-col'}`}>
              {active && (
                <div
                  data-testid="pane"
                  className={`flex-1 min-h-0 min-w-0 ${layout === 'side' ? 'order-3' : ''} ${shownPane && shownPane !== 'content' ? 'hidden' : ''}`}
                >
                  {contentNode}
                </div>
              )}

              {active && (
                <div
                  {...(layout === 'side'
                    ? dividerProps({ axis: 'x', get: () => sideW, set: setSideW, sign: 1, min: 300, max: () => (splitRef.current?.getBoundingClientRect().width ?? 1200) - 320 })
                    : dividerProps({ axis: 'y', get: () => stackH, set: setStackH, sign: -1, min: 160, max: () => (splitRef.current?.getBoundingClientRect().height ?? 800) - 200 }))}
                  title="Drag to resize"
                  className={`hidden md:block shrink-0 bg-ctp-surface0 hover:bg-ctp-accent/60 active:bg-ctp-accent transition-colors touch-none ${layout === 'side' ? 'w-1 cursor-col-resize order-2' : 'h-1 cursor-row-resize'}`}
                />
              )}

              {/* Claude — always present. Full width alone; fixed-size companion when a
                  tab is open. The terminal dock lives INSIDE this column (below), so it
                  tracks Claude's width rather than spanning the window. */}
              <div
                className={`flex flex-col ${
                  isPhone
                    // At phone this column is never the fixed-size companion: it is the whole
                    // pane area, holding the chat body and the terminal dock. It hides only for
                    // the two panes that live outside it.
                    ? `flex-1 min-h-0 min-w-0 ${shownPane === 'content' || shownPane === 'dock' ? 'hidden' : ''}`
                    : active ? `shrink-0 min-h-0 min-w-0 ${layout === 'side' ? 'border-r order-1' : 'border-t'} border-ctp-surface0` : 'flex-1 min-h-0 min-w-0'}`}
                // Gated off at phone: an inline height/width beats the Tailwind class above, so
                // leaving it would pin this column to a desktop companion size no class can undo.
                style={!isPhone && active
                  // In 'stack' the column is a fixed height, and it now carries the dock
                  // too — so add the dock's height on top, leaving the chat its full
                  // stackH (the content area absorbs the difference, as before).
                  // It must add the dock's BOUNDED height, not the raw `termH`: bounding one
                  // and not the other would make the column reserve space the dock no longer
                  // occupies, which is a gap below the terminal instead of a clipped one.
                  ? (layout === 'side' ? { width: sideW } : { height: dockShown ? `calc(${stackH}px + ${dockHeightCss} + 1px)` : stackH })
                  : undefined}
              >
                <div data-testid="pane" className={`flex-1 min-h-0 ${shownPane && shownPane !== 'chat' ? 'hidden' : ''}`}>
                  {activeId ? <ChatView key={activeId} sessionId={activeId} visible={!shownPane || shownPane === 'chat'} /> : <Empty />}
                </div>

                {/* Bottom dock: tabbed terminals for the ACTIVE session, sized to the
                    Claude column — with a notebook open, a terminal shouldn't run the
                    full width of the window. Every session's terminals stay mounted (see
                    the bodies below) so ptys + scrollback survive session switches; the
                    tab strip and sizing only apply to the active session's dock. */}
                {dockShown && (
                  <div
                    {...dividerProps({ axis: 'y', get: () => termH, set: setTermH, sign: -1, min: 120, max: () => 700 })}
                    title="Drag to resize"
                    className="hidden md:block shrink-0 h-1 cursor-row-resize bg-ctp-surface0 hover:bg-ctp-accent/60 active:bg-ctp-accent transition-colors touch-none"
                  />
                )}
                {allTerms.length > 0 && (
                  <div
                    data-testid="pane"
                    className={!dockVisible ? 'hidden'
                      // At phone the dock IS the pane, so it fills the column. Dropping
                      // boundedDockH here is safe only because #root is sized to var(--vvh) —
                      // flex-1 inherits the visible viewport rather than the layout one.
                      : isPhone ? 'flex-1 min-h-0 flex flex-col min-w-0'
                      : 'shrink-0 flex flex-col min-w-0 border-t border-ctp-surface0'}
                    style={dockVisible && !isPhone ? { height: dockHeightCss } : undefined}
                  >
                    {/* Tab strip: one tab per terminal in the ACTIVE session (× to close), + to add, hide on the right. */}
                    <div className="h-7 shrink-0 flex items-stretch gap-1 px-2 bg-ctp-mantle border-b border-ctp-surface0 overflow-x-auto">
                      {terms.map((t, i) => (
                        <div
                          key={t.key}
                          onClick={() => selectTerm(t.key)}
                          title={t.cwd}
                          className={`group flex items-center gap-1.5 pl-2 pr-1 shrink-0 cursor-pointer text-[11px] border-b-2 ${activeTerm === t.key ? 'border-ctp-accent text-ctp-text' : 'border-transparent text-ctp-subtext hover:text-ctp-text'}`}
                        >
                          <span className="text-ctp-overlay">❯</span>
                          <span>Terminal {i + 1}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); closeTerm(t.key) }}
                            title="Close terminal"
                            className="opacity-0 group-hover:opacity-100 text-ctp-overlay hover:text-ctp-red p-0.5 rounded leading-none"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
                          </button>
                        </div>
                      ))}
                      <button onClick={() => addTerm(termCwd)} title="New terminal" className="shrink-0 self-center text-ctp-overlay hover:text-ctp-text px-1.5 text-sm leading-none">+</button>
                      <span className="ml-auto self-center text-[10px] text-ctp-overlay font-mono truncate max-w-[45%]">{prettyPath(terms.find((t) => t.key === activeTerm)?.cwd ?? termCwd)}</span>
                      <button onClick={hideTerm} title="Hide terminal" className="shrink-0 self-center text-ctp-overlay hover:text-ctp-text p-0.5">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
                      </button>
                    </div>
                    {/* Bodies: EVERY session's terminals stay mounted here (this container
                        persists across session switches, so ptys + scrollback survive);
                        only the active session's active terminal is shown. */}
                    <div className="flex-1 min-h-0 relative">
                      {allTerms.map((t) => {
                        // `dockVisible`, not `dockShown`: at phone the dock can be mounted but
                        // hidden behind another pane, and a TerminalView told it is visible
                        // while inside display:none fits xterm to a zero box.
                        const show = t.sid === activeId && dockVisible && activeTerm === t.key
                        return (
                          <div key={t.key} className={show ? 'absolute inset-0' : 'hidden'}>
                            <TerminalView
                              cwd={t.cwd}
                              visible={show}
                              sessionId={t.sid}
                              paneId={t.paneId ?? undefined}
                              onCreated={(pid) => setTermPaneId(t.sid, t.key, pid)}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right dock: Files or Git (narrow, resizable, full height). */}
          {dock && (
            <div
              {...dividerProps({ axis: 'x', get: () => dockW, set: setDockW, sign: -1, min: 240, max: () => 640 })}
              title="Drag to resize"
              className="hidden md:block shrink-0 w-1 cursor-col-resize bg-ctp-surface0 hover:bg-ctp-accent/60 active:bg-ctp-accent transition-colors touch-none"
            />
          )}
          {dock && (
            <div
              data-testid="pane"
              className={`min-h-0 ${isPhone
                ? `flex-1 min-w-0 border-l-0 ${shownPane === 'dock' ? '' : 'hidden'}`
                : 'shrink-0 border-l border-ctp-surface0'}`}
              style={isPhone ? undefined : { width: dockW }}
            >
              {dock === 'files' ? (
                <div className="flex flex-col h-full bg-ctp-base overflow-hidden">
                  {/* Files ⇄ Kernels sub-tabs. */}
                  <div className="shrink-0 flex bg-ctp-mantle border-b border-ctp-surface0 text-xs">
                    {(['files', 'kernels'] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setFilesTab(m)}
                        className={`flex-1 py-1.5 capitalize transition-colors ${filesTab === m ? 'text-ctp-text border-b-2 border-ctp-mauve' : 'text-ctp-overlay hover:text-ctp-subtext border-b-2 border-transparent'}`}
                      >{m}</button>
                    ))}
                  </div>
                  <div className="flex-1 min-h-0">
                    {filesTab === 'files' ? (
                      <FileManager
                        key={termCwd}
                        initialPath={termCwd}
                        onOpenNotebook={(p) => void notebooks.openPath(p, activeId ?? undefined).then((id) => {
                          // Focus the notebook's tab — including when it was already open,
                          // where the newly-seen effect above wouldn't fire.
                          if (id) focusNotebook(id)
                        })}
                        onOpenFile={openFile}
                        onNewNotebook={async (p) => {
                          // Focus explicitly, exactly as onOpenNotebook does above. Do NOT rely on
                          // the newly-seen effect: it marks an id seen before it checks whether it
                          // can attach, so a create while `activeId` is still null consumes the id
                          // and the retry its dep array provides is dead. FileManager's contract is
                          // unchanged — error string, or null on success.
                          const r = await notebooks.createPath(p, activeId ?? undefined)
                          if (r.error) return r.error
                          if (r.id) focusNotebook(r.id)
                          return null
                        }}
                        onClose={() => setDock(null)}
                      />
                    ) : (
                      <KernelsPanel onFocus={focusNotebook} onClose={() => setDock(null)} />
                    )}
                  </div>
                </div>
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
  useEscape(() => onChoose('cancel'))
  const btn = 'text-xs px-3 py-1.5 rounded-md transition'
  return (
    <Overlay onClose={() => onChoose('cancel')}>
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
    </Overlay>
  )
}

type Tab = { key: string; kind: 'notebook' | 'file' | 'agent'; id: string; label: string; path: string; dirty: boolean }

// A strip tab back to the pane entry it stands for.
function tabToContent(t: Tab): Content {
  if (t.kind === 'notebook') return { kind: 'notebook', id: t.id }
  if (t.kind === 'agent') return { kind: 'agent', id: t.id, label: t.label }
  return { kind: 'file', path: t.path }
}

// Tab strip: Chat + one tab per open content item, then the dock toggles (Files /
// Git / Terminal) and the companion-orientation control.
function MainTabs({ tabs, active, onSelectChat, onSelectTab, onCloseTab, layout, onSetLayout, showLayout, dock, onToggleDock, termOpen, onToggleTerm, canTerm, phonePane }: {
  tabs: Tab[]
  active: Content | null
  onSelectChat: () => void
  onSelectTab: (t: Tab) => void
  onCloseTab: (t: Tab) => void
  layout: 'side' | 'stack'; onSetLayout: (l: 'side' | 'stack') => void; showLayout: boolean
  dock: 'files' | 'git' | 'permissions' | 'sandbox' | null; onToggleDock: (w: 'files' | 'git' | 'permissions' | 'sandbox') => void
  termOpen: boolean; onToggleTerm: () => void
  // The dock toggles above are GLOBAL state and work with no session. The terminal is
  // PER-SESSION: toggleTerm opens `if (!activeId) return`. Without this the button renders
  // enabled and normally-styled and silently does nothing — reachable on a fresh install or
  // after closing the last session. Disable it rather than letting it lie about being live.
  canTerm: boolean
  // The RESOLVED phone pane, or null on desktop. The strip must highlight from THIS, not from
  // `active`: a machine-opened tab (notebook-opened, file-opened, proposed-edit auto-open) sets
  // `active` without taking the screen, so at phone the two legitimately disagree. Highlighting
  // from `active` would show a tab as current while the chat is what you are looking at.
  phonePane: PhonePane | null
}) {
  const tab = (on: boolean) =>
    `px-3 h-8 flex items-center gap-1.5 text-xs border-b-2 -mb-px whitespace-nowrap transition-colors ${
      on ? 'border-ctp-accent text-ctp-text' : 'border-transparent text-ctp-overlay hover:text-ctp-subtext'}`
  const isOn = (t: Tab) => {
    // At phone a content tab is only "on" when the content pane is actually the one showing.
    if (phonePane && phonePane !== 'content') return false
    if (!active) return false
    if (t.kind === 'notebook') return active.kind === 'notebook' && active.id === t.id
    if (t.kind === 'agent') return active.kind === 'agent' && active.id === t.id
    return active.kind === 'file' && active.path === t.path
  }
  const toggle = (on: boolean) =>
    `px-2.5 h-6 rounded text-[11px] transition-colors ${on ? 'bg-ctp-surface1 text-ctp-text' : 'text-ctp-overlay hover:text-ctp-subtext hover:bg-ctp-surface0'}`

  return (
    <div className="shrink-0 h-8 flex items-stretch gap-0 px-2 bg-ctp-mantle border-b border-ctp-surface0">
      {/* Tabs scroll in their OWN region so growing/overflowing tabs never push the
          toolbar. */}
      <div className="flex items-stretch min-w-0 flex-1 overflow-x-auto">
        <button className={tab(phonePane ? phonePane === 'chat' : active === null)} onClick={onSelectChat}>Chat</button>
        {/* Where Claude sits relative to open content — a SINGLE toggle that lives
            next to the Chat tab (so it reads as "Claude's position"), flipping
            beside ⇄ under. Only meaningful once a content tab is open. */}
        {showLayout && (
          <button
            onClick={() => onSetLayout(layout === 'side' ? 'stack' : 'side')}
            title={layout === 'side' ? 'Claude is beside — click to put it under' : 'Claude is under — click to put it beside'}
            aria-label="Toggle where Claude sits"
            className="hidden md:flex self-center shrink-0 mx-1 w-6 h-6 items-center justify-center rounded text-ctp-overlay hover:text-ctp-subtext hover:bg-ctp-surface0 transition-colors"
          >
            {layout === 'side'
              ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1.5" y="2.5" width="4.5" height="9" rx="1" /><rect x="8" y="2.5" width="4.5" height="9" rx="1" /></svg>
              : <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2.5" y="1.5" width="9" height="4.5" rx="1" /><rect x="2.5" y="8" width="9" height="4.5" rx="1" /></svg>}
          </button>
        )}
        {tabs.map((t) => (
          <span key={t.key} className={tab(isOn(t))}>
            <span className={`shrink-0 ${t.kind === 'agent' ? 'text-ctp-mauve' : ''}`}>{t.kind === 'notebook' ? '📓' : t.kind === 'agent' ? '◈' : '📄'}</span>
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
        <button className={toggle(dock === 'sandbox')} onClick={() => onToggleDock('sandbox')} title="Sandbox — what this session can reach: filesystem mounts, GPU devices, and connectors">Sandbox</button>
        <button
          className={`${toggle(termOpen)} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ctp-overlay`}
          onClick={onToggleTerm}
          disabled={!canTerm}
          title={canTerm ? 'Terminal' : 'Terminal — needs a session; create or select one first'}
        >Terminal</button>
      </div>
    </div>
  )
}

// Completion-sound toggle (on by default; no permission needed). A background
// session finishing / needing input chimes unless muted here.
// Toggle: auto-open a file's editor to show Claude's proposed edit when the file is
// CLOSED. Off → a closed file's edit stays in the chat permission card (no popup);
// an already-open file always shows its inline diff regardless.
function EditPopupToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      title={on
        ? 'Auto-open the editor to review Claude\'s edits — click to stop popping tabs for closed files'
        : 'Not auto-opening editors for edits — closed files stay in the chat prompt; click to auto-open'}
      aria-label={on ? 'Disable auto-open editor for edits' : 'Enable auto-open editor for edits'}
      aria-pressed={on}
      className={`w-6 h-6 flex items-center justify-center rounded transition-colors hover:bg-ctp-surface0 ${on ? 'text-ctp-accent' : 'text-ctp-overlay hover:text-ctp-subtext'}`}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {/* pencil (edit) */}
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        {!on && <path d="M2 2l20 20" />}
      </svg>
    </button>
  )
}

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

function Sidebar({ open, onClose, width, notif, autoOpenEdits, onToggleAutoOpenEdits, onOpenAgent }: { open: boolean; onClose: () => void; width: number; notif: NotificationsApi; autoOpenEdits: boolean; onToggleAutoOpenEdits: () => void; onOpenAgent: (sid: string, id: string, label: string) => void }) {
  const { sessions, activeId, setActive, destroy, connected, attention, homeDir } = useSessions()
  const [showNew, setShowNew] = useState(false)
  const [confirmClose, setConfirmClose] = useState<SessionInfo | null>(null)
  // The global Claudette deck (app-wide config; currently connectors). State lives here
  // rather than in App because nothing outside the sidebar opens it — the brand IS the
  // affordance. `cwd` only scopes the strict-mode pre-flight's config scan, so the active
  // session's dir is the useful default and homeDir the fallback.
  const [deckOpen, setDeckOpen] = useState(false)
  const deckCwd = sessions.find((s) => s.id === activeId)?.cwd || homeDir
  const pick = (id: string) => { setActive(id); onClose() }
  // A subsession belongs UNDER its parent, not at the bottom of the list: order the
  // flat server list into parent → its children (recursively), keeping each level in
  // creation order. An orphan (parent already closed) stays a top-level row.
  const ordered = useMemo(() => orderSessions(sessions), [sessions])

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
          {/* The brand opens the app-wide deck. Deliberately NOT a fifth right-dock tab:
              every dock panel edits the ACTIVE SESSION, and this edits the install. */}
          <button
            onClick={() => setDeckOpen(true)}
            title="Claudette settings — connectors and other app-wide config"
            className="group flex items-center gap-2.5 -mx-1 px-1 py-0.5 rounded hover:bg-ctp-surface0 transition-colors"
          >
            <Mark className="w-5 h-5 text-ctp-accent" />
            <span className="text-sm font-semibold tracking-tight text-ctp-text">Claudette</span>
            <span className="text-ctp-overlay group-hover:text-ctp-text text-[10px] leading-none transition-colors">⚙</span>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <EditPopupToggle on={autoOpenEdits} onToggle={onToggleAutoOpenEdits} />
            <SoundToggle notif={notif} />
            <NotifyBell notif={notif} />
            <span className={`ml-1 inline-flex items-center gap-1.5 text-[10px] ${connected ? 'text-ctp-green' : 'text-ctp-red'}`} title={connected ? 'Connected to server' : 'Disconnected'}>
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-ctp-green' : 'bg-ctp-red'}`} />
              {connected ? 'online' : 'offline'}
            </span>
          </div>
          <button onClick={onClose} className="md:hidden ml-1 text-ctp-overlay hover:text-ctp-text text-sm" aria-label="Close">✕</button>
        </div>

        <div className="px-3 pt-3 pb-1 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 min-w-0">
            <span className="text-[10px] font-medium uppercase tracking-wider text-ctp-overlay">Sessions</span>
            {/* Account-global session/weekly quota — shown once here in the mutual column. */}
            <SidebarUsage />
          </div>
          <button onClick={() => setShowNew(true)} title="New session" className="text-ctp-overlay hover:text-ctp-accent text-base leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-ctp-surface0 transition-colors">+</button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {sessions.length === 0 && <div className="px-2 py-2 text-xs text-ctp-overlay">No sessions yet.</div>}
          {ordered.map(({ session: s, depth }) => (
            <SessionRow
              // `finished` ONLY, deliberately. SessionRow renders the literal "done" and a dot
              // titled "Finished — needs your attention", both of which are FALSE for a
              // session that is merely blocked on a permission prompt. The store now carries
              // the reason; until the rendering slice lands, this narrows it back to a
              // boolean so the sidebar stays exactly as it is today. THIS is the line the
              // next slice changes.
              key={s.id} session={s} depth={depth} active={s.id === activeId} attention={attention.get(s.id) === 'finished'}
              onSelect={() => pick(s.id)} onClose={() => setConfirmClose(s)}
              onOpenAgent={(id, label) => { onOpenAgent(s.id, id, label); onClose() }}
            />
          ))}
        </div>

        <div className="border-t border-ctp-surface0 p-3 shrink-0">
          <button onClick={() => setShowNew(true)} className="w-full flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-2.5 rounded-md bg-ctp-accent text-ctp-base hover:brightness-110 active:brightness-95 transition">
            <span className="text-base leading-none">+</span> New session
          </button>
        </div>

        {showNew && <NewSessionDialog onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); onClose() }} />}
        {deckOpen && <ClaudetteDeck cwd={deckCwd} onClose={() => setDeckOpen(false)} />}
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
  const [pendingTrust, setPendingTrust] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => { nameRef.current?.focus() }, [])
  useEscape(onClose)

  // The actual session creation, once the cwd is known-trusted. Assumes busy is set.
  const doCreate = async (dir: string) => {
    try {
      await create(name.trim() || basename(dir) || 'session', dir, { model: model.trim() || undefined, agentId, sandbox: sbToConfig(sb, dir) })
      ;(onCreated ?? onClose)()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to create session.')
      setBusy(false)
      setPendingTrust(false)
    }
  }

  const submit = async () => {
    if (busy) return
    const dir = cwd.trim()
    if (!dir) { setErr('Working directory is required.'); return }
    setBusy(true); setErr(null)
    // Mirror Claude's native trust gate: an untrusted folder has its .claude/settings.local
    // permissions ignored. Ask before creating; fail-open if the check itself errors so a
    // transient failure never blocks session creation.
    let trusted = true
    try { trusted = await api.http.checkTrust(dir) } catch { /* fail-open */ }
    if (!trusted) { setPendingTrust(true); return }   // busy stays set; the trust modal drives the next step
    await doCreate(dir)
  }

  const confirmTrust = async () => {
    setPendingTrust(false)
    const dir = cwd.trim()
    try { await api.http.trustFolder(dir) } catch { /* proceed anyway; worst case the warning persists */ }
    await doCreate(dir)
  }
  const cancelTrust = () => { setPendingTrust(false); setBusy(false) }
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }

  return (
    <Overlay onClose={onClose}>
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
        <FileBrowser initialPath={cwd.trim() || homeDir} onPick={(path) => { setCwd(path); setBrowsing(false) }} onClose={() => setBrowsing(false)} />
      )}
      {pendingTrust && (
        <ConfirmDialog
          title="Trust this folder?"
          body={
            <>
              You haven’t trusted <span className="font-mono text-ctp-text">{prettyPath(cwd.trim())}</span> yet.
              Trusting it lets <span className="font-mono">.claude/settings.local.json</span> in this folder grant
              tool permissions to <b>every session that runs here — now and in future</b>, including teammates a
              session hires. That file is <b>writable by sessions themselves</b>, so this approves not just the
              permissions in it today but any a session adds later. Sandbox mounts still bound what a session can
              reach; this only affects whether it is prompted. Only trust folders whose contents <em>and
              sessions</em> you recognise.
            </>
          }
          confirmLabel="Trust folder"
          cancelLabel="Cancel"
          onConfirm={confirmTrust}
          onCancel={cancelTrust}
        />
      )}
    </Overlay>
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
// `flags` carries the non-mount switches (sandboxTerminals, gpu) through UNTOUCHED. These
// dialogs deliberately don't edit them — they're per-session settings the sandbox control
// owns — but a subsession seeds its state from the PARENT's config, so without this the
// round-trip would silently strip them and hand the child a weaker/GPU-less box than the
// parent it was spawned from.
type SbFlags = Pick<SandboxConfig, 'sandboxTerminals' | 'gpu'>
type SbState = { enabled: boolean; projectMode: 'rw' | 'ro' | 'none'; extra: SandboxMount[]; flags: SbFlags }
const defaultSb = (): SbState => ({ enabled: true, projectMode: 'rw', extra: [], flags: {} })
// Seed the fields from an existing config relative to a cwd (subsession → parent's).
function sbFromConfig(cfg: SandboxConfig | undefined, cwd: string): SbState {
  if (!cfg) return defaultSb()
  const cwdMount = cfg.mounts.find((m) => m.path === cwd)
  return {
    enabled: cfg.enabled,
    projectMode: cwdMount?.mode ?? 'none',
    extra: cfg.mounts.filter((m) => m.path !== cwd),
    flags: { sandboxTerminals: cfg.sandboxTerminals, gpu: cfg.gpu },
  }
}
// Build the SandboxConfig to submit (cwd folded back in per projectMode).
function sbToConfig(sb: SbState, cwd: string): SandboxConfig {
  const mounts: SandboxMount[] = [
    ...(sb.projectMode !== 'none' ? [{ path: cwd, mode: sb.projectMode } as SandboxMount] : []),
    ...sb.extra,
  ]
  return { enabled: sb.enabled, mounts, ...sb.flags }
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
          initialPath={cwd}
          onClose={() => setPicking(false)}
          onPick={(p) => { setPicking(false); if (p !== cwd && !value.extra.some((m) => m.path === p)) set({ extra: [...value.extra, { path: p, mode: 'ro' }] }) }}
        />
      )}
    </div>
  )
}

// Flatten the server's session list into display order: every subsession sits
// directly under its parent (nested to any depth), each level keeping the order the
// server sent. A session whose parent isn't in the list (closed, or not yet loaded)
// is treated as top-level so it can never vanish from the sidebar.
function orderSessions(sessions: SessionInfo[]): { session: SessionInfo; depth: number }[] {
  const byParent = new Map<string, SessionInfo[]>()
  const ids = new Set(sessions.map((s) => s.id))
  const roots: SessionInfo[] = []
  for (const s of sessions) {
    const pid = s.parentId && ids.has(s.parentId) && s.parentId !== s.id ? s.parentId : null
    if (!pid) { roots.push(s); continue }
    const kids = byParent.get(pid) ?? []; kids.push(s); byParent.set(pid, kids)
  }
  const out: { session: SessionInfo; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (s: SessionInfo, depth: number) => {
    if (seen.has(s.id)) return   // guards a parentId cycle from recursing forever
    seen.add(s.id)
    out.push({ session: s, depth })
    for (const k of byParent.get(s.id) ?? []) walk(k, depth + 1)
  }
  for (const r of roots) walk(r, 0)
  for (const s of sessions) if (!seen.has(s.id)) out.push({ session: s, depth: 0 })   // cycle leftovers
  return out
}

function SessionRow({ session, depth, active, attention, onSelect, onClose, onOpenAgent }: { session: SessionInfo; depth: number; active: boolean; attention: boolean; onSelect: () => void; onClose: () => void; onOpenAgent: (id: string, label: string) => void }) {
  const { sessions, agents, setAgent, rename } = useSessions()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [subOpen, setSubOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState(session.name)
  const [info, setInfo] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  // Guards the Enter→blur double-fire and a cancel-on-Escape from saving twice/at all.
  const renameDone = useRef(false)

  // This session's subagents, nested under its name. Collapsed by default — the ◈
  // badge is the toggle. Cleared cards are filtered out (see store/agentDismiss), so
  // the badge only appears while there's something left to look at.
  const { transcriptFor, tasksFor, stopTask } = useChat()
  const items = transcriptFor(session.id)
  const tasks = tasksFor(session.id)
  const dismissed = useDismissedAgents(session.id)
  const myAgents = useMemo(() => {
    const cleared = new Set(dismissed)
    return collectAgents(items, tasks).filter((a) => !cleared.has(agentKey(a)))
  }, [items, tasks, dismissed])
  const turnActive = session.state === 'running' || session.state === 'waiting'
  const liveAgents = myAgents.filter((a) => isAgentLive(a, turnActive)).length
  const finishedAgents = myAgents.length - liveAgents

  // Nested-looking iff it is actually nested IN THIS LIST. Deriving this from
  // `session.parentId` instead disagreed with `depth` for an orphan — close a parent while
  // its subsession lives on and orderSessions treats the child as a root (depth 0), so the
  // row got neither the root's pl-2.5 (suppressed by parentId) nor an indent (suppressed
  // by depth), and the ↳ landed at left:8 on top of the state dot. One source of truth.
  const isSub = depth > 0
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

  // Nesting indent: subsessions sit under their parent, one step per level (the ↳ mark
  // is drawn at the row's own left edge, so the indent moves with it).
  const indent = depth > 0 ? { paddingLeft: 20 + (depth - 1) * 12 } : undefined

  return (
    <div>
      <div onClick={onSelect} style={indent} className={`group relative rounded-md pr-1 py-2 cursor-pointer flex items-center gap-2.5 transition-colors ${isSub ? '' : 'pl-2.5'} ${active ? 'bg-ctp-surface0' : 'hover:bg-ctp-surface0/50'}`}>
        {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-ctp-accent" />}
        {isSub && <span style={{ left: (indent?.paddingLeft ?? 20) - 12 }} className="absolute text-ctp-overlay text-[11px] leading-none" title="Subsession">↳</span>}
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
              {/* The agents bullet: count of this session's subagents, and the toggle for
                  the list below. Only here while at least one card is uncleared. */}
              {myAgents.length > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); setAgentsOpen((v) => !v) }}
                  title={`${myAgents.length} subagent${myAgents.length > 1 ? 's' : ''}${liveAgents > 0 ? ` · ${liveAgents} running` : ''} — click to ${agentsOpen ? 'collapse' : 'expand'}`}
                  aria-expanded={agentsOpen}
                  className={`shrink-0 flex items-center gap-1 text-[9px] rounded px-1 py-0.5 transition-colors ${agentsOpen ? 'bg-ctp-mauve/15 text-ctp-mauve' : 'text-ctp-mauve hover:bg-ctp-mauve/10'}`}
                >
                  {liveAgents > 0 && <span className="w-1.5 h-1.5 rounded-full bg-ctp-mauve animate-pulse" />}
                  ◈{myAgents.length}
                </button>
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

      {/* Expanded: this session's subagents, one line each. Click opens the agent's full
          thought process as a content tab; × clears a finished card from the list. */}
      {agentsOpen && myAgents.length > 0 && (
        <div style={{ marginLeft: (indent?.paddingLeft ?? 10) + 8 }} className="mt-0.5 mb-1 pl-2 border-l border-ctp-surface1 space-y-px animate-fade-in">
          {myAgents.map((a) => (
            <AgentLine
              key={agentKey(a)} agent={a} turnActive={turnActive}
              onOpen={() => onOpenAgent(agentKey(a), agentTabLabel(a))}
              onClear={() => dismissAgents(session.id, [agentKey(a)])}
              onStop={() => { if (a.toolId) stopTask(session.id, a.toolId) }}
            />
          ))}
          {finishedAgents > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); dismissAgents(session.id, myAgents.filter((a) => !isAgentLive(a, turnActive)).map(agentKey)) }}
              className="mt-0.5 text-[10px] text-ctp-overlay hover:text-ctp-text transition-colors"
              title="Clear every finished agent from this list"
            >
              Clear finished
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// One subagent in the sidebar list: status dot, its type, what it was asked to do, and —
// depending on whether it's running — a ■ to stop it or a × to clear it. Only a FINISHED
// agent can be cleared (clearing a running one would hide it while it kept working, with
// no way back), and only a RUNNING one can be stopped.
function AgentLine({ agent, turnActive, onOpen, onClear, onStop }: { agent: AgentView; turnActive: boolean; onOpen: () => void; onClear: () => void; onStop: () => void }) {
  const active = isAgentLive(agent, turnActive)
  // Stoppable only with a task id from the CLI. A conversation resumed from disk replays
  // the Task tool_use but never its task_started, so those cards can't be stopped —
  // hide the button rather than offer one that always fails.
  const stoppable = active && !!agent.taskId
  return (
    <div className="group/agent flex items-center gap-1.5 rounded pr-0.5 hover:bg-ctp-surface0/60">
      <button onClick={(e) => { e.stopPropagation(); onOpen() }} className="min-w-0 flex-1 flex items-center gap-1.5 py-0.5 text-left" title={`${agent.type}: ${agent.description} — open its thought process`}>
        <AgentStatusDot agent={agent} turnActive={turnActive} />
        <span className="shrink-0 text-[9px] font-mono text-ctp-mauve/90">{agent.type}</span>
        <span className="min-w-0 truncate text-[11px] text-ctp-subtext">{agent.description}</span>
      </button>
      {stoppable && (
        <button
          onClick={(e) => { e.stopPropagation(); onStop() }}
          title="Stop this agent (the turn keeps running)"
          aria-label={`Stop agent: ${agent.description}`}
          className="shrink-0 opacity-100 md:opacity-0 md:group-hover/agent:opacity-100 text-ctp-overlay hover:text-ctp-red text-[9px] leading-none px-0.5 transition-opacity"
        >
          ■
        </button>
      )}
      {!active && (
        <button
          onClick={(e) => { e.stopPropagation(); onClear() }}
          title="Clear"
          className="shrink-0 opacity-100 md:opacity-0 md:group-hover/agent:opacity-100 text-ctp-overlay hover:text-ctp-red text-[11px] leading-none px-0.5 transition-opacity"
        >
          ×
        </button>
      )}
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

  useEscape(onClose)

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

  return (
    <Overlay z={70} onClose={onClose}>
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
    </Overlay>
  )
}

// Per-session actions menu (portal to body so the sidebar's scroll never clips it).
// Two views: the main actions, and a "change role" submenu listing the agents.
function SessionMenu({ x, y, session, agents, onClose, onSubsession, onInfo, onRename, onPickRole }: {
  x: number; y: number; session: SessionInfo; agents: AgentInfo[]
  onClose: () => void; onSubsession: () => void; onInfo: () => void; onRename: () => void; onPickRole: (id: string) => void
}) {
  const [view, setView] = useState<'main' | 'roles'>('main')
  useDismissOnOutside(true, onClose)
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

// Detail panel for a session (modal). Surfaces the fields that aren't otherwise
// visible — role, model, dirs, parent, permission mode, sandbox, id — plus the one
// setting that has no other home: whether this session may hire its own teammates.
function SessionInfoDialog({ session, roleName, parentName, onClose }: {
  session: SessionInfo; roleName: string; parentName: string | null; onClose: () => void
}) {
  const { sessions, setTeamEmploy } = useSessions()
  useEscape(onClose)
  const sandbox = session.sandbox?.enabled
    ? (session.sandboxed ? 'on' : 'requested — host can’t confine')
    : 'off'
  const members = sessions.filter((s) => s.parentId === session.id)
  // Only a top-level session leads a team: teammates are leaves, and the server refuses
  // to let one hire, so offering the toggle there would promise something it can't do.
  const canLead = !session.parentId
  const employ = !!session.teamEmploy
  const rows: [string, React.ReactNode][] = [
    ['Role', roleName],
    ['Model', session.model || 'account default'],
    ['State', session.state],
    ['Permission', session.permissionMode ?? 'default'],
    ...(parentName ? [['Parent', parentName] as [string, React.ReactNode]] : []),
    ['Working dir', <span className="font-mono break-all">{session.cwd}</span>],
    ['Root dir', <span className="font-mono break-all">{session.rootDir}</span>],
    ['Sandbox', sandbox],
    ...(canLead ? [['Team', (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { void setTeamEmploy(session.id, !employ) }}
            className={`px-2 py-0.5 rounded text-[10px] font-medium ${employ ? 'bg-ctp-green/20 text-ctp-green' : 'bg-ctp-surface0 text-ctp-overlay'}`}
          >
            {employ ? 'Employ team allowed' : 'Employ team off'}
          </button>
          <span className="text-ctp-overlay text-[11px]">
            {members.length ? `${members.length} teammate${members.length === 1 ? '' : 's'}` : 'no teammates'}
          </span>
        </div>
        <div className="text-ctp-overlay text-[11px] leading-snug">
          {employ
            ? 'This session can start and dismiss its own teammates — each is a real session that costs tokens. It can already message the teammates it has either way.'
            : 'Messaging between existing sessions always works. Turn this on only to let Claude create and dismiss teammates by itself.'}
        </div>
      </div>
    )] as [string, React.ReactNode]] : []),
    ['Session id', <span className="font-mono break-all text-ctp-overlay">{session.id}</span>],
  ]
  return (
    <Overlay z={70} onClose={onClose}>
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
    </Overlay>
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
