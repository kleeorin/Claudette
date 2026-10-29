// ISOLATED (git worktree) SESSIONS — server half. A session created inside a project with
// `isolated` runs in <repoRoot>/.claude/worktrees/<slug> on a new branch from HEAD; cwd AND
// rootDir are that worktree; `.claude/worktrees/` goes into <commonDir>/info/exclude; files
// .worktreeinclude matches are copied in. Membership is "same repo" (equal git common dir) for
// a worktree session only. Its box: worktree rw + common dir rw (git exec-vector pins on top),
// main work tree NOT mounted. Restore with the dir gone ⇒ exited with a reason, not recreated.
// Close: keep (dir stays) / remove (dir goes, branch stays; dirty or unmerged ⇒ 409 + second
// confirm with force). Rewind inside a worktree snapshots/restores the worktree, refs in the
// common dir.
//
// Drives the REAL routes through Fastify inject with launch() stubbed. Modules new in this
// change are imported defensively so the file runs (RED) against a tree without them.
//   npx tsx scratchpad/worktree-sessions-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { check, passed, failed } from './assert.mjs'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sessions-')))
process.env.CLAUDETTE_DATA_DIR = path.join(TMP, 'data')
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude')
fs.mkdirSync(process.env.CLAUDETTE_DATA_DIR, { recursive: true })
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'T'
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 't@t.test'

const { SessionManager } = await import('../server/src/claude/sessionManager')
const { registerSessionRoutes } = await import('../server/src/session/sessionApi')
const { ProjectStore, cwdFitsProject } = await import('../server/src/projects/projectStore')
const { registerProjectRoutes } = await import('../server/src/projects/projectApi')
const { sandboxPathAccess, wrapCommand, sandboxAvailable } = await import('../server/src/claude/sandbox')
const { projectDir } = await import('../server/src/claude/conversations')
const { snapshot, saveRef } = await import('../server/src/git/shadowSnapshots')
const wtMod = await import('../server/src/git/worktrees').catch(() => null)
if (!wtMod) console.log('⚠ git/worktrees.ts absent — expect RED')
const Fastify = (await import('fastify')).default

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const mkRepo = (dir: string, commit = true): string => {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  if (commit) {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a v0\n')
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nsecrets/\nbuild/\n')
    fs.writeFileSync(path.join(dir, '.worktreeinclude'), '.env\nsecrets/*.key\n')
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'one')
  }
  return dir
}
type Info = { id: string; cwd: string; rootDir: string; state: string; projectId?: string; worktree?: { path: string; branch: string; repoRoot: string; commonDir: string }; sandbox?: { enabled: boolean; mounts: { path: string; mode: string }[] } }
type AnyMgr = InstanceType<typeof SessionManager> & Record<string, unknown>
const launched: string[] = []
const newMgr = (): AnyMgr => {
  const m = new SessionManager({}) as AnyMgr
  ;(m as unknown as { launch: (s: { id: string }) => void }).launch = (s) => { launched.push(s.id) }
  return m
}
const mgr = newMgr()
const projects = new ProjectStore()
const app = Fastify()
registerSessionRoutes(app, mgr, projects)
registerProjectRoutes(app, mgr, projects)
await app.ready()
const post = async (url: string, payload: unknown) => {
  const r = await app.inject({ method: 'POST', url, payload: payload as object })
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(r.body) } catch { /* non-JSON */ }
  return { code: r.statusCode, body }
}
const info = (id: string) => mgr.get(id) as unknown as Info | undefined

// ── fixtures ────────────────────────────────────────────────────────────────────────────
const R = fs.realpathSync(mkRepo(path.join(TMP, 'repo')))
fs.writeFileSync(path.join(R, '.env'), 'SECRET=1\n')
fs.mkdirSync(path.join(R, 'secrets')); fs.writeFileSync(path.join(R, 'secrets', 'api.key'), 'k\n'); fs.writeFileSync(path.join(R, 'secrets', 'notes.txt'), 'n\n')
fs.mkdirSync(path.join(R, 'build')); fs.writeFileSync(path.join(R, 'build', 'out.js'), 'x\n')
const proj = projects.create('Repo', R) as { ok: true; project: { id: string; cwd: string } }
const EMPTY = mkRepo(path.join(TMP, 'empty'), false)
const projEmpty = projects.create('Empty', EMPTY) as { ok: true; project: { id: string } }
const PLAIN = path.join(TMP, 'plain'); fs.mkdirSync(PLAIN)
const projPlain = projects.create('Plain', PLAIN) as { ok: true; project: { id: string } }

