import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationMeta, PermissionMode, RewindPoint, RewindMode, SessionInfo } from '@claudette/shared'
import { useChat, isSubagentTool, type TranscriptItem, type SessionMeta, type RateLimitInfo } from '../store/chat'
import { useSessions } from '../store/sessions'
import { ToolDetail, toolHeadline, toolArg, truncate } from '../lib/toolFormat'
import { prettyPath } from '../lib/paths'
import { Markdown } from './Markdown'
import { ResumePicker } from './ResumePicker'
import { RewindPicker } from './RewindPicker'
import { SandboxControl } from './SandboxControl'
import { BypassConfirmDialog } from './BypassConfirmDialog'
import { useMentionComplete } from '../hooks/useMentionComplete'
import { loadDraft, saveDraft } from '../lib/drafts'
import { api } from '../api/client'
import type { UsageWindow } from '@claudette/shared'

// Sessions already auto-resumed this app load — so revisiting a session (or a
// /clear that empties the transcript) doesn't re-pull the old conversation.
// Resets on a full page reload (module re-eval), which is exactly when we DO want
// to resume again. Module-level so it survives ChatView remounts.
const autoResumed = new Set<string>()
// Sessions whose conversation was explicitly reset (/clear) or re-pointed (/resume,
// /rewind) — an in-flight auto-resume for one of these must abort rather than reload
// the old conversation over the user's action.
const resumeAborted = new Set<string>()

// Shell-like composer history (Up/Down recall the messages you've sent), persisted
// per session in localStorage so it survives a page reload AND a /clear — unlike the
// transcript, which is wiped by /clear and only present once a conversation resumes.
// Capped so a long-lived session can't grow the key without bound.
const HIST_CAP = 200
const histKey = (id: string) => `claudette:msghist:${id}`
function loadHist(id: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(histKey(id)) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}
function saveHist(id: string, h: string[]): void {
  try { localStorage.setItem(histKey(id), JSON.stringify(h)) } catch { /* quota / disabled storage — recall just won't persist */ }
}

// Where you are in that history right now, plus the text you'd left in the box at each
// level (level 0 = your own unsent draft, level k = the k-th message back). Recall
// carries the box's text with you instead of overwriting it, so stepping away from
// something you were writing never destroys it — Down brings it back verbatim. Kept in
// localStorage next to the draft, because ChatView remounts on every session switch and
// in-memory state would strand the recalled message on top of your draft.
interface Nav { ptr: number; edits: Record<string, string> }
const navKey = (id: string) => `claudette:msgnav:${id}`
function loadNav(id: string): Nav {
  try {
    const v = JSON.parse(localStorage.getItem(navKey(id)) ?? 'null')
    if (!v || typeof v.ptr !== 'number' || v.ptr < 0) return { ptr: 0, edits: {} }
    const edits: Record<string, string> = {}
    for (const [k, t] of Object.entries(v.edits ?? {})) if (typeof t === 'string') edits[k] = t
    return { ptr: v.ptr, edits }
  } catch { return { ptr: 0, edits: {} } }
}
function saveNav(id: string, nav: Nav): void {
  try {
    if (nav.ptr === 0 && !Object.keys(nav.edits).length) localStorage.removeItem(navKey(id))
    else localStorage.setItem(navKey(id), JSON.stringify(nav))
  } catch { /* quota / disabled storage — recall just won't survive a reload */ }
}

