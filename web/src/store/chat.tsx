import {
  createContext, useContext, useReducer, useEffect, useCallback, useRef, type ReactNode,
} from 'react'
import type { ClaudeEvent, PermissionRequest, PermissionDecision } from '@claudette/shared'
import { api } from '../api/client'

// Ported from ClaudeMaster's renderer chat store. The only transport change:
// `window.api` (Electron IPC) → `api` (the WS/HTTP client). ClaudeMaster's
// /resume + persisted-meta hydration are trimmed for Phase 1 (no conversations
// route yet); the reducer + stream-json → transcript reduction are unchanged.

// One rendered entry in a session's transcript. Built from completed stream-json
// events (assistant / user tool_result / result), with token-level streaming of
// text/thinking layered on via stream_event deltas.
export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string; streaming?: boolean }
  | { kind: 'thinking'; id: string; text: string; streaming?: boolean }
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; toolUseId: string; isError: boolean; content: string }
  | { kind: 'result'; id: string; isError: boolean; costUsd?: number; durationMs?: number; errorText?: string }
  | { kind: 'notice'; id: string; text: string }

export interface RateLimitInfo {
  status?: string
  resetsAt?: number
  rateLimitType?: string
  overageStatus?: string
  isUsingOverage?: boolean
  percentUsed?: number
}
export interface SessionMeta {
  model?: string
  contextTokens?: number
  contextWindow?: number
  costUsd?: number
  limits?: Record<string, RateLimitInfo>
}

interface State {
  transcripts: Record<string, TranscriptItem[]>
  pending: Record<string, PermissionRequest | undefined>
  slash: Record<string, string[]>
  open: Record<string, Record<number, string>>
  meta: Record<string, SessionMeta>
}

type Action =
  | { type: 'APPEND'; sessionId: string; items: TranscriptItem[] }
  | { type: 'LOAD'; sessionId: string; items: TranscriptItem[] }
  | { type: 'STREAM_START'; sessionId: string; index: number; kind: 'text' | 'thinking' }
  | { type: 'STREAM_DELTA'; sessionId: string; index: number; text: string }
  | { type: 'STREAM_STOP'; sessionId: string; index: number }
  | { type: 'SET_PENDING'; sessionId: string; req: PermissionRequest }
  | { type: 'CLEAR_PENDING'; sessionId: string }
  | { type: 'SET_SLASH'; sessionId: string; commands: string[] }
  | { type: 'SET_META'; sessionId: string; meta: Partial<SessionMeta> }
  | { type: 'SET_LIMIT'; sessionId: string; limitType: string; info: RateLimitInfo }
  | { type: 'CLEAR'; sessionId: string }

let seq = 0
const nextId = () => `i${++seq}`

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'APPEND': {
      const prev = state.transcripts[action.sessionId] ?? []
      return { ...state, transcripts: { ...state.transcripts, [action.sessionId]: [...prev, ...action.items] } }
    }
    case 'LOAD': {
      const open = { ...state.open }; delete open[action.sessionId]
      return { ...state, open, transcripts: { ...state.transcripts, [action.sessionId]: action.items } }
    }
    case 'STREAM_START': {
      const id = nextId()
      const prev = state.transcripts[action.sessionId] ?? []
      return {
        ...state,
        transcripts: { ...state.transcripts, [action.sessionId]: [...prev, { kind: action.kind, id, text: '', streaming: true }] },
        open: { ...state.open, [action.sessionId]: { ...(state.open[action.sessionId] ?? {}), [action.index]: id } },
      }
    }
    case 'STREAM_DELTA': {
      const id = state.open[action.sessionId]?.[action.index]
      if (!id) return state
      const prev = state.transcripts[action.sessionId] ?? []
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [action.sessionId]: prev.map((it) =>
            it.id === id && (it.kind === 'text' || it.kind === 'thinking') ? { ...it, text: it.text + action.text } : it),
        },
      }
    }
    case 'STREAM_STOP': {
      const openS = { ...(state.open[action.sessionId] ?? {}) }
      const id = openS[action.index]
      delete openS[action.index]
      const prev = state.transcripts[action.sessionId] ?? []
      return {
        ...state,
        open: { ...state.open, [action.sessionId]: openS },
        transcripts: {
          ...state.transcripts,
          [action.sessionId]: prev.map((it) =>
            it.id === id && (it.kind === 'text' || it.kind === 'thinking') ? { ...it, streaming: false } : it),
        },
      }
    }
    case 'SET_META':
      return { ...state, meta: { ...state.meta, [action.sessionId]: { ...(state.meta[action.sessionId] ?? {}), ...action.meta } } }
    case 'SET_LIMIT': {
      const m = state.meta[action.sessionId] ?? {}
      return {
        ...state,
        meta: { ...state.meta, [action.sessionId]: { ...m, limits: { ...(m.limits ?? {}), [action.limitType]: action.info } } },
      }
    }
    case 'SET_PENDING':
      return { ...state, pending: { ...state.pending, [action.sessionId]: action.req } }
    case 'CLEAR_PENDING': {
      const pending = { ...state.pending }
      delete pending[action.sessionId]
      return { ...state, pending }
    }
    case 'SET_SLASH':
      return { ...state, slash: { ...state.slash, [action.sessionId]: action.commands } }
    case 'CLEAR': {
      const transcripts = { ...state.transcripts }; delete transcripts[action.sessionId]
      const pending = { ...state.pending }; delete pending[action.sessionId]
      const slash = { ...state.slash }; delete slash[action.sessionId]
      const open = { ...state.open }; delete open[action.sessionId]
      const meta = { ...state.meta }; delete meta[action.sessionId]
      return { transcripts, pending, slash, open, meta }
    }
    default:
      return state
  }
}

