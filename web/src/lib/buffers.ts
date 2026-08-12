// Unsaved editor text, keyed by file path. Only the active tab of the active session
// is mounted, so switching session, tab or file tears the editor down — and its text
// lived nowhere else, so edits you hadn't saved were silently gone when you came back
// (the file was simply re-read from disk). This keeps them until they're saved.
//
// Deliberately in memory, not localStorage: a file's text can be large, and an unsaved
// buffer that outlived a page reload would be a surprise the ● dirty marker no longer
// explains — within one app session it's exactly what "come back to what I was doing"
// means. Nothing here is ever written to disk on its own; saving is still explicit.
const buffers = new Map<string, string>()

/** The unsaved text for a path, or undefined if it has none. */
export function peekBuffer(path: string): string | undefined {
  return buffers.get(path)
}

/** Hold (or, with null, drop — it matches disk again) a path's unsaved text. */
export function setBuffer(path: string, text: string | null): void {
  if (text === null) buffers.delete(path)
  else buffers.set(path, text)
}
