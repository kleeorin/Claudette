import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dataDir } from '../util/dataDir'
import { mangleCwd } from '../claude/conversations'

// Role handover notes: what a dismissed teammate leaves behind for whoever holds the
// role next.
//
// The problem this solves: a teammate is a session, and a session's knowledge lives in
// its conversation. Dismissing it orphans that conversation, so hiring a fresh Reviewer
// gets you someone with the same job title and no memory of your codebase. Anything a
// teammate wrote to a FILE survives; anything it merely knew does not. So we make the
// exit interview write it down.
//
// Notes are keyed by (working directory, role) — knowledge about this codebase held by
// whoever does this job — and live in Claudette's data dir rather than the user's repo:
// the server is the only reader and writer (it injects them into a new hire's first
// turn), so they never need to be inside anyone's sandbox, and they can't be committed
// by accident.

// Same cwd mangling the CLI uses for its own project dirs, so the folders line up
// recognisably when someone goes looking. Note it is LOSSY (/a/b-c and /a/b/c collide),
// so two unrelated projects can share a notes namespace — acceptable because a note is
// advisory context for the same machine's operator, not a security boundary.
const notesDir = (cwd: string): string => join(dataDir(), 'team-notes', mangleCwd(cwd))
const notesFile = (cwd: string, role: string): string => join(notesDir(cwd), `${role.replace(/[^a-zA-Z0-9_-]/g, '-')}.md`)

// Entries are separated by a sentinel comment so the file stays readable as markdown
// while still being splittable for the cap.
const SEP = '\n<!-- entry -->\n'

// How many predecessors' notes to keep. A rolling window, because the point is to hand
// over what's still true — an unbounded log would eventually cost more context than the
// knowledge is worth, and the oldest entries are the most likely to be stale.
const MAX_ENTRIES = 5

// Bytes kept per entry. MAX_ENTRIES bounds the COUNT, not the size, and every note is
// injected verbatim into a new hire's first turn — so without this one departing teammate
// could make every future hire in that role start with a megabyte of context.
const MAX_ENTRY_CHARS = 4000

// Everything left for this role in this workspace, newest last, or null when nobody has
// held the role before. Best-effort: unreadable notes are simply absent, never fatal —
// a hire must never fail because of its predecessor's paperwork.
export function readRoleNotes(cwd: string, role: string): string | null {
  try {
    const body = readFileSync(notesFile(cwd, role), 'utf8').trim()
    return body || null
  } catch {
    return null
  }
}

// Append one teammate's parting notes, trimming to the most recent MAX_ENTRIES.
export function appendRoleNote(cwd: string, role: string, author: string, notes: string): void {
  const trimmed = notes.trim()
  if (!trimmed) return
  try {
    mkdirSync(notesDir(cwd), { recursive: true })
    const file = notesFile(cwd, role)
    let existing: string[] = []
    try {
      existing = readFileSync(file, 'utf8').split(SEP).map((s) => s.trim()).filter(Boolean)
    } catch { /* first note for this role */ }
    const body = trimmed.length > MAX_ENTRY_CHARS
      ? `${trimmed.slice(0, MAX_ENTRY_CHARS)}\n\n…(handover truncated at ${MAX_ENTRY_CHARS} characters)`
      : trimmed
    // The author name reaches here from employ_teammate's `name` argument, i.e. from a
    // model, and lands in a markdown header in a file every future hire reads. Unsanitised,
    // a name containing newlines writes arbitrary extra structure into the shared note —
    // its own headers and sections — so collapse whitespace and cap it.
    const who = author.replace(/\s+/g, ' ').trim().slice(0, 60) || 'a teammate'
    const entry = `## ${new Date().toISOString()} — ${who}\n\n${body}`
    const kept = [...existing, entry].slice(-MAX_ENTRIES)
    writeFileSync(file, kept.join(SEP) + '\n')
  } catch { /* best-effort: losing a note must never break a dismissal */ }
}