// Normalize a tool_result's `content` (string | block array) to display text.
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('')
  }
  return content == null ? '' : JSON.stringify(content)
}

// Best-effort human message for an errored result event.
function resultErrorText(e: ClaudeEvent): string {
  const r = e as Record<string, unknown>
  const raw = [r.result, r.api_error_status, r.error, r.subtype]
    .map((v) => (typeof v === 'string' ? v : v ? JSON.stringify(v) : ''))
    .find((s) => s && s !== 'success' && s !== 'null') ?? 'The turn ended with an error.'
  const s = String(raw)
  if (/usage limit|rate.?limit|429|quota/i.test(s)) return `Usage limit reached — ${s}`
  if (/overloaded|529|503/i.test(s)) return `The model is overloaded right now — ${s}`
  if (/max.?turns/i.test(s)) return 'Stopped: reached the maximum number of turns for one request.'
  if (/error_during_execution/i.test(s)) return 'Claude hit an internal error partway through this turn (error_during_execution). This is usually transient — send the message again.'
  if (/error_max_output|max.?tokens/i.test(s)) return 'Stopped: hit the maximum output length for one turn.'
  return /^[a-z0-9_]+$/i.test(s) ? `The turn ended with an error (${s}).` : s
}

// Turn one raw stream-json event into transcript items.
function itemsFromEvent(e: ClaudeEvent, fromReplay = false): TranscriptItem[] {
  const out: TranscriptItem[] = []
  if (e.type === 'assistant') {
    const content = (e as { message?: { content?: unknown[] } }).message?.content ?? []
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use') out.push({ kind: 'tool_use', id: nextId(), name: String(b.name), input: b.input })
      else if (fromReplay && b.type === 'text' && b.text) out.push({ kind: 'text', id: nextId(), text: String(b.text) })
      else if (fromReplay && b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', id: nextId(), text: String(b.thinking) })
    }
  } else if (e.type === 'user') {
    const content = (e as { message?: { content?: unknown[] } }).message?.content ?? []
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_result') {
        out.push({
          kind: 'tool_result', id: nextId(),
          toolUseId: String(b.tool_use_id), isError: b.is_error === true, content: resultText(b.content),
        })
      }
    }
  } else if (e.type === 'result') {
    const isError = (e as { is_error?: boolean }).is_error === true
      || /error/i.test(String((e as { subtype?: string }).subtype ?? ''))
    out.push({
      kind: 'result', id: nextId(),
      isError,
      costUsd: (e as { total_cost_usd?: number }).total_cost_usd,
      durationMs: (e as { duration_ms?: number }).duration_ms,
      errorText: isError ? resultErrorText(e) : undefined,
    })
  } else if (e.type === 'stderr' && e.text) {
    out.push({ kind: 'notice', id: nextId(), text: String(e.text) })
  }
  return out
}

// Translate one wrapped Anthropic streaming event into stream actions.
function handleStreamEvent(dispatch: (a: Action) => void, sessionId: string, ev?: Record<string, unknown>): void {
  if (!ev) return
  const index = ev.index as number
  if (ev.type === 'content_block_start') {
    const bt = (ev.content_block as { type?: string })?.type
    if (bt === 'text' || bt === 'thinking') dispatch({ type: 'STREAM_START', sessionId, index, kind: bt })
  } else if (ev.type === 'content_block_delta') {
    const d = ev.delta as { type?: string; text?: string; thinking?: string }
    if (d?.type === 'text_delta' && d.text) dispatch({ type: 'STREAM_DELTA', sessionId, index, text: d.text })
    else if (d?.type === 'thinking_delta' && d.thinking) dispatch({ type: 'STREAM_DELTA', sessionId, index, text: d.thinking })
  } else if (ev.type === 'content_block_stop') {
    dispatch({ type: 'STREAM_STOP', sessionId, index })
  }
}

