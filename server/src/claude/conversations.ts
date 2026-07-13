import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import type { ConversationMeta, ClaudeEvent } from '@claudette/shared'

// Claude stores each conversation as a JSONL transcript under
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. The dir name is the absolute
// cwd with every non-alphanumeric char replaced by '-'. This backs the native
// /resume picker — the launch-time flow the headless stream-json channel can't
// express. Ported from ClaudeMaster's `main/conversations.ts` (already local-only).
export function projectDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
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
      if (t === 'user') {
        const txt = contentText((o.message as { content?: unknown })?.content)
        const hasToolResult = Array.isArray((o.message as { content?: unknown })?.content)
          && ((o.message as { content?: unknown[] }).content!).some((b) => (b as { type?: string })?.type === 'tool_result')
        if (!hasToolResult && txt.trim() && isNoise(txt)) continue
      }
      events.push({ type: t, message: (o.message as Record<string, unknown>) } as ClaudeEvent)
    }
  }
  return events
}
