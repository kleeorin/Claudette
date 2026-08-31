import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, unlinkSync } from 'fs'
import path from 'path'
import { dataDir } from '../util/dataDir'
import { errMessage } from '../util/errMessage'
import { BUILTIN_CONNECTORS } from './builtins'
import {
  type ConnectorDef, type ConnectorView, type ConnectorTool, type ConnectorHealth,
  type OAuthClient, type AccountConnector, connectorIdError, accountConnectorNameError, MAX_TOOL_NAME_LEN,
} from '@claudette/shared'

// The connector catalog: the operator's list of external MCP servers, plus the OAuth
// clients they reference. THE source of truth for what a session may be granted.
//
// WHY IT LIVES IN dataDir(): this file holds API tokens, stdio env vars, and (in its
// sibling connector-creds.json) OAuth refresh tokens. dataDir() is ~/.config/claudette,
// which is outside the DEFAULT mount set of every session sandbox — the same property
// that makes
// sessions.json safe to replay as trusted at boot (see util/dataDir.ts). Putting the
// catalog anywhere under ~/.claude would hand every confined session every connector
// credential, and would let one edit its own grants for the next restart.
//
// Written 0600 and via tmp+rename, matching session/sessionPersistence.ts: a crash
// mid-write must not leave a truncated catalog, because a truncated catalog silently
// revokes connectors on the next boot.

interface Catalog {
  connectors: ConnectorDef[]
  oauthClients: OAuthClient[]
  // Operator-declared claude.ai account connectors. Kept here rather than probed because
  // Claudette has no way to enumerate them (no credential, no API) — see AccountConnector.
  accountConnectors: AccountConnector[]
  // Is --strict-mcp-config in force for every launch? Off by default; turning it on is a
  // deliberate operator act preceded by the pre-flight report, because it is the switch
  // that makes a hand-configured MCP server stop appearing in sessions.
  strict: boolean
  // The operator's changes to BUILT-IN connectors, keyed by built-in id. A PATCH, never a
  // copy of the definition — a copy is what seeding would have been, and it would stop the
  // built-in ever receiving a fix. Only fields the operator actually changed live here.
  builtinOverrides: Record<string, BuiltinOverride>
}

export interface BuiltinOverride {
  // The operator does not want to see this row. Built-ins cannot be DELETED — they are not
  // stored, so there is nothing to remove — and a delete button that silently did nothing
  // on the next read would be worse than no button. Hiding is the honest verb.
  hidden?: boolean
  enabledByDefault?: boolean
  oauthClientRef?: string
  // Learned tool classification. A user connector persists this on its def in
  // connectors.json; a built-in has no stored def, so it lives here — and it MUST be
  // persisted, not held in a Map. launch() is synchronous and runs from restore() at boot
  // with nothing dialled, so a read-only role's deny list has to be computable without
  // waiting on a probe. An in-memory Map would make every built-in contribute zero denials
  // for the whole first turn after a restart — fail-open, at exactly the wrong moment.
  tools?: ConnectorTool[]
}

const EMPTY: Catalog = { connectors: [], oauthClients: [], accountConnectors: [], strict: false, builtinOverrides: {} }

const file = (): string => path.join(dataDir(), 'connectors.json')

// Runtime state that is NOT persisted: health and the last error are properties of a
// live connection, and a restart legitimately knows nothing about them. Keeping them out
// of the file also stops a stale 'connected' from being served before anything is dialled.
// Tool classification, by contrast, IS persisted (see ConnectorDef consumers below) —
// launch() is synchronous and runs from restore() at boot with no connection warm, so a
// role's deny list cannot wait on a probe.
const health = new Map<string, { health: ConnectorHealth; lastError?: string }>()
// NB there is deliberately no separate `tools` Map. Classification lives on the cached
// ConnectorDef and nowhere else: a Map alongside it meant load() copied def→map,
// persist() copied map→def, every reader used the map, and `getConnector(x).tools` was
// therefore silently STALE from the moment setTools ran — one fact stored twice, with
// only convention keeping the wrong copy out of a decision.

