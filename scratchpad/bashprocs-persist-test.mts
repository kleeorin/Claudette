// Background-process registry PERSISTENCE across a server restart — saved() → restore().
//
// ★ REWRITTEN 2026-11-12 FOR AUTO-REMOVAL. The registry now holds RUNNING shells only: a
// record is deleted the moment it settles (pruneBashProcs; see bashprocs-autoremove-test.mts
// for the live settle paths). Across a restart that means NOTHING comes back:
//   • a persisted 'running' record — its shell died with the old server — settles to
//     'unknown' on restore (never 'failed': the outcome is unknowable, not known-bad) and is
//     therefore removed;
//   • a persisted finished record (written by an older build that kept them) is not restored.
// The previous version of this file asserted the opposite (finished rows restore unchanged,
// round trips keep every toolId); those assertions encoded the old keep-50-finished policy.
//
// Asserts on the REGISTRY via bashProcsOf(newId) after restore — never on a return value.
// The old 'unknown, NOT failed' assertion is gone because the settled record is no longer
// observable after restore. The conversion in restore() still writes 'unknown'.
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

  check('restore() produced both sessions', ids.length === 2, `got ${ids.length}`)
  check("★ a persisted 'running' record does not come back (its shell died with the server)",
    !procsOf(0).some((r) => r.toolId === 'running-1'), procsOf(0).map((r) => r.toolId).join(','))
  check('★ persisted finished records (done/failed/stopped) are not restored',
    !procsOf(0).some((r) => ['done-1', 'failed-1', 'stopped-1'].includes(r.toolId)), procsOf(0).map((r) => r.toolId).join(','))
  check('…so the restored registry is empty', procsOf(0).length === 0, `got ${procsOf(0).length}`)
  check('a session persisted with no bashProcs restores with an empty registry, no crash',
    procsOf(1).length === 0, `got ${procsOf(1).length}`)

  // ── THE ROUND TRIP ───────────────────────────────────────────────────────────────────────
  const dumped = sessions.saved()
  check('saved() does not re-persist anything for the restored session',
    dumped.find((x) => x.name === 'withProcs')?.bashProcs === undefined,
    JSON.stringify(dumped.find((x) => x.name === 'withProcs')?.bashProcs))
  check('…nor for a session that never had any',
    dumped.find((x) => x.name === 'noProcs')?.bashProcs === undefined,
    JSON.stringify(dumped.find((x) => x.name === 'noProcs')?.bashProcs))

  // A RUNNING record in a live registry IS written (the only kind that still exists).
  ;(sessions as unknown as { bashProcs: Map<string, Map<string, BashProcRecord>> }).bashProcs
    .set(ids[1], new Map([['live-1', rec({ toolId: 'live-1', status: 'running' })]]))
  const live = sessions.saved().find((x) => x.name === 'noProcs')?.bashProcs
  check('saved() writes a running record', live?.length === 1 && live[0].toolId === 'live-1', JSON.stringify(live))
  const ids2 = sessions.restore(sessions.saved())
  check('…and a saved()→restore() round trip drops it (settled to unknown → removed)',
    ids2.every((i) => sessions.bashProcsOf(i).length === 0),
    ids2.map((i) => sessions.bashProcsOf(i).length).join(','))
} finally {
  sessions.shutdown()
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
