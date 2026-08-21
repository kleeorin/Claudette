# Connectors — external MCP servers as per-session reach

The CLI's answer to "which MCP servers can this session use?" is *every configured server,
in every session, invisibly*. Connectors make reach an operator-controlled per-session
property, the way role, model, permission mode and sandbox mounts already are.

Status: **server-side and UI complete**, hardened across two adversarial passes. OAuth and
a standalone connection probe are deliberately not built — see [Deferred](#deferred).
The catalog lives in the global Claudette deck; per-session grants live in that session's
Sandbox panel (two scopes, two surfaces).

---

## Two kinds, because the credential decides what control is possible

| | `catalog` | `account` |
|---|---|---|
| Who holds the credential | Claudette | the user's Anthropic account |
| Mechanism | injected into `--mcp-config` | served by the CLI |
| Granting | real — absent from the config ⇒ the session has no such tools **at all** | impossible; we hold nothing to inject |
| Revoking | real, and immediate (see the proxy) | a deny rule, and only for names the operator declared |
| Survives swapping the engine | yes | no |

`account` is the weaker of the two and the docs say so rather than implying parity. Under
strict mode the distinction collapses: the CLI never fetches account connectors at all.

## The mount model's analogue: what a session actually gets

```
--mcp-config '{"mcpServers":{
    "app":  {"type":"http","url":"http://127.0.0.1:<mcp>/mcp/<token>"},     # always: Claudette's own tools
    "gh":   {"type":"http","url":"http://127.0.0.1:<proxy>/c/<token>"},     # granted http  → PROXIED
    "pg":   {"command":"mcp-postgres","args":[…],"env":{…}}                 # granted stdio → CARRIED
}}'
--disallowedTools '<NOTEBOOK_DENY>,<role denials>,mcp__gmail,mcp__gh__create_issue,…'
--strict-mcp-config                                                          # only when strict mode is on
```

Everything not granted is simply absent. There is no "connected but denied" state for a
catalog connector — the session has no such tools to call.

## Why HTTP connectors are proxied, not configured directly

The obvious implementation writes the connector's real URL and `Authorization` header into
the session's `--mcp-config`. That hands every granted session the **credential**: readable
from inside the box (it is on the process argv), reusable outside Claudette, and
impossible to revoke without a relaunch.

`ConnectorProxy` (`server/src/connectors/connectorProxy.ts`) keeps the secret server-side
and turns the grant into a live check:

- **Revocation is immediate.** Every request re-asks `SessionManager.isGranted`, which
  reads the *live* session record — not what the engine launched with. Ungranting stops
  the very next tool call, no relaunch. Verified in the test suite against a real upstream.
- **Granting still needs a relaunch**, because the engine reads its server list once at
  spawn and ignores `notifications/tools/list_changed`. That asymmetry is what
  `SessionInfo.connectorsPending` means — and it never means "still reachable".
- **The token is the attribution.** One random URL token per (session, connector), minted
  per launch, exactly as `AppControlMcpServer` does it. Every box shares the host network
  namespace (no `--unshare-net`), so the token — not network isolation — is what stops one
  session reaching another's connector. Tokens are released on relaunch and on destroy.
- **We see the traffic**, which is where tool classification comes from (below).

**stdio connectors are NOT proxied.** Their definitions are re-emitted verbatim so the
*engine* spawns the child, which puts it inside the session's bwrap namespace. A child of
the Claudette server would run on the host, outside every box. This is why Claudette
deliberately grows no host-side process manager.

## Trust gating — the mirror of the sandbox rule

Connector grants are **reach**, and reach is gated exactly as `sandbox.enabled` and
`teamEmploy` are (SANDBOX.md "Control-plane escape"). A confined session can reach the
loopback control API; without the gate it could grant *itself* a database, a ticket
tracker, an internal HTTP service the operator never gave it — which is the entire
property this feature establishes.

`normalizeGrants` refuses an untrusted grant. `trusted` is set only by the auth-gated HTTP
route, by boot restore of an already-approved value, and by inheritance of a parent's
already-approved set.

> Note the asymmetry with the sandbox gate. There, the refused direction is turning
> confinement **off**. Here it is turning reach **on**. Both refuse the *widening* move.

Two deliberate details:

- `setConnectors` **refuses** an untrusted call rather than applying it as empty. Silently
  revoking everything would turn a rejected escalation into a denial of service against
  the operator's own session.
- Subsessions **inherit** the parent's grants, like the sandbox — a teammate can only ever
  receive reach the operator already approved for the parent, never more.

## Read-only roles and tool classification

A `reviewer` must not gain a mutating tool merely because it arrived over MCP. Native deny
lists can't catch this: an MCP tool is in none of them.

- `Agent.readOnly` is **declared**, not inferred from `disallowedTools` — `reviewer` keeps
  `Bash` (to run `git diff` and tests) yet is still read-only in intent.
- `ConnectorTool.write` defaults **true** when the MCP `annotations.readOnlyHint` is
  absent. The spec explicitly says a client must not trust annotations from an untrusted
  server, and the other default would hand a read-only role a mutating tool because the
  server declined to describe itself.
- An **unprobed** connector denies the *whole server* for a read-only role. Absent
  classification means "we haven't looked", which counts as write-capable.
- Classification is **persisted in the catalog**, not held in memory, because `launch()` is
  synchronous and runs from `restore()` at boot with nothing dialled. A deny list that had
  to wait on a probe would contribute nothing at exactly the moment it matters.

Classification is learned from `tools/list` replies passing through the proxy. That is the
only probe in this build.

## Strict mode and its pre-flight

`--strict-mcp-config` is what makes the catalog the *only* source of reach: the CLI stops
resolving `.mcp.json`, settings-scoped `mcpServers` and `~/.claude.json` projects, and
never fetches account connectors. It is also what makes a hand-configured server vanish.

So it is **operator-enabled, off by default**, and `GET /api/connectors/preflight` reports
the cost before it is paid: what can be imported, what can't be represented, what is
already in the catalog, which sessions currently have no grants at all, and the standing
caveats the scan structurally cannot see (plugin-provided and agent-frontmatter servers,
and account connectors).

Import is idempotent by construction, so it can be re-run — it runs when the operator
enables strict mode, not once at first boot, and anything added the normal way in between
would otherwise be dropped.

**Import precedence is load-bearing.** A duplicated name resolves first-wins, and the
sources are read *most specific first* to match the CLI's own local > project > user
ordering. Reading user settings first (as the first draft did) imported the least specific
definition — leaving the operator with a connector pointing at a stale global URL while
the project's current one was dropped as a duplicate.

## Where the catalog lives, and why

`dataDir()/connectors.json`, mode `0600`, written tmp+rename.

It holds API tokens and stdio env vars. `dataDir()` is `~/.config/claudette`, which is
**outside the default mount set** of every session sandbox — the same property that makes
`sessions.json` safe to replay as trusted at boot (see `util/dataDir.ts`). Putting the
catalog anywhere under `~/.claude` would hand every confined session every connector
credential, and would let one edit its own grants for the next restart.

> **Not an absolute.** SANDBOX.md:505 states the honest version: out of reach of the
> *default* mounts is not the same claim as never mounted, and "an operator mount of `~`
> or `~/.config` exposes it". The catalog now puts live connector credentials beside
> `token` and `sessions.json` under exactly that caveat — so an operator who mounts `$HOME`
> into one session hands that box every connector credential *and* the loopback auth
> token, and therefore the trusted routes that gate GPU passthrough, `enabled:false`,
> `teamEmploy` and grants. Mounting `$HOME` rw into a sandboxed session defeats this
> feature's guarantees, not just the sandbox's.

Secrets travel **inward only**: `toView` redacts headers, env, args *and* the URL's
userinfo and query — `postgres://user:pass@host` as an arg and `?token=` in a URL are as
common as an `Authorization` header. Because the client never receives a secret, edits are
**omit-means-keep**; treating an omitted field as "clear it" would silently break every
round-tripped edit form.

## Validation rules that are not cosmetic

- **No underscores in an id.** The CLI attributes a tool call by splitting
  `mcp__<server>__<tool>` on `__` and taking index 1, so an id containing `__` resolves to
  the wrong server name — and every deny rule written against the real id silently stops
  matching. That is a security failure, not a naming preference.
- **`app` is reserved.** Both land in one `mcpServers` object, so a connector claiming that
  name shadows Claudette's own server and deletes the notebook, pane and team tools.
- **Composed tool names are length-checked.** A name that is legal upstream but too long
  once prefixed fails the *whole turn*, not just that call — so those are denied outright.
- **Ids are immutable.** Grants, deny rules and live `mcp__<id>__*` names are all keyed on
  the id; renaming would strand every grant and silently un-deny a read-only role's write
  tools. Renaming edits the display name only.
- **No plaintext http except loopback.** A bearer token on the wire is what this feature
  exists to keep out of reach.

## Adversarial testing (2026-08-17)

`scratchpad/connectors-gpu-adversarial-test.mts` — 29 attacks, every check written so that
*passing means the attack was blocked*. The threat model adds one actor to SANDBOX.md's:
a **malicious upstream MCP server**, whose responses we parse and whose tool names we feed
into the engine's command line.

Six real defects were found and fixed:

| # | Defect | Impact |
|---|---|---|
| B2 | `setConnectors` gated only on *non-empty* input, so an untrusted caller posting two empty arrays fell through and **cleared the grants** | A rejected escalation became sabotage of the operator's session. Now every untrusted call is refused, in both directions. |
| C1 | A tool name from `tools/list` was emitted **verbatim** into a deny rule. `--disallowedTools` is one comma-joined argv value, so a tool called `evil,Bash` **forged a second rule** | A malicious server could write entries into a session's deny list; a malformed value risks the CLI rejecting the *whole* list, including `NOTEBOOK_DENY`. An unusable name now denies the whole server, and every rule is filtered through `isSafeDenyRule` before it reaches argv. |
| C2 | Account connector names were unvalidated and reach the same argv value | Same injection, one paste accident away. `accountConnectorNameError` now applies at the store, the route and the form. |
| D3 | A server answering `tools/list` with `[]` read as "probed, nothing to deny" | A **read-only role got the whole server**. Empty and absent now both fail closed. |
| C2b | Account connector names allowed a **double** underscore. The CLI attributes a call by splitting `mcp__<server>__<tool>` on `__` and taking index 1, so `mcp__ev__il` resolves to server `ev` | **Fails open**: the deny rule silently stops matching and the connector stays reachable while the UI reports it denied. Found by checking the naming convention against real data — account connectors are really named `claude_ai_Google_Drive`, so single underscores had to stay legal while `__` is now rejected. |
| E4 | A CRLF in a connector header threw `ERR_INVALID_CHAR` inside the proxy's request construction — **uncaught in an HTTP handler** | Server-wide denial of service: one bad header, and every call to that connector killed Claudette. Now rejected at save *and* contained at the proxy, so a pre-existing catalog entry can't do it either. |

Confirmed already-holding: the GPU trust gate across every entry point (including
truthy-non-boolean smuggling and the forced-on downgrade branch), grant escalation via
`normalizeGrants`, client-supplied `Authorization`/`Cookie` never reaching upstream, the
operator credential never reaching the session, live revocation through an already-minted
URL, catalog mode `0600`, and no secret in any client-facing view.

### Second pass — independent red-team agent (2026-08-18), ALL FIXED

A second adversarial review found seven defects the first pass and my own suite missed.
All are now fixed and covered by regression tests in section G of
`scratchpad/connectors-gpu-adversarial-test.mts` (41 attacks blocked).

> Worth recording *why* they were not fixed on discovery: the reviewing session had
> `server/` and `shared/` pinned read-only by `appSourceProtections` (SANDBOX.md
> "Self-modification escape"), so the fixes had to wait for a session that could write app
> source. The guard did its job — the finding session could not patch the server it was
> auditing.

| Sev | Defect | Fix |
|---|---|---|
| HIGH | **Persistent session brick.** `learnTools` persists an unbounded tool list; for a read-only role `roleScopedDenies` emits one rule per write tool, all joined into the single `--disallowedTools` argv entry. Linux caps one entry at `MAX_ARG_STRLEN` = 131072 B. 4000 tools → **166 937 B → `E2BIG`**, and because classification is persisted and `restore()` relaunches at boot, the session stays dead across restarts. No route clears `ConnectorDef.tools`. | **Reproduced** by me: spawn returns `E2BIG`, and still does after dropping caches and reloading from disk. Fix: collapse to a whole-server deny above ~64 rules (strictly more restrictive, so no safety cost), and cap what `learnTools` persists. |
| HIGH | **No bound on upstream data.** `connectorProxy.ts` accumulates a whole JSON reply into one string with no cap and no timeout (~110 MB RSS for one 126 MB reply; V8 throws above ~512 MB *inside an un-try/caught handler*). Descriptions are persisted verbatim — 40 tools × 1 MB grew `connectors.json` to 40 MB, and every JSON reply rewrites the file synchronously. | Amplified by a second bug: **`learnTools` runs on every JSON reply, not just `tools/list`** — confirmed by reading `connectorProxy.ts:135-147`, which has no method check despite the comment claiming one. |
| MED | **The importer bypasses every `saveConnector` validation.** `addImported` checks only `connectorIdError`. A hostile `.mcp.json` can therefore store what the API refuses: plaintext `http://` to any host, `file://` URLs, CRLF headers — and the proxy dials them (observed `200` from an attacker-chosen target). Worse, `ConnectorView` has **no `command` field**, so an imported *stdio* connector's command/args/env — which the engine will spawn — is never shown anywhere, before or after import. | Needs the operator to import a hostile repo's config *and* grant it, but the UI gives them nothing to judge it on. |
| MED | **Read-only scoping escaped by hiring.** Grants inherit to a subsession, but role scoping is applied per session from that session's own `agent.readOnly`. A `reviewer` granted a connector hires a `general` teammate → teammate inherits the server with **zero** deny rules. Requires `teamEmploy`. | Inheritance preserves *which servers*, not *which tools* — but the read-only guarantee is stated in tool terms. |
| MED-LOW | **Proxy never completes on a stalled or aborted upstream.** No `setTimeout`/`headersTimeout`/`requestTimeout` anywhere; `res` ends only on `up.on('end')`/pipe completion, and a server-initiated abort emits neither that nor `error`. Three cases hang indefinitely, each pinning a socket pair. | |
| LOW | `addImported` computes `have` once and never updates it, so `my_db` and `my-db` in one file both slug to `my-db` and both land in the catalog. | |
| LOW | `/api/health` is in the auth-open set and now returns `gpuDevices` — host GPU inventory disclosed pre-auth. | Recon only (`homeDir` was already there), but it is hardware inventory handed out unauthenticated. |
| INFO | The `isSafeDenyRule` backstop's comment claims dropping is safe "because the callers substitute a whole-server deny" — untrue when the *whole-server* rule is itself malformed, which then fails **open**. Only reachable via a hand-edited catalog. | |

**Fixes applied.** `MAX_TOOL_DENY_RULES = 64` collapses an oversized rule set to a
whole-server deny (strictly more restrictive, so no safety is lost); `setTools` caps at 500
tools and 500-char descriptions; the proxy now streams rather than buffering, capturing at
most 2 MB for classification, and only classifies when the request was actually a
`tools/list`; `upstream.setTimeout` plus `aborted`/`error` handlers end a request that the
upstream stalls or drops (all three previously hung forever); `connectorDefError` is one
validator shared by `saveConnector` **and** `addImported`, with a scheme allowlist added;
`addImported` updates its seen-set as it goes; `ConnectorView.command` and the pre-flight
rows now show the program a stdio connector will spawn; `register` refuses to inherit
grants from a read-only parent into a less-restricted child; `/api/health` returns
`gpuDevices` only to an authenticated caller; and `connectorServers` refuses to expose a
connector whose id cannot form a valid deny rule at all.

Held under attack: the C1/C2/C2b injection backstops (even from a hand-edited catalog),
E4 CRLF containment via the importer path, request smuggling and SSRF *path* control,
prototype pollution via `__proto__` in a hostile `.mcp.json`, every trust gate, and the
web UI (no `dangerouslySetInnerHTML`, no secret on any read path). GPU was reviewed by
code only — no `/dev/nvidia*` was visible to the reviewing session.

### Accepted risks (not fixed, deliberately)

- **A stdio connector's credential IS disclosed to the granted session.** The whole
  argument for proxying HTTP connectors — "the credential never enters the box" — does not
  carry over to stdio, and it is worth stating plainly rather than leaving implied by the
  transport table. A stdio connector is spawned *by the engine, inside the sandbox*, which
  is the point of the transport; its `env` and `args` are re-emitted verbatim into the
  `--mcp-config` value, and that value is one entry on the launch command line. Any session
  granted the connector can read its own `/proc/self/cmdline` and recover a `PGPASSWORD`, a
  `postgres://user:pass@…` argument, a bearer token. This is structural: the child has to be
  spawned in the box, and the box has to be told how. Mitigation is disclosure, not
  mechanism — the transport blurb and the grant checkbox both say so at the point of
  decision — plus the ordinary advice: prefer HTTP for anything holding a real secret, and
  give a stdio connector a credential scoped to what that session should have anyway.
- **Tool classification is server-asserted.** `write` is seeded from
  `annotations.readOnlyHint`, so a connector that declares a mutating tool read-only is
  believed, and a read-only role would be allowed it. Absent hints already default to
  write-capable; the real mitigation is an **operator override** on classification — the
  type has always described this as operator data — which needs the catalog UI to expose
  a per-tool toggle. Deferred with the rest of the UI work. Until then, treat adding a
  connector as trusting it, and prefer granting untrusted connectors only to full-tool roles.
- **A proxy token is a bearer token.** HTTP gives the proxy no caller identity beyond the
  URL, and every box shares the host network namespace, so whoever holds a token has that
  session's reach. Tokens are unguessable UUIDs, minted per launch, released on relaunch
  and destroy, and only ever written into their own session's `--mcp-config`. Identical to
  the model `AppControlMcpServer` has always used.
- **Re-creating a deleted id re-points a stale grant.** Grants are keyed on the id, so
  deleting a connector and later re-adding the same id adopts the old grants. It takes two
  deliberate operator actions and the id is immutable in between; rewriting every session's
  grants on delete would discard the operator's intent on a mis-click.

## Known gaps, stated plainly

- **An undeclared account connector is not denied.** Claudette cannot enumerate them (no
  credential, no API), so the operator declares the names, and the deny list can only cover
  what was declared. This fails **open** for anything omitted. Strict mode makes it moot.
- **Deleting a connector does not rewrite grants that name it.** A stale grant is inert
  (`connectorServers` skips an unknown id) and re-adding the id restores it — better than
  discarding the operator's intent on a mis-click.
- **Tool classification is only as fresh as the last `tools/list`.** A server that adds a
  mutating tool is not re-classified until a granted session lists tools again.

## Deferred

- **OAuth.** `OAuthClient` and `ConnectorDef.oauthClientRef` are modelled and validated,
  but nothing dials an authorize/callback/refresh flow yet. Until then an HTTP connector
  authenticates with a static header, and an imported one arrives `needs-auth`.
- **A standalone probe.** Classification is learned opportunistically from proxied
  `tools/list` traffic — there is no "test connection" that dials on demand.

## Verification

`scratchpad/connectors-test.mts` — 94 checks covering id/tool-name validation, redaction
(including URL userinfo and query), omit-means-keep, OAuth-client reference integrity,
account/strict persistence, import inference + precedence + SSE refusal, the trust gate in
both directions, launch composition (proxy URL for http, verbatim for stdio, no credential
on the argv **for http** — a stdio connector's env/args are on it by construction, see
"Accepted risks"), deny-rule computation across roles and probe states, the catalog's `0600`
mode, and the proxy end-to-end against a real upstream: credential added server-side,
tools learned from a passing `tools/list`, `readOnlyHint` honoured, unknown token refused,
`release()` retiring tokens, 401 classified as `needs-auth`, and **revocation taking effect
on the next call with no relaunch**.
