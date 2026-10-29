// GIT EXEC-VECTOR PROTECTION (SANDBOX.md "Git exec-vector escape"). A git dir inside a rw
// mount is a host code-execution channel: hooks/, config (core.hooksPath, core.fsmonitor,
// core.sshCommand, filter drivers, aliases, include.path), config.worktree, commondir and a
// linked worktree's `.git` pointer all decide what the OPERATOR's unsandboxed `git` runs.
// This pins them ro inside every rw mount, plus a self-bind of each gitdir / work-tree top
// so `mv .git .gitx && mkdir .git` cannot shed the overlays.
//
// Three layers of evidence: the argv wrapCommand emits, the authorizer (sandboxPathAccess),
// and — when bwrap works here — the attacks actually attempted inside a real box.
// Runs against a tree without gitProtection.ts too (that is its RED).
//   npx tsx scratchpad/git-exec-protection-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync, execFileSync } from 'child_process'
import { check, passed, failed } from './assert.mjs'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitprot-')))
// Removed on EVERY exit, crash included: a leftover fixture holds a deliberately planted
// commondir, and any later box that mounts /tmp would (correctly) refuse to launch over it.
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* best effort */ } })
process.env.CLAUDETTE_DATA_DIR = path.join(TMP, 'data')
fs.mkdirSync(process.env.CLAUDETTE_DATA_DIR, { recursive: true })
const { wrapCommand, sandboxPathAccess, sandboxAvailable } = await import('../server/src/claude/sandbox')
const gp = await import('../server/src/claude/gitProtection').catch(() => null)
if (!gp) console.log('⚠ gitProtection.ts absent — expect RED')

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const mkRepo = (dir: string): string => {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', 'a.txt'); git(dir, 'commit', '-qm', 'one')
  return dir
}
const rw = (...p: string[]) => ({ enabled: true, gpu: false, mounts: p.map((x) => ({ path: x, mode: 'rw' as const })) })
type Args = string[]
const argvOf = (cfg: ReturnType<typeof rw>, cwd: string): Args => wrapCommand(cfg as never, cwd, '/bin/true', []).args
const acc0 = (cfg: ReturnType<typeof rw>, cwd: string, p: string) => sandboxPathAccess(cfg as never, cwd, p)
// The LAST bind whose dest is exactly p, as its flag — bwrap's last-wins at an equal path.
const bindAt = (args: Args, p: string): string | null => {
  let flag: string | null = null
  for (let i = 0; i < args.length - 2; i++) if ((args[i] === '--bind' || args[i] === '--ro-bind') && args[i + 2] === p) flag = args[i]
  return flag
}

// ── 1. plain repo, mounted rw as cwd ─────────────────────────────────────────────────────
const R = mkRepo(path.join(TMP, 'repo'))
fs.rmSync(path.join(R, '.git', 'hooks'), { recursive: true, force: true })   // absent at launch
let a = argvOf(rw(R), R)
check('1a .git/config ro-bound', bindAt(a, path.join(R, '.git/config')) === '--ro-bind')
check('1b absent hooks/ was CREATED, then ro-bound', fs.existsSync(path.join(R, '.git/hooks')) && bindAt(a, path.join(R, '.git/hooks')) === '--ro-bind')
check('1c .git self-bound rw (rename guard)', bindAt(a, path.join(R, '.git')) === '--bind')
check('1d commondir materialized as "./" (libgit2-safe) and ro-bound',
  fs.existsSync(path.join(R, '.git/commondir')) && fs.readFileSync(path.join(R, '.git/commondir'), 'utf8') === './\n' && bindAt(a, path.join(R, '.git/commondir')) === '--ro-bind')
check('1e git still works on the host with commondir="./"', git(R, 'status', '--porcelain') === '' && git(R, 'rev-parse', '--abbrev-ref', 'HEAD').trim() === 'main')
check('1f self-bind is emitted BEFORE the ro overlays inside it', a.lastIndexOf(path.join(R, '.git')) < a.lastIndexOf(path.join(R, '.git/config')))

// idempotent: a second launch neither rewrites it nor refuses
const mtime = fs.statSync(path.join(R, '.git/commondir')).mtimeMs
let relaunch = true
try { argvOf(rw(R), R) } catch { relaunch = false }
check('1k second launch: no refusal, commondir untouched', relaunch && fs.statSync(path.join(R, '.git/commondir')).mtimeMs === mtime)
// a legacy "." (from before the "./" switch) is ours too: accepted, never rewritten
const LEG = mkRepo(path.join(TMP, 'legacy')); fs.writeFileSync(path.join(LEG, '.git/commondir'), '.\n')
let legOk = true
try { argvOf(rw(LEG), LEG) } catch { legOk = false }
check('1l legacy "." commondir accepted and left as-is', legOk && fs.readFileSync(path.join(LEG, '.git/commondir'), 'utf8') === '.\n')
// a commondir in a MAIN gitdir pointing ELSEWHERE is the attack: launch refuses, file untouched
const EVIL = mkRepo(path.join(TMP, 'evil-target'))
const VIC = mkRepo(path.join(TMP, 'victim'))
fs.writeFileSync(path.join(VIC, '.git/commondir'), `${path.join(EVIL, '.git')}\n`)
let refusal = ''
try { argvOf(rw(VIC), VIC) } catch (e) { refusal = (e as Error).message }
check('1m planted commondir in a main gitdir → launch REFUSED, naming the file and its target',
  refusal.includes('refusing to launch') && refusal.includes(path.join(VIC, '.git/commondir')) && refusal.includes(path.join(EVIL, '.git')), refusal)
