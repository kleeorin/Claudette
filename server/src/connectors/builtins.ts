import type { ConnectorDef } from '@claudette/shared'

// Connectors we ship, present in the catalog without the operator typing anything.
//
// ── WHY THESE LIVE IN CODE AND ARE MERGED AT READ TIME ────────────────────────────────
// The alternative — seeding them into connectors.json on first run — freezes a COPY at
// whatever we shipped that day. Correct a URL later and every existing install keeps the
// broken one, with no signal that it is stale and no way for the operator to know. It is
// the same failure as a comment that outlived what it described, except nobody can read it.
// "First run" is also ill-defined (missing file? empty array? the operator deleted the row
// deliberately?) and answering it needs another persisted flag that can itself drift.
// So: definitions here, and the operator's changes in a small override layer patched over
// the top (connectorStore's `builtinOverrides`). Built-ins get fixes; the operator keeps
// control, including hiding one.
//
// ── CONSTRAINTS ON `id`, BOTH LOAD-BEARING ────────────────────────────────────────────
// The id IS the MCP server name the engine sees, so it must satisfy CONNECTOR_ID_RE
// (/^[a-z0-9][a-z0-9-]{0,23}$/) and must never contain a comma — a comma forges an extra
// `--disallowedTools` entry, which scratchpad/rt2-connectors-c.mts guards against live.
// A user-defined connector with the same id WINS OUTRIGHT and hides the built-in; the two
// are not merged field-by-field, because silently blending two things the operator thinks
// are separate produces a definition nobody can explain.
export const BUILTIN_CONNECTORS: readonly ConnectorDef[] = [
  {
    id: 'confluence',
    name: 'Confluence (Atlassian)',
    transport: 'http',
    // ★ DO NOT "FIX" THIS TO https://mcp.atlassian.com/v1/sse.
    // Sources disagree about whether the legacy SSE endpoint is already dead: one says it
    // was dropped after 2026-06-30, Atlassian's own repo says still supported but not
    // recommended. `/v1/mcp/authv2` is correct under BOTH readings, so the disagreement
    // does not need resolving — but a future reader who finds `/sse` in a tutorial will
    // otherwise change us backwards, which is why the reasoning is here and not in a
    // commit message. Streamable HTTP, not SSE.
    url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    // No `requiresOAuthClient`: Atlassian supports OAuth 2.1 Dynamic Client Registration,
    // so the client self-registers on first connect. Nothing for the operator to create or
    // paste — which is the whole reason this one can honestly ship "available by default".
    //
    // The same endpoint also serves Jira, JSM, Bitbucket and Compass; a Jira entry would be
    // this definition with a different id and name, if it is ever asked for.
    //
    // ⚠ One precondition we cannot satisfy from here, and it is in the description because
    // it otherwise presents as OUR bug: an Atlassian SITE ADMIN must switch the remote MCP
    // server on for Confluence (Atlassian Admin → Products). A connect can legitimately
    // fail with everything correct on this side.
    builtin: true,
  },
  // ── GOOGLE WORKSPACE ────────────────────────────────────────────────────────────────
  // Per-product endpoints, and every one of them REQUIRES the operator to create their own
  // OAuth client (Cloud Console → Web application client ID + secret, consent screen with
  // product-specific scopes such as gmail.readonly / gmail.compose). Google offers no
  // Dynamic Client Registration, so unlike Confluence these CANNOT work out of the box.
  // That is a property of Google's design, not something to engineer around — so they ship
  // VISIBLE, OFF, and marked `needsSetup`, with the toggle blocked until a client exists.
  // The two rejected alternatives are worth knowing: hiding them until credentials exist
  // makes them undiscoverable, and letting them switch on and fail at connect produces the
  // least diagnosable error of the three.
  //
  // Not shipped but real, and the reason this is a list rather than five hard-coded blocks:
  // Slides (slidesmcp), Chat (chatmcp), and People — note People is on a DIFFERENT host
  // pattern, https://people.googleapis.com/mcp/v1, so do not derive the URL from the id.
  ...([
    ['gdrive', 'Google Drive', 'https://drivemcp.googleapis.com/mcp/v1'],
    ['gdocs', 'Google Docs', 'https://docsmcp.googleapis.com/mcp/v1'],
    ['gsheets', 'Google Sheets', 'https://sheetsmcp.googleapis.com/mcp/v1'],
    ['gcalendar', 'Google Calendar', 'https://calendarmcp.googleapis.com/mcp/v1'],
    ['gmail', 'Gmail', 'https://gmailmcp.googleapis.com/mcp/v1'],
  ] as const).map(([id, name, url]): ConnectorDef => ({
    id, name, transport: 'http', url, builtin: true, requiresOAuthClient: true,
  })),
]

// Human-readable why-can't-I-turn-this-on text. Kept beside the definitions so it cannot
// drift from them, and phrased as what the operator must DO rather than what we lack.
export const BUILTIN_SETUP_HINT: Record<string, string> = {
  gdrive: 'Needs a Google OAuth client (Cloud Console → Web application) with Drive scopes.',
  gdocs: 'Needs a Google OAuth client (Cloud Console → Web application) with Docs scopes.',
  gsheets: 'Needs a Google OAuth client (Cloud Console → Web application) with Sheets scopes.',
  gcalendar: 'Needs a Google OAuth client (Cloud Console → Web application) with Calendar scopes.',
  gmail: 'Needs a Google OAuth client (Cloud Console → Web application) with Gmail scopes.',
}

export const isBuiltinId = (id: string): boolean => BUILTIN_CONNECTORS.some((b) => b.id === id)
