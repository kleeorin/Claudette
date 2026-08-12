import {
  createContext, useContext, useReducer, useEffect, useCallback, useMemo, useRef, type ReactNode,
} from 'react'
import type { ClaudeEvent, PermissionRequest, PermissionDecision, TaskRecord, TeamMessageKind } from '@claudette/shared'
import { isSubagentTool, isAsyncLaunchAck, userContentText, parseTaskNotification, parseSystemTaskNotification } from '@claudette/shared'
import { hasTeamMessage, parseTeamMessages, stripTeamMessages } from '@claudette/shared'
import { api } from '../api/client'

// Re-export the subagent-parsing helpers (now owned by @claudette/shared, so server
// and client derive identically) under their old store path — existing importers
// (ChatView) keep working unchanged.
export { isSubagentTool }

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
  // A message from another session on this team. It arrives on the wire as an ordinary
  // user turn (that is how the mailbox injects it), so without this it would render as
  // though the USER had typed a teammate's report — the one thing the transcript must
  // never lie about. Split out here so the UI can attribute it.
  | { kind: 'team'; id: string; from: string; role: string; messageKind: TeamMessageKind; text: string }

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
  // The server's authoritative subagent registry per session (connect snapshot +
  // live session:tasks). The durable fallback that settles an agent card when its
  // terminal signal never reached the transcript.
  tasks: Record<string, TaskRecord[]>
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
  | { type: 'SET_TASKS'; sessionId: string; tasks: TaskRecord[] }   // replace the subagent registry (snapshot / live)
  | { type: 'SET_META'; sessionId: string; meta: Partial<SessionMeta> }
  | { type: 'SET_LIMIT'; sessionId: string; limitType: string; info: RateLimitInfo }
  | { type: 'CLEAR_LIMITS'; sessionId: string }
  | { type: 'CLEAR'; sessionId: string }

// One content block of a completed assistant message; `index` matches the stream
// event's block index so we can pair it with the item built from that block's deltas.
interface AssistantBlock { index: number; kind: 'text' | 'thinking' | 'tool_use'; text?: string; name?: string; input?: unknown; toolId?: string }

let seq = 0
const nextId = () => `i${++seq}`

