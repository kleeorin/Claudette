// Connectors — external MCP servers a session may reach, as first-class Claudette
// objects. The CLI's own answer is "every configured server, in every session,
// invisibly"; this makes reach an operator-controlled per-session property, the way
// role / model / permission mode / sandbox mounts already are.
//
// TWO KINDS, because the credential decides what control is possible:
//
//   'catalog' — Claudette holds the credential (an API token, or OAuth it ran itself)
//               and injects the server into a session's --mcp-config. Absent from the
//               config ⇒ the session has no such tools at all. A real GRANT, and it
//               survives swapping the `claude` CLI for another engine.
//   'account' — a claude.ai connector bound to the user's Anthropic account and served
//               by the CLI. Claudette holds no credential, so it cannot inject one and
//               cannot withhold one either — the only lever is a DENY rule
//               (`mcp__<server>` in --disallowedTools). Weaker, and engine-bound.
//
// The validation rules live here rather than server-side because both ends need them:
// the web form rejects a bad id at the point of typing, and the store re-checks on
// save. Two copies of the regex would drift, which is the lesson tasks.ts/team.ts
// already record.

// Which transport a catalog connector speaks. 'http' is streamable HTTP — the only kind
// Claudette DIALS itself (it owns the OAuth, so the credential never enters a session).
//
// 'stdio' entries are CARRIED, not dialled: their definition is re-emitted verbatim into
// the session's --mcp-config so the ENGINE spawns the child. That matters for
// confinement — a child of `claude` inherits its bwrap namespace automatically, whereas
// a child of the Claudette server would run on the host, outside every box. Importing a
// user's existing stdio servers is what this kind exists for; we deliberately do not
// grow a host-side process manager.
//
// 'sse' is absent on purpose: it is deprecated in the current MCP spec, and Atlassian —
// the one target service that offered it — retired its /v1/sse endpoint on 2026-06-30.
export type ConnectorTransport = 'http' | 'stdio'

export type ConnectorKind = 'catalog' | 'account'

// An OAuth client (id + secret) registered by the USER with a provider, referenced by
// one or more connectors. Google publishes no dynamic client registration, so a
// hand-registered client is the normal path there rather than a fallback — and one
// Google client serves Gmail, Drive and Calendar, so the indirection stops the same
// secret being pasted once per connector.
export interface OAuthClient {
  id: string             // local reference id (not the provider's client_id)
  name: string           // display name, e.g. "Google Workspace"
  clientId: string
  clientSecret?: string  // SECRET — never leaves the server (see ConnectorView)
}

// A catalog connector's definition. `headers` / `env` / `args` / the URL's userinfo and
// query are all SECRET-BEARING and are redacted on the way out (toView).
export interface ConnectorDef {
  id: string                    // slug; ALSO the MCP server name the engine sees
  name: string                  // display name
  transport: ConnectorTransport
  // --- http ---
  url?: string
  headers?: Record<string, string>   // SECRET (e.g. Authorization: Basic …)
  oauthClientRef?: string            // OAuthClient.id, when this connector uses OAuth
  // --- stdio (carried, engine-spawned) ---
  command?: string
  args?: string[]                    // SECRET-BEARING (connection strings are common)
  env?: Record<string, string>       // SECRET
  // Grant this to every NEW session. Off by default: a connector that arrives switched
  // on everywhere is the ungoverned behaviour this feature exists to replace.
  enabledByDefault?: boolean
  // Where this came from, so the UI can explain a row the user didn't type. Set by the
  // import of a pre-existing CLI config.
  importedFrom?: string
  // ── BUILT-IN CONNECTORS ────────────────────────────────────────────────────────────
  // Shipped in code (server/src/connectors/builtins.ts) and merged into the catalog at
  // READ time, never seeded into connectors.json. Seeding would freeze a copy at first
  // run: correct a URL later and every existing install keeps the broken one, with no
  // signal that it is stale. Merging means built-ins get fixes, and the operator's
  // changes live in a small override layer patched over the top.
  builtin?: true
  // This vendor requires the OPERATOR to create their own OAuth client — there is no
  // Dynamic Client Registration, so the connector CANNOT work out of the box. A property
  // of the vendor, hence declared here and static.
  // ★ NOTE THIS IS THE REQUIREMENT, NOT THE STATE. Whether setup is outstanding is
  // DERIVED (see ConnectorView.needsSetup) from this plus whether an oauthClientRef is
  // set and still resolves. A stored "needsSetup" flag would be a second source of truth
  // for something already determined, and would go stale the moment a client is saved or
  // deleted — the one failure this file has the most scar tissue about.
  requiresOAuthClient?: true
  // The tool list learned by the last probe, PERSISTED with the definition rather than
  // held only in memory. launch() is synchronous and runs from restore() at boot with
  // nothing connected, so a read-only role's deny list has to be computable without
  // waiting on a dial — an unprobed connector would otherwise silently contribute no
  // denials at exactly the moment it matters.
  tools?: ConnectorTool[]
}