// A single model's slice of a result event's `modelUsage` map.
interface ModelUsage { contextWindow?: number; inputTokens?: number }

// Pick the context window for the MAIN conversation model. `modelUsage` regularly
// holds several models — the main model plus small/fast helpers (e.g. a haiku sub-
// call), each with its OWN window (200k vs 1M). Keying by the session's model is
// essential: `Object.values(mu)[0]` grabs an arbitrary entry, so the meter would
// divide the fill by the wrong model's window and report a nonsense percentage.
function pickWindow(mu: Record<string, ModelUsage>, knownModel?: string): number | undefined {
  if (knownModel && typeof mu[knownModel]?.contextWindow === 'number') return mu[knownModel].contextWindow
  // No known model yet (e.g. before init on replay): fall back to the model that
  // processed the most input — the one carrying the real conversation context.
  let best: ModelUsage | undefined
  for (const v of Object.values(mu)) {
    if (typeof v?.contextWindow !== 'number') continue
    if (!best || (v.inputTokens ?? 0) > (best.inputTokens ?? 0)) best = v
  }
  return best?.contextWindow
}

// Cost (cumulative) + context-window size from a result event. Context *fill* is
// taken per assistant message instead (contextFromAssistant), since result.usage
// is cumulative over a turn's internal calls and overcounts cache reads.
function metaFromResult(e: ClaudeEvent, knownModel?: string): Partial<SessionMeta> {
  const meta: Partial<SessionMeta> = {}
  const cost = (e as { total_cost_usd?: unknown }).total_cost_usd
  if (typeof cost === 'number') meta.costUsd = cost
  const mu = (e as { modelUsage?: Record<string, ModelUsage> }).modelUsage
  if (mu && typeof mu === 'object') {
    const cw = pickWindow(mu, knownModel)
    if (typeof cw === 'number') meta.contextWindow = cw
  }
  return meta
}

// Context fill = tokens processed as context on the LATEST assistant call.
function contextFromAssistant(e: ClaudeEvent): Partial<SessionMeta> | null {
  const u = (e as { message?: { usage?: Record<string, number> } }).message?.usage
  if (!u) return null
  return { contextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) }
}

// Rebuild the MetaBar figures from a resumed conversation's replayed events. The
// live handler only folds meta from events as they stream, so without this a
// resume would blank the model/context/cost until the next turn. Scans in order so
// the last values win, and resolves the window against the model in play.
function metaFromReplay(events: ClaudeEvent[]): Partial<SessionMeta> {
  const meta: Partial<SessionMeta> = {}
  for (const e of events) {
    if (e.type === 'system' && (e as { subtype?: string }).subtype === 'init') {
      const m = (e as { model?: unknown }).model
      if (typeof m === 'string') meta.model = m
    } else if (e.type === 'assistant') {
      const am = (e as { message?: { model?: unknown } }).message?.model
      if (typeof am === 'string') meta.model = am
      const cm = contextFromAssistant(e)
      if (cm?.contextTokens != null) meta.contextTokens = cm.contextTokens
    } else if (e.type === 'result') {
      Object.assign(meta, metaFromResult(e, meta.model))
    }
  }
  return meta
}

interface ContextValue {
  transcriptFor: (sessionId: string) => TranscriptItem[]
  pendingFor: (sessionId: string) => PermissionRequest | undefined
  slashCommandsFor: (sessionId: string) => string[]
  metaFor: (sessionId: string) => SessionMeta
  sendTurn: (sessionId: string, text: string) => void
  interrupt: (sessionId: string) => void
  respond: (sessionId: string, requestId: string, decision: PermissionDecision) => void
  loadTranscript: (sessionId: string, events: ClaudeEvent[]) => void
  clearTranscript: (sessionId: string) => void
}

