import { readdir, readFile, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import crypto from 'crypto'
import type { ConversationMeta, ClaudeEvent, RewindPoint } from '@claudette/shared'
import { snapshottedUuids } from '../git/shadowSnapshots'
import { stripEditorContext } from './editorContext'

// Claude stores each conversation as a JSONL transcript under
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. The dir name is the absolute
// cwd with every non-alphanumeric char replaced by '-'. This backs the native
// /resume picker — the launch-time flow the headless stream-json channel can't
// express. Ported from ClaudeMaster's `main/conversations.ts` (already local-only).
export function projectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

function contentText(content: unknown): string {
  // Strip any ambient editor-context block we appended before sending to the CLI, so
  // it never surfaces in titles / resume replay / rewind points (see editorContext.ts).
  if (typeof content === 'string') return stripEditorContext(content)
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text'
      ? String((b as { text?: unknown }).text ?? '') : '')).join('')
  }
  return ''
}

// Slash-command wrappers + injected caveats/reminders aren't real conversation.
function isNoise(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('<command-name>') || t.startsWith('<local-command-caveat>') || t.startsWith('<command-message>')
}

// List resumable conversations for a directory, newest first.
export async function listConversations(cwd: string): Promise<ConversationMeta[]> {
  const dir = projectDir(cwd)
  let names: string[]
  try { names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')) } catch { return [] }

  const metas = await Promise.all(names.map(async (name) => {
    const full = join(dir, name)
    const id = name.slice(0, -'.jsonl'.length)
    let mtimeMs = 0
    try { mtimeMs = (await stat(full)).mtimeMs } catch { /* leave 0 */ }
    let title = '', lastPrompt = '', firstUser = '', turns = 0
    try {
      const raw = await readFile(full, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let o: Record<string, unknown>
        try { o = JSON.parse(line) } catch { continue }
        const t = o.type as string
        if (t === 'ai-title' && typeof o.aiTitle === 'string') title = o.aiTitle
        else if (t === 'last-prompt' && typeof o.lastPrompt === 'string') lastPrompt = o.lastPrompt
        else if (t === 'user' && !o.isMeta && !o.isSidechain) {
          const txt = contentText((o.message as { content?: unknown })?.content)
          if (txt.trim() && !isNoise(txt)) { turns++; if (!firstUser) firstUser = txt }
        }
      }
    } catch { /* unreadable transcript → minimal meta */ }
    return {
      id, mtimeMs, turns,
      title: title || firstUser.slice(0, 80) || '(untitled)',
      lastPrompt: (lastPrompt || firstUser).slice(0, 140),
    }
  }))
  return metas.filter((m) => m.turns > 0).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

// Read a conversation back as ClaudeEvent[] the client can feed through the same
// transcript builder used for live events.
export async function readConversation(cwd: string, id: string): Promise<ClaudeEvent[]> {
  const full = join(projectDir(cwd), `${id}.jsonl`)
  let raw: string
  try { raw = await readFile(full, 'utf8') } catch { return [] }
  const events: ClaudeEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try { o = JSON.parse(line) } catch { continue }
    const t = o.type as string
    if ((t === 'assistant' || t === 'user') && !o.isMeta && !o.isSidechain) {
      let message = o.message as Record<string, unknown>
      if (t === 'user') {
        const txt = contentText(message?.content)
        const hasToolResult = Array.isArray(message?.content)
          && (message.content as unknown[]).some((b) => (b as { type?: string })?.type === 'tool_result')
        if (!hasToolResult && txt.trim() && isNoise(txt)) continue
        // Drop the appended editor-context block from the replayed prompt bubble.
        if (typeof message?.content === 'string') message = { ...message, content: stripEditorContext(message.content) }
      }
      events.push({ type: t, message } as ClaudeEvent)
    }
  }
  return events
}

// --- /rewind ------------------------------------------------------------------

// The user turns of a conversation, as rewind points (oldest first). Each is one real
// text prompt — a string-content user line that isn't a tool_result echo or a
// slash-command / caveat wrapper (isNoise) — keyed by its uuid, the boundary
// forkConversationBefore truncates at. `id` is the session's current claude session id.
export async function listRewindPoints(cwd: string, id: string): Promise<RewindPoint[]> {
  const full = join(projectDir(cwd), `${id}.jsonl`)
  let raw: string
  try { raw = await readFile(full, 'utf8') } catch { return [] }
  const points: RewindPoint[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try { o = JSON.parse(line) } catch { continue }
    if (o.type !== 'user' || o.isMeta || o.isSidechain) continue
    if (typeof o.uuid !== 'string') continue
    const content = (o.message as { content?: unknown })?.content
    if (typeof content !== 'string' || !content.trim() || isNoise(content)) continue
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    // Strip the appended editor-context block so the point text is the user's original
    // prompt — both for display and so it matches the pre-turn snapshot's `text`.
    points.push({ uuid: o.uuid, text: stripEditorContext(content).trim(), mtimeMs: Number.isNaN(ts) ? 0 : ts, ordinal: points.length + 1, hasSnapshot: false })
  }
  // Mark which turns have a working-tree snapshot (one batch lookup for the whole list).
  const snapped = await snapshottedUuids(cwd)
  for (const p of points) p.hasSnapshot = snapped.has(p.uuid)
  return points
}

// Fork a conversation to JUST BEFORE the user turn `uuid`: copy every transcript line
// preceding that one into a NEW conversation (fresh claude session id, stamped through
// each line's sessionId) and return the new id. The original transcript is left intact —
// a rewind is itself a fork, so resuming the original undoes it. Returns null if `uuid`
// isn't a line in this transcript.
export async function forkConversationBefore(cwd: string, id: string, uuid: string): Promise<string | null> {
  const dir = projectDir(cwd)
  let raw: string
  try { raw = await readFile(join(dir, `${id}.jsonl`), 'utf8') } catch { return null }
  const lines = raw.split('\n').filter((l) => l.trim())
  const cut = lines.findIndex((l) => {
    try { return (JSON.parse(l) as { uuid?: unknown }).uuid === uuid } catch { return false }
  })
  if (cut < 0) return null
  const newId = crypto.randomUUID()
  const kept = lines.slice(0, cut).map((l) => {
    try {
      const o = JSON.parse(l) as Record<string, unknown>
      if ('sessionId' in o) o.sessionId = newId   // re-key the prefix to the fork
      return JSON.stringify(o)
    } catch { return l }
  })
  // Trailing newline keeps the file line-framed like the CLI writes it.
  await writeFile(join(dir, `${newId}.jsonl`), kept.length ? kept.join('\n') + '\n' : '')
  return newId
}