check('1n …and the planted file is NOT overwritten', fs.readFileSync(path.join(VIC, '.git/commondir'), 'utf8') === `${path.join(EVIL, '.git')}\n`)
let authzOk = true
try { acc0(rw(VIC), VIC, path.join(VIC, 'a.txt')) } catch { authzOk = false }
check('1o the authorizer path does not throw on it (it only pins)', authzOk)

// authorizer agrees with the box
const acc = (cfg: ReturnType<typeof rw>, cwd: string, p: string) => sandboxPathAccess(cfg as never, cwd, p)
check('1g authorizer: .git/config not writable', acc(rw(R), R, path.join(R, '.git/config')).write === false)
check('1h authorizer: a new hook not writable', acc(rw(R), R, path.join(R, '.git/hooks/pre-commit')).write === false)
check('1i authorizer: .git/commondir not writable', acc(rw(R), R, path.join(R, '.git/commondir')).write === false)
check('1j authorizer: work tree + objects still writable',
  acc(rw(R), R, path.join(R, 'a.txt')).write === true && acc(rw(R), R, path.join(R, '.git/objects/x')).write === true)

// ── 2. ro mount: a self-bind must never WIDEN to rw ─────────────────────────────────────
const RO = mkRepo(path.join(TMP, 'ro-repo'))
a = argvOf({ enabled: true, gpu: false, mounts: [{ path: RO, mode: 'ro' }] } as never, RO)
check('2a ro-mounted repo: no rw bind of its .git', bindAt(a, path.join(RO, '.git')) !== '--bind')
check('2b ro-mounted repo: nothing materialized', !fs.existsSync(path.join(RO, '.git/commondir')))
// …and an ro repo NESTED in a rw parent: the gitdir is inside a rw mount by path, but the box
// cannot write it — a self-bind there would turn it writable.
const RWP = path.join(TMP, 'rwparent'); const ROIN = mkRepo(path.join(RWP, 'inner'))
a = argvOf({ enabled: true, gpu: false, mounts: [{ path: RWP, mode: 'rw' }, { path: ROIN, mode: 'ro' }] } as never, RWP)
check('2c ro repo inside a rw parent: its .git is NOT bound rw', bindAt(a, path.join(ROIN, '.git')) !== '--bind', String(bindAt(a, path.join(ROIN, '.git'))))

// ── 3. a box-written .git POINTER aimed outside every mount steers no host write ────────
const OUT = path.join(TMP, 'outside-gitdir'); fs.mkdirSync(OUT)
fs.writeFileSync(path.join(OUT, 'HEAD'), 'ref: refs/heads/main\n')
const P = path.join(TMP, 'proj'); fs.mkdirSync(P)
fs.writeFileSync(path.join(P, '.git'), `gitdir: ${OUT}\n`)
argvOf(rw(P), P)
check('3a no hooks/ created outside the box', !fs.existsSync(path.join(OUT, 'hooks')))
check('3b no commondir created outside the box', !fs.existsSync(path.join(OUT, 'commondir')))
check('3c the pointer file itself is ro-bound', bindAt(argvOf(rw(P), P), path.join(P, '.git')) === '--ro-bind')

// ── 4. linked worktree: rw worktree + rw common dir, main tree NOT mounted ──────────────
const W = path.join(TMP, 'wt')
git(R, 'worktree', 'add', '-q', W, '-b', 'feat')
const C = path.join(R, '.git')
a = argvOf(rw(W, C), W)
check('4a worktree .git pointer ro', bindAt(a, path.join(W, '.git')) === '--ro-bind')
check('4b common config + hooks ro', bindAt(a, path.join(C, 'config')) === '--ro-bind' && bindAt(a, path.join(C, 'hooks')) === '--ro-bind')
check('4c worktrees/<n>/commondir ro', bindAt(a, path.join(C, 'worktrees/wt/commondir')) === '--ro-bind')
check('4d main work tree never bound', bindAt(a, R) === null && acc(rw(W, C), W, path.join(R, 'a.txt')).write === false)
check('4e authorizer: worktree pointer + common config not writable',
  acc(rw(W, C), W, path.join(W, '.git')).write === false && acc(rw(W, C), W, path.join(C, 'config')).write === false)

