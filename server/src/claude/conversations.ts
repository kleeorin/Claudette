import { readdir, readFile, stat, writeFile } from 'fs/promises'
import { join, isAbsolute, resolve } from 'path'
import crypto from 'crypto'
import type { ConversationMeta, ClaudeEvent, RewindPoint } from '@claudette/shared'
import { snapshottedUuids } from '../git/shadowSnapshots'
import { claudeConfigDir } from './sandbox'
import { stripEditorContext } from './editorContext'

// Claude stores each conversation as a JSONL transcript under
// <claudeConfigDir()>/projects/<encoded-cwd>/<sessionId>.jsonl (i.e. ~/.claude unless
// CLAUDE_CONFIG_DIR overrides it). The dir name is the absolute
// cwd with every non-alphanumeric char replaced by '-'. This backs the native
// /resume picker — the launch-time flow the headless stream-json channel can't
// express. Ported from ClaudeMaster's `main/conversations.ts` (already local-only).
// The CLI's own scheme for turning a working directory into a single path segment. Shared
// so anything else keying state by cwd (team notes) mangles it identically instead of
// keeping a second copy that could drift from the CLI's.
//
// NB it is lossy: /a/b-c and /a/b/c both become -a-b-c. Fine for a display-oriented
// folder name; do NOT rely on it to isolate one project's state from another's.
export function mangleCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function projectDir(cwd: string): string {
  // claudeConfigDir(), not ~/.claude: the CLI writes its transcripts under
  // CLAUDE_CONFIG_DIR when that is set, and sandbox.ts sets it for every confined child.
  // Hardcoding the home path meant that with the env var set, /resume listed nothing,
  // listRewindPoints returned [] (so code rewind was permanently unavailable),
  // forkConversationBefore returned null and /api/session/rewind answered "rewind point
  // not found" — all while the transcripts sat there under the configured directory.
  return join(claudeConfigDir(), 'projects', mangleCwd(cwd))
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

// --- /rewind code-restore SCOPE ----------------------------------------------------
//
// A code restore used to re-materialise the WHOLE snapshot tree, so rewinding one session
// reverted every other session's edits in the same repo — and the operator's own. The
// restore set is now what THIS conversation changed with its file-edit tools, read back
// from its own transcript, which is Claude Code's own checkpointing rule. Bash-made changes
// are NOT covered (same as Claude Code): a shell command's file effects are not recoverable
// from the transcript.
//
// WHICH TOOLS. The built-ins that write the file on disk: Edit, Write, MultiEdit (input
// `file_path`) and NotebookEdit (`notebook_path`). Claudette's own notebook MCP tools
// (mcp__app__edit_cell, add_cell, …) are DELIBERATELY EXCLUDED: they edit an in-memory
// notebook document that reaches disk only when it is saved, and restoring the file under
// an open, dirty document would be silently overwritten by the next save — a restore that
// reports success and is undone later. Their path is also optional (they can follow the
// user's pane), so it is not always in the transcript at all.
//
// A FAILED edit is not an edit. A tool_use whose tool_result carries `is_error` (a denied
// permission, an old_string that did not match) changed nothing, and counting it would
// revert a file this session never touched.
//
// SUBAGENT EDITS ARE INCLUDED. A subagent's transcript is a separate file,
// <projectDir>/<sessionId>/subagents/agent-*.jsonl, so it is unambiguously THIS session's;
// what it lacks is a link to the main transcript's turn, so those edits are attributed to
// turns by TIMESTAMP (at or after the target turn's own timestamp). Chosen over excluding
// them because a rewind that leaves a subagent's edits in place undoes half of what the
// turn did. Known limit: after a conversation-rewind the current transcript is a FORK whose
// prefix was copied from another session id, and that id's subagent files are not followed
// — edits a subagent made in the copied prefix are not in the set.
export interface FileEdit {
  path: string        // absolute, as the tool received it (resolved against the line's cwd)
  ts: number          // the assistant line's timestamp (ms), 0 if absent
  tool: string
  subagent: boolean
}

const FILE_EDIT_TOOLS: Record<string, string> = {
  Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path',
}

// Successful file edits in one transcript file's lines, each tagged with its line index.
function editsInLines(lines: string[], cwd: string, subagent: boolean): (FileEdit & { line: number })[] {
  const pending = new Map<string, FileEdit & { line: number }>()
  const failed = new Set<string>()
  lines.forEach((line, i) => {
    if (!line.trim()) return
    let o: Record<string, unknown>
    try { o = JSON.parse(line) } catch { return }
    const content = (o.message as { content?: unknown })?.content
    if (!Array.isArray(content)) return
    for (const b of content as Record<string, unknown>[]) {
      if (!b || typeof b !== 'object') continue
      if (o.type === 'assistant' && b.type === 'tool_use' && typeof b.name === 'string' && b.name in FILE_EDIT_TOOLS) {
        const p = (b.input as Record<string, unknown> | undefined)?.[FILE_EDIT_TOOLS[b.name]]
        if (typeof p !== 'string' || !p.trim() || typeof b.id !== 'string') continue
        const base = typeof o.cwd === 'string' ? o.cwd : cwd
        const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
        pending.set(b.id, { path: isAbsolute(p) ? p : resolve(base, p), ts: Number.isNaN(ts) ? 0 : ts, tool: b.name, subagent, line: i })
      } else if (o.type === 'user' && b.type === 'tool_result' && b.is_error === true && typeof b.tool_use_id === 'string') {
        failed.add(b.tool_use_id)
      }
    }
  })
  return [...pending.entries()].filter(([id]) => !failed.has(id)).map(([, e]) => e)
}

async function subagentEdits(cwd: string, id: string): Promise<FileEdit[]> {
  const dir = join(projectDir(cwd), id, 'subagents')
  let names: string[]
  try { names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')) } catch { return [] }
  const out: FileEdit[] = []
  for (const n of names) {
    try { out.push(...editsInLines((await readFile(join(dir, n), 'utf8')).split('\n'), cwd, true)) } catch { /* unreadable → skip */ }
  }
  return out
}

// The successful file edits this conversation made FROM user turn `uuid` onward (the turn's
// own edits included), main agent and subagents. `fromMs` is that turn's timestamp, which
// other sessions' edits are compared against for conflicts. Null when `uuid` is not a line
// in this transcript.
export async function fileEditsFrom(cwd: string, id: string, uuid: string): Promise<{ edits: FileEdit[]; fromMs: number } | null> {
  let raw: string
  try { raw = await readFile(join(projectDir(cwd), `${id}.jsonl`), 'utf8') } catch { return null }
  const lines = raw.split('\n')
  let cut = -1, fromMs = 0
  for (let i = 0; i < lines.length && cut < 0; i++) {
    if (!lines[i].includes(uuid)) continue
    try {
      const o = JSON.parse(lines[i]) as Record<string, unknown>
      if (o.uuid !== uuid) continue
      cut = i
      const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
      fromMs = Number.isNaN(ts) ? 0 : ts
    } catch { /* not JSON */ }
  }
  if (cut < 0) return null
  const main = editsInLines(lines, cwd, false).filter((e) => e.line > cut)
  const subs = (await subagentEdits(cwd, id)).filter((e) => e.ts >= fromMs)
  return { edits: [...main, ...subs].map(({ path, ts, tool, subagent }) => ({ path, ts, tool, subagent })), fromMs }
}

// Every successful file edit this conversation made at or after `sinceMs` — the view of
// ANOTHER session used for conflict detection, where only wall-clock time relates its turns
// to ours.
export async function fileEditsSince(cwd: string, id: string, sinceMs: number): Promise<FileEdit[]> {
  let raw: string
  try { raw = await readFile(join(projectDir(cwd), `${id}.jsonl`), 'utf8') } catch { return [] }
  const main = editsInLines(raw.split('\n'), cwd, false)
  return [...main, ...(await subagentEdits(cwd, id))]
    .filter((e) => e.ts >= sinceMs)
    .map(({ path, ts, tool, subagent }) => ({ path, ts, tool, subagent }))
}

// Result of forking before a turn: the new fork's id, or `{ empty: true }` when there is
// no resumable conversation before that turn (rewinding to the very first prompt) — the
// caller must restart fresh in that case rather than resume an empty transcript, or
// `null` when `uuid` isn't a line in this transcript.
export type ForkResult = { newId: string } | { empty: true } | null

// Fork a conversation to JUST BEFORE the user turn `uuid`: copy every transcript line
// preceding that one into a NEW conversation (fresh claude session id, stamped through
// each line's sessionId) and return the new id. The original transcript is left intact —
// a rewind is itself a fork, so resuming the original undoes it.
//
// Rewinding to the FIRST turn leaves only pre-conversation noise (queue-operation lines,
// etc.) before the cut — no user/assistant message. Claude's --resume rejects such a
// transcript ("No conversation found") and exits, so we signal `{ empty: true }` and
// write no fork file (which would also collide with the resume-fallback's --session-id).
export async function forkConversationBefore(cwd: string, id: string, uuid: string): Promise<ForkResult> {
  const dir = projectDir(cwd)
  let raw: string
  try { raw = await readFile(join(dir, `${id}.jsonl`), 'utf8') } catch { return null }
  const lines = raw.split('\n').filter((l) => l.trim())
  const parsed = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } })
  const cut = parsed.findIndex((o) => o?.uuid === uuid)
  if (cut < 0) return null
  // A conversation is resumable only if some real message precedes the cut; queue-operation /
  // attachment / mode / title lines alone are not a conversation Claude can --resume into.
  const hasMessage = parsed.slice(0, cut).some((o) => o?.type === 'user' || o?.type === 'assistant')
  if (!hasMessage) return { empty: true }
  const newId = crypto.randomUUID()
  const kept = parsed.slice(0, cut).map((o, i) => {
    if (!o) return lines[i]
    if ('sessionId' in o) o.sessionId = newId   // re-key the prefix to the fork
    return JSON.stringify(o)
  })
  // Trailing newline keeps the file line-framed like the CLI writes it.
  await writeFile(join(dir, `${newId}.jsonl`), kept.join('\n') + '\n')
  return { newId }
}