let cache: Catalog | null = null

function load(): Catalog {
  if (cache) return cache
  try {
    const p = file()
    if (!existsSync(p)) return (cache = { ...EMPTY })
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<Catalog>
    cache = {
      connectors: Array.isArray(parsed.connectors) ? parsed.connectors : [],
      oauthClients: Array.isArray(parsed.oauthClients) ? parsed.oauthClients : [],
      accountConnectors: Array.isArray(parsed.accountConnectors) ? parsed.accountConnectors : [],
      // Default FALSE on a malformed/absent value. Defaulting to true would silently cut
      // every session off from its configured servers because a field failed to parse.
      strict: parsed.strict === true,
      builtinOverrides: (parsed.builtinOverrides && typeof parsed.builtinOverrides === 'object')
        ? parsed.builtinOverrides as Record<string, BuiltinOverride> : {},
    }
    return cache
  } catch (e) {
    // A corrupt catalog must not take the server down — but it must be LOUD, because
    // running on an empty one silently revokes every grant.
    console.error(`[connectors] could not read the catalog, starting empty: ${errMessage(e)}`)
    return (cache = { ...EMPTY })
  }
}

function persist(c: Catalog): void {
  const p = file()
  const tmp = `${p}.tmp`
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)   // explicit: a pre-existing tmp would keep its old mode
  renameSync(tmp, p)
  cache = c
}

// --- reads -------------------------------------------------------------------------

// The catalog as everything downstream sees it: the operator's own connectors, plus the
// built-ins we ship, merged HERE rather than seeded into the file. Every consumer
// (connectorApi, the deny-rule builder, launch()) goes through this, so a built-in is a
// first-class connector everywhere without any of them knowing built-ins exist.
export function listConnectors(): ConnectorDef[] {
  const c = load()
  const own = [...c.connectors]
  const ownIds = new Set(own.map((x) => x.id))
  const merged = [...own]
  for (const b of BUILTIN_CONNECTORS) {
    // A user-defined connector with the same id WINS OUTRIGHT and the built-in disappears.
    // Not a field-by-field merge: blending two definitions the operator believes are
    // separate produces behaviour neither of them describes.
    if (ownIds.has(b.id)) continue
    const ov = c.builtinOverrides[b.id]
    if (ov?.hidden) continue
    // Spread the override LAST so the operator's choices win, but only for the fields they
    // actually set — everything else (url, transport, name) keeps tracking what we ship,
    // which is the entire point of not seeding.
    merged.push({
      ...b,
      ...(ov?.enabledByDefault !== undefined ? { enabledByDefault: ov.enabledByDefault } : {}),
      ...(ov?.oauthClientRef !== undefined ? { oauthClientRef: ov.oauthClientRef } : {}),
      // Classification is persisted per-connector for user entries; for a built-in it lives
      // in the health/tools side-channel the same way, so read it back here.
      ...(ov?.tools ? { tools: ov.tools } : {}),
    })
  }
  return merged
}


export function getConnector(id: string): ConnectorDef | undefined {
  return listConnectors().find((c) => c.id === id)
}

export function listOAuthClients(): OAuthClient[] {
  return [...load().oauthClients]
}

export function getOAuthClient(id: string): OAuthClient | undefined {
  return load().oauthClients.find((c) => c.id === id)
}

export function toolsOf(id: string): ConnectorTool[] | undefined {
  // Through getConnector, NOT the raw stored list. A built-in's classification lives in the
  // override layer, so reading `load().connectors` directly returned undefined for every
  // built-in — and this function feeds the read-only role's deny rules, so that would have
  // been silently FAIL-OPEN: a built-in contributing no denials at all, with nothing to see.
  return getConnector(id)?.tools
}

export function listAccountConnectors(): AccountConnector[] {
  return [...load().accountConnectors]
}

