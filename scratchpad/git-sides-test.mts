// gitManager.sides() + GET /api/git/sides against throwaway repos.
//
// No browser, no live server: the route is exercised through a bare Fastify with only
// registerGitRoutes mounted (app.inject, no port). Every repo lives under os.tmpdir().
//
// Paths are fed in exactly as `git status --porcelain=v1 -z` hands them out — the shape
// the Git panel passes back — including from a SUBDIRECTORY cwd, where porcelain paths
// are still repo-root-relative.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import Fastify from 'fastify'
import { check, failed } from './assert.mjs'

const { sides, status, diff, stage, unstage } = await import('../server/src/git/gitManager')
const { registerGitRoutes } = await import('../server/src/git/gitApi')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sides-'))
const g = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' })
const w = (dir: string, f: string, c: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
  fs.writeFileSync(path.join(dir, f), c)
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`)

// --- repo with history -------------------------------------------------------
const repo = path.join(tmp, 'r')
fs.mkdirSync(repo)
g(repo, 'init', '-q')
w(repo, 'mod.txt', 'base\n')
w(repo, 'staged.txt', 'base\n')
w(repo, 'both.txt', 'head\n')
w(repo, 'gone.txt', 'gone\n')
w(repo, 'rmcached.txt', 'rm\n')
w(repo, 'old-name.txt', 'renamed body\n')
w(repo, 'sub/deep.txt', 'deep base\n')
w(repo, 'bin.dat', Buffer.from([1, 2, 0, 3]))
w(repo, 'big.txt', 'x')
g(repo, 'add', '.')
g(repo, 'commit', '-qm', 'init')

w(repo, 'mod.txt', 'base\nworktree\n')
w(repo, 'staged.txt', 'base\nindex\n'); g(repo, 'add', 'staged.txt')
w(repo, 'both.txt', 'index\n'); g(repo, 'add', 'both.txt'); w(repo, 'both.txt', 'worktree\n')
fs.unlinkSync(path.join(repo, 'gone.txt'))
g(repo, 'rm', '-q', '--cached', 'rmcached.txt')
g(repo, 'mv', 'old-name.txt', 'new-name.txt')
w(repo, 'sub/deep.txt', 'deep base\nchanged\n')
w(repo, 'bin.dat', Buffer.from([1, 2, 0, 4]))
w(repo, 'big.txt', 'x'.repeat(5 * 1024 * 1024 + 1))
w(repo, 'new.txt', 'brand new\n')

// Status entries as the panel sees them (from a subdirectory cwd, on purpose).
const st = await status(path.join(repo, 'sub'))
if (st.repo !== true) throw new Error('status failed: ' + JSON.stringify(st))
const byPath = new Map(st.files.map((f) => [f.path, f]))
check('porcelain paths are root-relative even from sub/', byPath.has('sub/deep.txt'), [...byPath.keys()].join(','))
const ren = byPath.get('new-name.txt')
eq('rename entry carries orig', ren?.orig, 'old-name.txt')

for (const cwd of [repo, path.join(repo, 'sub')]) {
  const at = cwd === repo ? 'root' : 'sub/'
  eq(`[${at}] unstaged modified`, await sides(cwd, 'mod.txt', false, false), { ok: true, original: 'base\n', modified: 'base\nworktree\n' })
  eq(`[${at}] staged modified`, await sides(cwd, 'staged.txt', true, false), { ok: true, original: 'base\n', modified: 'base\nindex\n' })
  eq(`[${at}] both: staged side HEAD→index`, await sides(cwd, 'both.txt', true, false), { ok: true, original: 'head\n', modified: 'index\n' })
  eq(`[${at}] both: unstaged side index→worktree`, await sides(cwd, 'both.txt', false, false), { ok: true, original: 'index\n', modified: 'worktree\n' })
  eq(`[${at}] deleted from worktree`, await sides(cwd, 'gone.txt', false, false), { ok: true, original: 'gone\n', modified: '' })
  eq(`[${at}] deleted from index (staged)`, await sides(cwd, 'rmcached.txt', true, false), { ok: true, original: 'rm\n', modified: '' })
  eq(`[${at}] untracked`, await sides(cwd, 'new.txt', false, true), { ok: true, original: '', modified: 'brand new\n' })
  eq(`[${at}] nested file by root-relative path`, await sides(cwd, 'sub/deep.txt', false, false), { ok: true, original: 'deep base\n', modified: 'deep base\nchanged\n' })
  eq(`[${at}] staged rename uses orig for HEAD side`, await sides(cwd, 'new-name.txt', true, false, 'old-name.txt'), { ok: true, original: 'renamed body\n', modified: 'renamed body\n' })
  eq(`[${at}] staged rename without orig → original ''`, await sides(cwd, 'new-name.txt', true, false), { ok: true, original: '', modified: 'renamed body\n' })
  eq(`[${at}] binary`, await sides(cwd, 'bin.dat', false, false), { ok: true, original: '', modified: '', binary: true })
  eq(`[${at}] > 5 MB`, await sides(cwd, 'big.txt', false, false), { ok: false, error: 'file too large for diff view' })
}

const out = await sides(repo, '../escape.txt', false, true)
check('path traversal refused', !out.ok && /outside/.test(out.error), JSON.stringify(out))
const nr = await sides(tmp, 'x', false, false)
check('non-repo → ok:false', !nr.ok, JSON.stringify(nr))

// --- fresh repo, no HEAD -----------------------------------------------------
const fresh = path.join(tmp, 'fresh')
fs.mkdirSync(fresh)
g(fresh, 'init', '-q')
w(fresh, 'first.txt', 'first\n'); g(fresh, 'add', 'first.txt'); w(fresh, 'first.txt', 'first\nmore\n')
eq('no HEAD: staged new file', await sides(fresh, 'first.txt', true, false), { ok: true, original: '', modified: 'first\n' })
eq('no HEAD: unstaged side of it', await sides(fresh, 'first.txt', false, false), { ok: true, original: 'first\n', modified: 'first\nmore\n' })

// --- diff / stage / unstage take the same root-relative status paths ---------
// Control first: the raw cwd-relative form really is empty from sub/ — so the [sub/]
// cases below are testing something, not passing vacuously.
const d = path.join(tmp, 'd')
fs.mkdirSync(d)
g(d, 'init', '-q')
w(d, 'sub/a.txt', 'a\n'); w(d, 'sub/s.txt', 's\n'); w(d, 'top.txt', 't\n')
g(d, 'add', '.'); g(d, 'commit', '-qm', 'init')
w(d, 'sub/a.txt', 'a\nunstaged-line\n')
w(d, 'top.txt', 't\nstaged-line\n'); g(d, 'add', 'top.txt')
w(d, 'sub/u.txt', 'untracked-line\n')
w(d, 'sub/s.txt', 's\nto-stage\n')
const dsub = path.join(d, 'sub')
eq('control: cwd-relative `git -C sub diff -- sub/a.txt` is empty', g(dsub, 'diff', '--', 'sub/a.txt'), '')

const cached = () => g(d, 'diff', '--cached', '--name-only').split('\n').filter(Boolean)
for (const cwd of [d, dsub]) {
  const at = cwd === d ? 'root' : 'sub/'
  const du = await diff(cwd, 'sub/a.txt', false, false)
  check(`[${at}] diff unstaged names file + line`, du.ok && du.diff.includes('b/sub/a.txt') && du.diff.includes('+unstaged-line'), JSON.stringify(du).slice(0, 160))
  const ds = await diff(cwd, 'top.txt', true, false)
  check(`[${at}] diff staged names file + line`, ds.ok && ds.diff.includes('b/top.txt') && ds.diff.includes('+staged-line'), JSON.stringify(ds).slice(0, 160))
  const dn = await diff(cwd, 'sub/u.txt', false, true)
  check(`[${at}] diff untracked names file + line`, dn.ok && dn.diff.includes('b/sub/u.txt') && dn.diff.includes('+untracked-line'), JSON.stringify(dn).slice(0, 160))

  const s1 = await stage(cwd, 'sub/s.txt')
  check(`[${at}] stage ok and sub/s.txt now cached`, s1.ok && cached().includes('sub/s.txt'), JSON.stringify(s1) + ' cached=' + cached().join(','))
  const s2 = await unstage(cwd, 'sub/s.txt')
  check(`[${at}] unstage ok and sub/s.txt no longer cached`, s2.ok && !cached().includes('sub/s.txt'), JSON.stringify(s2) + ' cached=' + cached().join(','))
}

// --- the route ---------------------------------------------------------------
const app = Fastify()
registerGitRoutes(app)
const q = (o: Record<string, string>) => '/api/git/sides?' + new URLSearchParams(o).toString()
const r1 = await app.inject({ method: 'GET', url: q({ cwd: path.join(repo, 'sub'), file: 'staged.txt', staged: '1', untracked: '0' }) })
eq('route: staged', r1.json(), { ok: true, original: 'base\n', modified: 'base\nindex\n' })
const r2 = await app.inject({ method: 'GET', url: q({ cwd: repo, file: 'new-name.txt', orig: 'old-name.txt', staged: '1' }) })
eq('route: rename with orig', r2.json(), { ok: true, original: 'renamed body\n', modified: 'renamed body\n' })
const r3 = await app.inject({ method: 'GET', url: q({ cwd: repo, file: 'new.txt', untracked: '1' }) })
eq('route: untracked', r3.json(), { ok: true, original: '', modified: 'brand new\n' })
const r4 = await app.inject({ method: 'GET', url: q({ cwd: repo }) })
eq('route: missing file', r4.json(), { ok: false, error: 'cwd and file are required' })
await app.close()

fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
