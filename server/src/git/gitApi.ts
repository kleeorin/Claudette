import type { FastifyInstance } from 'fastify'
import type { GitStatus, GitDiff, GitLog, GitBranches, GitResult } from '@claudette/shared'
import * as git from './gitManager'

// HTTP surface for the Git panel. Reads are GET (cwd + params in the query);
// mutations are POST (cwd + args in the body). Every op runs in the session's cwd
// — passed explicitly by the client (git has no per-session state here). Auth is
// already enforced by the global preHandler (see index.ts). Ported one-for-one
// from ClaudeMaster's git IPC channels.

export function registerGitRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { cwd?: string } }>('/api/git/status', async (req): Promise<GitStatus> => {
    const cwd = req.query.cwd?.trim()
    if (!cwd) return { repo: 'error', error: 'cwd is required' }
    return git.status(cwd)
  })

  app.get<{ Querystring: { cwd?: string; file?: string; staged?: string; untracked?: string } }>(
    '/api/git/diff',
    async (req): Promise<GitDiff> => {
      const { cwd, file } = req.query
      if (!cwd?.trim() || !file) return { ok: false, error: 'cwd and file are required' }
      return git.diff(cwd, file, req.query.staged === '1', req.query.untracked === '1')
    },
  )

  app.get<{ Querystring: { cwd?: string; limit?: string } }>('/api/git/log', async (req): Promise<GitLog> => {
    const cwd = req.query.cwd?.trim()
    if (!cwd) return { ok: false, error: 'cwd is required' }
    return git.log(cwd, Number(req.query.limit ?? 100) || 100)
  })

  app.get<{ Querystring: { cwd?: string; hash?: string } }>('/api/git/show', async (req): Promise<GitDiff> => {
    const { cwd, hash } = req.query
    if (!cwd?.trim() || !hash) return { ok: false, error: 'cwd and hash are required' }
    return git.show(cwd, hash)
  })

  app.get<{ Querystring: { cwd?: string } }>('/api/git/branches', async (req): Promise<GitBranches> => {
    const cwd = req.query.cwd?.trim()
    if (!cwd) return { ok: false, error: 'cwd is required' }
    return git.branches(cwd)
  })

  // --- mutations (POST) ---
  const needCwd = (cwd: unknown): cwd is string => typeof cwd === 'string' && cwd.trim().length > 0

  app.post<{ Body: { cwd?: string; file?: string } }>('/api/git/stage', async (req): Promise<GitResult> => {
    const { cwd, file } = req.body
    if (!needCwd(cwd) || !file) return { ok: false, error: 'cwd and file are required' }
    return git.stage(cwd, file)
  })

  app.post<{ Body: { cwd?: string; file?: string } }>('/api/git/unstage', async (req): Promise<GitResult> => {
    const { cwd, file } = req.body
    if (!needCwd(cwd) || !file) return { ok: false, error: 'cwd and file are required' }
    return git.unstage(cwd, file)
  })

  app.post<{ Body: { cwd?: string } }>('/api/git/stageAll', async (req): Promise<GitResult> => {
    const { cwd } = req.body
    if (!needCwd(cwd)) return { ok: false, error: 'cwd is required' }
    return git.stageAll(cwd)
  })

  app.post<{ Body: { cwd?: string } }>('/api/git/stageTracked', async (req): Promise<GitResult> => {
    const { cwd } = req.body
    if (!needCwd(cwd)) return { ok: false, error: 'cwd is required' }
    return git.stageTracked(cwd)
  })

  app.post<{ Body: { cwd?: string } }>('/api/git/unstageAll', async (req): Promise<GitResult> => {
    const { cwd } = req.body
    if (!needCwd(cwd)) return { ok: false, error: 'cwd is required' }
    return git.unstageAll(cwd)
  })

  app.post<{ Body: { cwd?: string; message?: string } }>('/api/git/commit', async (req): Promise<GitResult> => {
    const { cwd, message } = req.body
    if (!needCwd(cwd)) return { ok: false, error: 'cwd is required' }
    return git.commit(cwd, message ?? '')
  })

  app.post<{ Body: { cwd?: string; name?: string } }>('/api/git/createBranch', async (req): Promise<GitResult> => {
    const { cwd, name } = req.body
    if (!needCwd(cwd) || !name) return { ok: false, error: 'cwd and name are required' }
    return git.createBranch(cwd, name)
  })

  app.post<{ Body: { cwd?: string; name?: string } }>('/api/git/checkoutBranch', async (req): Promise<GitResult> => {
    const { cwd, name } = req.body
    if (!needCwd(cwd) || !name) return { ok: false, error: 'cwd and name are required' }
    return git.checkoutBranch(cwd, name)
  })

  app.post<{ Body: { cwd?: string; name?: string; force?: boolean } }>('/api/git/deleteBranch', async (req): Promise<GitResult> => {
    const { cwd, name, force } = req.body
    if (!needCwd(cwd) || !name) return { ok: false, error: 'cwd and name are required' }
    return git.deleteBranch(cwd, name, !!force)
  })

  app.post<{ Body: { cwd?: string; name?: string } }>('/api/git/mergeBranch', async (req): Promise<GitResult> => {
    const { cwd, name } = req.body
    if (!needCwd(cwd) || !name) return { ok: false, error: 'cwd and name are required' }
    return git.mergeBranch(cwd, name)
  })
}
