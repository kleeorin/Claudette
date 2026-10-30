import { EventEmitter } from 'events'
import { join, basename } from 'path'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import crypto from 'crypto'
import type { ProjectInfo, ProjectDefaults, SandboxConfig, SandboxMount, WorktreeInfo } from '@claudette/shared'
import { PERMISSION_MODES } from '@claudette/shared'
import { dataDir } from '../util/dataDir'
import { canonicalDir, normalizeSandbox } from '../claude/sessionManager'
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

// PROJECT DEFAULTS (ProjectInfo.defaults): what a NEW session created in the project starts
// with when the create request does not say — explicit > project default > app setting >
// built-in (sessionApi.ts /api/session/create). Only ever read at that moment.
// Validated on LOAD and on SET by the one function below: a bad permissionMode or a malformed
// sandbox drops ONLY the defaults (with a warn), never the project. The sandbox goes through
// normalizeSandbox — the path session configs take — so mounts are canonicalised and deduped
// exactly as a session's would be. Trusted (operator config, auth-gated): enabled:false and an
// ELEVATED permissionMode are kept as given — a deliberate exception to settingsStore.ts's
// refusal of elevated APP-WIDE defaults (see the note on CHECKS.defaultPermissionMode there):
// a project default is per-project, operator-set, and shown pre-filled in red before every
// create. projects.json sits in dataDir(), out of every box's reach (see the header).
export function validateDefaults(raw: unknown, cwd: string): { ok: true; defaults: ProjectDefaults | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, defaults: undefined }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Project defaults must be an object.' }
  const r = raw as { sandbox?: unknown; permissionMode?: unknown }
  const out: ProjectDefaults = {}
  if (r.permissionMode !== undefined) {
    if (typeof r.permissionMode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(r.permissionMode)) {
      return { ok: false, error: `The default permission mode must be one of: ${PERMISSION_MODES.join(', ')}.` }
    }
    out.permissionMode = r.permissionMode as ProjectDefaults['permissionMode']
  }
  if (r.sandbox !== undefined) {
    const sb = r.sandbox as Partial<SandboxConfig> | null
    const mountsOk = !!sb && typeof sb === 'object' && typeof sb.enabled === 'boolean' && Array.isArray(sb.mounts)
      && sb.mounts.every((m: Partial<SandboxMount>) => !!m && typeof m.path === 'string' && m.path.trim() !== '' && (m.mode === 'rw' || m.mode === 'ro'))
    if (!mountsOk) return { ok: false, error: 'The default sandbox must be { enabled: boolean, mounts: [{ path, mode: "rw" | "ro" }] }.' }
    const n = normalizeSandbox(sb as SandboxConfig, cwd, /* trusted */ true)
    out.sandbox = {
      enabled: n.enabled, mounts: n.mounts,
      ...(n.sandboxTerminals !== undefined ? { sandboxTerminals: n.sandboxTerminals } : {}),
      ...(n.gpu !== undefined ? { gpu: n.gpu } : {}),
    }
  }
  return { ok: true, defaults: out.sandbox || out.permissionMode ? out : undefined }
}

export class ProjectStore extends EventEmitter {
  private projects: ProjectInfo[] = []

  list(): ProjectInfo[] { return this.projects.map((p) => structuredClone(p)) }

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
    return p && structuredClone(p)
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
      const cwd = canonicalDir(p.cwd)
      const dv = validateDefaults(p.defaults, cwd)
      if (!dv.ok) console.warn(`[projects] dropping invalid defaults of project "${p.name}" in projects.json (the project is kept): ${dv.error}`)
      this.projects.push(this.withRepo({
        id: p.id, name: p.name.trim() || basename(p.cwd), cwd,
        createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
        ...(p.collapsed ? { collapsed: true } : {}),
        ...(dv.ok && dv.defaults ? { defaults: dv.defaults } : {}),
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

  // `defaults` (optional, already validated or validated here): the fromSession snapshot.
  create(name: string, cwd: string, defaults?: ProjectDefaults): { ok: true; project: ProjectInfo } | { ok: false; error: string } {
    const dir = canonicalDir(cwd ?? '')
    if (!dir) return { ok: false, error: 'A project needs a working directory.' }
    const dv = validateDefaults(defaults, dir)
    if (!dv.ok) return { ok: false, error: dv.error }
    const project: ProjectInfo = this.withRepo({ id: crypto.randomUUID(), name: (name ?? '').trim() || basename(dir) || dir, cwd: dir, createdAt: Date.now(), ...(dv.defaults ? { defaults: dv.defaults } : {}) })
    this.projects.push(project)
    this.changed()
    return { ok: true, project: structuredClone(project) }
  }

  rename(id: string, name: string): ProjectInfo | undefined {
    const p = this.projects.find((x) => x.id === id)
    const n = (name ?? '').trim()
    if (!p || !n) return undefined
    p.name = n
    this.changed()
    return structuredClone(p)
  }

  setCollapsed(id: string, collapsed: boolean): ProjectInfo | undefined {
    const p = this.projects.find((x) => x.id === id)
    if (!p) return undefined
    if (collapsed) p.collapsed = true; else delete p.collapsed
    this.changed()
    return structuredClone(p)
  }

  // Removes ONLY the project record. Ungrouping its sessions is the caller's job (the route
  // does it through SessionManager), because sessions are not this store's to touch.
  // REPLACES the defaults with exactly what is given (validated). Refuses an empty set —
  // clearing is clearDefaults, the second verb.
  setDefaults(id: string, defaults: unknown): { ok: true; project: ProjectInfo } | { ok: false; error: string; notFound?: true } {
    const p = this.projects.find((x) => x.id === id)
    if (!p) return { ok: false, error: 'No such project.', notFound: true }
    const dv = validateDefaults(defaults, p.cwd)
    if (!dv.ok) return { ok: false, error: dv.error }
    if (!dv.defaults) return { ok: false, error: 'No defaults were supplied — to clear them, use resetDefaults.' }
    p.defaults = dv.defaults
    this.changed()
    return { ok: true, project: structuredClone(p) }
  }

  clearDefaults(id: string): ProjectInfo | undefined {
    const p = this.projects.find((x) => x.id === id)
    if (!p) return undefined
    if (p.defaults) { delete p.defaults; this.changed() }
    return structuredClone(p)
  }

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