export function setAccountConnectors(list: AccountConnector[]): AccountConnector[] {
  const c = load()
  // De-dupe by name, and VALIDATE it. The name is the deny-rule key and lands in the
  // comma-joined --disallowedTools value, so a name containing a comma forges extra rules
  // (and an empty one emits the rule `mcp__`, which the CLI rejects — taking the whole
  // launch with it). Rejected entries are dropped loudly rather than silently mangled.
  const seen = new Set<string>()
  c.accountConnectors = list
    .map((a) => ({ ...a, name: a.name?.trim() ?? '' }))
    .filter((a) => {
      const err = accountConnectorNameError(a.name)
      if (err) { console.warn(`[connectors] dropping account connector ${JSON.stringify(a.name)}: ${err}`); return false }
      if (seen.has(a.name)) return false
      seen.add(a.name)
      return true
    })
  persist(c)
  return c.accountConnectors
}

export function strictMode(): boolean {
  return load().strict
}

export function setStrictMode(enabled: boolean): boolean {
  const c = load()
  c.strict = enabled
  persist(c)
  return c.strict
}

// Connectors granted to every NEW session. Deliberately a per-connector opt-in rather
// than a global default: a connector that arrives switched on everywhere reproduces the
// ungoverned reach this feature replaces.
export function defaultGrants(): string[] {
  return load().connectors.filter((c) => c.enabledByDefault).map((c) => c.id)
}

export function setHealth(id: string, h: ConnectorHealth, lastError?: string): void {
  health.set(id, { health: h, lastError })
}

// Bounds on what an upstream may write into our catalog. Without these, one tools/list
// reply grew connectors.json to 40 MB (descriptions are persisted verbatim), and a few
// thousand tools produced a --disallowedTools value past the argv size limit that bricked
// every later launch of any session granted the connector.
const MAX_PERSISTED_TOOLS = 500
const MAX_TOOL_DESC = 500

export function setTools(id: string, list: ConnectorTool[]): void {
  if (list.length > MAX_PERSISTED_TOOLS) {
    console.warn(`[connectors] ${id} advertised ${list.length} tools — keeping the first ${MAX_PERSISTED_TOOLS}`)
  }
  list = list.slice(0, MAX_PERSISTED_TOOLS).map((t) => ({
    ...t,
    name: t.name.slice(0, MAX_TOOL_NAME_LEN),
    description: t.description ? t.description.slice(0, MAX_TOOL_DESC) : undefined,
  }))
  const c = load()
  const def = c.connectors.find((d) => d.id === id)
  if (def) { def.tools = list; persist(c); return }   // classification is durable
  // A BUILT-IN has no stored def; its classification goes in the override layer. Guarded on
  // the id actually being a built-in so a probe for a connector that no longer exists still
  // does nothing, exactly as before.
  if (BUILTIN_CONNECTORS.some((b) => b.id === id)) {
    c.builtinOverrides[id] = { ...c.builtinOverrides[id], tools: list }
    persist(c)
  }
}

// --- redaction ---------------------------------------------------------------------

// Scheme + host only. A connector URL routinely carries a secret in its userinfo
// (`https://user:tok@host`) or query (`?token=…`); an earlier draft of this redaction
// omitted url and args entirely while the type claimed secrets were write-only.
function urlDisplay(url?: string): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return undefined   // unparseable ⇒ show nothing rather than risk echoing a secret
  }
}

// Is there an OAuth client here that could actually complete a flow? Deliberately stricter
// than "the ref resolves": saveOAuthClient requires a clientId but NOT a clientSecret, so a
// half-configured client resolves happily. Treating that as configured would clear
// needsSetup, unblock the toggle, and land the operator in the fail-at-connect state that
// was explicitly rejected in favour of blocking — the worst of the three to diagnose.
// ★ ASSUMPTION, stated so it can be revised rather than rediscovered: this requires a
// SECRET, which is right for the Google Web application clients these built-ins need. A
// public/PKCE client legitimately has no secret, so if one is ever supported this is the
// line to change — not the rule that a resolving ref means configured.
function oauthClientUsable(ref?: string): boolean {
  if (!ref) return false
  const c = getOAuthClient(ref)
  return !!c?.clientId?.trim() && !!c?.clientSecret?.trim()
}