// Stable empty identities, so a session with nothing yet doesn't hand consumers a
// fresh []/{} on every call — that defeats the `useMemo`s keyed on these (the sidebar
// agent lists, the MetaBar) and makes them recompute each render for no reason.
const EMPTY_TASKS: TaskRecord[] = []
const EMPTY_ITEMS: TranscriptItem[] = []
const EMPTY_SLASH: string[] = []
const EMPTY_META: SessionMeta = {}

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
    case 'SET_TASKS':
      return { ...state, tasks: { ...state.tasks, [action.sessionId]: action.tasks } }
    case 'CLEAR': {
      const transcripts = { ...state.transcripts }; delete transcripts[action.sessionId]
      const pending = { ...state.pending }; delete pending[action.sessionId]
      const slash = { ...state.slash }; delete slash[action.sessionId]
      const open = { ...state.open }; delete open[action.sessionId]
      const meta = { ...state.meta }; delete meta[action.sessionId]
      const tasks = { ...state.tasks }; delete tasks[action.sessionId]
      return { transcripts, pending, slash, open, meta, tasks }
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
// A user turn the team mailbox injected carries one or more <team-message> blocks (a
// flush coalesces a whole backlog into one turn, so there can be several). Turn each
// into its own attributed item, and keep any surrounding prose as a normal user bubble.
// Returns null when this is an ordinary turn, so callers fall through unchanged.
function teamItemsFrom(text: string): TranscriptItem[] | null {
  if (!hasTeamMessage(text)) return null
  const msgs = parseTeamMessages(text)
  // FAIL CLOSED. If the turn carries an envelope we couldn't parse (a malformed or
  // truncated one — MESSAGE_RE needs attributes after the tag name, for instance),
  // returning null would attribute the whole thing to the HUMAN's own bubble. Attributing
  // machine traffic to the user is the one mistake the transcript must never make, so
  // surface it as an unattributed teammate message instead.
  if (!msgs.length) {
    return [{ kind: 'team', id: nextId(), from: 'unknown', role: 'unknown', messageKind: 'report', text }]
  }
  const out: TranscriptItem[] = msgs.map((m) => ({
    kind: 'team' as const, id: nextId(), from: m.from, role: m.role, messageKind: m.kind, text: m.body,
  }))
  const rest = stripTeamMessages(text)
  if (rest) out.unshift({ kind: 'user', id: nextId(), text: rest })
  return out
}

function itemsFromEvent(e: ClaudeEvent, fromReplay = false): TranscriptItem[] {
  const out: TranscriptItem[] = []
  // On a subagent's own events this is the parent Task's tool id — tag its items so
  // the UI can nest them under that agent's card.
  const parentId = (() => { const p = (e as { parent_tool_use_id?: unknown }).parent_tool_use_id; return typeof p === 'string' && p ? p : undefined })()
  // The current CLI signals a background agent's completion as a `system` event
  // (subtype task_notification), not a <task-notification> user turn. Synthesize the
  // terminal tool_result its Task is still waiting on so the agent card settles even if
  // the authoritative task-registry broadcast is missed.
  const sysNotif = parseSystemTaskNotification(e)
  if (sysNotif) {
    out.push({ kind: 'tool_result', id: nextId(), toolUseId: sysNotif.toolUseId, isError: sysNotif.isError, content: sysNotif.summary })
    return out
  }
  if (e.type === 'assistant') {
    const content = (e as { message?: { content?: unknown[] } }).message?.content ?? []
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use') out.push({ kind: 'tool_use', id: nextId(), name: String(b.name), input: b.input, toolId: typeof b.id === 'string' ? b.id : undefined, parentId })
      // A SUBAGENT's text/thinking (parentId set) is always captured — it's the agent's
      // chain of thought, shown in its agent card. The MAIN agent's live text/thinking
      // arrives via the stream path (reconciled by ASSISTANT), so here it's replay-only.
      else if ((fromReplay || parentId) && b.type === 'text' && b.text) out.push({ kind: 'text', id: nextId(), text: String(b.text), parentId })
      else if ((fromReplay || parentId) && b.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', id: nextId(), text: String(b.thinking), parentId })
    }
  } else if (e.type === 'user') {
    const content = (e as { message?: { content?: unknown } }).message?.content
    // A <task-notification> is a background agent's completion signal. Synthesize the
    // terminal tool_result its Task tool_use is still waiting on, so collectAgents can
    // settle the agent card to done/failed. Handled before the branches below because
    // the notification can arrive as either string or block content.
    const notif = parseTaskNotification(userContentText(content))
    if (notif) {
      out.push({ kind: 'tool_result', id: nextId(), toolUseId: notif.toolUseId, isError: notif.isError, content: notif.summary })
      return out
    }
    if (typeof content === 'string') {
      // REPLAY ONLY, exactly like the user branch below. Live, a team message already
      // arrives through the userTurn mirror (the mailbox injects it via sendUserTurn,
      // which emits 'userTurn'), while bridgeSessionEvents ALSO broadcasts the CLI's raw
      // echo of the same turn — so parsing it here unconditionally rendered every
      // teammate's message twice. buffer() drops that echo from the snapshot and
      // sendUserTurn records the turn itself, so replay sees it exactly once.
      const team = fromReplay ? teamItemsFrom(content) : null
      if (team) { out.push(...team); return out }
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

// One subagent, assembled from a transcript: its `Task` call + its own nested
// activity (steps) + its final result. Drives the sidebar's per-session agent list
// and the agent detail tab — the Task no longer renders inline in the conversation.
export interface AgentView {
  id: string          // the Task item's local id (stable React key)
  toolId?: string     // the anthropic tool id (pairs result + child activity)
  taskId?: string     // the CLI's task id, when known — the handle `stop_task` needs
  type: string        // subagent_type
  description: string
  prompt?: string
  steps: TranscriptItem[]                                   // the agent's own calls/results
  launched: boolean                                         // a background agent whose launch was acked (runs detached from the parent turn)
  result?: Extract<TranscriptItem, { kind: 'tool_result' }> // final output (present ⇒ finished); excludes the async-launch ack
}

// Stable identity for an agent across transcript rebuilds: the anthropic tool id when
// we have it (survives collectAgents re-runs), else the local item id. Used as the
// clear-key, the sidebar list key, and the agent tab's handle on its agent.
export function agentKey(a: AgentView): string {
  return a.toolId ?? a.id
}

// Is this agent still going? A background agent (launch acked, no result yet) runs
// detached from the parent turn; a foreground one only lives while the turn does.
// THE single definition — the sidebar's live count, its "clear finished" predicate, the
// row's spinner, the status dot, and the detail view all read it from here. It used to be
// written out at each of those sites, and they had already drifted: the sidebar counted a
// 'stopped' agent (no result, not launched, turn idle) as finished but refused to clear
// it, so "Clear finished" rendered a button that did nothing and never went away.
export function isAgentLive(a: AgentView, turnActive: boolean): boolean {
  return !a.result && (a.launched || turnActive)
}

// Pull every subagent out of a transcript. Groups each subagent's calls/results
// (parentId === the Task's toolId) under its Task, and pairs the Task's result.
export function collectAgents(items: TranscriptItem[], tasks?: TaskRecord[]): AgentView[] {
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
  // The server's authoritative registry, keyed by tool id — the fallback that settles a
  // card when its terminal tool_result / <task-notification> never reached the transcript.
  const registry = new Map((tasks ?? []).map((t) => [t.toolId, t]))
  // The last user turn: a subagent whose Task call precedes it belongs to a COMPLETED
  // past turn. Such an agent can't still be running once a newer turn has started (a
  // live background agent would carry a registry record) — so if it also has no result
  // and no record, it's a leftover and must settle, not re-light on the session's
  // running flag. Without this, any resultless old Task re-shows "running…starting…"
  // whenever the session is busy again.
  let lastUserIndex = -1
  // A TURN START is either the human typing or a teammate's message being injected —
  // both begin a new turn for the session. Counting only 'user' meant a member session
  // (whose work always arrives as 'team') never advanced this, so subagent cards from
  // an earlier turn were never treated as past and re-lit as "running" forever.
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'user' || items[i].kind === 'team') lastUserIndex = i
  }
  const agents: AgentView[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind !== 'tool_use' || !isSubagentTool(it.name)) continue
    const input = (it.input ?? {}) as { description?: string; prompt?: string; subagent_type?: string }
    const rec = it.toolId ? registry.get(it.toolId) : undefined
    const txResult = it.toolId ? resultByTool.get(it.toolId) : undefined
    const pastTurn = i < lastUserIndex
    // A past-turn agent with neither a real result nor a live registry record is a
    // leftover — synthesize a terminal result so it shows finished (and dismissable).
    const stale = !txResult && !rec && pastTurn ? staleResult(it.toolId ?? it.id) : undefined
    agents.push({
      id: it.id, toolId: it.toolId,
      taskId: rec?.taskId,   // present ⇒ the CLI gave us a handle we can stop it by
      type: input.subagent_type || 'agent',
      description: input.description || 'Subagent task',
      prompt: input.prompt,
      steps: it.toolId ? childrenByParent.get(it.toolId) ?? [] : [],
      launched: (it.toolId ? launchedTools.has(it.toolId) : false) || !!rec?.launched,
      // Transcript result wins; else a settled registry record; else the stale marker.
      result: txResult ?? terminalFromRecord(rec) ?? stale,
    })
  }
  return agents
}

// A settled (done/failed) registry record → the synthetic tool_result the agent views
// use to mark a card finished. A still-running record yields nothing (the card stays running).
function terminalFromRecord(rec: TaskRecord | undefined): Extract<TranscriptItem, { kind: 'tool_result' }> | undefined {
  if (!rec || rec.status === 'running') return undefined
  return { kind: 'tool_result', id: `reg-${rec.toolId}`, toolUseId: rec.toolId, isError: rec.status === 'failed', content: rec.summary ?? '' }
}

// A stable synthetic result marking a leftover subagent (past turn, no result, no
// registry record) as ended, so its card settles instead of re-lighting on the session.
function staleResult(key: string): Extract<TranscriptItem, { kind: 'tool_result' }> {
  return { kind: 'tool_result', id: `stale-${key}`, toolUseId: key, isError: false, content: 'Ended in an earlier turn.' }
}

interface ContextValue {
  transcriptFor: (sessionId: string) => TranscriptItem[]
  pendingFor: (sessionId: string) => PermissionRequest | undefined
  slashCommandsFor: (sessionId: string) => string[]
  metaFor: (sessionId: string) => SessionMeta
  tasksFor: (sessionId: string) => TaskRecord[]
  sendTurn: (sessionId: string, text: string) => void
  interrupt: (sessionId: string) => void
  stopTask: (sessionId: string, toolId: string) => void
  respond: (sessionId: string, requestId: string, decision: PermissionDecision) => void
  loadTranscript: (sessionId: string, events: ClaudeEvent[]) => void
  clearTranscript: (sessionId: string) => void
}

const ChatContext = createContext<ContextValue | null>(null)

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { transcripts: {}, pending: {}, slash: {}, open: {}, meta: {}, tasks: {} })
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
      // Token-level streaming of text/thinking blocks — MAIN AGENT ONLY.
      // The engine runs with --include-partial-messages, and a subagent's partials carry
      // parent_tool_use_id just like its completed message does. Feeding them to
      // handleStreamEvent put the subagent's prose straight into the main transcript
      // (STREAM_START has no parentId, so ChatView's subagent filter can't drop it), then
      // appended the same text a SECOND time when the completed subagent `assistant` event
      // landed with a parentId. Worse, the open-block map is keyed by block index alone, so
      // two agents running in parallel both stream index 0 and their deltas interleave into
      // one garbled item — and a subagent's message_start wiped the main agent's index map,
      // re-materializing its text as a duplicate. Subagent text is captured in full from the
      // completed event below, so skipping the partials here loses nothing.
      if (e.type === 'stream_event') {
        if (!isSubagentEvent(e)) handleStreamEvent(dispatch, id, (e as { event?: Record<string, unknown> }).event)
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
    const offSnapshot = api.on.snapshot((id, evs, pending, tasks) => {
      dispatch({ type: 'LOAD', sessionId: id, items: evs.flatMap((e) => itemsFromEvent(e, true)) })
      // The authoritative registry from the snapshot: settles cards whose completion
      // is no longer in the (possibly-evicted) replayed transcript.
      dispatch({ type: 'SET_TASKS', sessionId: id, tasks: tasks ?? [] })
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
    // Live subagent-registry updates — the durable fallback that settles an agent card
    // even when its terminal <task-notification> was evicted / never buffered / lost.
    const offTasks = api.on.tasks((id, tks) => {
      dispatch({ type: 'SET_TASKS', sessionId: id, tasks: tks })
    })
    const offPerm = api.on.permission((id, req) => {
      dispatch({ type: 'ADD_PENDING', sessionId: id, req })
    })
    // A user turn from ANY device — mirror it here, unless it's this client's own
    // optimistic echo (already appended in sendTurn under this turnId).
    const offUserTurn = api.on.userTurn((id, text, turnId) => {
      if (turnId && stateRef.current.transcripts[id]?.some((it) => it.id === turnId)) return
      // The mailbox injects a teammate's message through this same channel, so attribute
      // it rather than showing a teammate's report as something the user typed.
      const team = teamItemsFrom(text)
      dispatch({
        type: 'APPEND', sessionId: id,
        items: team ?? [{ kind: 'user', id: turnId ?? nextId(), text }],
      })
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
    return () => { offEvent(); offSnapshot(); offTasks(); offPerm(); offUserTurn(); offPermResolved(); offState() }
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

  // Stop one subagent. Deliberately no optimistic state change: the card settles when the
  // CLI's task_notification lands, the same path a self-finishing agent takes, so a stop
  // that doesn't take can't leave a card stuck showing "stopped" while it keeps working.
  const stopTask = useCallback((sessionId: string, toolId: string) => {
    api.session.stopTask(sessionId, toolId)
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

  const transcriptFor = useCallback((sessionId: string) => state.transcripts[sessionId] ?? EMPTY_ITEMS, [state.transcripts])
  // The prompt to show now = head of the session's queue (answering it reveals the
  // next). Kept as a single-value API so callers render one card at a time.
  const pendingFor = useCallback((sessionId: string) => state.pending[sessionId]?.[0], [state.pending])
  const slashCommandsFor = useCallback((sessionId: string) => state.slash[sessionId] ?? EMPTY_SLASH, [state.slash])
  const metaFor = useCallback((sessionId: string) => state.meta[sessionId] ?? EMPTY_META, [state.meta])
  const tasksFor = useCallback((sessionId: string) => state.tasks[sessionId] ?? EMPTY_TASKS, [state.tasks])

  // Memoize the context value so a streamed token (which re-renders ChatProvider)
  // doesn't hand every consumer a fresh object identity and re-render them all.
  const value = useMemo(
    () => ({ transcriptFor, pendingFor, slashCommandsFor, metaFor, tasksFor, sendTurn, interrupt, stopTask, respond, loadTranscript, clearTranscript }),
    [transcriptFor, pendingFor, slashCommandsFor, metaFor, tasksFor, sendTurn, interrupt, stopTask, respond, loadTranscript, clearTranscript],
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
