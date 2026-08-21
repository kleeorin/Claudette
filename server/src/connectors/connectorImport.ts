import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { claudeConfigDir } from '../claude/sandbox'
import { errMessage } from '../util/errMessage'
import { type ConnectorDef, type ConnectorTransport, CONNECTOR_ID_RE, RESERVED_CONNECTOR_IDS } from '@claudette/shared'

// Find the MCP servers the user has ALREADY configured for the CLI, so adopting
// Claudette's catalog doesn't silently take them away.
//
// This exists because of `--strict-mcp-config`. Under it the CLI skips disk-config
// resolution entirely — .mcp.json, settings-scoped mcpServers, and
// ~/.claude.json projects[cwd].mcpServers all yield nothing, and the claude.ai
// account-connector fetch is never made. That is the point (the catalog becomes the only
// source of reach), but it means anything the user configured by hand vanishes the
// moment strict is switched on. Importing first turns "your servers disappeared" into
// "your servers are listed here, grant them per session".
//
// SCOPE, honestly: this reads the shapes the CLI reads, but a scan is not a migration.
//  • An imported HTTP server arrives NEEDS-AUTH. The CLI keeps OAuth credentials for
//    remote servers OUTSIDE the config entry, so the entry carries the URL, not the
//    grant. Claudette has to auth it again on its own terms.
//  • stdio entries are imported as CARRIED definitions: re-emitted verbatim into a
//    granted session's config so the ENGINE spawns them (and they inherit its sandbox).
//    Claudette never runs them itself.
//  • Plugin-provided and agent-frontmatter MCP servers are NOT here, because they aren't
//    in these files. Strict mode drops those too, and the pre-flight report — not this
//    scanner — is what has to say so.

export interface ImportSource {
  label: string      // human description of where it came from, for `importedFrom`
  path: string
}

// Every file the CLI would read a server definition out of, MOST SPECIFIC FIRST.
//
// Order is load-bearing, because a duplicated name resolves first-wins (see
// scanExistingServers). The CLI's own MCP scope precedence is local > project > user, so
// reading user settings first — as an earlier version of this list did — imported the
// LEAST specific definition of a conflicted name. That is not cosmetic: the operator ends
// up with a connector pointing at whatever stale URL their global config still carries,
// while the project's current one is silently dropped as a duplicate.
function sources(cwd: string): ImportSource[] {
  const cfg = claudeConfigDir()
  return [
    { label: 'local settings', path: path.join(cwd, '.claude', 'settings.local.json') },
    { label: 'project .mcp.json', path: path.join(cwd, '.mcp.json') },
    { label: 'project settings', path: path.join(cwd, '.claude', 'settings.json') },
    { label: 'user settings', path: path.join(cfg, 'settings.json') },
  ]
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch (e) {
    console.warn(`[connectors] skipping unreadable ${p}: ${errMessage(e)}`)
    return null
  }
}

// A raw entry as the CLI's config files carry it. Deliberately loose: these files are
// hand-edited, and a shape we don't recognise should be reported as unimportable rather
// than crash the scan.
interface RawServer {
  type?: string
  url?: string
  command?: string
  args?: unknown
  env?: unknown
  headers?: unknown
}

export interface ImportCandidate {
  def: ConnectorDef
  source: string
}

export interface ImportScan {
  candidates: ImportCandidate[]
  // Entries we found but cannot represent — surfaced so the pre-flight report can say
  // "this one will stop working and we can't carry it", instead of losing it quietly.
  skipped: { name: string; source: string; reason: string }[]
}

// Turn a config key into a legal connector id. The CLI's own naming is far looser than
// ours has to be (we forbid underscores, because the CLI attributes a tool call by
// splitting `mcp__<server>__<tool>` on '__' — an id containing '__' resolves to the wrong
// server and unmatches every deny rule written against it).
function toId(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[_\s.]+/g, '-')      // underscores, spaces and dots all become hyphens
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24)
  if (!slug || !CONNECTOR_ID_RE.test(slug) || RESERVED_CONNECTOR_IDS.includes(slug)) return null
  return slug
}

function asStringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val
  }
  return Object.keys(out).length ? out : undefined
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === 'string')
  return out.length ? out : undefined
}

