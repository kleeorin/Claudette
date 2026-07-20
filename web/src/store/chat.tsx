import {
  createContext, useContext, useReducer, useEffect, useCallback, useMemo, useRef, type ReactNode,
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
  | { kind: 'text'; id: string; text: string; streaming?: boolean; parentId?: string }
  | { kind: 'thinking'; id: string; text: string; streaming?: boolean; parentId?: string }
  // `toolId` = the anthropic tool_use block id (`toolu_…`); pairs a call with its
  // tool_result and, for a `Task`, links its subagent's activity. `parentId` =
  // `parent_tool_use_id`: set on a SUBAGENT's own calls/results, matching the parent
  // Task's `toolId` — lets the UI nest an agent's work under its card.
  | { kind: 'tool_use'; id: string; name: string; input: unknown; toolId?: string; parentId?: string }
  | { kind: 'tool_result'; id: string; toolUseId: string; isError: boolean; content: string; parentId?: string }
  | { kind: 'result'; id: string; isError: boolean; costUsd?: number; durationMs?: number; errorText?: string }
  | { kind: 'notice'; id: string; text: string }

export interface RateLimitInfo {
  status?: string
  resetsAt?: number
  rateLimitType?: string
  isUsingOverage?: boolean
  // NOTE: current CLIs (≥2.1) no longer put a usage fraction in `rate_limit_event` —
  // the info is just {status, resetsAt, rateLimitType}. `utilization` (a 0–1 fraction,
  // older CLIs) is still normalized into `percentUsed` (0–100) when present, so the
  // chip shows a % on a CLI that provides one; otherwise it shows status + reset time.
  utilization?: number
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
  // A QUEUE of unanswered permission prompts per session (the CLI can have several
  // outstanding at once from parallel tool_uses). The UI answers them one at a time.
  pending: Record<string, PermissionRequest[]>
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
  // A completed (live) assistant message. Reconciles its text/thinking blocks against
  // what was streamed: a block the client streamed is finalized in place; a block it
  // never saw stream (e.g. a device that joined mid-turn) is materialized fresh — so
  // text isn't lost for a late/second client. tool_use blocks are appended as before.
  | { type: 'ASSISTANT'; sessionId: string; blocks: AssistantBlock[] }
  | { type: 'MSG_START'; sessionId: string }   // a new assistant message → reset the per-message block map
  | { type: 'ADD_PENDING'; sessionId: string; req: PermissionRequest }        // one new prompt (dedup by requestId)
  | { type: 'SET_PENDING'; sessionId: string; reqs: PermissionRequest[] }     // replace the whole queue (snapshot)
  | { type: 'REMOVE_PENDING'; sessionId: string; requestId: string }          // one prompt answered/resolved
  | { type: 'CLEAR_PENDING'; sessionId: string }                              // drop the whole queue
  | { type: 'SET_SLASH'; sessionId: string; commands: string[] }
  | { type: 'SET_META'; sessionId: string; meta: Partial<SessionMeta> }
  | { type: 'SET_LIMIT'; sessionId: string; limitType: string; info: RateLimitInfo }
  | { type: 'CLEAR_LIMITS'; sessionId: string }
  | { type: 'CLEAR'; sessionId: string }

// One content block of a completed assistant message; `index` matches the stream
// event's block index so we can pair it with the item built from that block's deltas.
interface AssistantBlock { index: number; kind: 'text' | 'thinking' | 'tool_use'; text?: string; name?: string; input?: unknown; toolId?: string }

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
      // Keep the index→id mapping in `open` (don't delete it): the completed ASSISTANT
      // event still needs it to pair this block with its streamed item and finalize
      // the authoritative text. `open` for the message is cleared when ASSISTANT lands.
      const id = state.open[action.sessionId]?.[action.index]
      const prev = state.transcripts[action.sessionId] ?? []
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [action.sessionId]: prev.map((it) =>
            it.id === id && (it.kind === 'text' || it.kind === 'thinking') ? { ...it, streaming: false } : it),
        },
      }
    }
    case 'ASSISTANT': {
      const sid = action.sessionId
      const openMap = state.open[sid] ?? {}   // index → item id for this message's blocks
      const nextOpen = { ...openMap }
      let list = state.transcripts[sid] ?? []
      const append: TranscriptItem[] = []
      for (const b of action.blocks) {
        if (b.kind === 'tool_use') {
          append.push({ kind: 'tool_use', id: nextId(), name: b.name ?? '', input: b.input, toolId: b.toolId })
          continue
        }
        const knownId = openMap[b.index]
        if (knownId) {
          // We already have this block's item (streamed here, or materialized from an
          // earlier partial assistant snapshot). Finalize it IN PLACE with the
          // authoritative text — so a repeated/cumulative assistant event for the same
          // message re-settles the same item instead of appending a duplicate.
          list = list.map((it) => it.id === knownId && (it.kind === 'text' || it.kind === 'thinking')
            ? { ...it, text: b.text ?? it.text, streaming: false } : it)
        } else if (b.text) {
          // No item for this block yet (a device that joined mid-turn never streamed it).
          // Materialize it AND register its id under this block index, so a later
          // cumulative snapshot of the SAME message finalizes it in place rather than
          // materializing a second copy. `open` is reset per message on `message_start`.
          const newId = nextId()
          append.push({ kind: b.kind, id: newId, text: b.text })
          nextOpen[b.index] = newId
        }
      }
      return {
        ...state,
        open: { ...state.open, [sid]: nextOpen },
        transcripts: { ...state.transcripts, [sid]: append.length ? [...list, ...append] : list },
      }
    }
    case 'MSG_START': {
      // A new assistant message starts here: reset the per-message index→item map so
      // its blocks (numbered from 0 again) can't collide with the previous message's.
      const open = { ...state.open }; delete open[action.sessionId]
      return { ...state, open }
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
    case 'CLEAR_LIMITS': {
      const m = state.meta[action.sessionId]
      if (!m?.limits) return state
      const next = { ...m }; delete next.limits
      return { ...state, meta: { ...state.meta, [action.sessionId]: next } }
    }
    case 'ADD_PENDING': {
      const cur = state.pending[action.sessionId] ?? []
      if (cur.some((r) => r.requestId === action.req.requestId)) return state   // dedup (echo/replay)
      return { ...state, pending: { ...state.pending, [action.sessionId]: [...cur, action.req] } }
    }
    case 'SET_PENDING':
      return { ...state, pending: { ...state.pending, [action.sessionId]: action.reqs } }
    case 'REMOVE_PENDING': {
      const cur = state.pending[action.sessionId]
      if (!cur?.length) return state
      return { ...state, pending: { ...state.pending, [action.sessionId]: cur.filter((r) => r.requestId !== action.requestId) } }
    }
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

// Fold a `rate_limit_event` into meta. Current CLIs name the window (`rateLimitType`,
// e.g. "five_hour") and give its status + reset time, but NO usage fraction — so the
// chip shows status + reset (no %). Older CLIs sent `utilization` (0–1) which we still
// normalize to `percentUsed` (0–100) when present. A truly bare `allowed` event (no
// window at all) means we've recovered: clear stale warning/overage chips, so an old
// "overage 101%" value doesn't latch on the chip forever (there's no "0%" update).
function applyRateLimit(dispatch: (a: Action) => void, sessionId: string, e: { rate_limit_info?: RateLimitInfo }): void {
  const info = e.rate_limit_info
  if (!info) return
  if (!info.rateLimitType && (info.status ?? 'allowed') === 'allowed') {
    dispatch({ type: 'CLEAR_LIMITS', sessionId })
    return
  }
  const percentUsed = typeof info.percentUsed === 'number' ? info.percentUsed
    : typeof info.utilization === 'number' ? info.utilization * 100
    : undefined
  dispatch({ type: 'SET_LIMIT', sessionId, limitType: info.rateLimitType ?? 'limit', info: { ...info, percentUsed } })
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

// Parse a completed assistant event's content into ordered blocks (with their index)
// for the ASSISTANT reducer to reconcile against streamed items.
function parseAssistantBlocks(e: ClaudeEvent): AssistantBlock[] {
  const content = (e as { message?: { content?: unknown[] } }).message?.content ?? []
  const blocks: AssistantBlock[] = []
  content.forEach((raw, index) => {
    const b = raw as Record<string, unknown>
    if (b.type === 'tool_use') blocks.push({ index, kind: 'tool_use', name: String(b.name), input: b.input, toolId: typeof b.id === 'string' ? b.id : undefined })
    else if (b.type === 'text' && typeof b.text === 'string' && b.text) blocks.push({ index, kind: 'text', text: b.text })
    else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) blocks.push({ index, kind: 'thinking', text: b.thinking })
  })
  return blocks
}

// Turn one raw stream-json event into transcript items.
function itemsFromEvent(e: ClaudeEvent, fromReplay = false): TranscriptItem[] {
  const out: TranscriptItem[] = []
  // On a subagent's own events this is the parent Task's tool id — tag its items so
  // the UI can nest them under that agent's card.
  const parentId = (() => { const p = (e as { parent_tool_use_id?: unknown }).parent_tool_use_id; return typeof p === 'string' && p ? p : undefined })()
  if (e.type === 'assistant') {
    const content = (e as { message?: { content?: unknown[] } }).message?.content ?? []
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use') out.push({ kind: 'tool_use', id: nextId(), name: String(b.name), input: b.input, toolId: typeof b.id === 'string' ? b.id : undefined, parentId })
      // A SUBAGENT's text/thinking (parentId set) is always captured — it's the agent's
      // chain of thought, shown in its tray card. The MAIN agent's live text/thinking
      // arrives via the stream path (reconciled by ASSISTANT), so here it's replay-only.
      else if ((fromReplay || parentId) && b.type === 'text' && b.text) out.push({ kind: 'text', id: nextId(), text: String(b.text), parentId })
      else if ((fromReplay || parentId) && b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', id: nextId(), text: String(b.thinking), parentId })
    }
  } else if (e.type === 'user') {
    const content = (e as { message?: { content?: unknown } }).message?.content
    // A <task-notification> is a background agent's completion signal. Synthesize the
    // terminal tool_result its Task tool_use is still waiting on, so collectAgents can
    // settle the tray card to done/failed. Handled before the branches below because
    // the notification can arrive as either string or block content.
    const notif = parseTaskNotification(userContentText(content))
    if (notif) {
      out.push({ kind: 'tool_result', id: nextId(), toolUseId: notif.toolUseId, isError: notif.isError, content: notif.summary })
      return out
    }
    if (typeof content === 'string') {
      // A resumed conversation records your prompts as string-content user turns;
      // surface them as user bubbles (replay only — live turns are echoed locally).
      if (fromReplay && content.trim()) out.push({ kind: 'user', id: nextId(), text: content })
    } else if (Array.isArray(content)) {
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === 'tool_result') {
          out.push({
            kind: 'tool_result', id: nextId(),
            toolUseId: String(b.tool_use_id), isError: b.is_error === true, content: resultText(b.content), parentId,
          })
        } else if (fromReplay && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ kind: 'user', id: nextId(), text: b.text })
        }
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
  // Start of a new assistant message: reset the block-index map so this message's
  // blocks (numbered from 0) don't pair with the previous message's streamed items.
  if (ev.type === 'message_start') { dispatch({ type: 'MSG_START', sessionId }); return }
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
  // No known model yet (e.g. before init on replay): the main conversation model is the
  // one with the LARGEST context window (helper models like haiku carry a smaller 200k
  // window). Picking by inputTokens misfires under prompt caching — the main model's
  // fresh input_tokens can be ~0 while its real context sits in cache_read.
  let best: ModelUsage | undefined
  for (const v of Object.values(mu)) {
    if (typeof v?.contextWindow !== 'number') continue
    if (!best || v.contextWindow > (best.contextWindow ?? 0)) best = v
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

// A subagent (Task) message is nested under a Task tool_use: it carries
// `parent_tool_use_id` on the live stream (or `isSidechain` on replayed transcript
// events). Its model/usage belong to the SUBagent, not the session — folding its
// context into the meter is what made the ctx bar jump to the agent's window. Gate
// every meta-from-assistant update on this so the meter stays the session's own.
function isSubagentEvent(e: ClaudeEvent): boolean {
  const o = e as { parent_tool_use_id?: unknown; isSidechain?: unknown }
  return (o.parent_tool_use_id != null && o.parent_tool_use_id !== '') || o.isSidechain === true
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
    } else if (e.type === 'assistant' && !isSubagentEvent(e)) {
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

// The tool the model calls to spawn a subagent. Named `Task` on some CLIs and
// `Agent` on others (FleetView) — match both so the Agents tray recognizes a
// subagent regardless of which name this CLI emits.
export const isSubagentTool = (name: string): boolean => name === 'Task' || name === 'Agent'

// A background/async subagent launch returns an IMMEDIATE tool_result that only
// acknowledges the launch ("Async agent launched successfully…") — it is NOT the
// agent's output, which arrives much later as a <task-notification>. Treat this ack
// as "launched, still running", never as the terminal result — otherwise the tray
// card flips to done the instant the agent starts.
const ASYNC_LAUNCH_ACK = /Async agent launched successfully/i
function isAsyncLaunchAck(content: string): boolean {
  return ASYNC_LAUNCH_ACK.test(content)
}

// Flatten a user message's content (string, or an array of blocks) to plain text.
function userContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => { const o = b as { type?: string; text?: unknown }; return o?.type === 'text' && typeof o.text === 'string' ? o.text : '' })
      .join('\n')
  }
  return ''
}

