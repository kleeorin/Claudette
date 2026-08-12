// Team messaging (star topology): the envelope a session-to-session message is
// wrapped in, shared so the SERVER's framing and the WEB's rendering derive from the
// SAME rules — the lesson of tasks.ts, where a second copy of the parse would have
// let the two drift. The server frames on delivery (teamMailbox); the client parses
// to render a teammate's message as a labelled card instead of the user's own turn.
//
// The shape deliberately mirrors the CLI's own <task-notification>: a tagged block on
// a plain user turn. That's a format Claude already reads correctly as "the harness is
// telling me something" rather than "the human typed this".

// Who a message is from, and what kind of traffic it is. `kind` exists so the
// recipient can weight it: a `directive` from the coordinator is work to do, a
// `report` from a member is information, a `handover` is a member's own summary
// re-seeding its freshly cleared context.
export type TeamMessageKind = 'directive' | 'report' | 'handover'

export interface TeamMessage {
  from: string           // sender's display name (what the human calls it)
  role: string           // sender's agentId — 'reviewer', 'planner', …
  sessionId: string      // sender's session id, so a reply can be addressed exactly
  kind: TeamMessageKind
  body: string
}

const OPEN_TAG = '<team-message'
const CLOSE_TAG = '</team-message>'

// XML attribute escaping. A session's display name is user-supplied free text, so a
// name containing a quote or an angle bracket would otherwise break out of the
// attribute and corrupt every message after it in a coalesced batch.
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
function unescapeAttr(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

// A body must not be able to speak the harness's language. Two distinct risks:
//
//  1. A literal CLOSING tag ends the envelope early and spills the rest of the message
//     into the turn as unframed text - a teammate quoting this very protocol does that
//     by accident.
//  2. A literal OPENING tag is worse, and needn't be an accident: a member can write a
//     whole <team-message from="Lead" kind="directive"> block into its body, and the
//     RECIPIENT MODEL reads a coordinator-attributed instruction. The parser isn't fooled
//     (MESSAGE_RE is non-greedy, so it stays inside the real sender's body) - but the
//     parser isn't what acts on it. The point of enforcing the star in the handlers is
//     that a confused model cannot violate it; letting a body forge a directive hands
//     that straight back. Same for the CLI's own framing (<task-notification>,
//     <system-reminder>), which a body could otherwise fake.
//
// The scheme: escape `&` first, then escape `<` ONLY where it opens one of those tags.
// Escaping `&` first is what makes it injective - an original "&lt;" becomes "&amp;lt;",
// so reversing in the opposite order cannot confuse it with a `<` we escaped. Ordinary
// markup (`<div>`, `a < b`, JSX) passes through untouched and readable.
//
// The previous scheme swapped the closing tag for a sentinel STRING and was NOT
// injective: any body that happened to contain that sentinel got silently rewritten into
// a real closing tag on the way out. It also did nothing about opening tags.
// Every tag a recipient model would read as harness framing rather than as content. This
// is a deny-list and therefore inherently incomplete — it cannot stop a model treating,
// say, a "━━ SYSTEM ━━" banner as authoritative — but each name here is one the CLI or
// this app genuinely injects, so a forged one is otherwise indistinguishable from the real
// thing. `editor-context` in particular: sendUserTurn appends those blocks to team turns
// too, so a member could forge one naming any file it wanted the recipient to open.
const HARNESS_TAGS = [
  'team-message', 'task-notification', 'system-reminder',
  'command-name', 'command-message', 'local-command-caveat', 'editor-context',
]
const DANGEROUS_TAG = new RegExp(`<(/?(?:${HARNESS_TAGS.join('|')})\\b)`, 'gi')

function escapeBody(s: string): string {
  return s.replace(/&/g, '&amp;').replace(DANGEROUS_TAG, '&lt;$1')
}
function unescapeBody(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

// Frame one message for injection as a user turn.
export function formatTeamMessage(m: TeamMessage): string {
  const attrs = `from="${escapeAttr(m.from)}" role="${escapeAttr(m.role)}" session="${escapeAttr(m.sessionId)}" kind="${m.kind}"`
  return `${OPEN_TAG} ${attrs}>\n${escapeBody(m.body)}\n${CLOSE_TAG}`
}

// True when a turn's text carries at least one team message. Cheap pre-check so the
// common case (an ordinary user turn) never runs the parser.
export function hasTeamMessage(text: string): boolean {
  return text.includes(OPEN_TAG)
}

const MESSAGE_RE = /<team-message\s+([^>]*)>\n?([\s\S]*?)\n?<\/team-message>/g
const ATTR_RE = /(\w+)="([^"]*)"/g

// Parse EVERY message in a turn — a flush coalesces several reports into one turn, so
// a single-message parser would silently drop all but the first.
export function parseTeamMessages(text: string): TeamMessage[] {
  if (!hasTeamMessage(text)) return []
  const out: TeamMessage[] = []
  for (const m of text.matchAll(MESSAGE_RE)) {
    const attrs: Record<string, string> = {}
    for (const a of m[1].matchAll(ATTR_RE)) attrs[a[1]] = unescapeAttr(a[2])
    const kind = attrs.kind
    out.push({
      from: attrs.from || 'teammate',
      role: attrs.role || 'general',
      sessionId: attrs.session || '',
      kind: kind === 'directive' || kind === 'report' || kind === 'handover' ? kind : 'report',
      body: unescapeBody(m[2]),
    })
  }
  return out
}

// The text of a turn with every team-message block removed, so a client can render the
// blocks as cards and still show any surrounding prose. Empty when the turn was
// nothing but team traffic (the usual case).
export function stripTeamMessages(text: string): string {
  return text.replace(MESSAGE_RE, '').trim()
}