try {
  // ── 1. repoStatus ─────────────────────────────────────────────────────────────────────
  const rs = await post('/api/project/repoStatus', { id: proj.project.id })
  const repo = rs.body.repo as { root: string; commonDir: string; hasCommit: boolean } | null
  check('1a repoStatus: repo with a commit', rs.code === 200 && repo?.root === R && repo?.commonDir === path.join(R, '.git') && repo?.hasCommit === true, JSON.stringify(rs.body))
  const re = await post('/api/project/repoStatus', { id: projEmpty.project.id })
  check('1b repoStatus: repo without commits → hasCommit false', (re.body.repo as { hasCommit?: boolean } | null)?.hasCommit === false, JSON.stringify(re.body))
  const rp = await post('/api/project/repoStatus', { id: projPlain.project.id })
  check('1c repoStatus: not a repo → repo null', rp.code === 200 && rp.body.repo === null, JSON.stringify(rp.body))

  // ── 2. creation ───────────────────────────────────────────────────────────────────────
  const c1 = await post('/api/session/create', { name: 'Fix Login!', cwd: '', projectId: proj.project.id, isolated: {}, sandbox: { enabled: true, mounts: [{ path: R, mode: 'rw' }] } })
  const s1 = c1.body.id ? info(c1.body.id as string) : undefined
  const W1 = path.join(R, '.claude', 'worktrees', 'fix-login')
  check('2a create isolated → 200, cwd = rootDir = <repo>/.claude/worktrees/<slug>', c1.code === 200 && s1?.cwd === W1 && s1?.rootDir === W1, JSON.stringify(c1.body))
  check('2b worktree record {path, branch=slug, repoRoot, commonDir}',
    s1?.worktree?.path === W1 && s1?.worktree?.branch === 'fix-login' && s1?.worktree?.repoRoot === R && s1?.worktree?.commonDir === path.join(R, '.git'), JSON.stringify(s1?.worktree))
  check('2c git: branch created from HEAD and registered as a worktree',
    git(R, 'rev-parse', 'fix-login').trim() === git(R, 'rev-parse', 'HEAD').trim() && git(R, 'worktree', 'list', '--porcelain').includes(`worktree ${W1}`))
  check('2d .claude/worktrees/ in <commonDir>/info/exclude, main checkout stays clean',
    fs.readFileSync(path.join(R, '.git', 'info', 'exclude'), 'utf8').split('\n').includes('.claude/worktrees/') && git(R, 'status', '--porcelain') === '', git(R, 'status', '--porcelain'))
  check('2e .worktreeinclude: .env and secrets/*.key copied; non-matching ignored files not',
    fs.existsSync(path.join(W1, '.env')) && fs.existsSync(path.join(W1, 'secrets', 'api.key')) && !fs.existsSync(path.join(W1, 'secrets', 'notes.txt')) && !fs.existsSync(path.join(W1, 'build', 'out.js')))
  check('2f session stays in the project', s1?.projectId === proj.project.id)
  check('2g launch() was called for it', !!c1.body.id && launched.includes(c1.body.id as string))

  const c2 = await post('/api/session/create', { name: 'x', cwd: '', projectId: proj.project.id, isolated: { branch: 'feature/two' } })
  const s2 = c2.body.id ? info(c2.body.id as string) : undefined
  check('2h explicit branch: branch kept verbatim, dir is its slug', c2.code === 200 && s2?.worktree?.branch === 'feature/two' && s2?.cwd === path.join(R, '.claude', 'worktrees', 'feature-two'), JSON.stringify(c2.body))
  check('2i branch collision → 400, nothing created', (await post('/api/session/create', { name: 'Fix Login', cwd: '', projectId: proj.project.id, isolated: {} })).code === 400)
  check('2j invalid branch name → 400', (await post('/api/session/create', { name: 'y', cwd: '', projectId: proj.project.id, isolated: { branch: 'bad..name' } })).code === 400)
  check('2k repo with no commits → 400', (await post('/api/session/create', { name: 'z', cwd: '', projectId: projEmpty.project.id, isolated: {} })).code === 400)
  check('2l project dir not a repo → 400', (await post('/api/session/create', { name: 'z', cwd: '', projectId: projPlain.project.id, isolated: {} })).code === 400)
  check('2m isolated without a project → 400', (await post('/api/session/create', { name: 'z', cwd: R, isolated: {} })).code === 400)

  // ── 3. membership = same repo, for worktree sessions only ─────────────────────────────
  const P = proj.project as never
  check('3a worktree session fits its repo\'s project', !!s1?.worktree && cwdFitsProject(W1, P, s1.worktree as never))
  check('3b same-cwd rule still holds for an ordinary session', cwdFitsProject(R, P))
  fs.mkdirSync(path.join(R, 'sub'), { recursive: true })
  check('3c ordinary session in ANOTHER dir of the same repo does not fit', !cwdFitsProject(path.join(R, 'sub'), P))
  const OTHER = mkRepo(path.join(TMP, 'other'))
  git(OTHER, 'worktree', 'add', '-q', path.join(TMP, 'other-wt'), '-b', 'o')
  const forged = { path: path.join(TMP, 'other-wt'), branch: 'o', repoRoot: R, commonDir: path.join(R, '.git') }
  check('3d a worktree of ANOTHER repo does not fit, even with a record claiming this repo', !cwdFitsProject(forged.path, P, forged as never))
  check('3e a worktree record whose path is not the cwd does not fit', !!s1?.worktree && !cwdFitsProject(path.join(TMP, 'other-wt'), P, s1.worktree as never))
  const out = await post('/api/session/setProject', { id: c1.body.id, projectId: null })
  const back = await post('/api/session/setProject', { id: c1.body.id, projectId: proj.project.id })
  check('3f setProject: an isolated session can leave and re-join its repo\'s project', out.code === 200 && back.code === 200 && back.body.ok === true, JSON.stringify(back.body))
  check('3g ProjectInfo carries gitCommonDir for the client', (projects.get(proj.project.id) as { gitCommonDir?: string })?.gitCommonDir === path.join(R, '.git'))

  // ── 4. the box ────────────────────────────────────────────────────────────────────────
  const sb = s1?.sandbox as never
  const mounts = (s1?.sandbox?.mounts ?? []).map((m) => `${m.mode}:${m.path}`)
  check('4a mounts: worktree rw + common dir rw; the dialog-seeded main tree mount is dropped',
    mounts.includes(`rw:${W1}`) && mounts.includes(`rw:${path.join(R, '.git')}`) && !mounts.some((m) => m.endsWith(`:${R}`)), JSON.stringify(mounts))
  const acc = (p: string) => sandboxPathAccess(sb, W1, p)
  check('4b main work tree NOT writable (nor readable)', acc(path.join(R, 'a.txt')).write === false && acc(path.join(R, 'a.txt')).read === false)
  check('4c worktree files writable', acc(path.join(W1, 'a.txt')).write === true)
  check('4d common objects/refs + its own worktrees/<name> gitdir writable',
    acc(path.join(R, '.git', 'objects', 'x')).write === true && acc(path.join(R, '.git', 'worktrees', 'fix-login', 'index')).write === true)
  check('4e common config / hooks / worktree pointer NOT writable',
    acc(path.join(R, '.git', 'config')).write === false && acc(path.join(R, '.git', 'hooks', 'pre-commit')).write === false && acc(path.join(W1, '.git')).write === false)
  const argv = wrapCommand(sb, W1, '/bin/true', []).args
  const bindAt = (p: string) => { let f: string | null = null; for (let i = 0; i < argv.length - 2; i++) if ((argv[i] === '--bind' || argv[i] === '--ro-bind') && argv[i + 2] === p) f = argv[i]; return f }
  check('4f argv: main tree never bound; hooks + config ro', bindAt(R) === null && bindAt(path.join(R, '.git', 'hooks')) === '--ro-bind' && bindAt(path.join(R, '.git', 'config')) === '--ro-bind')
  if (sandboxAvailable()) {
    const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const script = [
      'cd "$1"', 'echo w > w.txt',
      `${gitBin} add w.txt && ${gitBin} -c user.name=t -c user.email=t@t commit -qm wt && echo COMMIT_OK`,
      // Reading is the meaningful probe: the main tree's DIR exists in the box only as an
      // auto-created parent of the two mounts (empty tmpfs), so a write there "succeeds" into
      // RAM and is lost — the documented write decoy. The host bytes are what must not change.
      `cat "$2/a.txt" 2>/dev/null && echo MAIN_READ`,
      `echo x >> "$2/a.txt" 2>/dev/null`,
      `echo "#!/bin/sh" > "$2/.git/hooks/post-checkout" 2>/dev/null && echo HOOK_WRITTEN`,
    ].join('\n')
    const spec = wrapCommand(sb, W1, '/bin/sh', ['-c', script, 'sh', W1, R])
    const r = spawnSync(spec.command, spec.args, { encoding: 'utf8', timeout: 20_000 })
    const o = r.stdout + r.stderr
    check('4g LIVE: commit inside the worktree box works (objects/refs in the common dir)', o.includes('COMMIT_OK') && git(R, 'log', '-1', '--format=%s', 'fix-login').trim() === 'wt', o.trim())
    check('4h LIVE: main work tree invisible from the box, and its files untouched on the host', !o.includes('MAIN_READ') && fs.readFileSync(path.join(R, 'a.txt'), 'utf8') === 'a v0\n', o.trim())
    check('4i LIVE: common hooks not writable from the box', !o.includes('HOOK_WRITTEN') && !fs.existsSync(path.join(R, '.git', 'hooks', 'post-checkout')))
    git(W1, 'reset', '-q', '--hard', 'HEAD~1')   // undo, so section 6's clean-remove holds
  } else console.log('⚠ bwrap unavailable — live box checks skipped')

  // ── 5. persistence + restore with the dir gone ────────────────────────────────────────
  const saved = mgr.saved() as { worktree?: { path: string } }[]
  check('5a saved() carries the worktree record', saved.some((x) => x.worktree?.path === W1))
  const W2 = s2!.cwd
  const m2 = new SessionManager({}) as AnyMgr
  const exits: { id: string; msg: string }[] = []
  m2.on('exit', (id: string, _err: boolean, msg: string) => exits.push({ id, msg }))
  // Hide W2 only for the restore: launch() runs FOR REAL here (that is where the check
  // lives), with PATH emptied so that, should the check be missing, no real CLI can spawn.
  fs.renameSync(W2, W2 + '.hidden')
  const realPath = process.env.PATH
  let ids: string[] = []
  const realLaunch = (m2 as unknown as { launch: (s: { id: string; worktree?: unknown }) => void }).launch.bind(m2)
  ;(m2 as unknown as { launch: (s: { id: string; worktree?: { path: string } }) => void }).launch = (s) => {
    // Only the isolated session whose dir is gone goes through the real launch.
    if (s.worktree?.path === W2) { process.env.PATH = '/nonexistent'; try { realLaunch(s) } finally { process.env.PATH = realPath } }
  }
  ids = m2.restore(saved as never)
  fs.renameSync(W2 + '.hidden', W2)
  const restored = ids.map((id) => m2.get(id) as unknown as Info)
  const gone = restored.find((x) => x?.worktree?.path === W2)
  const kept = restored.find((x) => x?.worktree?.path === W1)
  check('5b restore: worktree record replayed', !!gone && !!kept && kept.cwd === W1)
  check('5c restore with the dir gone → exited, with a reason naming the worktree', gone?.state === 'exited' && exits.some((e) => e.id === gone!.id && /no longer exists/.test(e.msg) && e.msg.includes(W2)), JSON.stringify(exits))
  check('5d …and it is NOT recreated', !fs.existsSync(W2 + '.hidden') && exits.length === 1)
  for (const id of ids) (m2 as unknown as { cleanup: (id: string) => void }).cleanup(id)

  // ── 6. close: keep / remove / dirty + unmerged guard ──────────────────────────────────
  const mk = async (name: string) => {
    const r = await post('/api/session/create', { name, cwd: '', projectId: proj.project.id, isolated: {} })
    return { id: r.body.id as string, dir: info(r.body.id as string)!.cwd, branch: info(r.body.id as string)!.worktree!.branch }
  }
  const k = await mk('keep me')
  check('6a keep (plain close): session gone, worktree stays', (await post('/api/session/destroy', { id: k.id })).code === 200 && !mgr.get(k.id) && fs.existsSync(k.dir))
  const clean = await mk('clean one')
  const rc = await post('/api/session/destroy', { id: clean.id, removeWorktree: true })
  check('6b remove clean: dir gone, branch kept, session gone',
    rc.code === 200 && !fs.existsSync(clean.dir) && git(R, 'branch', '--list', clean.branch).trim() !== '' && !mgr.get(clean.id), JSON.stringify(rc.body))
  const dirty = await mk('dirty one')
  fs.writeFileSync(path.join(dirty.dir, 'scratch.txt'), 'wip\n')
  const rd = await post('/api/session/destroy', { id: dirty.id, removeWorktree: true })
  const st = rd.body.status as { dirty?: string[]; unmerged?: string[] } | undefined
  check('6c remove dirty without force → 409 needsConfirm + the dirty files; session NOT closed',
    rd.code === 409 && rd.body.needsConfirm === true && !!st?.dirty?.some((l) => l.includes('scratch.txt')) && !!mgr.get(dirty.id) && fs.existsSync(dirty.dir), JSON.stringify(rd.body))
  const ws = await post('/api/session/worktreeStatus', { id: dirty.id })
  check('6d worktreeStatus route reports the same', ws.code === 200 && (ws.body.dirty as string[]).some((l) => l.includes('scratch.txt')))
  const rf = await post('/api/session/destroy', { id: dirty.id, removeWorktree: true, force: true })
  check('6e second confirm (force) → dir gone, branch kept', rf.code === 200 && !fs.existsSync(dirty.dir) && git(R, 'branch', '--list', dirty.branch).trim() !== '', JSON.stringify(rf.body))
  const ahead = await mk('ahead one')
  fs.writeFileSync(path.join(ahead.dir, 'feat.txt'), 'f\n'); git(ahead.dir, 'add', 'feat.txt'); git(ahead.dir, 'commit', '-qm', 'unmerged work')
  const ra = await post('/api/session/destroy', { id: ahead.id, removeWorktree: true })
  const sa = ra.body.status as { dirty?: string[]; unmerged?: string[] } | undefined
  check('6f clean tree but an unmerged commit → 409 listing it', ra.code === 409 && sa?.dirty?.length === 0 && !!sa?.unmerged?.some((l) => l.includes('unmerged work')), JSON.stringify(ra.body))
  const raf = await post('/api/session/destroy', { id: ahead.id, removeWorktree: true, force: true })
  check('6g force → removed; the commit survives on the kept branch', raf.code === 200 && !fs.existsSync(ahead.dir) && git(R, 'log', '-1', '--format=%s', ahead.branch).trim() === 'unmerged work')
  const plainSess = await post('/api/session/create', { name: 'plain', cwd: '', projectId: proj.project.id })
  check('6h removeWorktree on an ordinary session → 400, session left open',
    (await post('/api/session/destroy', { id: plainSess.body.id, removeWorktree: true })).code === 400 && !!mgr.get(plainSess.body.id as string))

  // ── 7. rewind inside a worktree ───────────────────────────────────────────────────────
  const rw = await mk('rewinder')
  const commit = await snapshot(rw.dir)
  check('7a snapshot in a worktree succeeds', !!commit)
  if (commit) await saveRef(rw.dir, 'RW-T1', commit)
  const refs = git(R, 'for-each-ref', '--format=%(refname)')
  check('7b the snapshot ref lands in the COMMON dir (visible from the main checkout)', /\/RW-T1$/m.test(refs), refs)
  fs.writeFileSync(path.join(rw.dir, 'a.txt'), 'edited in worktree\n')
  const T1 = Date.parse('2026-10-27T10:00:00Z')
  const iso = (ms: number) => new Date(ms).toISOString()
  const claudeId = (mgr as unknown as { claudeSessionId: (id: string) => string }).claudeSessionId(rw.id)
  fs.mkdirSync(projectDir(rw.dir), { recursive: true })
  fs.writeFileSync(path.join(projectDir(rw.dir), `${claudeId}.jsonl`), [
    JSON.stringify({ type: 'user', uuid: 'RW-T1', timestamp: iso(T1), cwd: rw.dir, message: { role: 'user', content: 'edit a' } }),
    JSON.stringify({ type: 'assistant', uuid: 'as-1', timestamp: iso(T1 + 1000), cwd: rw.dir, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: path.join(rw.dir, 'a.txt'), old_string: 'a v0', new_string: 'edited' } }] } }),
    JSON.stringify({ type: 'user', uuid: 'tr-1', timestamp: iso(T1 + 1100), cwd: rw.dir, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  ].join('\n') + '\n')
  const pv = await app.inject({ method: 'GET', url: `/api/session/rewindPreview?id=${rw.id}&uuid=RW-T1` })
  const preview = (JSON.parse(pv.body) as { preview: { reverted: string[] } | null }).preview
  check('7c rewind preview scoped to the worktree (repo-relative a.txt)', JSON.stringify(preview?.reverted) === '["a.txt"]', pv.body)
  const rr = await app.inject({ method: 'POST', url: '/api/session/rewind', payload: { id: rw.id, uuid: 'RW-T1', mode: 'code', deleteNewer: false } })
  check('7d rewind restores the WORKTREE file; the main checkout is untouched',
    (JSON.parse(rr.body) as { ok: boolean }).ok && fs.readFileSync(path.join(rw.dir, 'a.txt'), 'utf8') === 'a v0\n' && fs.readFileSync(path.join(R, 'a.txt'), 'utf8') === 'a v0\n', rr.body)
} finally {
  await app.close()
  fs.rmSync(TMP, { recursive: true, force: true })
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
