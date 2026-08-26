import {
  type AccountConnector, type ConnectorDef,
  composedToolName, denyAllRule, toolNameUsable, isSafeDenyRule,
} from '@claudette/shared'
import { getConnector, listAccountConnectors, toolsOf } from './connectorStore'
import type { ConnectorProxy } from './connectorProxy'

// Turning a session's GRANTS into the two things a launch needs: the `mcpServers` object
// that goes into --mcp-config, and the deny rules that go into --disallowedTools.
//
// Both are computed SYNCHRONOUSLY, at launch, from persisted state only. That constraint
// is why ConnectorDef.tools is stored in the catalog rather than held in memory: launch()
// runs from restore() at boot with nothing dialled, and a deny list that had to wait on a
// probe would contribute nothing at exactly the moment it matters most.

// The MCP server entries for a session's granted catalog connectors.
//
// http  → a loopback proxy URL (the credential stays server-side; see ConnectorProxy).
// stdio → the definition VERBATIM, so the ENGINE spawns the child and it inherits the
//         session's bwrap namespace. Spawning it here would put it on the host, outside
//         every box — which is why Claudette deliberately grows no process manager.
export function connectorServers(
  sessionId: string,
  granted: string[],
  proxy: ConnectorProxy,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const id of granted) {
    const def = getConnector(id)
    // A grant naming a connector that has since been deleted is simply absent from the
    // launch. Failing the launch instead would let one stale grant strand a session.
    if (!def) continue
    // If we cannot even express a well-formed whole-server deny for this id, we have no
    // way to scope it later — so do not expose it at all. The isSafeDenyRule backstop
    // DROPS a malformed rule, and when the dropped rule is the whole-server one that
    // failed OPEN: a read-only role kept a server it was meant to be denied. Refusing the
    // mount is the fail-closed answer. (Unreachable via the API, which enforces
    // CONNECTOR_ID_RE — reachable via a hand-edited catalog.)
    if (!isSafeDenyRule(denyAllRule(def.id))) {
      console.warn(`[connectors] refusing to expose ${JSON.stringify(def.id)}: its id cannot form a valid deny rule, so it could never be scoped`)
      continue
    }
    out[def.id] = def.transport === 'http'
      ? { type: 'http', url: proxy.urlFor(sessionId, def.id) }
      : { command: def.command, ...(def.args?.length ? { args: def.args } : {}), ...(def.env ? { env: def.env } : {}) }
  }
  return out
}

// The deny rules for a session, in the CLI's rule grammar. Three independent sources:
//
//  1. ACCOUNT connectors the session was not allowed. Claudette holds no credential for
//     these and cannot withhold one, so a deny rule is the only lever — and it can only
//     cover names the operator declared. An undeclared account connector is NOT denied;
//     that is a fail-OPEN the UI must state plainly rather than imply away. Under strict
//     mode it is moot: the CLI never fetches account connectors at all.
//  2. READ-ONLY ROLES. A `reviewer` must not gain a mutating tool just because it arrived
//     over MCP. An unprobed connector denies the WHOLE server — absent classification
//     means "we haven't looked", which counts as write-capable (see ConnectorTool).
//  3. UNUSABLE TOOL NAMES. A tool whose composed `mcp__<id>__<tool>` breaks the Messages
//     API's name rule would otherwise fail the entire turn, not just that call.
export function connectorDenyRules(opts: {
  granted: string[]
  accountAllow: string[]
  readOnlyRole: boolean
  accountConnectors?: AccountConnector[]
}): string[] {
  const rules: string[] = []
  const allow = new Set(opts.accountAllow)
  for (const a of opts.accountConnectors ?? listAccountConnectors()) {
    if (!allow.has(a.name)) rules.push(denyAllRule(a.name))
  }
  // Per-connector GROUPS, not one flat list, so the size budget below can collapse a
  // whole connector at a time. MAX_TOOL_DENY_RULES bounds each connector on its own, but
  // `--disallowedTools` is a single argv entry shared by all of them plus the role's own
  // denials: sixteen connectors each sitting just under their individual cap still
  // overflowed MAX_ARG_STRLEN, and the resulting E2BIG is persistent (classification is on
  // disk and restore() relaunches at boot) — the same brick the per-connector cap exists
  // to prevent, reached by addition.
  const groups: { id: string; rules: string[] }[] = []
  for (const id of opts.granted) {
    const def = getConnector(id)
    if (!def) continue
    groups.push({ id, rules: roleScopedDenies(def, opts.readOnlyRole) })
  }
  rules.push(...fitDenyBudget(rules, groups))
  // FINAL FILTER — the injection backstop. Tool names come from the upstream server's
  // tools/list, i.e. from a party we do not control, and they end up in a comma-joined
  // argv value. Anything that is not a well-formed rule is dropped here rather than
  // trusted to have been validated on the way in. Dropping a per-tool rule is safe because
  // roleScopedDenies substitutes a whole-server deny whenever one can't be formed. Dropping
  // a WHOLE-SERVER rule would fail OPEN, so connectorServers refuses to expose a connector
  // whose id cannot produce one at all — the two halves have to be read together.
  const safe: string[] = []
  for (const r of new Set(rules)) {
    if (isSafeDenyRule(r)) { safe.push(r); continue }
    console.warn(`[connectors] dropping malformed deny rule ${JSON.stringify(r)} — it could forge entries in --disallowedTools`)
  }
  return safe
}

