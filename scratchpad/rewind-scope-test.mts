// /rewind's code restore must touch ONLY the files the rewinding session itself edited.
//
// It used to re-materialise the whole snapshot tree (`read-tree` + `checkout-index -a -f`)
// and, with deleteNewer, unlink every untracked file created since. So rewinding session A
// reverted session B's edits in the same repo and the operator's own, and deleted files
// nobody in A ever made. Now the restore set comes from A's own transcript (Edit / Write /
// MultiEdit / NotebookEdit, its subagents included, failed edits excluded), and the preview
// flags any file in that set another live session also edited after the target turn.
//
// Drives the REAL routes (/api/session/rewindPreview and /api/session/rewind) through Fastify
// inject, against a real git repo and synthetic transcripts in a temp CLAUDE_CONFIG_DIR. No
// engine, no CLI, nothing spawned. Because it goes through the routes, the same file runs
// unchanged against the pre-fix tree — which is how its RED was measured.
//   npx tsx scratchpad/rewind-scope-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { check, passed, failed } from './assert.mjs'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-scope-')))
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude')
const repo = path.join(TMP, 'repo')
const outside = path.join(TMP, 'outside.txt')

const { snapshot, saveRef } = await import('../server/src/git/shadowSnapshots')
const { projectDir } = await import('../server/src/claude/conversations')
const { SessionManager } = await import('../server/src/claude/sessionManager')
const { registerSessionRoutes } = await import('../server/src/session/sessionApi')
const Fastify = (await import('fastify')).default

const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
const put = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), body) }
const read = (rel: string) => { try { return fs.readFileSync(path.join(repo, rel), 'utf8') } catch { return null } }
const iso = (ms: number) => new Date(ms).toISOString()

// One transcript line per call, in the CLI's shapes.
const userTurn = (uuid: string, ts: number, text: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: iso(ts), cwd: repo, message: { role: 'user', content: text } })
const toolUse = (id: string, name: string, input: Record<string, unknown>, ts: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', uuid: `as-${id}`, timestamp: iso(ts), cwd: repo, ...extra, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const toolResult = (id: string, ts: number, isError = false) =>
  JSON.stringify({ type: 'user', uuid: `tr-${id}`, timestamp: iso(ts), cwd: repo, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'denied' : 'ok', ...(isError ? { is_error: true } : {}) }] } })
const writeTranscript = (claudeId: string, lines: string[]) => {
  fs.mkdirSync(projectDir(repo), { recursive: true })
  fs.writeFileSync(path.join(projectDir(repo), `${claudeId}.jsonl`), lines.join('\n') + '\n')
}

