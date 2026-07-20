// Permission Control Center — a GUI over Claude's OWN permission settings files,
// not a parallel rule store (see ../../../HANDOVER-permissions.md in ClaudeMaster).
// The durable source of truth is the CLI's three settings files:
//
//   user     ~/.claude/settings.json
//   project  <cwd>/.claude/settings.json
//   local    <cwd>/.claude/settings.local.json
//
// each shaped `{ permissions: { allow[], deny[], ask[], defaultMode } }`. This is
// exactly where "allow always" already persists. getEffective() merges the three
// into an effective picture (rules tagged by origin scope + the effective
// defaultMode); addRule/removeRule read-modify-write one scope's file. Claudette is
// local-only, so — unlike the ClaudeMaster original — there is no remote/ssh path.
import { homedir } from 'os'
import { join, dirname } from 'path'
import { errMessage } from '../util/errMessage'
import { readFile, writeFile, mkdir } from 'fs/promises'
import type {
  EffectivePermissions, PermissionRule, PermissionMode, PermissionScope, PermissionFile,
  PermissionAction, WriteResult,
} from '@claudette/shared'
import { getAgent } from './agents'
import { NOTEBOOK_DENY } from './claudeEngine'

// The modes we recognise for display; an unknown `defaultMode` string is ignored
// (treated as if unset) rather than shown as a bogus mode.
const KNOWN_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

type Loaded = { exists: boolean; unreadable: boolean; data: Record<string, unknown> | null }

// Read + parse one settings file. A missing file → exists:false; a present-but-
// invalid file → exists:true, unreadable:true (surfaced in the UI so a typo'd
// settings.json doesn't look like "no rules").
async function readSettings(absPath: string): Promise<Loaded> {
  let text: string | null = null
  try { text = await readFile(absPath, 'utf8') } catch { text = null }
  if (text == null) return { exists: false, unreadable: false, data: null }
  try { return { exists: true, unreadable: false, data: JSON.parse(text) as Record<string, unknown> } }
  catch { return { exists: true, unreadable: true, data: null } }
}

// Pull the allow/deny/ask lists + defaultMode out of a parsed settings object.
function extract(data: Record<string, unknown> | null): { allow: string[]; deny: string[]; ask: string[]; mode?: PermissionMode } {
  const perms = (data?.permissions ?? {}) as Record<string, unknown>
  const list = (k: string): string[] =>
    Array.isArray(perms[k]) ? (perms[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const dm = perms.defaultMode
  const mode = typeof dm === 'string' && KNOWN_MODES.includes(dm) ? (dm as PermissionMode) : undefined
  return { allow: list('allow'), deny: list('deny'), ask: list('ask'), mode }
}

// The absolute path of each settings file for a session cwd. Shared by read
// (getEffective) and write (add/removeRule) so they always agree on where each
// scope's file lives.
function resolvePaths(cwd: string): Record<PermissionScope, string> {
  return {
    user: join(homedir(), '.claude', 'settings.json'),
    project: join(cwd, '.claude', 'settings.json'),
    local: join(cwd, '.claude', 'settings.local.json'),
  }
}

// The effective permission picture for a session's cwd and its agent role. Reads
// the three files in precedence order (user < project < local); later scopes win
// the effective mode, and every rule is kept + tagged with its origin scope.
export async function getEffective(cwd: string, agentId?: string): Promise<EffectivePermissions> {
  const notebookFunnel = NOTEBOOK_DENY.split(',')
  const agentDef = getAgent(agentId)
  const agent = {
    id: agentDef.id, name: agentDef.name,
    allowedTools: agentDef.allowedTools, disallowedTools: agentDef.disallowedTools,
  }
  try {
    const paths = resolvePaths(cwd)
    const rules: PermissionRule[] = []
    const files: PermissionFile[] = []
    let mode: PermissionMode = 'default'
    let modeScope: PermissionScope | undefined

    const scopes: PermissionScope[] = ['user', 'project', 'local']
    // Read the three files together, then merge in precedence order below.
    const loaded = await Promise.all(scopes.map((s) => readSettings(paths[s])))
    for (let i = 0; i < scopes.length; i++) {
      const scope = scopes[i]
      const { exists, unreadable, data } = loaded[i]
      files.push({ scope, path: paths[scope], exists, unreadable })
      if (!data) continue
      const { allow, deny, ask, mode: fileMode } = extract(data)
      for (const value of allow) rules.push({ action: 'allow', value, scope })
      for (const value of deny) rules.push({ action: 'deny', value, scope })
      for (const value of ask) rules.push({ action: 'ask', value, scope })
      if (fileMode) { mode = fileMode; modeScope = scope }  // higher-precedence file wins
    }

    return { cwd, mode, modeScope, rules, files, notebookFunnel, agent }
  } catch (err) {
    return {
      cwd, mode: 'default', rules: [], files: [], notebookFunnel, agent,
      error: errMessage(err),
    }
  }
}

// Write a settings object back to disk, pretty-printed, creating the parent
// .claude/ dir if needed.
async function writeSettings(absPath: string, data: Record<string, unknown>): Promise<WriteResult> {
  const text = JSON.stringify(data, null, 2) + '\n'
  try {
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, text, 'utf8')
    return { ok: true }
  } catch (err) { return { ok: false, error: errMessage(err) } }
}

// Read-modify-write one settings file's permissions[action] list. `mutate` returns
// the new list (or null to signal "no change needed"). Preserves everything else
// in the file; creates the file/keys if absent.
async function editRule(
  cwd: string, scope: PermissionScope, action: PermissionAction,
  mutate: (list: string[]) => string[] | null,
): Promise<WriteResult> {
  try {
    const absPath = resolvePaths(cwd)[scope]
    const { unreadable, data } = await readSettings(absPath)
    if (unreadable) return { ok: false, error: `${scope} settings file is not valid JSON — fix it by hand first` }
    const root: Record<string, unknown> = data ?? {}
    const perms = (root.permissions && typeof root.permissions === 'object' ? root.permissions : {}) as Record<string, unknown>
    const current = Array.isArray(perms[action]) ? (perms[action] as unknown[]).filter((x): x is string => typeof x === 'string') : []
    const next = mutate(current)
    if (next == null) return { ok: true }  // nothing to do (e.g. duplicate add / absent remove)
    perms[action] = next
    root.permissions = perms
    return writeSettings(absPath, root)
  } catch (err) { return { ok: false, error: errMessage(err) } }
}

// Add an allow/deny/ask rule to a scope's settings file (no-op if already present).
export function addRule(cwd: string, scope: PermissionScope, action: PermissionAction, value: string): Promise<WriteResult> {
  const v = value.trim()
  if (!v) return Promise.resolve({ ok: false, error: 'empty rule' })
  return editRule(cwd, scope, action, (list) => (list.includes(v) ? null : [...list, v]))
}

// Remove a rule from a scope's settings file (no-op if absent).
export function removeRule(cwd: string, scope: PermissionScope, action: PermissionAction, value: string): Promise<WriteResult> {
  return editRule(cwd, scope, action, (list) => (list.includes(value) ? list.filter((x) => x !== value) : null))
}
