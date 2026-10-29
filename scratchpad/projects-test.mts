// PROJECTS — server half. A grouping level above top-level sessions: every session in a project
// shares its cwd; only TOP-LEVEL sessions carry a projectId (subsessions belong to their parent's
// project implicitly); delete UNGROUPS and closes nothing; a project outlives its last session;
// projects.json persists tmp+rename in dataDir() and is out of every box's reach.
//
// Drives the REAL routes through Fastify inject with a SessionManager whose launch() is stubbed,
// so nothing is spawned. The project modules are imported DEFENSIVELY so this file also runs
// against a tree without them — which is how its RED was measured (every route answers 404).
//   npx tsx scratchpad/projects-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { check, passed, failed } from './assert.mjs'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'projects-')))
const HOME = path.join(TMP, 'home')
process.env.CLAUDETTE_DATA_DIR = path.join(HOME, '.config', 'claudette')
fs.mkdirSync(process.env.CLAUDETTE_DATA_DIR, { recursive: true })

const { SessionManager } = await import('../server/src/claude/sessionManager')
const { registerSessionRoutes } = await import('../server/src/session/sessionApi')
const { sandboxPathAccess, wrapCommand } = await import('../server/src/claude/sandbox')
const storeMod = await import('../server/src/projects/projectStore').catch(() => null)
const apiMod = await import('../server/src/projects/projectApi').catch(() => null)
if (!storeMod || !apiMod) console.log('⚠ the project modules are absent — every project route below will 404 (the RED state)')
const Fastify = (await import('fastify')).default

type AnyMgr = InstanceType<typeof SessionManager> & Record<string, unknown>
const newMgr = (): AnyMgr => {
  const m = new SessionManager({}) as AnyMgr
  ;(m as unknown as { launch: () => void }).launch = () => {}   // never spawn a CLI
  return m
}
const build = async (mgr: AnyMgr) => {
  const projects = storeMod ? new storeMod.ProjectStore() : undefined
  const app = Fastify()
  registerSessionRoutes(app, mgr, projects as never)
  if (apiMod && projects) apiMod.registerProjectRoutes(app, mgr, projects)
  await app.ready()
  return { app, projects }
}

