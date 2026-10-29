import { EventEmitter } from 'events'
import { join, basename } from 'path'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import crypto from 'crypto'
import type { ProjectInfo, WorktreeInfo } from '@claudette/shared'
import { dataDir } from '../util/dataDir'
import { canonicalDir } from '../claude/sessionManager'
import { gitCommonDirSync } from '../git/worktrees'

// PROJECTS — a sidebar grouping level above top-level sessions (see ProjectInfo).
//
// Persisted in <dataDir>/projects.json, beside sessions.json and for the same reason: it is
// read back at boot as TRUSTED (a projectId is replayed onto restored sessions), so it must be
// out of every box's reach. dataDir() gives it the protections sessions.json has — the whole
// directory is hidden from every sandbox by stateDirsToHide() in sandbox.ts (bound over with
// an empty dir, ro AND rw mounts), and sandboxPathAccess() refuses it to the notebook MCP
// tools. Pinned for this file by scratchpad/projects-test.mts. sessions.json stays a bare
// SavedSession[]; projects live in their own file rather than being folded into it.
//
// Written tmp+rename, as sessionPersistence.ts does, so a crash mid-write cannot leave a
// truncated file behind.
const file = (): string => join(dataDir(), 'projects.json')

// ★ THE ONE PLACE THAT DECIDES WHETHER A SESSION'S cwd FITS A PROJECT. Two rules:
//   · an ordinary session: its cwd IS the project's (exact equality, unchanged);
//   · an ISOLATED session (`worktree` set): its cwd is its own worktree, so it fits when it
//     belongs to the SAME REPOSITORY — its common git dir equals the project dir's
//     `git rev-parse --git-common-dir` (realpath'd both sides). Computed LIVE from the
//     project dir, never from the cached ProjectInfo.gitCommonDir (that one is for the
//     client's menu only), and from the worktree's own dir rather than its stored record,
//     so a sessions.json edit cannot claim a repo the directory is not in.
// The relaxation is deliberately NOT extended to ordinary sessions in another directory of
// the same repo: "every session in a project shares its cwd" still holds for them.
export function cwdFitsProject(cwd: string, project: ProjectInfo, worktree?: WorktreeInfo): boolean {
  if (canonicalDir(cwd) === project.cwd) return true
  if (!worktree || canonicalDir(cwd) !== canonicalDir(worktree.path)) return false
  const mine = gitCommonDirSync(worktree.path)
  return !!mine && mine === gitCommonDirSync(project.cwd)
}

export class ProjectStore extends EventEmitter {
  private projects: ProjectInfo[] = []

  list(): ProjectInfo[] { return this.projects.map((p) => ({ ...p })) }

  // Fill ProjectInfo.gitCommonDir (client-side membership hint only — see cwdFitsProject).
  // Computed when a project is created or loaded; a repo initialised later shows up on the
  // next load, which only delays a menu item.
  private withRepo(p: ProjectInfo): ProjectInfo {
    const common = gitCommonDirSync(p.cwd)
    if (common) p.gitCommonDir = common; else delete p.gitCommonDir
    return p
  }
  get(id: string): ProjectInfo | undefined {
    const p = this.projects.find((x) => x.id === id)
    return p && { ...p }
  }

  // Validated per entry: a malformed row is dropped loudly rather than taking the file with it.
  async load(): Promise<void> {
    let raw: unknown
    try { raw = JSON.parse(await readFile(file(), 'utf8')) } catch { this.projects = []; return }
    const list = Array.isArray(raw) ? raw : []
    this.projects = []
    for (const p of list as Partial<ProjectInfo>[]) {
      if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || typeof p.cwd !== 'string' || !p.cwd.trim()) {
        console.warn(`[projects] dropping a malformed entry in projects.json: ${JSON.stringify(p).slice(0, 120)}`)
        continue
      }
      if (this.projects.some((x) => x.id === p.id)) continue
      this.projects.push(this.withRepo({
        id: p.id, name: p.name.trim() || basename(p.cwd), cwd: canonicalDir(p.cwd),
        createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
        ...(p.collapsed ? { collapsed: true } : {}),
      }))
    }
  }

  private async save(): Promise<void> {
    try {
      await mkdir(dataDir(), { recursive: true })
      const tmp = `${file()}.tmp`
      await writeFile(tmp, JSON.stringify(this.projects))
      await rename(tmp, file())
    } catch (e) {
      // Unlike sessions.json this is not silent: a lost project file ungroups the sidebar.
      console.warn(`[projects] could not save projects.json: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private changed(): void {
    void this.save()
    this.emit('changed')
  }

  create(name: string, cwd: string): { ok: true; project: ProjectInfo } | { ok: false; error: string } {
    const dir = canonicalDir(cwd ?? '')
    if (!dir) return { ok: false, error: 'A project needs a working directory.' }
    const project: ProjectInfo = this.withRepo({ id: crypto.randomUUID(), name: (name ?? '').trim() || basename(dir) || dir, cwd: dir, createdAt: Date.now() })
    this.projects.push(project)
    this.changed()
    return { ok: true, project: { ...project } }
  }

  rename(id: string, name: string): ProjectInfo | undefined {
    const p = this.projects.find((x) => x.id === id)
    const n = (name ?? '').trim()
    if (!p || !n) return undefined
    p.name = n
    this.changed()
    return { ...p }
  }

  setCollapsed(id: string, collapsed: boolean): ProjectInfo | undefined {
    const p = this.projects.find((x) => x.id === id)
    if (!p) return undefined
    if (collapsed) p.collapsed = true; else delete p.collapsed
    this.changed()
    return { ...p }
  }

  // Removes ONLY the project record. Ungrouping its sessions is the caller's job (the route
  // does it through SessionManager), because sessions are not this store's to touch.
  delete(id: string): boolean {
    const before = this.projects.length
    this.projects = this.projects.filter((x) => x.id !== id)
    if (this.projects.length === before) return false
    this.changed()
    return true
  }

  // Test seam: point load/save at a fresh state without a new process.
  reset(): void { this.projects = [] }
}