export function toView(d: ConnectorDef, inUseBy?: number): ConnectorView {
  const h = health.get(d.id)
  return {
    id: d.id,
    name: d.name,
    kind: 'catalog',
    transport: d.transport,
    urlDisplay: urlDisplay(d.url),
    headerKeys: Object.keys(d.headers ?? {}),
    envKeys: Object.keys(d.env ?? {}),
    hasArgs: !!d.args?.length,
    command: d.command,
    oauthClientRef: d.oauthClientRef,
    enabledByDefault: d.enabledByDefault,
    ...(d.builtin ? { builtin: true as const } : {}),
    // DERIVED on every read, never stored: the vendor needs an operator-created OAuth
    // client and there is no usable one yet. Checking that the ref RESOLVES (not merely
    // that it is set) is the point — deleting the OAuth client must put the row straight
    // back into needs-setup, and a stored flag would have said "configured" forever.
    ...(d.requiresOAuthClient && !oauthClientUsable(d.oauthClientRef) ? { needsSetup: true } : {}),
    importedFrom: d.importedFrom,
    health: h?.health ?? 'disconnected',
    lastError: h?.lastError,
    tools: d.tools,
    inUseBy,
  }
}

// An OAuth client as the client may see it: the client_id is not a secret (it ships in
// every authorize URL), the secret is.
export function oauthClientView(c: OAuthClient): Omit<OAuthClient, 'clientSecret'> & { hasSecret: boolean } {
  const { clientSecret, ...rest } = c
  return { ...rest, hasSecret: !!clientSecret }
}

// --- writes ------------------------------------------------------------------------

export type SaveResult = { ok: true; def: ConnectorDef } | { ok: false; error: string }
export type SaveClientResult = { ok: true; client: OAuthClient } | { ok: false; error: string }

// Create or update. `id` is IMMUTABLE once created — grants, role deny rules, and the
// live `mcp__<id>__*` tool names in a running session are all keyed on it, so a rename
// would strand every grant and, worse, silently un-deny a read-only role's write tools.
// Renaming edits `name` only.
//
// Secret fields are OMIT-MEANS-KEEP, not omit-means-clear: the client never receives
// them (toView redacts), so a round-tripped edit form legitimately posts without them.
// Every rule a connector definition must satisfy, in ONE place so the importer cannot
// diverge from the API. It did: addImported checked only the id, so a hostile .mcp.json
// could store what saveConnector refuses — plaintext http:// to any host, file:// URLs,
// CRLF headers — and the proxy would then dial it. Returns null when the definition is
// acceptable, else the reason.
export function connectorDefError(input: ConnectorDef): string | null {
  const idErr = connectorIdError(input.id)
  if (idErr) return idErr
  if (!input.name?.trim()) return 'A name is required.'

  if (input.transport === 'http') {
    if (!input.url?.trim()) return 'An HTTP connector needs a URL.'
    let u: URL
    try { u = new URL(input.url) } catch { return 'That URL could not be parsed.' }
    // Scheme allowlist. Without it `file://`, `gopher://` and friends are dialable
    // destinations chosen by whoever wrote the config we imported.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return `"${u.protocol}" is not a supported scheme — use https (or http on 127.0.0.1).`
    }
    // Refuse plaintext to anywhere but loopback: a bearer token on the wire is exactly
    // what this feature exists to keep out of reach.
    if (u.protocol !== 'https:' && u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
      return 'Use https:// (http is allowed only for 127.0.0.1).'
    }
  } else if (!input.command?.trim()) {
    return 'A stdio connector needs a command.'
  }

  // Header names/values Node will refuse to send. A CRLF here is request-splitting in
  // shape, and it threw ERR_INVALID_CHAR deep inside the proxy — uncaught in an http
  // handler, that took the whole server down on every call to the connector.
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) return `"${k}" is not a valid header name.`
    if (/[\r\n\0]/.test(v) || /[^\t\x20-\x7e\x80-\xff]/.test(v)) {
      return `The value for "${k}" contains characters that cannot be sent in an HTTP header (line breaks or control characters).`
    }
  }
  return null
}

