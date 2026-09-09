import type { OAuthClient, OAuthProvider } from '@claudette/shared'

// Where each supported provider's OAuth endpoints live, and the scopes our built-in
// connectors ask for. Static data, deliberately in code rather than in the catalog file:
// a preset the operator cannot mistype is the entire point (see OAuthClient.provider).
//
// NOTHING HERE DIALS ANYTHING. This module is data plus two pure resolvers, so it can be
// read, tested and reviewed without touching the authorize/refresh flow that consumes it.

interface ProviderPreset {
  authorizeUrl: string
  tokenUrl: string
  // Where to send a token for revocation, when the provider publishes one. Its presence is what
  // lets "Disconnect" mean revoked rather than merely forgotten — see CONNECTORS.md.
  revokeUrl?: string
  // A scope the provider REQUIRES for a refresh token, added to whatever the connector asks for.
  // Atlassian's `offline_access` is the case: omit it and everything works until the first
  // expiry, then stops with no signal pointing back here.
  requiresScope?: string
  // Endpoints come from discovery rather than from this table.
  discovered?: boolean
  // Sent as `access_type=offline&prompt=consent` for Google — without BOTH, a second
  // authorization of the same client returns no refresh_token at all and the connector dies
  // silently an hour later. Kept per-provider because it is a Google-specific wart.
  authorizeParams?: Record<string, string>
}

const PRESETS: Record<Exclude<OAuthProvider, 'custom'>, ProviderPreset> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    // Publishes a revocation endpoint, so "Disconnect" can genuinely revoke rather than merely
    // forget our copy. See revokeUrl / CONNECTORS.md.
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
  },
  // ATLASSIAN IS DISCOVERED, NOT PRESET. Its endpoints live under an opaque, rotating issuer id
  // (auth.atlassian.com/<id>/...), so any constant here is a bug with a delay on it — this
  // codebase already believed a registration endpoint (mcp.atlassian.com/v1/register) that the
  // authorization server's own metadata contradicts. The entry exists to carry the one thing
  // discovery cannot tell us: the authorize PARAMETER the provider requires.
  atlassian: {
    // Filled in from discovery at authorize time; never read from here.
    authorizeUrl: '',
    tokenUrl: '',
    // Atlassian's equivalent of Google's access_type=offline. WITHOUT IT NO REFRESH TOKEN IS
    // ISSUED, and the connector dies silently about an hour after it starts working — the same
    // class of wart as the Google pair, so it lives in the same place where it cannot be
    // forgotten rather than in whoever-writes-the-flow's memory.
    authorizeParams: { prompt: 'consent' },
    requiresScope: 'offline_access',
    discovered: true,
  },
}

// The endpoints to use for a client. A preset WINS over stored URLs rather than falling back
// to them: a stored authorizeUrl on a client later switched to `google` would otherwise keep
// quietly redirecting the token exchange — a client secret and an auth code POSTed to a host
// nobody re-approved. Returns null when a custom client has not supplied both.
export function endpointsFor(c: OAuthClient): { authorizeUrl: string; tokenUrl: string; authorizeParams?: Record<string, string>; requiresScope?: string; revokeUrl?: string } | null {
  const preset = c.provider && c.provider !== 'custom' ? PRESETS[c.provider] : undefined
  if (preset) return preset
  if (!c.authorizeUrl?.trim() || !c.tokenUrl?.trim()) return null
  return { authorizeUrl: c.authorizeUrl.trim(), tokenUrl: c.tokenUrl.trim() }
}

// The scopes we ASK FOR when authorizing a built-in connector.
//
// Verified 2026-09 against each endpoint's RFC 9728 metadata at
// <origin>/.well-known/oauth-protected-resource/mcp/v1 (public, no credential). Two of these
// were WRONG when written from the API-name pattern, and both would have consented cleanly and
// then failed at call time — the worst shape of bug, because the failure is nowhere near the
// cause:
//   · gdocs and gsheets are NOT standalone. Each needs a DRIVE scope alongside its own; a client
//     asking only for `documents` gets consent and then fails on file access.
//   · Gmail's broadest scope is `https://mail.google.com/` — not a googleapis.com URL at all, so
//     anything deriving scope strings from a template gets it wrong.
//
// ★ THESE ARE A MINIMUM, NOT THE ADVERTISED MENU, AND THE DIFFERENCE IS THE WHOLE POINT.
// `scopes_supported` lists what a resource ACCEPTS, not what we need. Requesting the advertised
// union would re-create the exact over-grant that moving scopes onto the connector avoided:
// gmail advertises `https://mail.google.com/` (unrestricted mailbox access), so a connector that
// asked for everything on the menu would put the most alarming consent screen in the set in
// front of someone who wanted to read their calendar. Ask for the least that works; let the
// operator widen it via ConnectorDef.scopes if they need more.
export const BUILTIN_SCOPES: Record<string, string[]> = {
  gdrive: ['https://www.googleapis.com/auth/drive'],
  // Drive alongside Docs/Sheets is REQUIRED, not belt-and-braces — see above.
  gdocs: ['https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/drive'],
  gsheets: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
  gcalendar: ['https://www.googleapis.com/auth/calendar'],
  // `gmail.modify` rather than `https://mail.google.com/`: read/compose/modify without the
  // unrestricted-mailbox scope, which includes permanent deletion.
  gmail: ['https://www.googleapis.com/auth/gmail.modify'],
  // CONFLUENCE ONLY. The Atlassian MCP endpoint advertises Jira, Compass and TWG scopes on the
  // SAME resource, so the advertised set is emphatically not the right ask: it would put Jira
  // write access on a consent screen for someone who asked for Confluence. Same over-grant
  // argument that put scopes on the connector rather than the client, and the same answer.
  // `offline_access` is NOT listed here — it is a provider requirement, merged in from the
  // atlassian preset, because a connector author has no reason to know Atlassian issues no
  // refresh token without it.
  confluence: [
    'read:confluence-user',
    'search:confluence',
    'read:page:confluence', 'write:page:confluence',
    'read:comment:confluence', 'write:comment:confluence',
    'read:space:confluence', 'read:hierarchical-content:confluence',
  ],
}

