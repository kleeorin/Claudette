import { describe, it, expect } from 'vitest'
import type { SessionInfo, ProjectInfo } from '@claudette/shared'
import { projectMenuItems } from './projectMenu'

const S = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id: 's', name: 's', cwd: '/w/a', rootDir: '/w/a', state: 'idle', ...over } as unknown as SessionInfo)
const P = (id: string, cwd: string): ProjectInfo => ({ id, name: id, cwd, createdAt: 0 })

describe('projectMenuItems — which project actions a session row offers', () => {
  it('an ungrouped top-level session can become a project, and can move into a SAME-cwd project only', () => {
    const m = projectMenuItems(S(), [P('pa', '/w/a'), P('pb', '/w/b')])
    expect(m.canMakeProject).toBe(true)
    expect(m.moveTargets.map((p) => p.id)).toEqual(['pa'])
    expect(m.canRemove).toBe(false)
  })

  it('a session already in a project offers Remove and no Make project, and is not offered its own project', () => {
    const m = projectMenuItems(S({ projectId: 'pa' }), [P('pa', '/w/a'), P('pa2', '/w/a')])
    expect(m.canMakeProject).toBe(false)
    expect(m.canRemove).toBe(true)
    expect(m.moveTargets.map((p) => p.id)).toEqual(['pa2'])
  })

  it('a SUBSESSION offers no project actions at all — it belongs to its parent\'s project', () => {
    const m = projectMenuItems(S({ parentId: 'p', projectId: 'pa' }), [P('pa', '/w/a')])
    expect(m).toEqual({ canMakeProject: false, moveTargets: [], canRemove: false })
  })

  it('an ISOLATED (worktree) session fits a project of the same repo (equal common dir), and no other', () => {
    const wt = { path: '/w/a/.claude/worktrees/x', branch: 'x', repoRoot: '/w/a', commonDir: '/w/a/.git' }
    const s = S({ cwd: wt.path, rootDir: wt.path, worktree: wt })
    const ps = [{ ...P('same', '/w/a'), gitCommonDir: '/w/a/.git' }, { ...P('other', '/w/b'), gitCommonDir: '/w/b/.git' }, P('norepo', '/w/c')]
    expect(projectMenuItems(s, ps).moveTargets.map((p) => p.id)).toEqual(['same'])
  })

  it('an ORDINARY session in another dir of the same repo is still NOT offered the project', () => {
    const m = projectMenuItems(S({ cwd: '/w/a/sub' }), [{ ...P('pa', '/w/a'), gitCommonDir: '/w/a/.git' }])
    expect(m.moveTargets).toEqual([])
  })

  it('a session with no cwd cannot become a project', () => {
    expect(projectMenuItems(S({ cwd: '' }), []).canMakeProject).toBe(false)
  })

  it('a DANGLING projectId reads as ungrouped: Make project is offered, Remove is not', () => {
    const m = projectMenuItems(S({ projectId: 'gone' }), [P('pa', '/w/a')])
    expect(m.canMakeProject).toBe(true)
    expect(m.canRemove).toBe(false)
  })
})
