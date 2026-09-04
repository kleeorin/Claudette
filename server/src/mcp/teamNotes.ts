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

// Characters of an entry INJECTED into a new hire's first turn. MAX_ENTRIES bounds the
// COUNT, not the size, and without this one departing teammate could make every future hire
// in that role start with a megabyte of context.
//
// ★ THIS IS A READ-TIME CAP, AND THAT IS THE WHOLE POINT. It used to be applied inside
// appendRoleNote, BEFORE writeFileSync — so the surplus was never written at all. Found on
// 2026-09-02, when five exit interviews (PM, Architect, Critic, QA, Devil) were discovered
// already destroyed at rest: every one cut off mid-sentence inside its recurring-defect
// section, losing the defect-pattern catalogue, the repo traps, the items VERIFIED CLOSED
// that a successor must not re-open, and the findings raised but never dispositioned. Three
// separate new hires reported receiving the stubs before anyone realised the full text had
// never existed on disk.
//
// The cap's stated purpose is bounding what a first turn COSTS. Truncating on read serves
// that purpose exactly, and truncating on write additionally destroys the one artefact a
// dismissed session can never be asked to rewrite — its author is gone by the time anyone
// notices. THE FIX DOES NOT RESTORE THOSE FIVE; they are unrecoverable. It prevents the sixth.
const MAX_INJECTED_ENTRY_CHARS = 4000

// A runaway guard on what is STORED, and deliberately not a second injection cap. 256 KB was
// chosen as a round power of two comfortably above any real note — about 13x the largest
// handover written here (~20 KB), not the "two orders of magnitude" an earlier draft of this
// comment claimed. (Two orders above 20 KB would be ~2 MB; the number was picked first and the
// justification written afterwards, which is how a tab bar in this repo came to be documented
// as h-9 while being h-8.) An entry that reaches this is a model pasting a file, not a
// teammate writing an exit interview.
// It exists only so a bug cannot grow this file without bound. If it ever bites a genuine
// handover, RAISE IT — the lesson above is that losing the text is the expensive failure and
// a large file is the cheap one.
const MAX_STORED_ENTRY_CHARS = 262_144

// Everything left for this role in this workspace, newest last, or null when nobody has
// held the role before. Best-effort: unreadable notes are simply absent, never fatal —
// a hire must never fail because of its predecessor's paperwork.
export function readRoleNotes(cwd: string, role: string): string | null {
  try {
    const file = notesFile(cwd, role)
    const raw = readFileSync(file, 'utf8').trim()
    if (!raw) return null
    // Truncate PER ENTRY, here at the point of use, so the cap bounds the first turn without
    // ever reaching the disk. Splitting on SEP first matters: capping the whole file instead
    // would spend the entire budget on the oldest predecessor and drop the newest — the one
    // most likely to still be true — off the end.
    const body = raw.split(SEP).map((s) => s.trim()).filter(Boolean)
      .map((entry) => {
        // Budget the BODY, not the whole entry. The `## <iso> — <author>` header is ~38
        // characters of metadata a reader needs in order to know whose advice this is and how
        // old it is; charging it to the content budget silently bought nothing and cost a
        // sentence of the handover.
        const nl = entry.indexOf('\n')
        const header = nl >= 0 ? entry.slice(0, nl) : ''
        const text = nl >= 0 ? entry.slice(nl + 1) : entry
        if (text.length <= MAX_INJECTED_ENTRY_CHARS) return entry
        // Say WHERE the rest is. A reader who knows only "this was shortened" cannot act; a
        // reader who knows the path can ask for it. That sentence is what would have turned
        // 2026-09-02's silent loss into a five-minute recovery — three new hires reported a
        // note cut mid-sentence and none could tell whether a fuller copy existed. The file
        // lives outside every sandbox, so a confined teammate has to ask for it.
        //
        // ★ THE CAVEAT IS NOT PADDING. Without it this notice is FALSE for precisely the five
        // notes the fix was written for: their surplus was destroyed at WRITE time in 2026-09,
        // so no fuller copy exists to fetch. They still land here — an old stub's body carries
        // the previous implementation's own "(handover truncated…)" line, which pushes it over
        // the cap — and telling a new hire to go and ask for text that is gone converts an
        // unknown into a confident falsehood. That is worse than the silence it replaced, and
        // it is the same wrong-direction error this whole fix exists to prevent.
        // Stated as a DATE rather than detected: sniffing for the old marker would misfire on
        // any note that legitimately quotes it, and handovers written since discuss it by name.
        return `${header}\n${text.slice(0, MAX_INJECTED_ENTRY_CHARS)}\n\n`
          + `…(shortened to ${MAX_INJECTED_ENTRY_CHARS} characters for this first turn. Notes are stored IN FULL at `
          + `${file} — ask your coordinator to read out the rest. CAVEAT: entries written before 2026-09-04 were `
          + 'truncated when they were SAVED, by a bug since fixed, so for those this may already be all that survives.)'
      })
      .join(SEP)
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
    // STORE THE WHOLE NOTE. The injection cap is applied in readRoleNotes; applying it here
    // as well would be the bug this function was fixed for — see MAX_INJECTED_ENTRY_CHARS.
    // The only cap left is the runaway guard, which no real handover reaches.
    const body = trimmed.length > MAX_STORED_ENTRY_CHARS
      ? `${trimmed.slice(0, MAX_STORED_ENTRY_CHARS)}\n\n…(stored note capped at ${MAX_STORED_ENTRY_CHARS} characters — this is the runaway guard, not the injection cap; if a real handover hit it, raise the constant)`
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