try {
  // --- the repo, committed, plus an ignored pre-existing file -------------------------
  fs.mkdirSync(repo, { recursive: true })
  git('init', '-q'); git('config', 'user.email', 't@t.test'); git('config', 'user.name', 'T')
  for (const f of ['a.txt', 'b.txt', 'shared.txt', 'manual.txt', 'failed.txt', 'roundtrip.txt']) put(f, `${f} v0\n`)
  put('.gitignore', '.env\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  put('.env', 'SECRET=pre-existing\n')   // ignored: never in any snapshot
  fs.writeFileSync(outside, 'outside\n')  // a file OUTSIDE the repo that A's transcript names
  const headBefore = git('rev-parse', 'HEAD').trim()

  // --- A's target turn: snapshot BEFORE it, keyed to its uuid -------------------------
  const T0 = Date.parse('2026-10-22T10:00:00Z')
  const T1 = T0 + 60_000            // A's target turn
  const commit = await snapshot(repo)
  if (!commit) throw new Error('snapshot failed')
  await saveRef(repo, 'A-T1', commit)

  // --- what happened after the snapshot -----------------------------------------------
  put('a.txt', 'a.txt edited by A\n')            // A
  put('new.txt', 'created by A\n')               // A (Write, new file)
  put('sub.txt', 'created by A\'s subagent\n')   // A's subagent
  put('shared.txt', 'edited by A then B\n')      // A, then B
  put('.env', 'SECRET=rewritten by A\n')         // A writes an IGNORED file
  put('b.txt', 'b.txt edited by B\n')            // B only
  put('manual.txt', 'operator edited by hand\n') // nobody's tool — the operator
  put('op-new.txt', 'operator created\n')        // operator, untracked, created since
  // failed.txt: A TRIED to edit it and the tool errored, so A changed nothing there — and the
  // OPERATOR then edited it by hand. Counting the failed edit as A's would revert their work.
  put('failed.txt', 'operator fixed it by hand\n')

  writeTranscript('claude-A', [
    userTurn('A-T0', T0, 'earlier turn'),
    toolUse('t0', 'Edit', { file_path: path.join(repo, 'b.txt'), old_string: 'x', new_string: 'y' }, T0 + 1000),   // BEFORE the target: not in the set
    toolResult('t0', T0 + 1100),
    userTurn('A-T1', T1, 'the turn we rewind to'),
    toolUse('t1', 'Edit', { file_path: path.join(repo, 'a.txt'), old_string: 'v0', new_string: 'edited' }, T1 + 1000),
    toolResult('t1', T1 + 1100),
    toolUse('t2', 'Write', { file_path: 'new.txt', content: 'created by A' }, T1 + 2000),   // RELATIVE path → line cwd
    toolResult('t2', T1 + 2100),
    toolUse('t3', 'Edit', { file_path: path.join(repo, 'shared.txt'), old_string: 'v0', new_string: 'A' }, T1 + 3000),
    toolResult('t3', T1 + 3100),
    toolUse('t4', 'Edit', { file_path: path.join(repo, 'failed.txt'), old_string: 'nope', new_string: 'x' }, T1 + 4000),
    toolResult('t4', T1 + 4100, /* isError */ true),
    toolUse('t5', 'Write', { file_path: path.join(repo, '.env'), content: 'x' }, T1 + 5000),
    toolResult('t5', T1 + 5100),
    toolUse('t6', 'Write', { file_path: outside, content: 'x' }, T1 + 6000),
    toolResult('t6', T1 + 6100),
    // Edited, then edited BACK: in the set, but already equal to the snapshot.
    toolUse('t7', 'Edit', { file_path: path.join(repo, 'roundtrip.txt'), old_string: 'v0', new_string: 'v0' }, T1 + 6500),
    toolResult('t7', T1 + 6600),
  ])
  // A's subagent: one edit after the target turn (in), one before it (out).
  const subDir = path.join(projectDir(repo), 'claude-A', 'subagents')
  fs.mkdirSync(subDir, { recursive: true })
  fs.writeFileSync(path.join(subDir, 'agent-1.jsonl'), [
    toolUse('s0', 'Edit', { file_path: path.join(repo, 'manual.txt'), old_string: 'v0', new_string: 'x' }, T0 + 5000, { isSidechain: true }),
    toolResult('s0', T0 + 5100),
    toolUse('s1', 'Write', { file_path: path.join(repo, 'sub.txt'), content: 'x' }, T1 + 7000, { isSidechain: true }),
    toolResult('s1', T1 + 7100),
  ].join('\n') + '\n')
  writeTranscript('claude-B', [
    userTurn('B-T0', T0, 'B early'),
    toolUse('b0', 'Edit', { file_path: path.join(repo, 'a.txt'), old_string: 'x', new_string: 'y' }, T0 + 2000),   // BEFORE A's turn: no conflict
    toolResult('b0', T0 + 2100),
    userTurn('B-T1', T1 + 10_000, 'B later'),
    toolUse('b1', 'Edit', { file_path: path.join(repo, 'b.txt'), old_string: 'v0', new_string: 'B' }, T1 + 11_000),
    toolResult('b1', T1 + 11_100),
    toolUse('b2', 'Edit', { file_path: path.join(repo, 'shared.txt'), old_string: 'A', new_string: 'B' }, T1 + 12_000),
    toolResult('b2', T1 + 12_100),
  ])

  // --- two live sessions in the same repo, no engines ---------------------------------
  const mgr = new SessionManager({})
  const reg = (mgr as unknown as { register: (...a: unknown[]) => { id: string } }).register.bind(mgr)
  const A = reg('Session A', repo, repo, undefined, false, 'claude-A')
  const B = reg('Session B', repo, repo, undefined, false, 'claude-B')
  const app = Fastify()
  registerSessionRoutes(app, mgr)
  await app.ready()

  const pv = await app.inject({ method: 'GET', url: `/api/session/rewindPreview?id=${A.id}&uuid=A-T1` })
  const preview = (JSON.parse(pv.body) as { preview: { reverted: string[]; deleted: string[]; skipped?: { path: string; reason: string }[]; conflicts?: { path: string; sessions: { id: string; name: string }[] }[] } | null }).preview
  const reverted = [...(preview?.reverted ?? [])].sort()
  const deleted = [...(preview?.deleted ?? [])].sort()
  check('1. preview: reverted is exactly A\'s own edited files (a.txt, shared.txt)',
    JSON.stringify(reverted) === '["a.txt","shared.txt"]', JSON.stringify(reverted))
  check('1b. preview: deleted is exactly what A and its subagent CREATED (new.txt, sub.txt)',
    JSON.stringify(deleted) === '["new.txt","sub.txt"]', JSON.stringify(deleted))
  check('1c. preview: B\'s file, the operator\'s files and the failed edit are in NEITHER list',
    !['b.txt', 'manual.txt', 'op-new.txt', 'failed.txt'].some((f) => reverted.includes(f) || deleted.includes(f)))
  // #1 already requires exactly [a.txt, shared.txt]; this names the reason roundtrip.txt is out.
  check('1d. preview: a file A edited that already matches the snapshot is not counted as reverted',
    !reverted.includes('roundtrip.txt'))
  const conflicts = preview?.conflicts ?? []
  check('2. preview: shared.txt is flagged as a CONFLICT with Session B, and nothing else is',
    conflicts.length === 1 && conflicts[0].path === 'shared.txt'
      && conflicts[0].sessions.length === 1 && conflicts[0].sessions[0].id === B.id && conflicts[0].sessions[0].name === 'Session B',
    JSON.stringify(conflicts))
  check('2b. …a.txt, which B edited only BEFORE the target turn, is NOT a conflict',
    !conflicts.some((c) => c.path === 'a.txt'))
  const skipped = preview?.skipped ?? []
  check('3. preview: the gitignored .env and the out-of-repo file are SKIPPED with a reason',
    skipped.some((s) => s.path === '.env' && /ignored/.test(s.reason))
      && skipped.some((s) => s.path === outside && /outside/.test(s.reason)),
    JSON.stringify(skipped))

  // --- restore WITHOUT deleteNewer ----------------------------------------------------
  {
    const r = await app.inject({ method: 'POST', url: '/api/session/rewind', payload: { id: A.id, uuid: 'A-T1', mode: 'code', deleteNewer: false } })
    const body = JSON.parse(r.body) as { ok: boolean; reverted?: number; deleted?: number; error?: string }
    check('4. restore (no deleteNewer) succeeds and reports 2 reverted, 0 deleted',
      body.ok && body.reverted === 2 && body.deleted === 0, r.body)
    check('4b. A\'s edits are reverted (a.txt, shared.txt back to v0)',
      read('a.txt') === 'a.txt v0\n' && read('shared.txt') === 'shared.txt v0\n', `a=${JSON.stringify(read('a.txt'))} shared=${JSON.stringify(read('shared.txt'))}`)
    check('4c. B\'s edit to ITS OWN file survives A\'s rewind', read('b.txt') === 'b.txt edited by B\n', JSON.stringify(read('b.txt')))
    check('4d. the operator\'s manual edit to an unrelated file survives', read('manual.txt') === 'operator edited by hand\n', JSON.stringify(read('manual.txt')))
    check('4d2. a file A only FAILED to edit keeps the operator\'s later hand edit', read('failed.txt') === 'operator fixed it by hand\n', JSON.stringify(read('failed.txt')))
    check('4e. a file A created STAYS without deleteNewer', read('new.txt') === 'created by A\n')
    check('4f. the ignored .env is left exactly as it is', read('.env') === 'SECRET=rewritten by A\n')
  }

  // --- restore WITH deleteNewer -------------------------------------------------------
  {
    const r = await app.inject({ method: 'POST', url: '/api/session/rewind', payload: { id: A.id, uuid: 'A-T1', mode: 'code', deleteNewer: true } })
    const body = JSON.parse(r.body) as { ok: boolean; reverted?: number; deleted?: number }
    check('5. restore with deleteNewer reports 2 deleted', body.ok && body.deleted === 2, r.body)
    check('5b. the files A and its subagent created are DELETED', read('new.txt') === null && read('sub.txt') === null)
    check('5c. an untracked file the OPERATOR created since is NOT deleted', read('op-new.txt') === 'operator created\n')
    check('5d. B\'s file and the operator\'s edit still survive', read('b.txt') === 'b.txt edited by B\n' && read('manual.txt') === 'operator edited by hand\n')
    check('5e. the ignored .env still exists (never deleted on a guess)', read('.env') !== null)
    check('5f. the out-of-repo file A wrote is untouched (it exists, content unchanged)',
      fs.existsSync(outside) && fs.readFileSync(outside, 'utf8') === 'outside\n')
  }

  // --- the real index / HEAD are untouched --------------------------------------------
  // The restore goes through a TEMP index: HEAD must not move, and nothing may be staged.
  let staged = ''
  try { execFileSync('git', ['-C', repo, 'diff', '--cached', '--quiet']) } catch { staged = git('diff', '--cached', '--name-only') }
  check('6. HEAD did not move and the real index has nothing staged',
    git('rev-parse', 'HEAD').trim() === headBefore && staged === '', `staged=${JSON.stringify(staged)}`)
  await app.close()
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