// Above this many per-tool rules we stop enumerating and deny the whole server instead.
// `--disallowedTools` is ONE argv entry, and Linux caps a single entry at MAX_ARG_STRLEN
// (32 * 4096 = 131072 bytes). A hostile upstream answering tools/list with a few thousand
// tools produced a 166 937-byte value, so every later launch of that session died with
// E2BIG — and since classification is persisted and restore() relaunches at boot, it
// stayed dead across restarts. Note what amplified it: `write` defaults TRUE when the
// server declines to hint, so the fail-CLOSED default made the rule list maximal.
// Collapsing is strictly MORE restrictive than enumerating, so the bound costs no safety.
const MAX_TOOL_DENY_RULES = 64

// Budget for the CONNECTOR share of the joined `--disallowedTools` value, in bytes.
// Linux caps one argv entry at MAX_ARG_STRLEN = 131072; the role's own denials are merged
// into the same entry, so leave real headroom rather than aiming at the true ceiling.
const MAX_DENY_VALUE_BYTES = 100_000

// Collapse whole connectors to a single deny-all rule, largest contributor first, until
// the joined value fits. Collapsing is strictly MORE restrictive than enumerating that
// connector's write tools, so this trades nothing away for the bound — and it is loud,
// because "your reviewer silently lost per-tool precision" is worth a line in the log.
function fitDenyBudget(accountRules: string[], groups: { id: string; rules: string[] }[]): string[] {
  const size = (): number =>
    [...accountRules, ...groups.flatMap((g) => g.rules)].join(',').length
  while (size() > MAX_DENY_VALUE_BYTES) {
    // Only groups still worth collapsing; one rule is already the floor.
    const biggest = groups.filter((g) => g.rules.length > 1).sort((a, b) => b.rules.length - a.rules.length)[0]
    if (!biggest) break   // everything is already a whole-server deny — nothing left to give
    console.warn(`[connectors] --disallowedTools is over budget — denying all of ${biggest.id} instead of its ${biggest.rules.length} per-tool rules`)
    biggest.rules = [denyAllRule(biggest.id)]
  }
  return groups.flatMap((g) => g.rules)
}

function roleScopedDenies(def: ConnectorDef, readOnlyRole: boolean): string[] {
  const tools = toolsOf(def.id)
  // A READ-ONLY ROLE IS DENIED THE WHOLE SERVER, ALWAYS — the classification is not
  // trusted to scope it. `write` is seeded from the upstream's own `annotations
  // .readOnlyHint` (connectorProxy.learnTools), i.e. from the very party being scoped, and
  // the MCP spec says outright that a client must not trust annotations from an untrusted
  // server. Enumerating per-tool denials therefore asked the connector which of its tools
  // a reviewer may call: a server answering `readOnlyHint: true` on `drop_table` got it
  // classified read-only, no rule was written for it, and a read-only role could call it.
  // Worse, setTools PERSISTS that answer to the on-disk catalog, so the lie survived
  // restarts and was replayed at boot by restore().
  //
  // This is not a new mechanism — it is the branch immediately below, widened from
  // "unprobed" to "read-only, full stop". The original design already failed CLOSED on
  // silence (absent hint ⇒ write:true; unprobed or empty ⇒ deny all); it only failed OPEN
  // on a lie. Removing the lie's only route in is the whole fix.
  //
  // The cost is real and deliberate: a read-only role now reaches NO connector tools at
  // all, including genuinely read-only ones. Restoring per-tool precision needs an
  // OPERATOR-set allowlist — `ConnectorTool.write` cannot serve, because setTools
  // overwrites `def.tools` wholesale on every tools/list, so an operator edit would be
  // clobbered by the next probe. That needs a new field on ConnectorDef and a way to set
  // it; deliberately not built here.
  if (readOnlyRole) return [denyAllRule(def.id)]

  const out: string[] = []
  for (const t of tools ?? []) {
    // A name we cannot express as a rule (illegal characters, or too long once prefixed)
    // gets the WHOLE SERVER denied instead of a hand-built rule containing that name.
    // Emitting the raw composed name here was an injection vector: a tool called
    // `evil,Bash` produced the rule `mcp__x__evil,Bash`, which the comma-join then split
    // into two — letting a malicious server write entries into the session's deny list.
    if (!toolNameUsable(def.id, t.name)) {
      console.warn(`[connectors] ${def.id} exposes an unusable tool name ${JSON.stringify(t.name)} — denying the whole server instead`)
      out.push(denyAllRule(def.id))
      continue
    }
    if (readOnlyRole && t.write) out.push(composedToolName(def.id, t.name))
  }
  if (out.length > MAX_TOOL_DENY_RULES) {
    console.warn(`[connectors] ${def.id} would need ${out.length} deny rules — denying the whole server instead, to keep --disallowedTools inside the argv size limit`)
    return [denyAllRule(def.id)]
  }
  return out
}

// What's actually in force for a session, as a comparable string. Same job as
// sandboxKey: the engine reads its server list once at spawn, so a grant change has to
// be detectable as "pending" against what the running process was launched with.
export function connectorKey(granted: string[] | undefined, accountAllow: string[] | undefined): string {
  // JSON rather than a join, so no member can forge a separator: `['a,b']` and `['a','b']`
  // produce the same joined string, which would make a real grant change look identical to
  // the running one and skip the relaunch. Validation already forbids commas in both id
  // spaces, so this is defence in depth — but a key whose correctness depends on a rule
  // enforced somewhere else is exactly the kind that breaks later.
  return JSON.stringify([[...(granted ?? [])].sort(), [...(accountAllow ?? [])].sort()])
}
