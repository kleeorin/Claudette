// Background-process registry PERSISTENCE across a server restart — saved() → restore().
//
// ★ THE GAP THIS CLOSES. `SavedSession.bashProcs` was declared in shared/src/types.ts from the
// day the registry landed, and was written by NOTHING: saved() serialised `tasks` and not
// `bashProcs`, restore() rehydrated `tasks` and never looked at `s.bashProcs`. So the field
// existed while the behaviour did not, and every background-process row vanished on restart —
// a user who backgrounded a build and restarted the server lost the record of it silently.
// A declared-but-unwritten field is the worst version of this: it reads as done.
//
// ★★ THE ASSERTION THAT MATTERS MOST: running → 'unknown', NEVER 'failed'.
// The `tasks` block it sits beside settles running agents to 'failed', and copying that would
// be the obvious-looking consistency. It is wrong here. An agent that died with its engine
// genuinely failed — it owed a result and never produced one. A shell did not: `npm test` may
// have passed thirty seconds before the restart. 'failed' asserts something false about the
// user's own build; 'unknown' says the only true thing. The negative assertion below is the
// one that catches a future "tidy-up" that makes the two blocks match.
//
// Asserts on the REGISTRY via bashProcsOf(newId) after restore — never on a return value.
// restore() returns ids, not records, so a round-trip that silently dropped the registry would
// return a perfectly good-looking array.
//
// MUTATIONS (measured 2026-10-01 against a COPY of server/, never the live file; ran=N is
// reported because a mutant that fails to PARSE yields zero failures exactly like a clean
// pass). All six at ran=16 — constant, which is what shows none crashed rather than failing:
//   P1  saved() stops emitting bashProcs (the gap's WRITE half)   → red=3, all three
//       round-trip cases. Nothing else sees it, because every other case hands restore() a
//       hand-built array — which is exactly why the round-trip cases had to exist.
//   P2  restore() stops rehydrating (the gap's READ half)         → red=12, i.e. everything
//       except the no-registry case and the two negative assertions. That breadth is the
//       honest shape of the original bug: the field was declared and nothing read it.
//   P3  running settles to 'failed', copying the tasks block      → red=3, including the
//       ★★ negative assertion written for precisely this "tidy-up".
//   P4  EVERY record blanked to unknown, not just running ones    → red=3, all three
//       already-settled controls. Without them, P3 could be "fixed" by blanking everything.
//   P5  endedAt left unset on the settled record                  → red=1, alone.
//   XX  a patch matching no text must REFUSE — it did, 0 matches, no run performed.
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { check, passed as pass, failed as fail } from './assert.mjs'
import type { BashProcRecord } from '../shared/src/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.CLAUDETTE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claudette-bpersist-data-'))
const work = mkdtempSync(path.join(tmpdir(), 'claudette-bpersist-cwd-'))

