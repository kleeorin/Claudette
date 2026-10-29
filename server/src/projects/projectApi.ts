import type { FastifyInstance } from 'fastify'
import type { ProjectListResponse, ProjectResponse, OkResponse, ProjectRepoStatusResponse } from '@claudette/shared'
import type { SessionManager } from '../claude/sessionManager'
import { ProjectStore, cwdFitsProject } from './projectStore'
import { repoInfo } from '../git/worktrees'

// Project routes. Auth-gated like every control route: the operator's own browser. A project
// changes only the SIDEBAR grouping and which cwd a new session gets — it grants nothing, and
// team / MCP / mailbox scope stays parentId-based — but projects.json is replayed at boot, so
// only the operator writes it.
export function registerProjectRoutes(app: FastifyInstance, sessions: SessionManager, projects: ProjectStore): void {
  app.get('/api/project/list', async (): Promise<ProjectListResponse> => ({ projects: projects.list() }))

  // A project from an existing TOP-LEVEL session: cwd = the session's, name = basename(cwd),
  // and the session moves into it.
  app.post<{ Body: { sessionId: string } }>('/api/project/fromSession', async (req, reply): Promise<ProjectResponse> => {
    const info = sessions.get(req.body?.sessionId)
    if (!info) { reply.code(404); return { ok: false, error: 'No such session.' } }
    if (info.parentId) { reply.code(400); return { ok: false, error: 'Only a top-level session can become a project — a subsession belongs to its parent\'s.' } }
    if (!info.cwd) { reply.code(400); return { ok: false, error: 'This session has no working directory to base a project on.' } }
    // An isolated session's project is its REPO, not its private worktree dir.
    const r = projects.create('', info.worktree?.repoRoot ?? info.cwd)
    if (!r.ok) { reply.code(400); return { ok: false, error: r.error } }
    sessions.setProject(info.id, r.project.id)
    return { ok: true, project: r.project }
  })

  // Whether an isolated (git worktree) session can be created in this project: the dialog
  // enables the option only for a repo with at least one commit. The create route re-checks.
  app.post<{ Body: { id: string } }>('/api/project/repoStatus', async (req, reply): Promise<ProjectRepoStatusResponse> => {
    const p = projects.get(req.body?.id)
    if (!p) { reply.code(404); return { ok: false, repo: null, error: 'No such project.' } }
    return { ok: true, repo: await repoInfo(p.cwd) }
  })

  app.post<{ Body: { name: string; cwd: string } }>('/api/project/create', async (req, reply): Promise<ProjectResponse> => {
    const r = projects.create(req.body?.name ?? '', req.body?.cwd ?? '')
    if (!r.ok) { reply.code(400); return { ok: false, error: r.error } }
    return { ok: true, project: r.project }
  })

  app.post<{ Body: { id: string; name: string } }>('/api/project/rename', async (req, reply): Promise<ProjectResponse> => {
    const p = projects.rename(req.body?.id, req.body?.name)
    if (!p) { reply.code(400); return { ok: false, error: projects.get(req.body?.id) ? 'A name is required.' : 'No such project.' } }
    return { ok: true, project: p }
  })

  app.post<{ Body: { id: string; collapsed: boolean } }>('/api/project/setCollapsed', async (req, reply): Promise<ProjectResponse> => {
    const p = projects.setCollapsed(req.body?.id, !!req.body?.collapsed)
    if (!p) { reply.code(404); return { ok: false, error: 'No such project.' } }
    return { ok: true, project: p }
  })

  // Delete UNGROUPS: its sessions become ordinary top-level rows. Nothing is closed.
  app.post<{ Body: { id: string } }>('/api/project/delete', async (req, reply): Promise<OkResponse & { ungrouped?: number; error?: string }> => {
    const id = req.body?.id
    if (!projects.get(id)) { reply.code(404); return { ok: false, error: 'No such project.' } }
    const ungrouped = sessions.clearProject(id)
    projects.delete(id)
    return { ok: true, ungrouped }
  })

  // Move a TOP-LEVEL session into a project (its cwd must fit — cwdFitsProject) or out (null).
  app.post<{ Body: { id: string; projectId: string | null } }>('/api/session/setProject', async (req, reply): Promise<OkResponse & { error?: string }> => {
    const info = sessions.get(req.body?.id)
    if (!info) { reply.code(404); return { ok: false, error: 'No such session.' } }
    const pid = req.body?.projectId ?? null
    if (pid) {
      const p = projects.get(pid)
      if (!p) { reply.code(404); return { ok: false, error: 'No such project.' } }
      if (!cwdFitsProject(info.cwd, p, info.worktree)) { reply.code(400); return { ok: false, error: `This session runs in ${info.cwd || '(no directory)'}, but the project is ${p.cwd}.` } }
    }
    const r = sessions.setProject(info.id, pid)
    if (r === 'not-top-level') { reply.code(400); return { ok: false, error: 'A subsession belongs to its parent\'s project and cannot be moved on its own.' } }
    return { ok: r === 'ok' }
  })
}