const ChatContext = createContext<ContextValue | null>(null)

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { transcripts: {}, pending: {}, slash: {}, open: {}, meta: {} })
  const stateRef = useRef(state); stateRef.current = state

  useEffect(() => {
    const offEvent = api.on.event((id, e) => {
      // init: capture slash-command catalog + model.
      if (e.type === 'system' && (e as { subtype?: string }).subtype === 'init') {
        const cmds = (e as { slash_commands?: unknown }).slash_commands
        if (Array.isArray(cmds)) dispatch({ type: 'SET_SLASH', sessionId: id, commands: cmds.map(String) })
        const model = (e as { model?: unknown }).model
        if (typeof model === 'string') dispatch({ type: 'SET_META', sessionId: id, meta: { model } })
        return
      }
      // Token-level streaming of text/thinking blocks.
      if (e.type === 'stream_event') {
        handleStreamEvent(dispatch, id, (e as { event?: Record<string, unknown> }).event)
        return
      }
      // App-control channel status (surfaced as a notice; conversation unaffected).
      if (e.type === 'app_control') {
        const reason = (e as { reason?: string }).reason
        if (reason) dispatch({ type: 'APPEND', sessionId: id, items: [{ kind: 'notice', id: nextId(), text: `⚠ ${reason}` }] })
        return
      }
      // Proactive rate/usage limit info (drives the session/weekly chips).
      if (e.type === 'rate_limit_event') {
        const info = (e as { rate_limit_info?: RateLimitInfo }).rate_limit_info
        if (info) dispatch({ type: 'SET_LIMIT', sessionId: id, limitType: info.rateLimitType ?? 'limit', info })
        return
      }
      // Each assistant message reports the context size of that model call.
      if (e.type === 'assistant') {
        const cm = contextFromAssistant(e)
        if (cm) dispatch({ type: 'SET_META', sessionId: id, meta: cm })
      }
      // Turn end: cumulative cost + context-window size (keyed to the session model).
      if (e.type === 'result') {
        const knownModel = stateRef.current.meta[id]?.model
        dispatch({ type: 'SET_META', sessionId: id, meta: metaFromResult(e, knownModel) })
      }
      const items = itemsFromEvent(e)
      if (items.length) dispatch({ type: 'APPEND', sessionId: id, items })
    })
    const offPerm = api.on.permission((id, req) => {
      dispatch({ type: 'SET_PENDING', sessionId: id, req })
    })
    // A finished/interrupted turn clears any stale prompt defensively.
    const offState = api.on.stateChange((id, s) => {
      if (s === 'idle' && stateRef.current.pending[id]) dispatch({ type: 'CLEAR_PENDING', sessionId: id })
    })
    return () => { offEvent(); offPerm(); offState() }
  }, [])

  const sendTurn = useCallback((sessionId: string, text: string) => {
    const t = text.trim()
    if (!t) return
    // Optimistic local echo (we don't pass --replay-user-messages, so no dup).
    dispatch({ type: 'APPEND', sessionId, items: [{ kind: 'user', id: nextId(), text: t }] })
    api.session.sendTurn(sessionId, t)
  }, [])

  const interrupt = useCallback((sessionId: string) => {
    api.session.interrupt(sessionId)
  }, [])

  const respond = useCallback((sessionId: string, requestId: string, decision: PermissionDecision) => {
    api.session.respondPermission(sessionId, requestId, decision)
    dispatch({ type: 'CLEAR_PENDING', sessionId })
  }, [])

  // Replace a session's transcript with a resumed conversation's history.
  const loadTranscript = useCallback((sessionId: string, events: ClaudeEvent[]) => {
    const items = events.flatMap((e) => itemsFromEvent(e, true))
    dispatch({ type: 'LOAD', sessionId, items })
    // Repopulate the MetaBar from history so a resume doesn't blank it out.
    const meta = metaFromReplay(events)
    if (Object.keys(meta).length) dispatch({ type: 'SET_META', sessionId, meta })
  }, [])

  // Full reset for /clear: wipe transcript, pending, and meta.
  const clearTranscript = useCallback((sessionId: string) => {
    dispatch({ type: 'CLEAR', sessionId })
  }, [])

  const transcriptFor = useCallback((sessionId: string) => state.transcripts[sessionId] ?? [], [state.transcripts])
  const pendingFor = useCallback((sessionId: string) => state.pending[sessionId], [state.pending])
  const slashCommandsFor = useCallback((sessionId: string) => state.slash[sessionId] ?? [], [state.slash])
  const metaFor = useCallback((sessionId: string) => state.meta[sessionId] ?? {}, [state.meta])

  return (
    <ChatContext.Provider value={{ transcriptFor, pendingFor, slashCommandsFor, metaFor, sendTurn, interrupt, respond, loadTranscript, clearTranscript }}>
      {children}
    </ChatContext.Provider>
  )
}

export function useChat(): ContextValue {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat must be used within ChatProvider')
  return ctx
}