// Shim BEFORE importing SessionManager — restore() LAUNCHES every session it restores, and
// launch spawns the literal command `claude`. Shim + stub live in `work` because that is the
// session cwd and so the only directory the default sandbox mounts.
copyFileSync(path.join(here, 'fake-claude-team.mjs'), path.join(work, 'fake-claude.mjs'))
const shim = path.join(work, 'claude')
writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(path.join(work, 'fake-claude.mjs'))} "$@"\n`)
chmodSync(shim, 0o755)
process.env.PATH = `${work}${path.delimiter}${process.env.PATH ?? ''}`
process.env.FAKE_TURN_MS = '20'

const { SessionManager } = await import('../server/src/claude/sessionManager.js')
const sessions = new SessionManager({})

const rec = (over: Partial<BashProcRecord>): BashProcRecord => ({
  toolId: 'toolu_x', command: 'npm test', startedAt: 1_000, status: 'running', ...over,
})

try {
  const ids = sessions.restore([
    { name: 'withProcs', cwd: work, bashProcs: [
      rec({ toolId: 'running-1', command: 'npm run build', status: 'running' }),
      rec({ toolId: 'done-1', command: 'npm test', status: 'done', endedAt: 2_000, exitCode: 0, summary: 'ok' }),
      rec({ toolId: 'failed-1', status: 'failed', endedAt: 2_000, exitCode: 1 }),
      rec({ toolId: 'stopped-1', status: 'stopped', endedAt: 2_000 }),
    ] },
    { name: 'noProcs', cwd: work },
  ])
  const procsOf = (i: number) => sessions.bashProcsOf(ids[i])
  const byId = (i: number, toolId: string) => procsOf(i).find((r) => r.toolId === toolId)

  check('restore() produced both sessions', ids.length === 2, `got ${ids.length}`)
  check('a persisted registry is rehydrated at all', procsOf(0).length === 4, `got ${procsOf(0).length}`)

  // ── THE RESTART-DISCIPLINE ASSERTIONS ────────────────────────────────────────────────────
  const r = byId(0, 'running-1')
  check("★ a persisted 'running' record comes back 'unknown'", r?.status === 'unknown', String(r?.status))
  check('★★ …and NOT "failed" — the outcome is unknowable, not known-bad',
    r?.status !== 'failed', String(r?.status))
  check('…with endedAt set, so elapsed stops counting', typeof r?.endedAt === 'number', String(r?.endedAt))
  check('…and a summary explaining why', !!r?.summary && r.summary.length > 0, String(r?.summary))

  // ── THE CONTROLS: already-settled records restore UNCHANGED ──────────────────────────────
  // Without these, a fix that blanked every status to 'unknown' would pass everything above.
  const d = byId(0, 'done-1')
  check("a persisted 'done' record restores unchanged", d?.status === 'done', String(d?.status))
  check('…keeping its exitCode', d?.exitCode === 0, String(d?.exitCode))
  check('…and its summary', d?.summary === 'ok', String(d?.summary))
  check("a persisted 'failed' record stays 'failed'", byId(0, 'failed-1')?.status === 'failed', String(byId(0, 'failed-1')?.status))
  check("a persisted 'stopped' record stays 'stopped'", byId(0, 'stopped-1')?.status === 'stopped', String(byId(0, 'stopped-1')?.status))

  // ── A SESSION WITH NO REGISTRY ───────────────────────────────────────────────────────────
  check('a session persisted with no bashProcs restores with an empty registry, no crash',
    procsOf(1).length === 0, `got ${procsOf(1).length}`)

  // ── THE ROUND TRIP: saved() must WRITE what restore() reads ──────────────────────────────
  // ★ This is the half the gap actually was. restore() reading s.bashProcs is useless if
  // saved() never emits it, and every assertion above would still pass — they feed restore()
  // a hand-built array. Only this case exercises saved().
  const dumped = sessions.saved()
  const withProcs = dumped.find((x) => x.name === 'withProcs')
  check('★ saved() EMITS the registry it just restored', (withProcs?.bashProcs?.length ?? 0) === 4,
    String(withProcs?.bashProcs?.length))
  check('…and omits it entirely for a session that has none',
    dumped.find((x) => x.name === 'noProcs')?.bashProcs === undefined,
    JSON.stringify(dumped.find((x) => x.name === 'noProcs')?.bashProcs))

  const ids2 = sessions.restore(dumped)
  const round = sessions.bashProcsOf(ids2[dumped.findIndex((x) => x.name === 'withProcs')])
  check('★ a full saved()→restore() round trip keeps every toolId',
    ['running-1', 'done-1', 'failed-1', 'stopped-1'].every((t) => round.some((x) => x.toolId === t)),
    round.map((x) => x.toolId).join(','))
  check('…and the once-running record stays settled rather than flipping again',
    round.find((x) => x.toolId === 'running-1')?.status === 'unknown',
    String(round.find((x) => x.toolId === 'running-1')?.status))
} finally {
  sessions.shutdown()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