// The harness injects a <task-notification> (delivered as a plain user turn) when a
// background agent stops — the real lifecycle signal, replacing the launch ack. Parse
// the Task tool-use-id it settles and whether it failed. It isn't written to the CLI's
// jsonl, so it only reaches us on the live stream / connect snapshot, never a resume.
interface TaskNotification { toolUseId: string; isError: boolean; summary: string }
function parseTaskNotification(text: string): TaskNotification | null {
  if (!text.includes('<task-notification>')) return null
  const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(text)?.[1]
  if (!toolUseId) return null
  const status = (/<status>\s*([^<]+?)\s*<\/status>/.exec(text)?.[1] ?? '').toLowerCase()
  const summary = /<summary>\s*([^<]*?)\s*<\/summary>/.exec(text)?.[1]?.trim()
  return { toolUseId, isError: status === 'failed' || status === 'error', summary: summary || `Agent ${status || 'finished'}` }
}

// One subagent, assembled from a transcript: its `Task` call + its own nested
// activity (steps) + its final result. Drives the Agents tray — the Task no longer
// renders inline in the conversation.
export interface AgentView {
  id: string          // the Task item's local id (stable React key)
  toolId?: string     // the anthropic tool id (pairs result + child activity)
  type: string        // subagent_type
  description: string
  prompt?: string
  steps: TranscriptItem[]                                   // the agent's own calls/results
  launched: boolean                                         // a background agent whose launch was acked (runs detached from the parent turn)
  result?: Extract<TranscriptItem, { kind: 'tool_result' }> // final output (present ⇒ finished); excludes the async-launch ack
}

