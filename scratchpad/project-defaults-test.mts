// PROJECT DEFAULTS — server half. A project carries a default sandbox + permission mode, used
// ONLY when a new session is created IN it: explicit request > project default > app setting >
// built-in. "Make project" snapshots the source session (deep clone; enabled:false and an
// elevated mode kept); an isolated source's worktree mounts are translated back to the repo.
// setDefaults REPLACES, resetDefaults clears; projects.json persists them; a malformed entry
// drops only the defaults. Teammates (parentId) are untouched.
// Drives the real routes with launch() stubbed; new pieces imported defensively (RED on HEAD).
//   npx tsx scratchpad/project-defaults-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { check, passed, failed } from './assert.mjs'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-defaults-')))
process.env.CLAUDETTE_DATA_DIR = path.join(TMP, 'data')
fs.mkdirSync(process.env.CLAUDETTE_DATA_DIR, { recursive: true })
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* best effort */ } })
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'T'
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 't@t.test'

const { SessionManager } = await import('../server/src/claude/sessionManager')
const { registerSessionRoutes } = await import('../server/src/session/sessionApi')
const { ProjectStore } = await import('../server/src/projects/projectStore')
const { registerProjectRoutes } = await import('../server/src/projects/projectApi')
const { saveSettings, resetSettingsCache } = await import('../server/src/settings/settingsStore')
const Fastify = (await import('fastify')).default

type Mount = { path: string; mode: string }
type Info = { id: string; cwd: string; permissionMode?: string; sandbox?: { enabled: boolean; mounts: Mount[]; gpu?: boolean }; worktree?: { path: string; commonDir: string } }
type Proj = { id: string; cwd: string; defaults?: { sandbox?: { enabled: boolean; mounts: Mount[] }; permissionMode?: string } }
type AnyMgr = InstanceType<typeof SessionManager> & Record<string, unknown>
const mgr = new SessionManager({}) as AnyMgr
;(mgr as unknown as { launch: () => void }).launch = () => {}
const projects = new ProjectStore()
const app = Fastify()
registerSessionRoutes(app, mgr, projects)
registerProjectRoutes(app, mgr, projects)
await app.ready()
const post = async (url: string, payload: unknown) => {
  const r = await app.inject({ method: 'POST', url, payload: payload as object })
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(r.body) } catch { /* */ }
  return { code: r.statusCode, body }
}
const info = (id: unknown) => mgr.get(id as string) as unknown as Info
const mk = (p: string) => { fs.mkdirSync(p, { recursive: true }); return p }
const W = mk(path.join(TMP, 'work')), DOCS = mk(path.join(TMP, 'docs'))
const projectFile = () => JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'projects.json'), 'utf8')) as Proj[]
// projects.json is written async (tmp+rename); poll until the predicate holds or ~2s pass.
const waitSaved = async (ok: () => boolean) => { for (let i = 0; i < 100; i++) { try { if (ok()) return } catch { /* */ } await new Promise((r) => setTimeout(r, 20)) } }

// ── 1. fromSession snapshot ─────────────────────────────────────────────────────────────
const src = await post('/api/session/create', { name: 'src', cwd: W, permissionMode: 'bypassPermissions',
  sandbox: { enabled: false, mounts: [{ path: W + '/', mode: 'rw' }, { path: DOCS, mode: 'ro' }] } })
const made = await post('/api/project/fromSession', { sessionId: src.body.id })
const P = made.body.project as Proj | undefined
check('1a fromSession snapshots the ELEVATED mode', P?.defaults?.permissionMode === 'bypassPermissions', JSON.stringify(P?.defaults))
check('1b …and the sandbox with enabled:false kept, mounts canonical', P?.defaults?.sandbox?.enabled === false
  && JSON.stringify(P?.defaults?.sandbox?.mounts) === JSON.stringify([{ path: W, mode: 'rw' }, { path: DOCS, mode: 'ro' }]), JSON.stringify(P?.defaults?.sandbox))
const live = projects.get(P!.id) as Proj
;(info(src.body.id).sandbox!.mounts as Mount[]).push({ path: '/mutated', mode: 'rw' })
check('1c the snapshot is a DEEP clone (mutating the session leaves the project alone)', (projects.get(P!.id) as Proj).defaults?.sandbox?.mounts.some((m) => m.path === '/mutated') === false && !!live)
const listed = projects.list().find((p) => p.id === P!.id) as Proj
listed.defaults!.sandbox!.mounts.push({ path: '/via-list', mode: 'rw' })
check('1c2 list() hands out copies — mutating one leaves the store alone', !(projects.get(P!.id) as Proj).defaults?.sandbox?.mounts.some((m) => m.path === '/via-list'))
const plain = await post('/api/project/create', { name: 'bare', cwd: mk(path.join(TMP, 'bare')) })
check('1d /api/project/create has NO defaults', plain.code === 200 && (plain.body.project as Proj).defaults === undefined)