// Native chat frontend for a Claude session — ported from ClaudeMaster. Renders
// the structured transcript, streams tokens, and surfaces permission /
// AskUserQuestion prompts as native cards. Handles /clear + /resume natively
// (P1.14); other slash commands pass through as a turn. Permission-mode switch
// lives in the MetaBar (P1.4).
export function ChatView({ sessionId, visible = true }: {
  sessionId: string
  // False while this pane is hidden behind another at phone width. Defaults true so every
  // existing call site (and desktop, which never hides the chat) is unaffected.
  visible?: boolean
}) {
  const { transcriptFor, pendingFor, slashCommandsFor, metaFor, sendTurn, interrupt, respond, loadTranscript, clearTranscript } = useChat()
  const { sessions, setMode, isFresh, markBusy } = useSessions()
  const session = sessions.find((s) => s.id === sessionId)
  const [showResume, setShowResume] = useState(false)
  const [showRewind, setShowRewind] = useState(false)
  const state = session?.state ?? 'idle'
  const items = transcriptFor(sessionId)
  const pending = pendingFor(sessionId)
  const meta = metaFor(sessionId)
  // Unsent text, seeded from what this session had in flight. ChatView is keyed by
  // session id, so a switch remounts it — without the seed + the persist effect below,
  // stepping away mid-sentence threw the sentence away.
  const [draft, setDraft] = useState(() => loadDraft(sessionId))
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // Whether the viewport is parked at the bottom. We only auto-scroll to new
  // content while this holds, so scrolling up to read stays undisturbed. It's a
  // ref (read inside the scroll effect) mirrored to state only for the button.
  const pinnedRef = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const running = state === 'running' || state === 'waiting'
  // `@`-mention path autocomplete (interactive citation picker), anchored at cwd.
  const mention = useMentionComplete({ draft, setDraft, taRef, cwd: session?.cwd ?? '' })

  // --- input history (shell-like Up/Down over the messages you've sent) ---------
  // The turns you've sent this session, oldest→newest, persisted across reloads (see
  // loadHist/saveHist). `histPtr` counts steps back (0 = the live draft); `editsRef`
  // holds the text left in the box at each level. Loaded per session on mount — ChatView
  // is keyed by session id, so switching sessions remounts and re-reads the right key.
  const [sentHistory, setSentHistory] = useState<string[]>(() => loadHist(sessionId))
  // Seed from a resumed conversation the first time its transcript lands, so an existing
  // conversation has recall before you send anything this run. Seed-once (only when the
  // stored history is empty) and persist it, so a later /clear doesn't lose the seed.
  const transcriptSent = useMemo(() => items.filter((it) => it.kind === 'user').map((it) => it.text), [items])
  useEffect(() => {
    if (!transcriptSent.length) return
    setSentHistory((h) => { if (h.length) return h; const seeded = transcriptSent.slice(-HIST_CAP); saveHist(sessionId, seeded); return seeded })
  }, [transcriptSent, sessionId])
  // Append a just-sent message (skipping an immediate duplicate, like a shell), trim to
  // the cap, and persist.
  const pushHistory = useCallback((text: string) => {
    setSentHistory((h) => {
      if (h[h.length - 1] === text) return h
      const next = [...h, text].slice(-HIST_CAP)
      saveHist(sessionId, next)
      return next
    })
  }, [sessionId])

  // Persist the unsent draft. Debounced — a localStorage write per keystroke is a
  // synchronous main-thread hit — with a flush on teardown, which is exactly when a
  // session switch happens (and lands well inside the debounce window).
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    const t = setTimeout(() => saveDraft(sessionId, draft), 300)
    return () => clearTimeout(t)
  }, [draft, sessionId])
  useEffect(() => () => saveDraft(sessionId, draftRef.current), [sessionId])

  // The rendered transcript, memoized on `items` so composer keystrokes (which
  // re-render ChatView via `draft`) don't re-filter and re-build the whole list.
  const rendered = useMemo(() => {
    // Everything about a subagent (its `Task` call, its own nested activity, and its
    // result) is pulled OUT of the conversation — subagents live in the sidebar, under
    // their session's name, and open as their own tab (see AgentDetail).
    const taskToolIds = new Set<string>()
    for (const it of items) if (it.kind === 'tool_use' && isSubagentTool(it.name) && it.toolId) taskToolIds.add(it.toolId)
    const shown = items.filter((it) => {
      // Drop signature-only "thinking" blocks (no readable body → empty toggle/gap).
      if (it.kind === 'thinking' && !it.streaming && !it.text.trim()) return false
      if (it.kind === 'tool_use' && isSubagentTool(it.name)) return false                     // → sidebar
      // A subagent's own activity — tool calls/results AND its text/thinking (chain of
      // thought) — is tagged with parentId and belongs to its agent, not inline.
      if ((it.kind === 'tool_use' || it.kind === 'tool_result' || it.kind === 'text' || it.kind === 'thinking') && it.parentId) return false
      if (it.kind === 'tool_result' && taskToolIds.has(it.toolUseId)) return false             // Task result → sidebar
      return true
    })
    return shown.map((it, i) => (
      <div key={it.id} className={gapClass(it, shown[i - 1])}>
        <Item item={it} />
      </div>
    ))
  }, [items])
  // Restored on mount (see Nav): a session switch mid-recall comes back exactly where
  // you left off, with the text you'd been writing still one Down away.
  const nav0 = useRef<Nav>(loadNav(sessionId))
  const [histPtr, setHistPtr] = useState(() => nav0.current.ptr)
  const editsRef = useRef<Map<number, string>>(new Map(Object.entries(nav0.current.edits).map(([k, t]) => [Number(k), t])))
  const caretToEnd = () => requestAnimationFrame(() => { const ta = taRef.current; if (ta) ta.selectionStart = ta.selectionEnd = ta.value.length })
  // Persist only what differs from the plain history text — the levels you actually
  // typed into — so the key stays small.
  const persistNav = useCallback((ptr: number, edits: Map<number, string>, hist: string[]) => {
    const out: Record<string, string> = {}
    for (const [level, text] of edits) if (text !== (level === 0 ? '' : hist[hist.length - level])) out[String(level)] = text
    saveNav(sessionId, { ptr, edits: out })
  }, [sessionId])
  const resetNav = useCallback(() => { editsRef.current.clear(); setHistPtr(0); saveNav(sessionId, { ptr: 0, edits: {} }) }, [sessionId])

  // A turn the server could not hand to a live engine: put its TEXT back in the
  // composer. The dashed "Not delivered" bubble is a receipt, and a receipt is nearly
  // worthless on its own — what the user lost is the words, and the only thing they
  // want to do with them is edit and resend. The draft store is already the right home:
  // per-session, localStorage-backed, seeded on mount above, and pruned when a session
  // goes away, so this needs no new lifecycle and no server change at all.
  //
  // IT MUST GO THROUGH setDraft, NOT saveDraft. Writing localStorage directly from here
  // would be clobbered within 300ms by the debounced persist effect above, which writes
  // whatever `draft` currently holds — normally '' at exactly this moment, because the
  // send that just failed cleared the composer. Routing through state means that same
  // effect persists the restored text for us.
  //
  // ONLY WHEN THE COMPOSER IS EMPTY. That is the overwhelmingly common case (the send
  // cleared it moments ago). If the user has since started typing something else,
  // silently replacing it would destroy live work to recover dead work — so the bubble
  // stays the fallback there, with its text selectable, and Up-arrow still reaches it
  // because pushHistory recorded it on send.
  //
  // AND ONLY AT HISTORY LEVEL 0. An empty composer is not the same as an idle one: the user
  // may be BROWSING recalled messages, and level 0 with an empty box is where browsing starts
  // and returns to. `goTo` saves the box's live DOM value against the level it is leaving, so a
  // restore landing mid-browse does not merely get overwritten — it is recorded as the user's
  // edit of whatever level they were on, and survives there. That corrupts navigation rather
  // than just the current text. Reachable in the real app: send a turn, press Up before the
  // frame arrives. Nothing is lost by declining — `pushHistory` recorded the turn on send, so
  // Up still reaches it, and the "Not delivered" bubble still holds the text.
  const itemsRef = useRef(items)
  itemsRef.current = items
  const histPtrRef = useRef(histPtr)
  histPtrRef.current = histPtr
  useEffect(() => api.on.sendFailed((id, turnId) => {
    if (id !== sessionId || !turnId || draftRef.current || histPtrRef.current !== 0) return
    const lost = itemsRef.current.find((it) => it.kind === 'user' && it.id === turnId)
    if (lost?.kind === 'user') setDraft(lost.text)
  }), [sessionId])
  // Step to another history level, taking the box's current text with us: it's saved
  // against the level we're leaving, so coming back — including all the way back to
  // level 0, your own half-written message — restores it verbatim. Read from the DOM
  // rather than `draft` so it's whatever is on screen at this instant, whatever else
  // may have set it.
  const goTo = (level: number, ta: HTMLTextAreaElement): void => {
    const edits = editsRef.current
    edits.set(histPtr, ta.value)
    setHistPtr(level)
    // `?? ''` also covers a level that no longer exists — history trimmed at the cap, or
    // a restored pointer into a history that has since been cleared.
    setDraft(edits.get(level) ?? (level === 0 ? '' : sentHistory[sentHistory.length - level]) ?? '')
    caretToEnd()
    persistNav(level, edits, sentHistory)
  }
  // Up: older message. Hijacked only when there's no line above the caret to move to,
  // so multi-line editing keeps working — in your own draft (where we ask for the very
  // start, as before) and in a recalled message alike.
  const recallPrev = (ta: HTMLTextAreaElement): boolean => {
    if (histPtr >= sentHistory.length) return histPtr > 0   // at the oldest: swallow, don't jump the caret
    const room = histPtr === 0
      ? ta.selectionStart === 0 && ta.selectionEnd === 0
      : !ta.value.slice(0, ta.selectionStart).includes('\n')
    if (!room) return false
    goTo(histPtr + 1, ta)
    return true
  }
  // Down: newer message, mirroring Up — hijacked when there's no line below the caret.
  // Stepping past the newest lands back on the draft you were writing.
  const recallNext = (ta: HTMLTextAreaElement): boolean => {
    if (histPtr === 0) return false
    if (ta.value.slice(ta.selectionEnd).includes('\n')) return false
    goTo(histPtr - 1, ta)
    return true
  }

  // Is Claude *actively thinking* right now? That's a sub-phase of 'running' the
  // server doesn't distinguish — we read it off the live transcript: the newest
  // item is a still-streaming thinking block with readable text. Its tail feeds a
  // live ticker at the composer so you can see the thought without scrolling up.
  const last = items[items.length - 1]
  const thinking = last && last.kind === 'thinking' && last.streaming ? last.text.trim() : ''
  const thinkTail = thinking.length > 180 ? '…' + thinking.slice(-180) : thinking

  // Track how close the viewport is to the bottom. Within the threshold we're
  // "pinned" and new content follows; scroll up and we release, so reading above
  // is never yanked down. Updates a ref (for the effect) and state (for the button).
  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinnedRef.current = pinned
    setShowJump((prev) => (prev === !pinned ? prev : !pinned))
  }

  const jumpToLatest = () => {
    pinnedRef.current = true
    setShowJump(false)
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }

  // Keep the newest content in view while this session is on screen — but only
  // when the reader is already parked at the bottom. Scrolled up? Stay put.
  // Keyed on `items`, NOT `items.length`: a streaming block keeps one item and grows
  // its text (STREAM_DELTA rebuilds the array with the same length), so a length dep
  // fired once at content_block_start and then never again — the answer started in
  // view and the rest ran off the bottom while the reader sat still.
  useEffect(() => {
    if (pinnedRef.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [items, pending])

  // RE-PIN ON RE-SHOW. While this pane is `display:none` it has no box at all, so the effect
  // above is a NO-OP — scrollIntoView on a zero-box subtree does nothing — and Chrome drops
  // `scrollTop` to 0 when the box is removed. Without this, a phone user who reads the chat,
  // taps a file and taps back lands at the TOP of the transcript with the new messages below
  // them, which reads as lost history rather than a lost scroll position.
  //
  // Note WHICH half breaks: `onScroll` is safe on its own, because a hidden element measures
  // 0 - 0 - 0 = 0, which is < 80 from the bottom and therefore RE-pins rather than unpins. So
  // the pin survives and only the position is lost — which is why the fix is a re-scroll and
  // not a re-pin guard. Mirrors TerminalView's existing `visible` contract; the house pattern,
  // not an invention.
  useEffect(() => {
    if (visible && pinnedRef.current) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [visible])

  // Auto-resume on load: a RESTORED session (not one just created) with an empty
  // transcript pulls in its latest conversation — the equivalent of /resume picking
  // the top entry — so a page reload lands you back where you were. Once per session
  // per app load; never disturbs a running turn.
  useEffect(() => {
    if (!session || autoResumed.has(sessionId)) return
    if (isFresh(sessionId) || items.length > 0 || running) return
    autoResumed.add(sessionId)
    const cwd = session.cwd
    void (async () => {
      try {
        const list = await api.http.listConversations(cwd)
        const latest = list[0]
        if (!latest || resumeAborted.has(sessionId)) return
        // Fetch BEFORE mutating, and re-check the abort flag after each await: a
        // /clear|/resume|/rewind may fire while we're fetching, and this in-flight
        // pull must not clobber it (the "/clear did nothing" race).
        const events = await api.http.readConversation(cwd, latest.id)
        if (resumeAborted.has(sessionId)) return
        clearTranscript(sessionId)
        loadTranscript(sessionId, events)
        await api.http.resumeInto(sessionId, latest.id)
      } catch { /* best-effort; the user can still /resume manually */ }
    })()
  }, [session, sessionId, items.length, running, isFresh, clearTranscript, loadTranscript])

  // Slash-command menu: the two natively-handled commands (/clear, /resume) plus
  // the session's own init `slash_commands` (which pass through as a turn).
  const showSlash = draft.startsWith('/') && !draft.includes(' ') && !draft.includes('\n')
  const q = draft.slice(1).toLowerCase()
  const suggestions = showSlash
    ? [...NATIVE_SLASH, ...slashCommandsFor(sessionId)]
        .filter((c, i, a) => a.indexOf(c) === i)
        .filter((c) => c.toLowerCase().startsWith(q))
        .slice(0, 8)
    : []

  // Returns true if handled natively (don't send as a turn). /clear starts a fresh
  // conversation + wipes the transcript; /resume opens the conversation picker;
  // /rewind opens the turn picker (fork the transcript to an earlier point).
  const handleSlash = (t: string): boolean => {
    // Mark as auto-resumed FIRST: emptying the transcript below is exactly the
    // auto-resume trigger, so without this the once-per-load effect would race in and
    // re-pull the old conversation — the "/clear did nothing, had to do it twice" bug.
    if (t === '/clear') { autoResumed.add(sessionId); resumeAborted.add(sessionId); clearTranscript(sessionId); void api.http.restartFresh(sessionId); return true }
    if (t === '/resume') { setShowResume(true); return true }
    if (t === '/rewind') { setShowRewind(true); return true }
    return false
  }

  const submit = () => {
    const t = draft.trim()
    if (!t) return
    pushHistory(draft)   // remember it for Up/Down recall (including slash commands, shell-style)
    resetNav()           // sent — back to a blank level 0, with no half-written levels left behind
    if (handleSlash(t)) { setDraft(''); return }
    sendTurn(sessionId, draft)
    markBusy(sessionId)   // show Working…/interrupt immediately, before the WS round-trip
    setDraft('')
  }

  // Pick a past conversation: wipe the pane, replay its history, then rebind the
  // engine via --resume so the next turn continues it.
  const pickResume = async (meta: ConversationMeta) => {
    setShowResume(false)
    if (!session) return
    autoResumed.add(sessionId); resumeAborted.add(sessionId)   // explicit pick — supersede any in-flight auto-resume
    clearTranscript(sessionId)
    loadTranscript(sessionId, await api.http.readConversation(session.cwd, meta.id))
    await api.http.resumeInto(sessionId, meta.id)
  }

  // Rewind to a past turn. mode 'code' only restores files (conversation untouched);
  // 'conversation'/'both' also fork the transcript before the turn (the server resumes
  // the engine into the fork) — so wipe the pane and replay the truncated history to
  // match the engine's new context. The next turn continues from that point.
  // Resolves to an error for the picker to show (it stays open), or null on success — a
  // failed restore that just closed the dialog was indistinguishable from a no-op.
  const pickRewind = async (point: RewindPoint, mode: RewindMode, deleteNewer: boolean): Promise<string | null> => {
    if (!session) return 'no session'
    const res = await api.http.rewind(sessionId, point.uuid, mode, deleteNewer)
    if (!res.ok) return res.error || 'rewind failed'   // point vanished or restore failed — leave the pane as-is
    setShowRewind(false)
    if (res.newId) {
      autoResumed.add(sessionId); resumeAborted.add(sessionId)   // explicit rewind — supersede any in-flight auto-resume
      clearTranscript(sessionId)
      loadTranscript(sessionId, await api.http.readConversation(session.cwd, res.newId))
    } else if (res.cleared) {
      // Rewound to before the first prompt: the server started a fresh conversation, so
      // empty the pane (same as /clear). Mark auto-resumed first so it isn't re-pulled.
      autoResumed.add(sessionId); resumeAborted.add(sessionId)
      clearTranscript(sessionId)
    }
    // The conversation moved (forked or cleared) → drop the rewound-to prompt back into
    // the composer so it can be edited and re-sent, like Claude Code's /rewind. Code-only
    // rewinds leave the turn in the transcript, so don't duplicate it into the draft.
    if (res.newId || res.cleared) { setDraft(point.text); caretToEnd() }
    return null
  }

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-overlay text-xs">
        No session selected.
      </div>
    )
  }

  return (
    <div className="relative flex flex-col h-full bg-ctp-base text-ctp-text">
      {showResume && <ResumePicker cwd={session.cwd} onPick={pickResume} onClose={() => setShowResume(false)} />}
      {showRewind && <RewindPicker sessionId={sessionId} onPick={pickRewind} onClose={() => setShowRewind(false)} />}
      <MetaBar
        meta={meta}
        session={session}
        title={session.name}
        cwd={session.cwd}
        mode={session.permissionMode ?? 'default'}
        onSetMode={(m) => setMode(sessionId, m)}
      />
      {state === 'exited' && (
        // BOUNDED, like the two cards. `exitError` is the server's stderrTail, capped at
        // TAIL_MAX = 2000 chars — roughly 45 lines at 11px on a 390px phone, ~600-700px of an
        // 844px viewport. It is `shrink-0` and sat ABOVE the transcript with no max-h and no
        // overflow, so a session that died with a stack trace squeezed the conversation
        // toward zero at exactly the moment the user most needs to read it. Same repair as
        // AskUserQuestionCard: bound and scroll the MESSAGE, keep the banner chrome outside
        // it so the "⚠ Claude exited" line is always visible.
        <div className="shrink-0 px-4 py-2 bg-ctp-red/10 border-b border-ctp-red/30 text-[11px] text-ctp-red">
          <div className="font-medium">⚠ Claude exited</div>
          {session.exitError && (
            <div className="mt-0.5 max-h-[calc(var(--vvh,100vh)*0.25)] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-snug opacity-90 pr-1">
              {session.exitError}
            </div>
          )}
        </div>
      )}
      {/* `data-testid` so a harness can identify THE transcript scroller directly. It used
          to be found by scanning for the largest overflowing `.overflow-y-auto`, which is a
          heuristic that silently retargets the moment any other scrollable region appears —
          e.g. the bounded question list in AskUserQuestionCard below. A test that keeps
          passing while measuring the wrong element is worse than one that fails. */}
      <div ref={scrollRef} onScroll={onScroll} data-testid="transcript-scroller" className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-5 sm:py-6 text-[13px]">
          {items.length === 0 && (
            <div className="text-ctp-overlay text-sm select-none pt-16 text-center">
              Send a message to start the conversation.
            </div>
          )}
          {rendered}


          {state === 'running' && !pending && (
            <div className="mt-4 flex items-center gap-2 text-ctp-overlay text-xs animate-fade-in">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-ctp-green animate-pulse" />
              Working…
              <button
                onClick={() => interrupt(sessionId)}
                title="Interrupt Claude (Esc)"
                className="px-1.5 py-0.5 rounded text-ctp-red/90 hover:bg-ctp-red/10 hover:text-ctp-red transition-colors"
              >
                Stop
              </button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* PINNED, and deliberately a SIBLING of the scroll container above rather than a
          child of it. This card used to render inside the transcript, so a prompt the
          session is BLOCKED on scrolled off-screen with the conversation — measured at
          668px away after one viewport of scroll. That is the same defect we fixed for
          teammates one audience over: a coordinator could not see that a member was
          blocked, and here a human cannot see that Claude is. On a phone it is the common
          case, not the edge case. Sitting between the transcript and the composer keeps it
          in view for as long as it is unanswered, which is exactly as long as it matters.

          NB no `overflow-y-auto` on this wrapper: layout-check's `scroller()` helper picks
          the largest overflowing `.overflow-y-auto` as "the transcript", and a second one
          here could be misidentified as the thing the card must not be inside. */}
      {pending && (
        <div className="shrink-0 border-t border-ctp-surface0 bg-ctp-base">
          <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-3">
            {/* KEYED BY requestId. Both cards hold their own answer state, and the
              pending queue reveals the next prompt in this same slot — so without a
              key React reused the instance and the new question mounted already
              "answered" with the previous one's selection, Submit live. Clicking it
              sent an answer the user never gave for a question they hadn't read. */}
            {pending.toolName === 'AskUserQuestion' ? (
              <AskUserQuestionCard
                key={pending.requestId}
                input={pending.input}
                onAnswer={(answers) => respond(sessionId, pending.requestId, { behavior: 'allow', updatedInput: { ...(pending.input as Record<string, unknown>), answers } })}
                onDismiss={() => respond(sessionId, pending.requestId, { behavior: 'deny', message: 'Dismissed by user' })}
              />
            ) : (
              <PermissionCard
                key={pending.requestId}
                toolName={pending.toolName}
                description={pending.description}
                input={pending.input}
                suggestions={pending.suggestions}
                onAllow={() => respond(sessionId, pending.requestId, { behavior: 'allow' })}
                onAllowAlways={() => respond(sessionId, pending.requestId, { behavior: 'allow', updatedPermissions: pending.suggestions })}
                onDeny={() => respond(sessionId, pending.requestId, { behavior: 'deny', message: 'Denied by user' })}
              />
            )}
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-ctp-surface0 bg-ctp-base">
        <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-3 relative">
          {showJump && (
            <button
              onClick={jumpToLatest}
              title="Jump to latest"
              className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-10 flex items-center gap-1 rounded-full border border-ctp-surface1 bg-ctp-mantle px-3 py-1 text-[11px] text-ctp-subtext shadow-pop hover:text-ctp-text hover:border-ctp-surface2 transition-colors animate-fade-in"
            >
              ↓ Jump to latest
            </button>
          )}
          {suggestions.length > 0 && (
            <div className="absolute bottom-full left-6 mb-2 w-64 rounded-lg border border-ctp-surface1 bg-ctp-mantle shadow-pop overflow-hidden z-10">
              {suggestions.map((c) => {
                const native = NATIVE_SLASH.includes(c)
                return (
                  <button
                    key={c}
                    onClick={() => { if (native) { handleSlash('/' + c); setDraft('') } else setDraft('/' + c + ' ') }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-ctp-surface0/60 flex justify-between items-center"
                  >
                    <span className="font-mono text-ctp-text">/{c}</span>
                    {native && <span className="text-[10px] text-ctp-overlay">native</span>}
                  </button>
                )
              })}
            </div>
          )}
          {/* @-mention path picker: file/folder autocomplete anchored at the cwd. */}
          {mention.active && (
            <div className="absolute bottom-full left-6 mb-2 w-80 rounded-lg border border-ctp-surface1 bg-ctp-mantle shadow-pop overflow-hidden z-10">
              <div className="px-3 py-1 text-[10px] text-ctp-overlay font-mono truncate border-b border-ctp-surface0/70">
                {prettyPath(mention.dir)}
              </div>
              {mention.items.map((it, i) => (
                <button
                  key={it.name}
                  onMouseDown={(e) => { e.preventDefault(); mention.apply(i) }}
                  className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${i === mention.sel ? 'bg-ctp-accent/15 text-ctp-text' : 'hover:bg-ctp-surface0/60 text-ctp-subtext'}`}
                >
                  <span aria-hidden>{it.isDir ? '📁' : '📄'}</span>
                  <span className="font-mono truncate">{it.name}{it.isDir ? '/' : ''}</span>
                </button>
              ))}
            </div>
          )}
          <div className="rounded-xl border border-ctp-surface0 bg-ctp-mantle focus-within:border-ctp-accent/50 focus-within:ring-1 focus-within:ring-ctp-accent/25 transition-colors">
            {/* Live activity right at the composer: the current thought while
                thinking, else a working pulse — so there's always a signal here. */}
            {running && (
              <div className="px-3.5 pt-2 pb-1.5 border-b border-ctp-surface0/70">
                {thinkTail ? (
                  <div className="flex items-start gap-1.5">
                    <span className="shrink-0 text-ctp-mauve animate-pulse leading-none pt-px" aria-hidden>💭</span>
                    <span className="text-[11px] leading-snug italic text-ctp-subtext/90 break-words line-clamp-2">
                      {thinkTail}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-[11px] text-ctp-overlay">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-ctp-green animate-pulse" />
                    {state === 'waiting' ? 'Waiting for you…' : 'Working…'}
                  </div>
                )}
              </div>
            )}
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => {
                // Typing doesn't leave history: the edit stays with the level you made
                // it on (goTo carries it), so nothing you write is ever dropped.
                setDraft(e.target.value); mention.sync(e.target.value, e.target.selectionStart ?? 0)
              }}
              onKeyUp={(e) => mention.sync(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
              onClick={(e) => mention.sync(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
              onKeyDown={(e) => {
                // The @-mention menu gets first crack at nav/complete/dismiss keys.
                if (mention.onKeyDown(e)) return
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
                else if (e.key === 'Escape' && running) { e.preventDefault(); interrupt(sessionId) }
                // Shell-like history: Up recalls the previous message you sent, Down
                // walks back toward the live draft. Skipped while a menu is open.
                else if (e.key === 'ArrowUp' && !suggestions.length && !mention.active) { if (recallPrev(e.currentTarget)) e.preventDefault() }
                else if (e.key === 'ArrowDown' && !suggestions.length && !mention.active) { if (recallNext(e.currentTarget)) e.preventDefault() }
              }}
              rows={2}
              placeholder={running ? 'Claude is working… (Esc to interrupt)' : 'Message Claude…  (Enter to send · Shift+Enter for newline · / for commands)'}
              className="w-full resize-none bg-transparent outline-none px-3.5 pt-2.5 pb-1 text-sm placeholder:text-ctp-overlay"
            />
            <div className="flex justify-between items-center px-2.5 pb-2 pt-0.5">
              <span className="text-[10px] text-ctp-overlay capitalize">{state}</span>
              <div className="flex gap-2">
                {/* While Claude works, a prominent Stop button (also Esc). Send is
                    still offered alongside it if the user has typed a follow-up. */}
                {running && (
                  <button
                    onClick={() => interrupt(sessionId)}
                    title="Interrupt Claude (Esc)"
                    className="text-xs px-3 py-1 rounded-md bg-ctp-red/90 text-ctp-base font-medium hover:brightness-110 active:brightness-95 transition inline-flex items-center gap-1.5"
                  >
                    <span className="inline-block w-2 h-2 rounded-[2px] bg-ctp-base" /> Stop
                  </button>
                )}
                {(!running || draft.trim()) && (
                  <button
                    onClick={submit}
                    disabled={!draft.trim()}
                    className="text-xs px-3.5 py-1 rounded-md bg-ctp-accent text-ctp-base font-medium hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// Slash commands Claudette handles itself (not passed through as a turn).
const NATIVE_SLASH = ['clear', 'resume', 'rewind']

// Vertical rhythm between transcript items: prose (user/assistant text) gets room
// to breathe; tool calls, their results, and consecutive tool rows pull into tight
// clusters so tool chatter reads as a subordinate group, not a stack of cards.
function gapClass(it: TranscriptItem, prev?: TranscriptItem): string {
  if (!prev) return ''
  const toolish = (k?: string) => k === 'tool_use' || k === 'tool_result'
  switch (it.kind) {
    case 'tool_result': return 'mt-0.5'
    case 'tool_use': return toolish(prev.kind) ? 'mt-1' : 'mt-4'
    case 'user': return 'mt-6'
    case 'team': return 'mt-6'
    case 'text': return 'mt-4'
    case 'thinking': return 'mt-3'
    case 'notice': return 'mt-2'
    default: return 'mt-4'
  }
}

// Memoized: the reducer preserves object identity for every settled item, so a
// streaming token (which only replaces the one growing item) re-renders that item
// alone instead of the whole transcript.
const Item = memo(function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user':
      // `undelivered` = the server told us this turn never reached a live claude process
      // (session:sendFailed). The bubble is appended optimistically the moment you hit
      // send, so WITHOUT this it keeps the ordinary accent styling and reads as delivered
      // forever. Muted + dashed + an explicit line, because the failure is otherwise
      // completely silent: no reply ever arrives and nothing else in the transcript
      // changes. The text is kept selectable so it can be copied and re-sent.
      return (
        <div className="flex justify-end animate-fade-in">
          <div className={item.undelivered
            ? 'max-w-[85%] rounded-2xl rounded-br-md bg-ctp-surface0/40 border border-dashed border-ctp-red/50 px-3.5 py-2 whitespace-pre-wrap text-ctp-subtext'
            : 'max-w-[85%] rounded-2xl rounded-br-md bg-ctp-accent/12 border border-ctp-accent/25 px-3.5 py-2 whitespace-pre-wrap text-ctp-text'}>
            {item.text}
            {item.undelivered && (
              <div className="mt-1.5 pt-1.5 border-t border-ctp-red/25 text-[11px] text-ctp-red flex items-center gap-1.5">
                <span aria-hidden>⚠</span>
                <span>Not delivered — the session wasn't running. Copy this and send it again.</span>
              </div>
            )}
          </div>
        </div>
      )
    case 'team': {
      // Deliberately NOT a user bubble: this came from a teammate, and the transcript
      // must not imply the user said it. Left-aligned with an explicit "from", so the
      // side of the conversation it belongs to is unmistakable at a glance.
      const label = item.messageKind === 'directive' ? 'assigned by'
        : item.messageKind === 'handover' ? 'handover from'
        : 'reported by'
      return (
        <div className="flex justify-start animate-fade-in">
          <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-ctp-surface0/50 border border-ctp-mauve/35 px-3.5 py-2">
            <div className="text-[10px] uppercase tracking-wide text-ctp-mauve mb-1">
              {label} {item.from} · {item.role}
            </div>
            {/* Markdown, not pre-wrap: a teammate's report is Claude-authored prose with
                headings, bullets and code fences — the same shape as assistant text, and
                it read as raw source before. */}
            <div className="text-ctp-text leading-relaxed break-words"><Markdown text={item.text} /></div>
          </div>
        </div>
      )
    }
    case 'text':
      return (
        <div className="leading-relaxed break-words text-ctp-text">
          <Markdown text={item.text} />
          {item.streaming && <span className="inline-block w-1.5 h-3.5 -mb-0.5 ml-0.5 bg-ctp-accent/80 animate-pulse" />}
        </div>
      )
    case 'thinking':
      // Some models (e.g. Fable) emit thinking as encrypted, signature-only blocks
      // with no readable text — a "thinking":"" content block. Rendering an empty
      // "Thinking" toggle for those is just noise, so suppress when there's no body.
      if (!item.text.trim()) return null
      return item.streaming
        ? <div className="text-ctp-overlay italic whitespace-pre-wrap text-xs">{item.text}<span className="inline-block w-1 h-3 ml-0.5 bg-ctp-overlay animate-pulse" /></div>
        : <Collapsible label="Thinking" tone="overlay" body={item.text} />
    case 'tool_use':
      return <ToolRow name={item.name} input={item.input} />
    case 'tool_result':
      return <ResultRow content={item.content} isError={item.isError} />
    case 'result':
      return (
        <div className="border-t border-ctp-surface0/60 pt-1.5 space-y-1">
          {item.errorText && (
            <div className="rounded border border-ctp-red/40 bg-ctp-red/10 px-2.5 py-1.5 text-xs text-ctp-red whitespace-pre-wrap">
              ⚠ {item.errorText}
            </div>
          )}
          <div className="text-[10px] text-ctp-overlay">
            {item.durationMs != null ? `${(item.durationMs / 1000).toFixed(1)}s` : ''}
          </div>
        </div>
      )
    case 'notice':
      return <div className="text-[11px] text-ctp-red/80 whitespace-pre-wrap font-mono">{item.text}</div>
  }
})

// Compact, collapsed-by-default tool call — a dim one-liner (`⏺ Read(client.ts)`)
// that expands to the full ToolDetail on click. Keeps tool chatter subordinate to
// the assistant's prose, matching the Claude Code CLI's hierarchy.
export function ToolRow({ name, input }: { name: string; input: unknown }) {
  const [open, setOpen] = useState(false)
  const arg = toolArg(name, (input ?? {}) as Record<string, unknown>)
  return (
    <div className="group animate-fade-in">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-baseline gap-1.5 text-left text-[12px] text-ctp-overlay hover:text-ctp-subtext w-full"
        title={toolHeadline(name, (input ?? {}) as Record<string, unknown>)}
      >
        <span className="text-ctp-mauve/70 shrink-0">⏺</span>
        <span className="font-medium text-ctp-subtext shrink-0">{name}</span>
        {arg && <span className="font-mono text-ctp-overlay truncate">{arg}</span>}
        <span className="ml-auto shrink-0 text-ctp-surface2 opacity-0 group-hover:opacity-100 transition-opacity">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="mt-1 mb-1.5 ml-4 pl-2 border-l border-ctp-surface0 text-xs">
          <ToolDetail name={name} input={input} />
        </div>
      )}
    </div>
  )
}

// Compact tool result — an indented `⎿` summary line (first line + line count),
// expandable to the full output. Errors surface in red but stay one line until opened.
export function ResultRow({ content, isError }: { content: string; isError: boolean }) {
  const [open, setOpen] = useState(false)
  const lines = content.split('\n')
  const firstLine = lines.find((l) => l.trim().length > 0) ?? ''
  const extra = lines.length > 1 ? ` +${lines.length - 1} lines` : ''
  const summary = isError ? (firstLine || 'error') : (firstLine || `${lines.length} line${lines.length === 1 ? '' : 's'}`)
  const color = isError ? 'text-ctp-red/80' : 'text-ctp-overlay'
  return (
    <div className="ml-4 animate-fade-in">
      <button onClick={() => setOpen((v) => !v)} className={`flex items-baseline gap-1.5 text-left text-[11.5px] ${color} hover:text-ctp-subtext w-full`}>
        <span className="text-ctp-surface2 shrink-0">⎿</span>
        <span className="truncate font-mono">{truncate(summary, 100)}</span>
        {extra && <span className="text-ctp-surface2 shrink-0">{extra}</span>}
      </button>
      {open && (
        <pre className="mt-1 mb-1 ml-4 pl-2 border-l border-ctp-surface0 whitespace-pre-wrap font-mono text-[11px] text-ctp-subtext max-h-80 overflow-y-auto">
          {content}
        </pre>
      )}
    </div>
  )
}

function Collapsible({ label, body, tone }: { label: string; body: string; tone: 'overlay' | 'subtext' | 'red' }) {
  const [open, setOpen] = useState(false)
  const color = tone === 'red' ? 'text-ctp-red/80' : tone === 'subtext' ? 'text-ctp-subtext' : 'text-ctp-overlay'
  const preview = body.length > 120 ? body.slice(0, 120) + '…' : body
  return (
    <div className={`text-xs ${color}`}>
      <button onClick={() => setOpen((v) => !v)} className="hover:text-ctp-text">
        {open ? '▾' : '▸'} {label}
      </button>
      <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] pl-4 opacity-90">
        {open ? body : preview}
      </pre>
    </div>
  )
}

// Compact token count: 210_234 → "210k". Sub-1k values shown as-is.
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`   // Opus' 1M window as "1.0M", not "1000k"
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

// The CLI's weekly window comes in several flavors: seven_day, seven_day_opus,
// seven_day_sonnet (plus a legacy "weekly"). Treat them all as the Weekly bucket.
const isWeekly = (t?: string) => t === 'weekly' || (t?.startsWith('seven_day') ?? false)

function limitLabel(type?: string): string {
  if (type === 'five_hour') return 'Session'
  if (isWeekly(type)) return 'Weekly'
  return (type ?? 'limit').replace(/_/g, ' ')
}
// Session window first, then any weekly window, then anything unrecognized.
const limitRank = (t?: string) => (t === 'five_hour' ? 0 : isWeekly(t) ? 1 : 9)

// Re-render on an interval so time-based UI (rate-limit chip expiry) updates without
// new events. Pass null to disable the timer (no re-renders) when there's nothing to
// age out.
function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (intervalMs == null) return
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

// Poll the plan-quota usage endpoint (session/weekly %). The CLI stream no longer
// carries a usage fraction, so this HTTP poll is the source for the rate-limit chips.
// Account-global (not per-session), so one interval suffices; refetch on mount, every
// 60s, and when the tab regains focus.
//
// The endpoint returns `{ windows: [] }` not only for "no OAuth token" but also for
// TRANSIENT upstream failures — a 401 mid-way through the CLI's token refresh, a 429,
// or a network blip all collapse to empty. Overwriting good data with that empty result
// is what made the chips blink out for ~60s and then return. So keep the last non-empty
// snapshot and only replace it when a poll actually carries windows; a genuinely
// token-less install simply stays at the initial empty state and shows no chip.
function useUsage(): UsageWindow[] {
  const [windows, setWindows] = useState<UsageWindow[]>([])
  useEffect(() => {
    let alive = true
    const load = () => { api.http.usage().then((u) => { if (alive && u.windows.length) setWindows(u.windows) }).catch(() => {}) }
    load()
    const iv = setInterval(load, 60_000)
    const onVis = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  return windows
}

// Always-visible status bar: session title + cwd, then model, real context usage
// (tokens + %), cost, and a chip per rate-limit window (session / weekly).
function MetaBar({ meta, session, title, cwd, mode, onSetMode }: {
  meta: SessionMeta; session: SessionInfo; title?: string; cwd?: string
  mode: PermissionMode; onSetMode: (mode: PermissionMode) => void
}) {
  const tokens = meta.contextTokens
  const win = meta.contextWindow
  const pct = win && tokens != null ? Math.min(100, Math.round((tokens / win) * 100)) : undefined
  // Against Opus' 1M window a few-k-token session rounds to 0% — show "<1%" (and keep a
  // 1px sliver of bar) so a working meter doesn't read as broken/empty.
  const pctLabel = pct == null ? undefined : pct === 0 && (tokens ?? 0) > 0 ? '<1%' : `${pct}%`
  const barPct = pct == null ? 0 : Math.max(pct, (tokens ?? 0) > 0 ? 1 : 0)
  const barColor = pct == null ? 'bg-ctp-accent' : pct >= 92 ? 'bg-ctp-red' : pct >= 80 ? 'bg-ctp-yellow' : 'bg-ctp-accent'
  // The session/weekly quota chips are account-global (identical for every session),
  // so they now live once in the sidebar header (SidebarUsage) rather than here. The
  // ctx meter below stays — it's the one usage figure that IS unique per session.

  return (
    <div className="shrink-0 flex items-center flex-wrap gap-x-3 gap-y-1 px-4 sm:px-5 min-h-[3rem] py-1.5 border-b border-ctp-surface0">
      {/* Session identity — hidden on mobile (the top bar already shows the name). */}
      <div className="hidden md:flex min-w-0 items-baseline gap-2">
        {title && <span className="text-sm font-medium text-ctp-text truncate max-w-[16rem]">{title}</span>}
        {cwd && <span className="text-[11px] text-ctp-overlay font-mono truncate max-w-[20rem]">{prettyPath(cwd)}</span>}
      </div>

      <div className="md:ml-auto flex items-center flex-wrap gap-x-3 gap-y-1 text-[10px] text-ctp-overlay">
        <SandboxControl session={session} />
        <ModeSelect mode={mode} onSetMode={onSetMode} />
        <span className="text-ctp-subtext font-mono" title={meta.model ? undefined : 'The model and context appear after your first message this session.'}>
          {meta.model ?? 'model · after first message'}
        </span>

        <span className="flex items-center gap-1.5" title="Context window used (input + cached tokens) vs the model's limit">
          <span className="text-ctp-overlay">ctx</span>
          <span className="inline-block w-16 h-1.5 rounded-full bg-ctp-surface0 overflow-hidden align-middle">
            {pct !== undefined && <span className={`block h-full rounded-full ${barColor}`} style={{ width: `${barPct}%` }} />}
          </span>
          {tokens != null && win
            ? <span className="font-mono text-ctp-subtext">{fmtTokens(tokens)} / {fmtTokens(win)} ({pctLabel})</span>
            : <span className="text-ctp-surface2">—</span>}
        </span>

        <RestartButton session={session} />
      </div>
    </div>
  )
}

// Live permission-mode switch (P1.4). Applies over the control protocol when the
// session is running (instant), else on the next launch — the returned status says
// which, shown briefly so the user knows it took. "allow all" (bypassPermissions)
// is guarded behind a confirm, matching the Permissions panel.
const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'prompt', acceptEdits: 'auto-edit', plan: 'plan', bypassPermissions: 'allow all',
}
function ModeSelect({ mode, onSetMode }: { mode: PermissionMode; onSetMode: (m: PermissionMode) => Promise<{ applied: string; reason?: string }> | void }) {
  const [hint, setHint] = useState<string | null>(null)
  const [confirmBypass, setConfirmBypass] = useState(false)
  const apply = async (m: PermissionMode) => {
    const r = await onSetMode(m)
    if (r && 'applied' in r) {
      const msg = r.applied === 'live' ? 'applied' : r.applied === 'relaunched' ? 'relaunching…' : 'applies on next run'
      setHint(msg)
      setTimeout(() => setHint(null), 2500)
    }
  }
  // Picking "allow all" opens the confirm instead of applying; the controlled
  // <select> keeps showing the current mode until it's confirmed (cancel = no-op).
  const change = (m: PermissionMode) => {
    if (m === mode) return
    if (m === 'bypassPermissions') { setConfirmBypass(true); return }
    void apply(m)
  }
  return (
    <span className="flex items-center gap-1" title="Permission mode — how Claude's tool use is gated">
      <select
        value={mode}
        onChange={(e) => change(e.target.value as PermissionMode)}
        className={`bg-ctp-surface0 rounded px-1 py-0.5 outline-none hover:text-ctp-text cursor-pointer ${
          mode === 'bypassPermissions' ? 'text-ctp-red' : 'text-ctp-subtext'}`}
      >
        {(Object.keys(MODE_LABEL) as PermissionMode[]).map((m) => (
          <option key={m} value={m}>{MODE_LABEL[m]}</option>
        ))}
      </select>
      {hint && <span className="text-ctp-overlay">{hint}</span>}
      {confirmBypass && (
        <BypassConfirmDialog
          onConfirm={() => { setConfirmBypass(false); void apply('bypassPermissions') }}
          onCancel={() => setConfirmBypass(false)}
        />
      )}
    </span>
  )
}

// Restart JUST this session's `claude` process (resume-preserving), not the whole
// session — kernels, terminals, and the conversation survive. Backs the same
// resume-restart the server uses to apply config changes (relaunchApply): kill →
// the exit handler relaunches via the `replacing` flag, which never fires
// SessionManager's own `exit`, so panes/kernels are never released. The one recovery
// for a session whose engine dropped its auth ("Not logged in") mid-run: a fresh
// process re-reads the (by-now refreshed) credentials. Confirms first only when a
// turn is live, since a restart interrupts it.
function RestartButton({ session }: { session: SessionInfo }) {
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const active = session.state === 'running' || session.state === 'waiting'
  const restart = async () => {
    setConfirm(false)
    setBusy(true)
    try { await api.http.relaunchApply(session.id) } finally { setBusy(false) }
  }
  return (
    <span className="relative flex items-center">
      <button
        onClick={() => (active ? setConfirm(true) : void restart())}
        disabled={busy}
        title="Restart the Claude process — keeps the conversation, kernels, and terminals"
        aria-label="Restart Claude"
        className="flex items-center justify-center w-5 h-5 rounded text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface0 transition-colors disabled:opacity-40"
      >
        <span className={busy ? 'inline-block animate-spin' : 'inline-block'} aria-hidden>↻</span>
      </button>
      {confirm && (
        <div className="absolute top-full right-0 mt-1 z-20 w-60 rounded-lg border border-ctp-surface1 bg-ctp-mantle shadow-pop p-2.5 text-[11px] leading-snug text-ctp-subtext">
          <p className="mb-2">Restart Claude? The current turn is interrupted. The conversation, kernels, and terminals are kept.</p>
          <div className="flex justify-end gap-2">
            <button className="px-2 py-0.5 rounded text-ctp-overlay hover:bg-ctp-surface0" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="px-2 py-0.5 rounded bg-ctp-accent/20 text-ctp-text hover:bg-ctp-accent/30" onClick={() => void restart()}>Restart</button>
          </div>
        </div>
      )}
    </span>
  )
}

function RateChip({ rl }: { rl: RateLimitInfo }) {
  const status = rl.status ?? 'allowed'
  const ok = status === 'allowed'
  const bad = /reject|exceed|block|limit_reached/i.test(status)
  const color = bad ? 'text-ctp-red' : ok ? 'text-ctp-overlay' : 'text-ctp-yellow'
  const resets = rl.resetsAt
    ? `resets ${new Date(rl.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
    : ''
  const usedPct = typeof rl.percentUsed === 'number' ? ` ${Math.round(rl.percentUsed)}%` : ''
  const label = limitLabel(rl.rateLimitType)
  return (
    <span className={color} title={`${label} limit: ${status}${rl.isUsingOverage ? ' (using overage)' : ''}${resets ? ` · ${resets}` : ''}`}>
      {ok ? '●' : '▲'} {label}{usedPct}{rl.isUsingOverage ? ' · overage' : ''}
      {/* Compact (sidebar) chip keeps the reset clock in the tooltip only, to stay narrow. */}
    </span>
  )
}

// Account-level quota chips (Session / Weekly) for the sidebar header. These windows
// are account-global — the same for every session — so they belong once in the mutual
// sidebar column, not inside any single session's MetaBar.
//
// PREFER the polled `/api/usage` endpoint (a continuous session + weekly %). Only when
// it's unavailable (no OAuth token / offline) fall back to the stream's rate_limit_event
// data — and there, pool every session's limits and keep the MOST-INFORMED reading per
// window (highest %, latest reset). The CLI only emits usage near a limit, so one idle
// session may know nothing while another already saw the window; pooling picks whichever
// session is best informed.
export function SidebarUsage() {
  const { sessions } = useSessions()
  const { metaFor } = useChat()
  const usage = useUsage()

  const usageChips: RateLimitInfo[] = usage.map((w) => ({
    rateLimitType: w.group === 'session' ? 'five_hour' : 'seven_day',
    percentUsed: w.percent,
    resetsAt: w.resetsAt,
    status: w.severity && w.severity !== 'normal' ? w.severity : 'allowed',
  }))

  // Only the stream fallback ages out (the endpoint refreshes itself on its poll), so
  // tick to self-clear expired windows only when we're actually in fallback mode.
  const now = useNow(usageChips.length ? null : 30_000)

  const pooled = new Map<string, RateLimitInfo>()
  for (const s of sessions) {
    const limits = metaFor(s.id).limits
    if (!limits) continue
    for (const rl of Object.values(limits)) {
      const key = isWeekly(rl.rateLimitType) ? 'weekly' : rl.rateLimitType ?? 'limit'
      const cur = pooled.get(key)
      const better = !cur
        || (rl.percentUsed ?? 0) > (cur.percentUsed ?? 0)
        || ((rl.percentUsed ?? 0) === (cur.percentUsed ?? 0) && (rl.resetsAt ?? 0) > (cur.resetsAt ?? 0))
      if (better) pooled.set(key, rl)
    }
  }
  const streamChips = [...pooled.values()]
    .filter((rl) => !(rl.resetsAt && rl.resetsAt * 1000 <= now))
    .filter((rl) => !isWeekly(rl.rateLimitType) || (rl.percentUsed ?? 0) > 85)

  const limits = (usageChips.length ? usageChips : streamChips)
    .sort((a, b) => limitRank(a.rateLimitType) - limitRank(b.rateLimitType))

  if (!limits.length) return null
  return (
    <span className="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-ctp-overlay normal-case tracking-normal">
      {limits.map((rl) => <RateChip key={rl.rateLimitType ?? 'limit'} rl={rl} />)}
    </span>
  )
}

// Interactive AskUserQuestion: the user picks option(s) per question; the
// selection is fed back as the tool's answer (updatedInput.answers, keyed by
// question text). Single-select picks one; multiSelect toggles several; an
// "Other…" field allows a free-text answer.
interface AskQuestion { question: string; header?: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }
function AskUserQuestionCard({ input, onAnswer, onDismiss }: {
  input: unknown
  onAnswer: (answers: Record<string, string>) => void
  onDismiss: () => void
}) {
  const qs: AskQuestion[] = Array.isArray((input as { questions?: unknown })?.questions)
    ? ((input as { questions: AskQuestion[] }).questions)
    : []
  const [sel, setSel] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})

  const toggle = (qi: number, label: string, multi: boolean) =>
    setSel((s) => {
      const cur = s[qi] ?? []
      if (!multi) return { ...s, [qi]: [label] }
      return { ...s, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] }
    })

  const valueFor = (qi: number): string => {
    const chosen = [...(sel[qi] ?? [])]
    const o = other[qi]?.trim()
    if (o) chosen.push(o)
    return chosen.join(', ')
  }
  const answered = qs.length > 0 && qs.every((_, qi) => valueFor(qi).length > 0)

  const submit = () => {
    const answers: Record<string, string> = {}
    qs.forEach((q, qi) => { answers[q.question] = valueFor(qi) })
    onAnswer(answers)
  }

  return (
    // BOUNDED, with the actions OUTSIDE the scrolling part. Slice 1 pinned this card as a
    // `shrink-0` sibling of the transcript, which fixed "the prompt scrolls away" — but this
    // card had no height bound at all, so it could neither shrink nor scroll and simply grew
    // past the fold. Measured at 390×844 with the worst case the tool actually permits
    // (4 questions × 4 options, each with a description, plus the per-question Other input):
    // card 1578px tall in an 844px viewport, Submit 873px BELOW the fold and unreachable.
    // That is a worse failure than the one slice 1 replaced — AskUserQuestion is in
    // ALWAYS_PROMPT, so it is the one card guaranteed to need a human.
    //
    // The questions scroll; Submit/Dismiss are a sibling of that region, so they are
    // reachable at ANY payload size. PermissionCard already uses this shape (max-h on its
    // detail region, buttons outside it) — this makes the two consistent.
    //
    // Sized off `--vvh` (lib/visualViewport.ts), NOT `vh`. On iOS the software keyboard does
    // not shrink the layout viewport, so `60vh` stayed 506px while the keyboard left ~508px
    // VISIBLE — measured: Submit at 669px passes a check against innerHeight and is hidden by
    // 161px in reality. The card's own free-text input is what raises the keyboard, so the
    // interaction that needs Submit is the one that hides it. `100vh` is the fallback for
    // browsers without visualViewport, where the two are the same thing anyway.
    <div className="rounded-lg border border-ctp-blue/50 bg-ctp-blue/10 px-3 py-2.5 flex flex-col gap-3 min-h-0 max-h-[calc(var(--vvh,100vh)*0.55)]">
      <div className="space-y-3 overflow-y-auto min-h-0 pr-1">
      {qs.map((q, qi) => (
        <div key={qi} className="space-y-1">
          <div className="text-xs text-ctp-text font-medium">{q.question}</div>
          <div className="flex flex-col gap-1">
            {q.options.map((op, oi) => {
              const active = (sel[qi] ?? []).includes(op.label)
              return (
                <button
                  key={oi}
                  onClick={() => toggle(qi, op.label, !!q.multiSelect)}
                  className={`text-left text-xs px-2 py-1 rounded border transition-colors ${active ? 'border-ctp-blue bg-ctp-blue/20 text-ctp-text' : 'border-ctp-surface1 text-ctp-subtext hover:bg-ctp-surface0'}`}
                >
                  <span className="font-medium break-words">{op.label}</span>
                  {op.description ? <span className="text-ctp-overlay break-words"> — {op.description}</span> : null}
                </button>
              )
            })}
            <input
              value={other[qi] ?? ''}
              onChange={(e) => setOther((s) => ({ ...s, [qi]: e.target.value }))}
              placeholder="Other…"
              className="text-xs px-2 py-1 rounded bg-ctp-surface0 text-ctp-text outline-none placeholder:text-ctp-overlay focus:ring-1 focus:ring-ctp-blue"
            />
          </div>
        </div>
      ))}
      </div>
      <div className="flex gap-2 shrink-0">
        <button onClick={submit} disabled={!answered} className="text-xs px-3 py-0.5 rounded bg-ctp-blue/80 hover:bg-ctp-blue text-ctp-base font-medium disabled:opacity-40 disabled:cursor-not-allowed">
          Submit
        </button>
        <button onClick={onDismiss} className="text-xs px-3 py-0.5 rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-subtext">
          Dismiss
        </button>
      </div>
    </div>
  )
}

function PermissionCard({
  toolName, description, input, suggestions, onAllow, onAllowAlways, onDeny,
}: {
  toolName: string; description?: string; input: unknown; suggestions: unknown[]
  onAllow: () => void; onAllowAlways: () => void; onDeny: () => void
}) {
  const headline = toolHeadline(toolName, (input ?? {}) as Record<string, unknown>)
  const always = suggestions.length > 0 ? suggestionLabel(suggestions) : undefined
  return (
    <div className="rounded-lg border border-ctp-yellow/50 bg-ctp-yellow/10 px-3 py-2.5">
      <div className="text-xs text-ctp-yellow font-medium mb-0.5">
        {headline}?
      </div>
      <div className="text-[10px] text-ctp-overlay mb-1.5">
        {toolName}{description && description !== headline ? ` · ${description}` : ''}
      </div>
      <div className="text-[11px] text-ctp-subtext max-h-48 overflow-y-auto mb-2 pr-1">
        <ToolDetail name={toolName} input={input} />
      </div>
      <div className="flex gap-2 flex-wrap">
        <button onClick={onAllow} className="text-xs px-3 py-0.5 rounded bg-ctp-green/80 hover:bg-ctp-green text-ctp-base font-medium">
          Allow once
        </button>
        {always && (
          <button onClick={onAllowAlways} className="text-xs px-3 py-0.5 rounded bg-ctp-green/20 hover:bg-ctp-green/30 text-ctp-green font-medium">
            {always}
          </button>
        )}
        <button onClick={onDeny} className="text-xs px-3 py-0.5 rounded bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-subtext">
          Deny
        </button>
      </div>
    </div>
  )
}

// Label the "allow always" button from the request's first permission suggestion.
function suggestionLabel(suggestions: unknown[]): string {
  const s = suggestions[0] as { type?: string; mode?: string; destination?: string; rules?: Array<{ toolName?: string; ruleContent?: string }> }
  if (s?.type === 'setMode') {
    if (s.mode === 'acceptEdits') return 'Accept edits (session)'
    return `Switch to ${s.mode}`
  }
  if (s?.type === 'addRules') {
    const r = s.rules?.[0]
    const name = r ? (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName) : ''
    const persists = s.destination && s.destination !== 'session'
    return `Always allow ${name}${persists ? '' : ' (session)'}`
  }
  return "Allow, don't ask"
}
