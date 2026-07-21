import type { ClaudeEvent } from './types'

// Subagent-lifecycle parsing, shared so the server's task registry and the client's
// tray derive identically from the SAME rules (a single source of truth is what keeps
// the two from drifting). The string helpers were lifted verbatim from the web store.

// The tool the model calls to spawn a subagent — `Task` on some CLIs, `Agent` on
// others (FleetView). Match both so subagent tracking is CLI-agnostic.
export const isSubagentTool = (name: string): boolean => name === 'Task' || name === 'Agent'

// A background/async subagent launch returns an IMMEDIATE tool_result that only
// acknowledges the launch ("Async agent launched successfully…") — NOT the agent's
// output, which arrives much later as a <task-notification>. Treat this ack as
// "launched, still running", never as the terminal result.
const ASYNC_LAUNCH_ACK = /Async agent launched successfully/i
export function isAsyncLaunchAck(content: string): boolean {
  return ASYNC_LAUNCH_ACK.test(content)
}

// Flatten a message's content (string, or an array of blocks) to plain text.
export function userContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => { const o = b as { type?: string; text?: unknown }; return o?.type === 'text' && typeof o.text === 'string' ? o.text : '' })
      .join('\n')
  }
  return ''
}

// The harness injects a <task-notification> (delivered as a plain user turn) when a
// background agent stops — the real terminal signal, replacing the launch ack. Parse
// the Task tool-use-id it settles and whether it failed. It isn't written to the CLI's
// jsonl, so it only reaches us on the live stream / connect snapshot, never a resume.
export interface TaskNotification { toolUseId: string; isError: boolean; summary: string }
export function parseTaskNotification(text: string): TaskNotification | null {
  if (!text.includes('<task-notification>')) return null
  const toolUseId = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/.exec(text)?.[1]
  if (!toolUseId) return null
  const status = (/<status>\s*([^<]+?)\s*<\/status>/.exec(text)?.[1] ?? '').toLowerCase()
  const summary = /<summary>\s*([^<]*?)\s*<\/summary>/.exec(text)?.[1]?.trim()
  return { toolUseId, isError: status === 'failed' || status === 'error', summary: summary || `Agent ${status || 'finished'}` }
}

// The current CLI delivers a background agent's completion NOT as a <task-notification>
// user turn but as a first-class `system` event: { subtype: 'task_notification',
// tool_use_id, status, summary }. Same terminal signal, different envelope — and the
// user-turn parser above never sees a `system` event, which is why a completed
// background card used to hang "running" forever. Parse the settle straight off the
// event. `tool_use_id` is the Task tool-use id (the registry / resultByTool key).
export function parseSystemTaskNotification(e: ClaudeEvent): TaskNotification | null {
  const o = e as unknown as { type?: string; subtype?: string; tool_use_id?: unknown; status?: unknown; summary?: unknown }
  if (o.type !== 'system' || o.subtype !== 'task_notification' || typeof o.tool_use_id !== 'string' || !o.tool_use_id) return null
  const status = String(o.status ?? '').toLowerCase()
  const summary = typeof o.summary === 'string' ? o.summary.trim() : ''
  // Anything other than a clean completion counts as an error state (failed / cancelled
  // / killed / interrupted); an empty status is treated as a normal finish, not an error.
  return { toolUseId: o.tool_use_id, isError: status !== '' && status !== 'completed' && status !== 'done', summary: summary || `Agent ${status || 'finished'}` }
}

// --- raw stream-json extractors (server-side) --------------------------------
// The client parses events into TranscriptItems first; the server holds raw events,
// so these pull the same tool_use / tool_result / content shapes straight off a
// ClaudeEvent's message — letting recordTask run from the very event tap that buffers.

function messageContent(e: ClaudeEvent): unknown {
  return (e as { message?: { content?: unknown } }).message?.content
}

export interface RawToolUse { id: string; name: string; input: Record<string, unknown> }
export function assistantToolUses(e: ClaudeEvent): RawToolUse[] {
  const content = messageContent(e)
  if (!Array.isArray(content)) return []
  const out: RawToolUse[] = []
  for (const b of content) {
    const o = b as { type?: string; id?: unknown; name?: unknown; input?: unknown }
    if (o?.type === 'tool_use' && typeof o.id === 'string' && typeof o.name === 'string') {
      out.push({ id: o.id, name: o.name, input: (o.input ?? {}) as Record<string, unknown> })
    }
  }
  return out
}

export interface RawToolResult { toolUseId: string; content: string }
export function userToolResults(e: ClaudeEvent): RawToolResult[] {
  const content = messageContent(e)
  if (!Array.isArray(content)) return []
  const out: RawToolResult[] = []
  for (const b of content) {
    const o = b as { type?: string; tool_use_id?: unknown; content?: unknown }
    if (o?.type === 'tool_result' && typeof o.tool_use_id === 'string') {
      out.push({ toolUseId: o.tool_use_id, content: userContentText(o.content) })
    }
  }
  return out
}

// A user event's content as text — for <task-notification> detection (it arrives as
// string content on a user turn).
export function userEventText(e: ClaudeEvent): string {
  return userContentText(messageContent(e))
}