// ── 2. isolated source → translated ─────────────────────────────────────────────────────
const R = mk(path.join(TMP, 'repo'))
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: R }); fs.writeFileSync(path.join(R, 'a'), 'a'); execFileSync('git', ['add', '-A'], { cwd: R }); execFileSync('git', ['commit', '-qm', '1'], { cwd: R })
const rp = (await post('/api/project/create', { name: 'repo', cwd: R })).body.project as Proj
const iso = await post('/api/session/create', { name: 'iso', cwd: '', projectId: rp.id, isolated: {},
  sandbox: { enabled: true, mounts: [{ path: R, mode: 'rw' }, { path: DOCS, mode: 'ro' }] } })
const isoInfo = info(iso.body.id)
const wtSub = path.join(isoInfo.worktree!.path, 'sub'); fs.mkdirSync(wtSub)
isoInfo.sandbox!.mounts.push({ path: wtSub, mode: 'ro' })   // a mount UNDER the worktree
await post('/api/session/setProject', { id: iso.body.id, projectId: null })
const before = JSON.stringify(info(iso.body.id).sandbox?.mounts)
const fromIso = (await post('/api/project/fromSession', { sessionId: iso.body.id })).body.project as Proj | undefined
check('2b the translation never touches the SOURCE session\'s own box', JSON.stringify(info(iso.body.id).sandbox?.mounts) === before, JSON.stringify(info(iso.body.id).sandbox?.mounts))
const tm = (fromIso?.defaults?.sandbox?.mounts ?? []).map((m) => `${m.mode}:${m.path}`).sort()
check('2a isolated source: worktree mount → repoRoot, common-dir mount dropped, under-worktree mount moved, others kept',
  JSON.stringify(tm) === JSON.stringify([`ro:${DOCS}`, `ro:${path.join(R, 'sub')}`, `rw:${R}`].sort()), JSON.stringify(tm))

// ── 3. setDefaults / resetDefaults ──────────────────────────────────────────────────────
const bad1 = await post('/api/project/setDefaults', { id: P!.id, permissionMode: 'banana' })
check('3a bad mode refused (400)', bad1.code === 400)
const bad2 = await post('/api/project/setDefaults', { id: P!.id, sandbox: { enabled: true, mounts: [{ path: '', mode: 'rw' }] } })
check('3b malformed sandbox refused (400)', bad2.code === 400)
const bad3 = await post('/api/project/setDefaults', { id: P!.id })
check('3c empty set refused — clearing is resetDefaults', bad3.code === 400 && /resetDefaults/.test(String(bad3.body.error)))
check('3d unknown project → 404', (await post('/api/project/setDefaults', { id: 'nope', permissionMode: 'plan' })).code === 404)
const set = await post('/api/project/setDefaults', { id: P!.id, permissionMode: 'acceptEdits' })
check('3e set REPLACES: mode set, sandbox default gone', set.code === 200 && (set.body.project as Proj).defaults?.permissionMode === 'acceptEdits' && (set.body.project as Proj).defaults?.sandbox === undefined, JSON.stringify(set.body))
await post('/api/project/setDefaults', { id: P!.id, permissionMode: 'acceptEdits', sandbox: { enabled: true, mounts: [{ path: W + '/', mode: 'ro' }, { path: W, mode: 'rw' }] } })
await waitSaved(() => projectFile().find((p) => p.id === P!.id)?.defaults?.permissionMode === 'acceptEdits')
const onDisk = projectFile().find((p) => p.id === P!.id)
check('3f persisted to projects.json, mounts canonicalised + deduped (rw wins)', onDisk?.defaults?.permissionMode === 'acceptEdits' && JSON.stringify(onDisk?.defaults?.sandbox?.mounts) === JSON.stringify([{ path: W, mode: 'rw' }]), JSON.stringify(onDisk?.defaults))
const reloaded = new ProjectStore(); await reloaded.load()
check('3g …and reload restores them', (reloaded.get(P!.id) as Proj)?.defaults?.permissionMode === 'acceptEdits')
const rs = await post('/api/project/resetDefaults', { id: P!.id })
check('3h resetDefaults clears them', rs.code === 200 && (rs.body.project as Proj).defaults === undefined)
check('3i resetDefaults on an unknown project → 404', (await post('/api/project/resetDefaults', { id: 'nope' })).code === 404)

// ── 4. malformed entry on load: drop defaults only ──────────────────────────────────────
fs.writeFileSync(path.join(TMP, 'data', 'projects.json'), JSON.stringify([
  { id: 'p1', name: 'one', cwd: W, createdAt: 1, defaults: { permissionMode: 'banana' } },
  { id: 'p2', name: 'two', cwd: W, createdAt: 2, defaults: { sandbox: { enabled: 'yes', mounts: [] } } },
  { id: 'p3', name: 'three', cwd: W, createdAt: 3, defaults: { permissionMode: 'plan' } },
]))
const ld = new ProjectStore(); await ld.load()
check('4a malformed defaults dropped, project kept', !!ld.get('p1') && !(ld.get('p1') as Proj).defaults && !!ld.get('p2') && !(ld.get('p2') as Proj).defaults)
check('4b a valid sibling keeps its defaults', (ld.get('p3') as Proj)?.defaults?.permissionMode === 'plan')