// Pull every subagent out of a transcript. Groups each subagent's calls/results
// (parentId === the Task's toolId) under its Task, and pairs the Task's result.
export function collectAgents(items: TranscriptItem[]): AgentView[] {
  const resultByTool = new Map<string, Extract<TranscriptItem, { kind: 'tool_result' }>>()
  const launchedTools = new Set<string>()
  const childrenByParent = new Map<string, TranscriptItem[]>()
  for (const it of items) {
    if (it.kind === 'tool_result') {
      // The async-launch ack marks a background agent as launched, not finished; the
      // real result (later notification / a foreground agent's output) is the terminal one.
      if (isAsyncLaunchAck(it.content)) launchedTools.add(it.toolUseId)
      else resultByTool.set(it.toolUseId, it)
    }
    const pid = (it.kind === 'tool_use' || it.kind === 'tool_result' || it.kind === 'text' || it.kind === 'thinking') ? it.parentId : undefined
    if (pid) { const a = childrenByParent.get(pid) ?? []; a.push(it); childrenByParent.set(pid, a) }
  }
  const agents: AgentView[] = []
  for (const it of items) {
    if (it.kind !== 'tool_use' || !isSubagentTool(it.name)) continue
    const input = (it.input ?? {}) as { description?: string; prompt?: string; subagent_type?: string }
    agents.push({
      id: it.id, toolId: it.toolId,
      type: input.subagent_type || 'agent',
      description: input.description || 'Subagent task',
      prompt: input.prompt,
      steps: it.toolId ? childrenByParent.get(it.toolId) ?? [] : [],
      launched: it.toolId ? launchedTools.has(it.toolId) : false,
      result: it.toolId ? resultByTool.get(it.toolId) : undefined,
    })
  }
  return agents
}