// a worktree too deep for the scan is still found through worktrees/<n>/gitdir
const DEEP = path.join(R, 'x', 'y', 'z', 'deepwt')
git(R, 'worktree', 'add', '-q', DEEP, '-b', 'deep')
a = argvOf(rw(R), R)
check('4f a worktree below scan depth: its .git pointer still ro (via worktrees/<n>/gitdir)', bindAt(a, path.join(DEEP, '.git')) === '--ro-bind')
git(R, 'worktree', 'remove', '--force', DEEP)

// ── 5. core.hooksPath + include.path inside the work tree ───────────────────────────────
const H = mkRepo(path.join(TMP, 'husky'))
git(H, 'config', 'core.hooksPath', '.githooks')
fs.writeFileSync(path.join(H, 'extra.cfg'), '')
git(H, 'config', 'include.path', '../extra.cfg')
a = argvOf(rw(H), H)
check('5a core.hooksPath dir created + ro', fs.existsSync(path.join(H, '.githooks')) && bindAt(a, path.join(H, '.githooks')) === '--ro-bind')
check('5b include.path target ro', bindAt(a, path.join(H, 'extra.cfg')) === '--ro-bind')

// ── 6. submodule + a repo two levels below the mount ────────────────────────────────────
const SUBSRC = mkRepo(path.join(TMP, 'subsrc'))
const T = path.join(TMP, 'tree'); const N = mkRepo(path.join(T, 'a', 'nested'))
git(N, 'submodule', 'add', '-q', SUBSRC, 'lib')
a = argvOf(rw(T), T)
check('6a nested repo found below the mount: config ro', bindAt(a, path.join(N, '.git/config')) === '--ro-bind')
check('6b submodule gitdir config + hooks ro',
  bindAt(a, path.join(N, '.git/modules/lib/config')) === '--ro-bind' && bindAt(a, path.join(N, '.git/modules/lib/hooks')) === '--ro-bind')
check('6c submodule .git pointer ro', bindAt(a, path.join(N, 'lib/.git')) === '--ro-bind')
check('6e nested work-tree top self-bound (rename guard)', bindAt(a, N) === '--bind')
// a DEINITED submodule has no work tree to find, but its gitdir (and config) live on
git(N, 'submodule', 'deinit', '-q', '-f', 'lib')
a = argvOf(rw(T), T)
check('6d deinited submodule: modules/lib/config still ro', bindAt(a, path.join(N, '.git/modules/lib/config')) === '--ro-bind')

// ── 7. LIVE: the attacks, inside a real box ─────────────────────────────────────────────
if (!sandboxAvailable()) {
  console.log('⚠ bwrap unavailable here — live section SKIPPED (argv + authorizer only)')
} else {
  const L = mkRepo(path.join(TMP, 'live'))
  const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const script = [
    'cd "$1"',
    'echo x >> .git/config 2>/dev/null && echo CONFIG_WRITTEN',
    'echo "#!/bin/sh" > .git/hooks/pre-commit 2>/dev/null && echo HOOK_WRITTEN',
    'mv .git .gitx 2>/dev/null && echo GITDIR_RENAMED',
    'echo /evil > .git/commondir 2>/dev/null && echo COMMONDIR_WRITTEN',
    `${gitBin} config core.fsmonitor "touch /pwn" 2>/dev/null && echo GIT_CONFIG_SET`,
    'echo b > b.txt',
    `${gitBin} -c user.name=t -c user.email=t@t add b.txt && ${gitBin} -c user.name=t -c user.email=t@t commit -qm two && echo COMMIT_OK`,
  ].join('\n')
  const spec = wrapCommand(rw(L) as never, L, '/bin/sh', ['-c', script, 'sh', L])
  const r = spawnSync(spec.command, spec.args, { encoding: 'utf8', timeout: 20_000 })
  const out = r.stdout + r.stderr
  check('7a box cannot write .git/config', !out.includes('CONFIG_WRITTEN'), out.trim())
  check('7b box cannot plant a hook', !out.includes('HOOK_WRITTEN'))
  check('7c box cannot rename .git away', !out.includes('GITDIR_RENAMED'))
  check('7d box cannot redirect commondir', !out.includes('COMMONDIR_WRITTEN'))
  check('7e `git config` from the box fails', !out.includes('GIT_CONFIG_SET'))
  check('7f ordinary commits still work in the box', out.includes('COMMIT_OK'), out.trim())
  check('7h no stray mountpoint left on the host for an ABSENT pin', !fs.existsSync(path.join(L, '.git/config.worktree')))
  check('7g host config untouched', !fs.readFileSync(path.join(L, '.git/config'), 'utf8').includes('fsmonitor'))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
