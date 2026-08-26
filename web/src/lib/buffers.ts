// Unsaved editor text, keyed by file path. Only the active tab of the active session
// is mounted, so switching session, tab or file tears the editor down — and its text
// lived nowhere else, so edits you hadn't saved were silently gone when you came back
// (the file was simply re-read from disk). This keeps them until they're saved.
//
// Deliberately in memory, not localStorage: a file's text can be large, and an unsaved
// buffer that outlived a page reload would be a surprise the ● dirty marker no longer
// explains — within one app session it's exactly what "come back to what I was doing"
// means. Nothing here is ever written to disk on its own; saving is still explicit.
//
// ── A BUFFER IS ONLY VALID AGAINST THE DISK TEXT IT WAS TAKEN FROM ────────────
// Each entry stores the DISK text that was on screen when the edit was made (`base`),
// and peekBuffer only restores when disk still matches it. Without that check the
// buffer shadowed disk unconditionally and the editor showed stale content forever:
// open a file, let something change it underneath you (a Claude edit, a git checkout,
// another device), reopen it — and you got the buffer, not the file. The change was
// never "not recorded"; it was on disk the whole time and simply never displayed.
//
// MARKDOWN MADE THIS FIRE WITHOUT ANYONE TYPING. Milkdown re-normalizes on load and
// emits that document, so for any .md file whose bytes are not already in Milkdown's
// normal form, merely OPENING it produced text !== disk, which is this app's definition
// of dirty — so a buffer was stored, and that path was shadowed for the rest of the
// session. Plain-text files needed a real keystroke to get into the same state, which
// is why markdown looked like the broken one.
//
// WHEN DISK HAS MOVED, DISK WINS and the stale entry is dropped. That is the safe
// direction: showing the file as it actually is can be corrected by the user, whereas
// silently presenting old text invites a save that clobbers whatever arrived in the
// meantime. It costs unsaved edits only in the case where they were written against a
// version that no longer exists — and for the markdown case above there was no real
// edit to lose. save() keeps its own overwrite confirmation for the race that remains.
type Entry = { text: string; base: string }

const buffers = new Map<string, Entry>()

/**
 * The unsaved text for a path, or undefined if it has none — or if the file changed
 * on disk since the edit was made, in which case the stale entry is dropped so the
 * caller falls through to fresh disk text.
 *
 * @param disk the file's CURRENT text, just read from the server.
 */
export function peekBuffer(path: string, disk: string): string | undefined {
  const hit = buffers.get(path)
  if (!hit) return undefined
  if (hit.base !== disk) { buffers.delete(path); return undefined }
  return hit.text
}

/**
 * Hold (or, with null, drop — it matches disk again) a path's unsaved text.
 *
 * @param base the disk text this edit was made against; a later peekBuffer only
 *   restores `text` while disk still equals it.
 */
export function setBuffer(path: string, text: string | null, base = ''): void {
  if (text === null) buffers.delete(path)
  else buffers.set(path, { text, base })
}

/** Drop every buffer. Exported for tests; nothing in the app needs it. */
export function clearBuffers(): void {
  buffers.clear()
}