export type ConnectorHealth = 'connected' | 'connecting' | 'needs-auth' | 'error' | 'disconnected'

// One tool a connector exposes. `write` drives role scoping: a read-only role
// (`reviewer`, `planner`) must not gain a mutating tool just because it arrived over
// MCP. It is OPERATOR data, not connector data — seeded from the MCP
// `annotations.readOnlyHint`, which the spec explicitly says a client must not trust
// from an untrusted server, and defaulting to write-capable when the hint is absent OR
// when we simply haven't probed yet. Persisted in the catalog because launch() is
// synchronous and runs from restore() at boot with no connection warm.
export interface ConnectorTool {
  name: string
  description?: string
  write: boolean
}

// What the CLIENT is allowed to see. Secrets travel INWARD only: the browser posts a
// token and never receives it back. Note that `url` and `args` are redacted too, not
// just `headers`/`env` — `postgres://user:pass@host` as an arg and `?token=` in a URL
// are as common as an Authorization header, and an earlier draft of this type leaked
// both while claiming secrets were write-only.
export interface ConnectorView {
  id: string
  name: string
  kind: ConnectorKind
  transport?: ConnectorTransport   // catalog only
  urlDisplay?: string              // scheme + host only; no userinfo, path or query
  headerKeys: string[]             // names without values
  envKeys: string[]
  hasArgs: boolean
  // The stdio COMMAND, shown in full. Not a secret — and withholding it was worse than
  // useless: an imported stdio connector is a program the ENGINE will spawn, and with no
  // `command` on this type the operator had no way to see what they were about to grant,
  // before or after import. `args`/`env` stay redacted (connection strings live there);
  // `hasArgs` says whether any exist.
  command?: string
  oauthClientRef?: string
  enabledByDefault?: boolean
  importedFrom?: string
  // Shipped by us rather than typed by the operator. The UI uses this to explain a row
  // nobody added, and to offer "hide" instead of "delete" — a built-in cannot be deleted
  // because it is not stored; hiding records an override.
  builtin?: true
  // ★ DERIVED, never stored: this built-in needs an operator-created OAuth client and does
  // not have a usable one yet. It is a THIRD state, distinct from both disabled and error:
  //   · disabled — the operator chose not to grant it
  //   · needsSetup — it cannot be granted yet, and the UI must block the toggle rather
  //     than let it switch on and fail at connect (undiagnosable), or hide the row
  //     (undiscoverable)
  //   · error — it was dialled and something went wrong
  // Recomputed on every read from `requiresOAuthClient` + whether `oauthClientRef` still
  // resolves, so saving or deleting an OAuth client can never leave it disagreeing.
  needsSetup?: boolean
  // What the operator must DO about `needsSetup`, per product. Carried on the view rather
  // than duplicated in web/src: the text lives beside the definitions it describes
  // (BUILTIN_SETUP_HINT in server/src/connectors/builtins.ts) so it cannot drift from them,
  // and copying it into the client would recreate exactly the drift that placement avoids.
  // Absent for anything that does not need setup.
  setupHint?: string
  health: ConnectorHealth
  lastError?: string
  tools?: ConnectorTool[]
  // Sessions currently granted this connector. Editing a live connector applies only on
  // relaunch, and the UI has to say so rather than implying the change took effect.
  inUseBy?: number
}

// --- validation ------------------------------------------------------------------
// A bad id doesn't break one tool, it breaks EVERY turn of a granted session: the
// composed `mcp__<id>__<tool>` has to satisfy the Messages API's tool-name rule, and a
// request carrying one illegal name is rejected whole.

// No underscores, despite the composed name allowing them. The CLI attributes a call by
// splitting `mcp__<server>__<tool>` on '__' and taking index 1, so an id containing '__'
// resolves to the wrong server name — and every deny rule written against the real id
// silently stops matching, which is a security failure, not a cosmetic one.
export const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/

// `app` is the app-control server's own entry. Both land in ONE mcpServers object, so a
// connector claiming that name shadows it and silently deletes the notebook, pane and
// team tools from the session.
export const RESERVED_CONNECTOR_IDS: readonly string[] = ['app']

// The Messages API's tool-name constraint, applied to the COMPOSED name.
export const MAX_TOOL_NAME_LEN = 128
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/

export function composedToolName(connectorId: string, tool: string): string {
  return `mcp__${connectorId}__${tool}`
}

// Is this tool name usable at all? A connector is free to expose a tool whose name is
// legal upstream but too long once prefixed; those are dropped and surfaced rather than
// left to fail the whole turn.
export function toolNameUsable(connectorId: string, tool: string): boolean {
  return TOOL_NAME_RE.test(composedToolName(connectorId, tool))
}

// Returns null when valid, else the reason — phrased for display, since this is what the
// add-connector form shows under the field.
export function connectorIdError(id: string): string | null {
  if (!id) return 'An id is required.'
  if (RESERVED_CONNECTOR_IDS.includes(id)) return `"${id}" is reserved by Claudette.`
  if (!CONNECTOR_ID_RE.test(id)) {
    return 'Use 1–24 characters: lower-case letters, digits and hyphens, starting with a '
      + 'letter or digit. Underscores are not allowed — tool names are split on "__".'
  }
  return null
}