export function saveConnector(input: ConnectorDef): SaveResult {
  if (input.oauthClientRef && !getOAuthClient(input.oauthClientRef)) {
    return { ok: false, error: 'That OAuth client no longer exists.' }
  }

  const c = load()
  const existing = c.connectors.find((x) => x.id === input.id)
  // Merge FIRST, validate the merged result second. Validation used to run on the raw
  // input, which contradicted omit-means-keep: the edit form cannot pre-fill `url` or
  // `command` (toView redacts them, deliberately), so it submits them empty to mean "keep
  // the stored one" — and validation rejected that with "An HTTP connector needs a URL"
  // before the merge could supply it. Editing an existing connector at all, even just to
  // tick a checkbox, meant retyping its URL or command, while the field's own label
  // promised the opposite.
  let merged: ConnectorDef = existing
    ? {
        ...existing,
        ...input,
        headers: input.headers ?? existing.headers,
        env: input.env ?? existing.env,
        args: input.args ?? existing.args,
      }
    : input
  // A transport CHANGE drops the other transport's fields rather than carrying them over.
  // The merge above kept them, so an http→stdio switch left the old url AND its
  // Authorization header on disk indefinitely, and toView then reported a host and a
  // header set for a connector that used neither.
  if (existing && input.transport && input.transport !== existing.transport) {
    merged = input.transport === 'http'
      ? { ...merged, command: undefined, args: undefined, env: undefined }
      : { ...merged, url: undefined, headers: undefined }
  }

  const err = connectorDefError(merged)
  if (err) return { ok: false, error: err }
  const def = merged

  c.connectors = existing
    ? c.connectors.map((x) => (x.id === def.id ? def : x))
    : [...c.connectors, def]
  persist(c)
  return { ok: true, def }
}

// Edit a BUILT-IN. Deliberately its own function rather than a branch inside
// saveConnector: through saveConnector the two cases are indistinguishable — "change the
// built-in's OAuth client" and "create my own connector that happens to use the id
// `confluence`" arrive as the same call, and guessing between them silently does the wrong
// one. Measured: a harness case creating a user connector called `confluence` was swallowed
// as an override, and the operator's definition vanished.
// Only fields an operator can meaningfully change are accepted; url/transport/name keep
// tracking what we ship, which is the entire reason built-ins are not seeded.
export function setBuiltinOverride(id: string, patch: BuiltinOverride): ConnectorDef | undefined {
  if (!BUILTIN_CONNECTORS.some((b) => b.id === id)) return undefined
  const c = load()
  c.builtinOverrides[id] = { ...c.builtinOverrides[id], ...patch }
  persist(c)
  return getConnector(id)
}

export function removeConnector(id: string): boolean {
  const c = load()
  const next = c.connectors.filter((x) => x.id !== id)
  if (next.length === c.connectors.length) {
    // Nothing stored under that id — but it may be a BUILT-IN, which cannot be deleted
    // because it is not stored. Record the dismissal instead, so "remove" does what the
    // operator meant (the row goes away) rather than silently doing nothing and having it
    // reappear on the next read. Reversible: clear the override and it returns.
    if (BUILTIN_CONNECTORS.some((b) => b.id === id)) {
      c.builtinOverrides[id] = { ...c.builtinOverrides[id], hidden: true }
      health.delete(id)
      persist(c)
      return true
    }
    return false
  }
  c.connectors = next
  health.delete(id)   // the tools went with the def
  persist(c)
  return true
}