// Translate one raw entry. Returns the reason it can't be carried, when it can't.
function translate(name: string, raw: RawServer, source: string): ImportCandidate | { reason: string } {
  const id = toId(name)
  if (!id) return { reason: `"${name}" cannot be turned into a valid connector id` }

  // `raw` is an UNCHECKED cast over whatever was in the file, so nothing has established
  // that these are strings. Without this, `{"x":{"url":123}}` produced a def whose url is
  // a number; validation then did `input.url?.trim()`, and optional chaining does not
  // guard a non-function property, so a TypeError was thrown inside addImported's loop —
  // uncaught, before persist. The route answered 500 and NOTHING was imported, including
  // the perfectly good entries alongside it.
  const url = typeof raw.url === 'string' ? raw.url : undefined
  const command = typeof raw.command === 'string' ? raw.command : undefined
  if (raw.url !== undefined && url === undefined) return { reason: `"${name}" has a non-string url` }
  if (raw.command !== undefined && command === undefined) return { reason: `"${name}" has a non-string command` }

  // The CLI infers stdio when a command is present and http/sse from the url; mirror that
  // rather than requiring an explicit `type`, since hand-written entries often omit it.
  const declared = typeof raw.type === 'string' ? raw.type.toLowerCase() : ''
  if (declared === 'sse') {
    // Carrying it as 'http' would change its wire protocol; better to say so. Checked
    // before the transport is inferred — the inference was dead work on this path.
    return { reason: `"${name}" uses the deprecated SSE transport, which Claudette does not speak` }
  }
  const transport: ConnectorTransport = (declared === 'http' || (!command && !!url)) ? 'http' : 'stdio'

  if (transport === 'http' && !url) return { reason: `"${name}" has no url` }
  if (transport === 'stdio' && !command) return { reason: `"${name}" has no command` }

  return {
    def: {
      id,
      name,
      transport,
      url: transport === 'http' ? url : undefined,
      headers: transport === 'http' ? asStringMap(raw.headers) : undefined,
      command: transport === 'stdio' ? command : undefined,
      args: transport === 'stdio' ? asStringArray(raw.args) : undefined,
      env: transport === 'stdio' ? asStringMap(raw.env) : undefined,
      // Imported connectors are NOT granted to anything by default. An import that
      // switched them on everywhere would reproduce the ungoverned behaviour this
      // feature replaces — the point is that reach becomes a deliberate per-session act.
      enabledByDefault: false,
      importedFrom: source,
    },
    source,
  }
}

// Scan every config the CLI would read for `cwd`. Later sources do not override earlier
// ones: the first definition of a name wins and any duplicate is dropped, matching how
// the operator will read the resulting list top-down.
export function scanExistingServers(cwd: string): ImportScan {
  const candidates: ImportCandidate[] = []
  const skipped: ImportScan['skipped'] = []
  const seen = new Set<string>()

  const take = (name: string, raw: unknown, source: string): void => {
    if (!raw || typeof raw !== 'object') return
    if (seen.has(name)) return
    seen.add(name)
    const r = translate(name, raw as RawServer, source)
    if ('reason' in r) skipped.push({ name, source, reason: r.reason })
    else candidates.push(r)
  }

  // ~/.claude.json, read from the canonical config dir first (what a sandboxed session
  // sees) then $HOME, since the two legitimately diverge; see claude/trust.ts for the same
  // two-file reasoning. The PROJECT entry is the CLI's `local` scope and the top-level map
  // is its `user` scope, so they sit at opposite ends of the precedence order rather than
  // being read together — hence two passes over the same files.
  // Parsed ONCE and reused by both passes: the file was read and JSON.parsed twice per
  // path, purely because the two scopes it holds sit at opposite ends of the precedence
  // order. Precedence is about the order we CONSUME the data, not how often we read it.
  const claudeJson = [...new Set([
    path.join(claudeConfigDir(), '.claude.json'),
    path.join(homedir(), '.claude.json'),
  ].map((x) => path.resolve(x)))]
    .map((p) => ({ p, d: readJson(p) }))
    .filter((x): x is { p: string; d: Record<string, unknown> } => !!x.d)

  // 1. local scope: ~/.claude.json → projects[cwd].mcpServers
  for (const { p, d } of claudeJson) {
    const project = (d.projects as Record<string, { mcpServers?: Record<string, unknown> }>)?.[path.resolve(cwd)]
    for (const [name, raw] of Object.entries(project?.mcpServers ?? {})) {
      take(name, raw, `${p} (this project)`)
    }
  }

  // 2. settings.json at each scope, and the project's .mcp.json — most specific first.
  for (const s of sources(cwd)) {
    const d = readJson(s.path)
    if (!d) continue
    for (const [name, raw] of Object.entries((d.mcpServers as Record<string, unknown>) ?? {})) {
      take(name, raw, `${s.label} (${s.path})`)
    }
  }

  // 3. user scope: ~/.claude.json → top-level mcpServers. Last, so a project-scoped
  // definition of the same name wins over the global one.
  for (const { p, d } of claudeJson) {
    for (const [name, raw] of Object.entries((d.mcpServers as Record<string, unknown>) ?? {})) {
      take(name, raw, `${p} (global)`)
    }
  }

  return { candidates, skipped }
}
