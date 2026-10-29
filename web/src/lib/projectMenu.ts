import type { SessionInfo, ProjectInfo } from '@claudette/shared'

// Which project actions a sidebar session row offers. Pure and tested (projectMenu.test.ts):
// nothing imports App.tsx, so a rule written inline in its menu would be tested by nothing.
//
// Only TOP-LEVEL sessions carry a project; a subsession belongs to its parent's, so it offers
// none of these. A projectId naming no known project is treated as ungrouped, matching how
// orderSidebar renders it.

// The CLIENT MIRROR of the server's cwdFitsProject (server/src/projects/projectStore.ts), used
// only to decide what to OFFER — the server re-checks every move, live, with git. Same two
// rules: an ordinary session fits a project with its exact cwd; an ISOLATED (worktree) session
// fits a project of the same repository — its worktree's common git dir equals the project's
// gitCommonDir. Server paths arrive canonicalised (common dirs realpath'd).
export function sessionFitsProject(session: SessionInfo, project: ProjectInfo): boolean {
  if (!!session.cwd && session.cwd === project.cwd) return true
  return !!session.worktree?.commonDir && session.worktree.commonDir === project.gitCommonDir
}

export interface ProjectMenuItems {
  canMakeProject: boolean       // "Make project" — ungrouped top-level with a cwd
  moveTargets: ProjectInfo[]    // "Move to project…" — other projects this session fits
  canRemove: boolean            // "Remove from project"
}

export function projectMenuItems(session: SessionInfo, projects: ProjectInfo[]): ProjectMenuItems {
  if (session.parentId) return { canMakeProject: false, moveTargets: [], canRemove: false }
  const current = session.projectId ? projects.find((p) => p.id === session.projectId) : undefined
  return {
    canMakeProject: !current && !!session.cwd,
    moveTargets: projects.filter((p) => p.id !== current?.id && sessionFitsProject(session, p)),
    canRemove: !!current,
  }
}