export function saveOAuthClient(input: OAuthClient): SaveClientResult {
  if (!input.id?.trim() || !input.name?.trim()) return { ok: false, error: 'An id and a name are required.' }
  if (!input.clientId?.trim()) return { ok: false, error: 'A client id is required.' }
  const c = load()
  const existing = c.oauthClients.find((x) => x.id === input.id)
  // Same omit-means-keep rule as connector secrets.
  const client: OAuthClient = existing
    ? { ...existing, ...input, clientSecret: input.clientSecret ?? existing.clientSecret }
    : input
  c.oauthClients = existing
    ? c.oauthClients.map((x) => (x.id === client.id ? client : x))
    : [...c.oauthClients, client]
  persist(c)
  return { ok: true, client }
}

export function removeOAuthClient(id: string): { ok: boolean; error?: string } {
  const c = load()
  const used = c.connectors.filter((x) => x.oauthClientRef === id).map((x) => x.name)
  if (used.length) return { ok: false, error: `Still used by: ${used.join(', ')}.` }
  const next = c.oauthClients.filter((x) => x.id !== id)
  if (next.length === c.oauthClients.length) return { ok: false, error: 'No such client.' }
  c.oauthClients = next
  persist(c)
  return { ok: true }
}

// Add imported definitions, skipping ids that already exist. Import is idempotent by
// construction so it can be re-run (it runs when the operator enables strict mode, not
// once at first boot — anything added the normal way in between would otherwise be
// silently dropped the moment strict lands).
// A definition the import refused, so the caller can TELL the operator. These used to be
// a console.warn and nothing else: the route's `skipped` comes from the file SCAN, so a
// def that scanned fine but failed validation vanished — the operator clicked "Import
// these 3", two arrived, no message explained the third, and the row was still offered as
// importable on every later run.
export interface ImportReject { name: string; source: string; reason: string }

export function addImported(defs: ConnectorDef[]): ConnectorDef[] {
  return addImportedDetailed(defs).added
}

export function addImportedDetailed(defs: ConnectorDef[]): { added: ConnectorDef[]; rejected: ImportReject[] } {
  const c = load()
  // `have` is UPDATED as we go. It used to be computed once, so two config keys slugging
  // to the same id (`my_db` and `my-db`) both landed in the catalog — duplicate entries
  // under one id, where getConnector returns whichever came first and removeConnector
  // deletes both.
  const have = new Set(c.connectors.map((x) => x.id))
  const added: ConnectorDef[] = []
  const rejected: ImportReject[] = []
  for (const d of defs) {
    if (have.has(d.id)) continue
    // The SAME validation the API applies. An import is not a trusted channel: these
    // definitions come out of files in whatever repo the operator happened to open.
    // A per-def try/catch too: one malformed entry must not abort the whole import
    // before persist, taking the valid entries beside it down with it.
    let err: string | null
    try { err = connectorDefError(d) } catch (e) { err = errMessage(e) }
    if (err) {
      console.warn(`[connectors] skipping import of ${JSON.stringify(d.id)}: ${err}`)
      rejected.push({ name: d.name || d.id, source: d.importedFrom ?? 'import', reason: err })
      continue
    }
    have.add(d.id)
    added.push(d)
  }
  if (added.length) {
    c.connectors = [...c.connectors, ...added]
    persist(c)
  }
  return { added, rejected }
}

// Test seam: drop the in-memory cache so a test (or a manual edit of the file) is seen.
export function resetConnectorCache(): void {
  cache = null
  health.clear()
}

// Remove the catalog entirely — only used by tests that created one under a
// CLAUDETTE_DATA_DIR override.
export function deleteCatalogFile(): void {
  try { unlinkSync(file()) } catch { /* nothing to remove */ }
  resetConnectorCache()
}
