// Ambient "what the user is looking at" context, appended to a user turn before it
// goes to the CLI so Claude can resolve "this file" / "the current file" to the code
// file open in the user's editor. Native Edit/Write need an absolute path (only
// notebooks have path-less MCP tools), so without this Claude has to guess or ask.
//
// The block is sent to the CLI ONLY — it's kept out of the live transcript/broadcast
// and STRIPPED from every read-back (resume replay, conversation titles, rewind
// points; see conversations.ts) so it never surfaces in the UI and doesn't disturb
// /rewind's user-text matching.

const OPEN = '<editor-context>'
const CLOSE = '</editor-context>'

// The context block for a code file the user is currently viewing.
export function buildEditorContext(path: string): string {
  return `\n\n${OPEN}\n`
    + `The user is currently viewing this file in their editor: ${path}\n`
    + `If they say "this file", "the current/open file", or otherwise refer to the code on screen `
    + `without naming a path, they mean this one — edit it with the Edit/Write tools at this absolute path.\n`
    + `${CLOSE}`
}

// Remove a trailing editor-context block (with any whitespace around it) from stored
// user text, so nothing the CLI persisted leaks back into the UI.
//
// Cut at the LAST opening tag, not by regex. The end-anchored, lazily-quantified pattern
// this replaces matched from the FIRST `<editor-context>` whose closing tag was followed
// only by whitespace — so a prompt that itself contained the literal tag
// ("fix <editor-context>x</editor-context> please") had everything from the user's own
// tag onward swallowed, leaving "fix". Beyond mangling the displayed prompt, that broke
// the rewind matcher: attachPendingSnapshot compares the stripped point text against the
// raw text we sent, so the two could never agree again and the turn had no code snapshot.
// We only ever APPEND one block at the very end, so only a trailing one is ours.
export function stripEditorContext(text: string): string {
  const i = text.lastIndexOf(OPEN)
  if (i < 0) return text
  // Ours only if that last block runs to the very end (trailing whitespace aside).
  if (!text.slice(i).trimEnd().endsWith(CLOSE)) return text
  return text.slice(0, i).trimEnd()
}