// ── 5. create precedence ────────────────────────────────────────────────────────────────
await post('/api/project/setDefaults', { id: P!.id, permissionMode: 'plan', sandbox: { enabled: true, mounts: [{ path: DOCS, mode: 'ro' }, { path: W, mode: 'ro' }] } })
const e1 = await post('/api/session/create', { name: 'explicit', cwd: '', projectId: P!.id, permissionMode: 'default', sandbox: { enabled: true, mounts: [{ path: W, mode: 'rw' }] } })
check('5a explicit request fields win over the project default', info(e1.body.id).permissionMode === 'default' && JSON.stringify(info(e1.body.id).sandbox?.mounts) === JSON.stringify([{ path: W, mode: 'rw' }]))
const e2 = await post('/api/session/create', { name: 'omitted', cwd: '', projectId: P!.id })
check('5b omitted fields take the PROJECT default', info(e2.body.id).permissionMode === 'plan' && info(e2.body.id).sandbox?.mounts.some((m) => m.path === DOCS), JSON.stringify(info(e2.body.id)))
resetSettingsCache(); (saveSettings as (p: unknown) => unknown)({ defaultPermissionMode: 'default' })
await post('/api/project/setDefaults', { id: P!.id, sandbox: { enabled: true, mounts: [{ path: W, mode: 'rw' }] } })   // mode default gone
const e3 = await post('/api/session/create', { name: 'appsetting', cwd: '', projectId: P!.id })
check('5c no project mode → the APP SETTING applies', info(e3.body.id).permissionMode === 'default', String(info(e3.body.id).permissionMode))
const e4 = await post('/api/session/create', { name: 'bare', cwd: '', projectId: (plain.body.project as Proj).id })
check('5d project without defaults: built-in sandbox (enabled, cwd rw)', info(e4.body.id).sandbox?.enabled === true && JSON.stringify(info(e4.body.id).sandbox?.mounts) === JSON.stringify([{ path: (plain.body.project as Proj).cwd, mode: 'rw' }]))
await post('/api/project/setDefaults', { id: P!.id, permissionMode: 'bypassPermissions' })
const e5 = await post('/api/session/create', { name: 'elevated', cwd: '', projectId: P!.id })
check('5e an ELEVATED project default is honoured on create', info(e5.body.id).permissionMode === 'bypassPermissions', String(info(e5.body.id).permissionMode))
await post('/api/project/setDefaults', { id: P!.id, sandbox: { enabled: false, mounts: [] } })
const e6 = await post('/api/session/create', { name: 'unsandboxed', cwd: '', projectId: P!.id })
check('5f a project default enabled:false is honoured on create', info(e6.body.id).sandbox?.enabled === false)

// ── 6. isolated create with project defaults ────────────────────────────────────────────
await post('/api/project/setDefaults', { id: rp.id, permissionMode: 'acceptEdits', sandbox: { enabled: true, mounts: [{ path: R, mode: 'rw' }, { path: DOCS, mode: 'ro' }] } })
const i2 = await post('/api/session/create', { name: 'iso two', cwd: '', projectId: rp.id, isolated: {} })
const i2i = info(i2.body.id)
const i2m = (i2i?.sandbox?.mounts ?? []).map((m) => `${m.mode}:${m.path}`)
check('6a isolated create: project default sandbox goes through worktreeSandbox (repo root dropped, worktree + common dir rw, extra kept) + project mode',
  i2.code === 200 && i2i.permissionMode === 'acceptEdits' && !i2m.includes(`rw:${R}`) && i2m.includes(`rw:${i2i.worktree?.path}`) && i2m.includes(`rw:${i2i.worktree?.commonDir}`) && i2m.includes(`ro:${DOCS}`), JSON.stringify(i2m))

// ── 7. teammates untouched ──────────────────────────────────────────────────────────────
const lead = info(e2.body.id)
const kid = await post('/api/session/create', { name: 'kid', cwd: lead.cwd, parentId: lead.id })
check('7a a teammate inherits its PARENT\'s box, not the project default', JSON.stringify(info(kid.body.id).sandbox?.mounts) === JSON.stringify(lead.sandbox?.mounts) && info(kid.body.id).sandbox?.enabled === lead.sandbox?.enabled, JSON.stringify(info(kid.body.id).sandbox))
check('7b …and is not given the project mode (parentId + projectId is refused outright)', (await post('/api/session/create', { name: 'kid2', cwd: '', parentId: lead.id, projectId: P!.id })).code === 400)

await app.close()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
