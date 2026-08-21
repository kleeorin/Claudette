import type { FastifyInstance } from 'fastify'
import type {
  ConnectorDef, ConnectorsResponse, OAuthClient, AccountConnector,
  OkResponse, SetSessionConnectorsRequest, StrictPreflight,
} from '@claudette/shared'
import { SessionManager } from '../claude/sessionManager'
import {
  listConnectors, saveConnector, removeConnector, listOAuthClients, saveOAuthClient,
  removeOAuthClient, toView, oauthClientView, listAccountConnectors, setAccountConnectors,
  strictMode, setStrictMode, addImportedDetailed, getConnector,
} from './connectorStore'
import { scanExistingServers } from './connectorImport'

// HTTP surface for the connector catalog. Every route here is behind the app's auth
// guard, which is what makes the writes "trusted" in the sense normalizeGrants means:
// only the operator's own browser can widen a session's reach (SANDBOX.md
// "Control-plane escape"). A sandboxed session shares the network namespace and can
// reach this port, but holds no CLAUDETTE_TOKEN, so it cannot authenticate.
//
// Secrets travel INWARD only. Every read path goes through toView/oauthClientView, which
// redact headers, env, args and the URL's userinfo+query — so an edit form round-trips
// without ever receiving what it is editing (hence omit-means-keep in the store).

export function registerConnectorRoutes(app: FastifyInstance, sessions: SessionManager): void {
  // How many sessions currently hold each connector — the UI needs it to say "editing
  // this applies on relaunch for the 3 sessions using it" rather than implying immediacy.
  const inUse = (): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const s of sessions.list()) {
      for (const id of s.connectors ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }

  app.get('/api/connectors', async (): Promise<ConnectorsResponse> => {
    const counts = inUse()
    return {
      connectors: listConnectors().map((d) => toView(d, counts.get(d.id) ?? 0)),
      oauthClients: listOAuthClients().map(oauthClientView),
      accountConnectors: listAccountConnectors(),
      strict: strictMode(),
    }
  })

  app.post<{ Body: ConnectorDef }>('/api/connectors/save', async (req, reply) => {
    const r = saveConnector(req.body)
    if (!r.ok) { reply.code(400); return { error: r.error } }
    const counts = inUse()
    return { connector: toView(r.def, counts.get(r.def.id) ?? 0) }
  })

  // Deleting a connector does NOT rewrite the grants that name it. A stale grant is inert
  // (connectorServers skips an unknown id) and re-adding the same id restores it, whereas
  // rewriting every session's grant list on a delete would silently discard the operator's
  // intent if the delete was a mistake.
  app.post<{ Body: { id: string } }>('/api/connectors/delete', async (req): Promise<OkResponse> => ({
    ok: removeConnector(req.body.id),
  }))

  app.post<{ Body: OAuthClient }>('/api/connectors/oauthClient/save', async (req, reply) => {
    const r = saveOAuthClient(req.body)
    if (!r.ok) { reply.code(400); return { error: r.error } }
    return { client: oauthClientView(r.client) }
  })

  app.post<{ Body: { id: string } }>('/api/connectors/oauthClient/delete', async (req, reply) => {
    const r = removeOAuthClient(req.body.id)
    if (!r.ok) { reply.code(400); return { error: r.error } }
    return { ok: true }
  })

  app.post<{ Body: { accountConnectors: AccountConnector[] } }>(
    '/api/connectors/account', async (req) => ({ accountConnectors: setAccountConnectors(req.body.accountConnectors ?? []) }))

  // --- strict mode + its pre-flight ------------------------------------------------
  // Strict mode is the switch that makes the catalog the only source of reach. It is also
  // the switch that makes a hand-configured server vanish, so the report comes FIRST and
  // enabling is a separate call — the operator sees the cost before paying it.
  app.get<{ Querystring: { cwd?: string } }>('/api/connectors/preflight', async (req): Promise<StrictPreflight> => {
    const cwd = req.query.cwd || process.cwd()
    const scan = scanExistingServers(cwd)
    const known = new Set(listConnectors().map((c) => c.id))
    return {
      importable: scan.candidates.filter((c) => !known.has(c.def.id))
        .map((c) => ({
          id: c.def.id, name: c.def.name, source: c.source,
          transport: c.def.transport,
          // Shown so a stdio import is judged on the program it will spawn, not its name.
          command: c.def.command,
        })),
      skipped: scan.skipped,
      alreadyInCatalog: scan.candidates.filter((c) => known.has(c.def.id)).map((c) => c.def.name),
      sessionsWithNoGrants: sessions.list()
        .filter((s) => !(s.connectors ?? []).length)
        .map((s) => ({ id: s.id, name: s.name })),
      notes: [
        'Plugin-provided and agent-frontmatter MCP servers are not in the files this scan reads. Strict mode drops those too, and they cannot be imported here.',
        'claude.ai account connectors stop being fetched entirely under strict mode — no deny rule needed, and no way to keep one.',
        'Importing a connector does NOT grant it. Every session starts with no reach; grant per session afterwards.',
        'An imported HTTP connector arrives needing auth: the CLI keeps remote-server OAuth outside the config entry, so the URL comes across but the grant does not.',
      ],
    }
  })

  app.post<{ Body: { cwd?: string } }>('/api/connectors/import', async (req) => {
    const scan = scanExistingServers(req.body?.cwd || process.cwd())
    // Validation rejects are merged into `skipped` alongside the scan's own, so the UI
    // accounts for EVERY row it offered: one list, and nothing disappears silently.
    const { added, rejected } = addImportedDetailed(scan.candidates.map((c) => c.def))
    return { added: added.map((d) => d.id), skipped: [...scan.skipped, ...rejected] }
  })

  app.post<{ Body: { enabled: boolean } }>('/api/connectors/strict', async (req) => ({
    strict: setStrictMode(!!req.body?.enabled),
  }))

  // --- per-session grants ------------------------------------------------------------
  // Trusted because this route is auth-gated: it is the operator's own browser. The
  // manager refuses an untrusted grant precisely so a confined session that reached the
  // loopback API could not hand itself a connector.
  app.post<{ Body: SetSessionConnectorsRequest }>('/api/session/setConnectors', async (req, reply) => {
    const { id, connectors = [], accountConnectors = [] } = req.body
    // Reject an unknown catalog id here rather than letting it sit inert in the grant
    // list: a typo that silently grants nothing is worse than a visible error, because
    // the session looks configured and isn't.
    const unknown = connectors.filter((c) => !getConnector(c))
    if (unknown.length) { reply.code(400); return { error: `No such connector: ${unknown.join(', ')}.` } }
    const ok = sessions.setConnectors(id, connectors, accountConnectors, /* trusted */ true)
    if (!ok) { reply.code(404); return { error: 'No such session.' } }
    return { ok: true }
  })
}
