import type { FastifyInstance } from 'fastify'
import type { SandboxDefaultFolder, SandboxDefaultsResponse } from '@claudette/shared'
import { listDefaultFolders, saveDefaultFolder, removeDefaultFolder } from './sandboxDefaults'

// HTTP surface for the operator's standing list of favourite folders — the one-click mount
// shortcuts offered in every session's sandbox editor.
//
// Every route here is behind the app's global auth guard (the `preHandler` hook in
// index.ts), so only the operator's own browser can edit the list: a sandboxed session
// shares the network namespace and can reach this port, but holds no CLAUDETTE_TOKEN, so it
// cannot authenticate (SANDBOX.md "Control-plane escape").
//
// Nothing here mounts anything. The list is inert by design — writing an entry only changes
// what the editor OFFERS, and turning an offer into a mount goes through the auth-gated
// setSandbox route and normalizeSandbox exactly as a hand-picked folder does. See
// SandboxDefaultFolder in shared/src/types.ts for why that is the whole security story.
//
// Every write replies with the WHOLE list rather than the row it touched, so a client never
// reconciles a patch against what it thought it had.

export function registerSandboxDefaultsRoutes(app: FastifyInstance): void {
  app.get('/api/sandbox/defaults', async (): Promise<SandboxDefaultsResponse> => ({
    folders: listDefaultFolders(),
  }))

  app.post<{ Body: SandboxDefaultFolder }>('/api/sandbox/defaults/save', async (req, reply) => {
    const r = saveDefaultFolder(req.body)
    if (!r.ok) { reply.code(400); return { error: r.error } }
    return { folders: r.folders }
  })

  app.post<{ Body: { path: string } }>('/api/sandbox/defaults/delete', async (req): Promise<SandboxDefaultsResponse> => ({
    folders: removeDefaultFolder(req.body?.path),
  }))
}