// What to ask for when authorizing a connector: its own declared scopes, else the built-in
// default. Empty means "we have nothing to ask for", which the caller must treat as a refusal to
// start a flow rather than as a request for every scope the client happens to hold.
export function scopesFor(connectorId: string, declared?: string[]): string[] {
  const s = declared?.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
  return s?.length ? s : (BUILTIN_SCOPES[connectorId] ?? [])
}

// The RFC 9728 protected-resource metadata for an MCP endpoint. Public, needs no credential.
//
// USED TO VALIDATE WHAT WE ASK FOR, NEVER TO CHOOSE IT.
//
// ★ SOMEONE WILL PROPOSE DISCOVERY-AS-SOURCE. It has already been proposed once, with a
// plausible precedent, so the counter-argument lives here rather than in a review comment.
//
// The proposal: fetch scopes at authorize time instead of shipping a list, so the list cannot go
// stale — which is the argument builtins.ts makes against freezing anything.
// WHY THAT PRECEDENT DOES NOT TRANSFER: a frozen list of things we ASK FOR is a different object
// from a live list of things a provider WILL GRANT, and only the first is ours to choose.
// `scopes_supported` is a MENU, not an ORDER.
//
// THE CONSEQUENCE, CONCRETELY: gmail advertises `https://mail.google.com/` — unrestricted mailbox
// access, including permanent deletion. A connector that requested its advertised set would put
// the most alarming consent screen in the whole set in front of someone who was connecting a
// calendar tool, with no way to decline the mail access and keep the calendar. That is the
// IDENTICAL over-grant that moving scopes onto the connector removed, re-entering through the
// discovery door.
//
// So discovery is used the other way round: to catch a scope we ask for that the resource does
// NOT advertise — which is exactly the gdocs/gsheets Drive-scope mistake, caught at authorize
// time and by name instead of at first tool call.
//
// Best-effort and NON-FATAL: a provider that is slow, offline, or does not publish this document
// must not block an operator from authorizing. A warning is the product here, not a gate.
export async function warnOnUnsupportedScopes(connectorUrl: string, asked: string[]): Promise<void> {
  try {
    const origin = new URL(connectorUrl).origin
    const res = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp/v1`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return
    const doc = await res.json() as { scopes_supported?: unknown; resource?: unknown }
    const supported = Array.isArray(doc.scopes_supported)
      ? doc.scopes_supported.filter((x): x is string => typeof x === 'string') : []
    if (!supported.length) return
    const unknown = asked.filter((a) => !supported.includes(a))
    if (unknown.length) {
      console.warn(`[connector-oauth] ${origin} does not advertise ${unknown.join(', ')} — `
        + 'authorization may succeed and then fail at call time. Advertised: '
        + `${supported.join(', ')}`)
    }
  } catch { /* discovery is advisory; never let it block an authorization */ }
}

// ★ THE `resource` VALUE, PINNED. Google serves TWO DIFFERENT values depending on which metadata
// document you fetch: /.well-known/oauth-protected-resource/mcp/v1 reports
// "https://calendarmcp.googleapis.com/mcp/v1", while the TOOL-SUFFIXED document reports the same
// origin with "/mcp" and NO "/v1". We pin the former — the one whose document also names
// accounts.google.com as the authorization server. Written down because the other value is real,
// reachable, and looks equally authoritative, so "fixing" this to match it is a plausible future
// change that would break token requests with no obvious cause.
export const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource/mcp/v1'

// The preset's authorize-time knobs for a connector, independent of where its ENDPOINTS came
// from. A DISCOVERED provider still needs its prompt / offline_access wart applied, and that wart
// is the one thing discovery cannot tell us: the metadata says which scopes exist, never which
// parameter a provider demands before it will issue a refresh token.
// Matched on the connector's own URL host, so it works for a connector that has no OAuthClient
// record at all — which is exactly the dynamically-registered case.
export function presetParams(def: { url?: string }): ProviderPreset | undefined {
  let host = ''
  try { host = def.url ? new URL(def.url).hostname : '' } catch { host = '' }
  if (host.endsWith('atlassian.com')) return PRESETS.atlassian
  if (host.endsWith('googleapis.com')) return PRESETS.google
  return undefined
}