try {
  const proj = path.join(HOME, 'work', 'alpha'); fs.mkdirSync(proj, { recursive: true })
  const other = path.join(HOME, 'work', 'beta'); fs.mkdirSync(other, { recursive: true })
  const mgr = newMgr()
  const { app, projects } = await build(mgr)
  let broadcasts = 0
  projects?.on('changed', () => { broadcasts++ })
  const post = async (url: string, payload: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: payload as object })
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(r.body) } catch { /* non-JSON */ }
    return { code: r.statusCode, body }
  }
  const info = (id: string) => mgr.get(id)

  // --- create a top-level session, then make it a project ----------------------------
  const created = await post('/api/session/create', { name: 'one', cwd: proj })
  const s1 = created.body.id as string
  const fromS = await post('/api/project/fromSession', { sessionId: s1 })
  const P = fromS.body.project as { id: string; name: string; cwd: string } | undefined
  check('1. fromSession makes a project from a top-level session: cwd = session cwd, name = basename(cwd)',
    fromS.code === 200 && P?.cwd === proj && P?.name === 'alpha', `${fromS.code} ${JSON.stringify(fromS.body)}`)
  check('1b. …and the session is now in it', !!P && info(s1)?.projectId === P.id, JSON.stringify(info(s1)?.projectId))
  check('1c. a project change is broadcast (projects emits changed → project:list)', broadcasts >= 1, `broadcasts=${broadcasts}`)

  // --- create INSIDE a project ---------------------------------------------------------
  const inP = await post('/api/session/create', { name: 'two', cwd: '', projectId: P?.id })
  const s2 = inP.body.id as string
  check('2. create with projectId and no cwd takes the PROJECT\'s cwd and joins it',
    inP.code === 200 && info(s2)?.cwd === proj && info(s2)?.projectId === P?.id, `${inP.code} ${JSON.stringify(inP.body)} cwd=${info(s2)?.cwd}`)
  const bad = await post('/api/session/create', { name: 'x', cwd: other, projectId: P?.id })
  check('2b. create with projectId and a MISMATCHING explicit cwd is rejected, and creates nothing',
    bad.code === 400 && !bad.body.id && mgr.list().length === 2, `${bad.code} ${JSON.stringify(bad.body)} sessions=${mgr.list().length}`)

  // --- subsessions carry no projectId ---------------------------------------------------
  const sub = await post('/api/session/create', { name: 'kid', cwd: proj, parentId: s1 })
  const k = sub.body.id as string
  check('3. a subsession of a projected parent carries NO projectId of its own',
    sub.code === 200 && !!info(k) && info(k)?.projectId === undefined, JSON.stringify(info(k)))
  const subP = await post('/api/session/create', { name: 'kid2', cwd: proj, parentId: s1, projectId: P?.id })
  check('3b. create with BOTH parentId and projectId is rejected', subP.code === 400, `${subP.code} ${JSON.stringify(subP.body)}`)
  const fromSub = await post('/api/project/fromSession', { sessionId: k })
  check('3c. fromSession refuses a subsession', fromSub.code === 400, `${fromSub.code}`)
  const moveSub = await post('/api/session/setProject', { id: k, projectId: P?.id })
  check('3d. setProject refuses a subsession', moveSub.code === 400 && info(k)?.projectId === undefined, `${moveSub.code}`)

  // --- setProject ----------------------------------------------------------------------
  const elsewhere = (await post('/api/session/create', { name: 'three', cwd: other })).body.id as string
  const mis = await post('/api/session/setProject', { id: elsewhere, projectId: P?.id })
  check('4. moving a session INTO a project with a different cwd is refused', mis.code === 400 && info(elsewhere)?.projectId === undefined, `${mis.code} ${JSON.stringify(mis.body)}`)
  const s4 = (await post('/api/session/create', { name: 'four', cwd: proj })).body.id as string
  const okMove = await post('/api/session/setProject', { id: s4, projectId: P?.id })
  check('4b. moving a same-cwd session in succeeds', okMove.code === 200 && info(s4)?.projectId === P?.id, `${okMove.code}`)
  const out = await post('/api/session/setProject', { id: s4, projectId: null })
  check('4c. projectId:null removes it from the project', out.code === 200 && info(s4)?.projectId === undefined, `${out.code}`)

  // --- rename / collapse ---------------------------------------------------------------
  const ren = await post('/api/project/rename', { id: P?.id, name: '  Alpha work  ' })
  const col = await post('/api/project/setCollapsed', { id: P?.id, collapsed: true })
  check('5. rename trims and applies; setCollapsed persists the flag',
    ren.code === 200 && projects?.get(P!.id)?.name === 'Alpha work' && col.code === 200 && projects?.get(P!.id)?.collapsed === true,
    `${ren.code} ${col.code} ${JSON.stringify(projects?.get(P?.id ?? ''))}`)
  const listed = await app.inject({ method: 'GET', url: '/api/project/list' })
  check('5b. GET /api/project/list returns it', listed.statusCode === 200 && (JSON.parse(listed.body).projects ?? []).some((p: { id: string }) => p.id === P?.id), listed.body.slice(0, 120))

  // --- promote on parent close ---------------------------------------------------------
  ;(mgr as unknown as { cleanup: (id: string) => void }).cleanup(s1)
  check('6. when a projected coordinator closes, its promoted member INHERITS the project',
    !!P && !info(s1) && info(k)?.parentId === undefined && info(k)?.projectId === P.id, JSON.stringify(info(k)))

  // --- persistence: projects.json + sessions' projectId ---------------------------------
  await new Promise((r) => setTimeout(r, 50))   // let the async tmp+rename land
  const pf = path.join(process.env.CLAUDETTE_DATA_DIR!, 'projects.json')
  let onDisk: { id: string; collapsed?: boolean }[] = []
  try { onDisk = JSON.parse(fs.readFileSync(pf, 'utf8')) } catch { /* absent */ }
  check('7. projects.json is written in dataDir(), with no .tmp left behind',
    onDisk.some((p) => p.id === P?.id && p.collapsed === true) && !fs.existsSync(`${pf}.tmp`), JSON.stringify(onDisk).slice(0, 160))
  const saved = mgr.saved()
  check('7b. saved() keeps projectId on top-level sessions only',
    !!P && saved.some((x) => x.name === 'two' && x.projectId === P.id) && saved.every((x) => x.parentIndex == null || !x.projectId), JSON.stringify(saved.map((x) => [x.name, x.projectId, x.parentIndex])))
  // a SavedSession that (by hand-editing) gives a CHILD a projectId — restore must strip it
  // A literal id, not P.id: this check must not pass vacuously when no project was created.
  const tampered = [{ name: 'p', cwd: proj, projectId: 'restored-pid' }, { name: 'c', cwd: proj, parentIndex: 0, projectId: 'restored-pid' }]
  const mgr2 = newMgr()
  const ids = mgr2.restore(tampered as never)
  check('7c. restore() re-applies a top-level projectId and STRIPS one from a child',
    mgr2.get(ids[0])?.projectId === 'restored-pid' && mgr2.get(ids[1])?.projectId === undefined, JSON.stringify(ids.map((i) => mgr2.get(i)?.projectId)))
  // The strip must happen at REGISTRATION, not only on the way out (toInfo/saved): a child that
  // silently kept a stored projectId would surface it the moment its parent closes and it is
  // promoted — here into a project its family was never in, because the parent had none.
  {
    const mgr3 = newMgr()
    const ids3 = mgr3.restore([{ name: 'p', cwd: proj }, { name: 'c', cwd: proj, parentIndex: 0, projectId: 'smuggled' }] as never)
    ;(mgr3 as unknown as { cleanup: (id: string) => void }).cleanup(ids3[0])
    check('7e. a child\'s smuggled projectId does NOT surface when its project-less parent closes',
      mgr3.get(ids3[1])?.parentId === undefined && mgr3.get(ids3[1])?.projectId === undefined, JSON.stringify(mgr3.get(ids3[1])?.projectId))
  }
  if (storeMod) {
    const reloaded = new storeMod.ProjectStore()
    await reloaded.load()
    check('7d. a fresh store reloads the project from disk', reloaded.get(P!.id)?.name === 'Alpha work')
  } else check('7d. a fresh store reloads the project from disk', false, 'no store module')

  // --- the last session closes: the project stays --------------------------------------
  for (const x of mgr.list()) (mgr as unknown as { cleanup: (id: string) => void }).cleanup(x.id)
  check('8. a project PERSISTS after its last session closes', mgr.list().length === 0 && !!projects?.get(P?.id ?? ''))

  // --- delete ungroups, closes nothing ---------------------------------------------------
  const a = (await post('/api/session/create', { name: 'a', cwd: '', projectId: P?.id })).body.id as string
  const b = (await post('/api/session/create', { name: 'b', cwd: '', projectId: P?.id })).body.id as string
  const del = await post('/api/project/delete', { id: P?.id })
  check('9. delete UNGROUPS its sessions and closes none of them',
    del.code === 200 && del.body.ungrouped === 2 && !!info(a) && !!info(b) && info(a)?.projectId === undefined && info(b)?.projectId === undefined && !projects?.get(P?.id ?? ''),
    `${del.code} ${JSON.stringify(del.body)}`)
  const ghost = await post('/api/session/create', { name: 'g', cwd: '', projectId: 'no-such-project' })
  check('9b. create naming a missing project is refused (404), not silently ungrouped', ghost.code === 404, `${ghost.code}`)

  // --- out of every box's reach, like sessions.json ------------------------------------
  {
    const box = { enabled: true, mounts: [{ path: HOME, mode: 'rw' as const }] }
    const acc = sandboxPathAccess(box, HOME, pf)
    check('10. sandboxPathAccess: projects.json is neither readable nor writable from a $HOME-mounted box',
      !acc.read && !acc.write, JSON.stringify(acc))
    for (const mode of ['rw', 'ro'] as const) {
      const args = wrapCommand({ enabled: true, mounts: [{ path: HOME, mode }] }, HOME, '/bin/sh', ['-c', ':']).args
      const hidden = args.some((x, i) => x === '--ro-bind' && args[i + 2] === process.env.CLAUDETTE_DATA_DIR && args[i + 1] !== args[i + 2])
      check(`10b. argv (${mode} $HOME): the dir holding projects.json is bound over from an empty dir`, hidden)
    }
  }
  await app.close()
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
