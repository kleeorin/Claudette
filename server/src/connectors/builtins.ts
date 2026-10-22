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
//
// ── CONFLUENCE WAS REMOVED 2026-10-21 (operator's decision) ───────────────────────────
// A 'confluence' built-in (Atlassian's remote MCP server, https://mcp.atlassian.com/v1/mcp/authv2,
// authorized by Dynamic Client Registration) shipped here until then. Atlassian is still
// SUPPORTED as a USER-ADDED connector: the `atlassian` provider preset (oauthProviders.ts) is
// matched on the connector's host, not on this list, and the DCR flow is generic. Use
// `/v1/mcp/authv2`, not the legacy `/v1/sse`, if you add one.
// What an install that had it is left with, and why none of it can crash anything: a
// `builtinOverrides.confluence` patch is ignored (listConnectors iterates this list only);
// stored tokens and a DCR registration are inert (nothing iterates them); a session grant is
// skipped at launch and dropped on the next setConnectors. Disconnect BEFORE upgrading if you
// want the Atlassian-side grant REVOKED — afterwards revokeUrlFor() has no definition to
// resolve an endpoint from, so disconnect can only forget the local copy.
export const BUILTIN_CONNECTORS: readonly ConnectorDef[] = [
  // ── GOOGLE WORKSPACE ────────────────────────────────────────────────────────────────
  // Per-product endpoints, and every one of them REQUIRES the operator to create their own
  // OAuth client (Cloud Console → Web application client ID + secret, consent screen with
  // product-specific scopes such as gmail.readonly / gmail.compose). Google offers no
  // Dynamic Client Registration, so these CANNOT work out of the box.
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