// A claude.ai ACCOUNT connector, as the operator declares it. Claudette holds no
// credential for these and cannot enumerate them either — the CLI fetches the list from
// the account at startup — so the operator names the ones they have. That list is only
// ever used to build DENY rules, which makes an incomplete list fail OPEN for the
// connectors it omits; the UI has to say so rather than implying full coverage. Under
// strict mode the question is moot: the CLI never makes the account fetch at all.
export interface AccountConnector {
  name: string     // the MCP server name the CLI uses, i.e. the `mcp__<name>` prefix
  label?: string   // display name, when it differs
}

// GET /api/connectors — everything the operator's connector UI needs in one read.
export interface ConnectorsResponse {
  connectors: ConnectorView[]
  oauthClients: (Omit<OAuthClient, 'clientSecret'> & { hasSecret: boolean })[]
  accountConnectors: AccountConnector[]
  // Is --strict-mcp-config in force for every session? OFF by default: switching it on
  // is what makes the catalog the only source of reach, and also what makes a
  // hand-configured server disappear — hence the pre-flight below.
  strict: boolean
}

// What switching strict mode ON would cost, computed BEFORE it is switched. The honest
// version of "your servers vanished": it names what would stop working, what can be
// carried over, and what this scan cannot see at all.
export interface StrictPreflight {
  // Servers found in the CLI's config files that are not yet in the catalog.
  // `transport` + `command` so the operator can judge a row BEFORE importing it: these
  // definitions come out of whatever repo they happened to open.
  importable: { id: string; name: string; source: string; transport?: string; command?: string }[]
  // Found but unrepresentable (SSE, no url/command, unusable name).
  skipped: { name: string; source: string; reason: string }[]
  // Already in the catalog — these survive, but only in sessions granted them.
  alreadyInCatalog: string[]
  // Sessions that currently have NO grants: under strict they reach no MCP server at all
  // beyond Claudette's own app-control tools.
  sessionsWithNoGrants: { id: string; name: string }[]
  // Standing caveats this scan structurally cannot enumerate — plugin-provided servers,
  // agent-frontmatter servers, and claude.ai account connectors all disappear under
  // strict and appear in none of the files scanned.
  notes: string[]
}

export interface SetSessionConnectorsRequest {
  id: string
  connectors: string[]         // catalog ids
  accountConnectors: string[]  // account connector names this session may use
}

// An MCP server name we are willing to write into a deny rule. Deliberately stricter than
// "non-empty": `--disallowedTools` is ONE comma-joined argv value, so any name that can
// contain a comma can forge additional rules — and a malformed value risks the CLI
// rejecting the whole list, taking NOTEBOOK_DENY and every role denial down with it.
// Account connector names are operator-typed and were previously unvalidated; a paste
// accident was enough. (Catalog ids are already covered by CONNECTOR_ID_RE.)
const SERVER_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

export function accountConnectorNameError(name: string): string | null {
  const n = name?.trim()
  if (!n) return 'A server name is required.'
  if (!SERVER_NAME_RE.test(n)) {
    return 'Use up to 64 characters: letters, digits, hyphens and underscores. '
      + 'Anything else could forge extra entries in the session\'s deny list.'
  }
  // SINGLE underscores are required — real account connectors are named like
  // `claude_ai_Google_Drive`. A DOUBLE underscore is the problem: the CLI attributes a
  // call by splitting `mcp__<server>__<tool>` on '__' and taking index 1, so a name
  // containing '__' makes `mcp__a__b` resolve to server `a`, and the deny rule written
  // against the real name silently stops matching. That fails OPEN — the connector stays
  // reachable while the UI claims it is denied — which is the same trap CONNECTOR_ID_RE
  // exists to close for catalog ids.
  if (n.includes('__')) {
    return 'Double underscores are not allowed: tool names are split on "__", so a rule '
      + 'naming this server would silently fail to match and the connector would stay reachable.'
  }
  return null
}

// Is this string safe to emit as a single rule in the comma-joined --disallowedTools
// value? The last line of defence: every rule the connector layer produces is filtered
// through this, so a name that slipped past validation upstream still cannot inject.
export function isSafeDenyRule(rule: string): boolean {
  return /^mcp__[a-zA-Z0-9_-]+(__[a-zA-Z0-9_-]+)?$/.test(rule) && rule.length <= MAX_TOOL_NAME_LEN
}

// The deny-rule form for a whole server. Verified against the CLI's own rule validator,
// which documents exactly three legal MCP shapes — `mcp__<server>`,
// `mcp__<server>__*`, `mcp__<server>__<tool>` — and rejects parenthesised patterns.
// This is what scopes a read-only role away from a connector, and what governs an
// account connector (where it is the ONLY lever).
export function denyAllRule(serverName: string): string {
  return `mcp__${serverName}`
}