// How many subagents are still in flight. A BACKGROUND agent (launch acked, no
// terminal result yet) runs detached, so it counts regardless of the parent turn. A
// FOREGROUND agent (no ack, no result) is only in flight while the parent turn is
// active — gating on `turnActive` keeps an interrupted Task from latching on forever.
// Drives the sidebar dot + the MetaBar chip.
export function countRunningAgents(items: TranscriptItem[], turnActive: boolean): number {
  const finished = new Set<string>()   // has a terminal (non-ack) result
  const launched = new Set<string>()   // background agent, launch acked
  for (const it of items) {
    if (it.kind !== 'tool_result') continue
    if (isAsyncLaunchAck(it.content)) launched.add(it.toolUseId)
    else finished.add(it.toolUseId)
  }
  return items.reduce((n, it) => {
    if (it.kind !== 'tool_use' || !isSubagentTool(it.name) || it.toolId == null || finished.has(it.toolId)) return n
    return n + (launched.has(it.toolId) || turnActive ? 1 : 0)
  }, 0)
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
      // Proactive rate/usage limit info (drives the session/weekly chips). The
      // event carries usage as `utilization` (0–1); normalize to `percentUsed` so
      // the chip shows "how much is used", not just when the window resets.
      if (e.type === 'rate_limit_event') {
        applyRateLimit(dispatch, id, e as { rate_limit_info?: RateLimitInfo })
        return
      }
      if (e.type === 'assistant') {
        if (isSubagentEvent(e)) {
          // Subagent (Task) message: its context is its own (don't touch the session
          // meter); surface its tool calls as before (text stays replay-only).
          const items = itemsFromEvent(e)
          if (items.length) dispatch({ type: 'APPEND', sessionId: id, items })
          return
        }
        // Main agent: fold context into the session meter, then reconcile the message's
        // text/thinking/tool_use — this materializes text even for a client that didn't
        // stream the turn from its start (the phone-joins-mid-turn case).
        const cm = contextFromAssistant(e)
        if (cm) dispatch({ type: 'SET_META', sessionId: id, meta: cm })
        dispatch({ type: 'ASSISTANT', sessionId: id, blocks: parseAssistantBlocks(e) })
        return
      }
      // Turn end: cumulative cost + context-window size (keyed to the session model).
      if (e.type === 'result') {
        const knownModel = stateRef.current.meta[id]?.model
        dispatch({ type: 'SET_META', sessionId: id, meta: metaFromResult(e, knownModel) })
      }
      const items = itemsFromEvent(e)
      if (items.length) dispatch({ type: 'APPEND', sessionId: id, items })
    })
    // Connect-time catch-up for a session already in progress: rebuild its
    // transcript from the buffered events (same replay path as /resume), restore the
    // slash catalog + MetaBar + rate-limit chips, and surface any still-pending
    // permission so THIS device (e.g. the phone) can answer it. LOAD replaces rather
    // than appends, so a reconnect is idempotent.
    const offSnapshot = api.on.snapshot((id, evs, pending) => {
      dispatch({ type: 'LOAD', sessionId: id, items: evs.flatMap((e) => itemsFromEvent(e, true)) })
      const meta = metaFromReplay(evs)
      if (Object.keys(meta).length) dispatch({ type: 'SET_META', sessionId: id, meta })
      for (const e of evs) {
        if (e.type === 'system' && (e as { subtype?: string }).subtype === 'init') {
          const cmds = (e as { slash_commands?: unknown }).slash_commands
          if (Array.isArray(cmds)) dispatch({ type: 'SET_SLASH', sessionId: id, commands: cmds.map(String) })
        } else if (e.type === 'rate_limit_event') {
          applyRateLimit(dispatch, id, e as { rate_limit_info?: RateLimitInfo })
        }
      }
      dispatch({ type: 'SET_PENDING', sessionId: id, reqs: pending ?? [] })
    })
    const offPerm = api.on.permission((id, req) => {
      dispatch({ type: 'ADD_PENDING', sessionId: id, req })
    })
    // A user turn from ANY device — mirror it here, unless it's this client's own
    // optimistic echo (already appended in sendTurn under this turnId).
    const offUserTurn = api.on.userTurn((id, text, turnId) => {
      if (turnId && stateRef.current.transcripts[id]?.some((it) => it.id === turnId)) return
      dispatch({ type: 'APPEND', sessionId: id, items: [{ kind: 'user', id: turnId ?? nextId(), text }] })
    })
    // A permission prompt was resolved (answered on any device / auto-denied). Clear
    // it here so a non-answering client isn't stuck on a dead prompt. Match on
    // requestId so a NEWER prompt that arrived meanwhile isn't cleared by mistake.
    const offPermResolved = api.on.permissionResolved((id, requestId) => {
      dispatch({ type: 'REMOVE_PENDING', sessionId: id, requestId })   // drop just this one; others stay
    })
    // A finished/interrupted turn clears any stale prompts defensively.
    const offState = api.on.stateChange((id, s) => {
      if (s === 'idle' && stateRef.current.pending[id]?.length) dispatch({ type: 'CLEAR_PENDING', sessionId: id })
    })
    return () => { offEvent(); offSnapshot(); offPerm(); offUserTurn(); offPermResolved(); offState() }
  }, [])

  const sendTurn = useCallback((sessionId: string, text: string) => {
    const t = text.trim()
    if (!t) return
    // Optimistic local echo under a globally-unique turnId. The server broadcasts the
    // turn to EVERY client (session:userTurn) so all devices mirror it; we de-dupe our
    // own echo by that id (a per-client counter would collide across devices). Not
    // crypto.randomUUID — the VPN origin is plain http (non-secure context).
    const turnId = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    dispatch({ type: 'APPEND', sessionId, items: [{ kind: 'user', id: turnId, text: t }] })
    api.session.sendTurn(sessionId, t, turnId)
  }, [])

  const interrupt = useCallback((sessionId: string) => {
    api.session.interrupt(sessionId)
  }, [])

  const respond = useCallback((sessionId: string, requestId: string, decision: PermissionDecision) => {
    api.session.respondPermission(sessionId, requestId, decision)
    dispatch({ type: 'REMOVE_PENDING', sessionId, requestId })   // reveal the next queued prompt, if any
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
  // The prompt to show now = head of the session's queue (answering it reveals the
  // next). Kept as a single-value API so callers render one card at a time.
  const pendingFor = useCallback((sessionId: string) => state.pending[sessionId]?.[0], [state.pending])
  const slashCommandsFor = useCallback((sessionId: string) => state.slash[sessionId] ?? [], [state.slash])
  const metaFor = useCallback((sessionId: string) => state.meta[sessionId] ?? {}, [state.meta])

  // Memoize the context value so a streamed token (which re-renders ChatProvider)
  // doesn't hand every consumer a fresh object identity and re-render them all.
  const value = useMemo(
    () => ({ transcriptFor, pendingFor, slashCommandsFor, metaFor, sendTurn, interrupt, respond, loadTranscript, clearTranscript }),
    [transcriptFor, pendingFor, slashCommandsFor, metaFor, sendTurn, interrupt, respond, loadTranscript, clearTranscript],
  )
  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  )
}

export function useChat(): ContextValue {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat must be used within ChatProvider')
  return ctx
}
