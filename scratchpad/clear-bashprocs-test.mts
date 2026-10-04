// session:clearBashProcs — clearing settled background-process rows from the SERVER's registry.
//
// ★ WHY THIS REPLACED A CLIENT-SIDE STORE. The panel used to hide cleared rows in browser
// localStorage (`web/src/store/bashProcDismiss.ts`, now deleted). That made a clear
// PER-DEVICE: a row cleared on the desktop still showed on the phone. This product treats the
// phone as first-class, so a per-device clear is a half-built control. The record is now
// removed server-side and every device repaints from the same `session:bashProcs` broadcast.
//
// ★★ THE ASSERTION THAT MATTERS MOST: A RUNNING RECORD IS NEVER REMOVED, WHATEVER IS ASKED.
// Hiding a live process is the worst outcome this panel has — the row is the only handle the
// user has on it, and the panel exists so a backgrounded command cannot get lost. The UI only
// offers the control for settled rows, so an id naming a running one arrives from a race or a
// second client. Neither is a reason to honour it. A fix that simply deleted every requested
// id would pass the two easy cases below and fail only this one.
//
// ON THE SETUP REACHING IN: the registry is populated through a cast, because the only public
// way to create a record is to drive a real CLI turn that backgrounds a shell. The ASSERTIONS
// all read `bashProcsOf()`, the same public accessor the broadcast and the API use, so what is
// pinned is observable behaviour; only the fixture is privileged.
//
// MUTATIONS (measured 2026-09-30; ran=N alongside, since a mutant that fails to PARSE yields
// zero failures exactly like a clean pass):
// All four measured at ran=13 — constant, which is what shows none died on a parse error.
// Red sets are AS MEASURED; three contradict what I predicted, and the measurements are kept:
//   C1  the running refusal dropped → red=5, not 1. Every running-row assertion AND the
//       no-op-broadcast case, because once a running row is removable the "removed nothing"
//       request removes something and broadcasts. I predicted "alone".
//   C2  clear ignores the id list and empties the session → red=6, the widest blast radius,
//       which is right for the most destructive mutant.
//   C3  no broadcast on change → red=2 (the broadcast case and the list-contents case), not 1.
//   C4  broadcasts when nothing was removed → red=1, alone. Predicted correctly.
//   XX  a patch matching no text must REFUSE — it did, 0 matches, no run performed.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { check, passed as pass, failed as fail } from './assert.mjs'
import type { BashProcRecord } from '../shared/src/index.js'

process.env.CLAUDETTE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claudette-clearbp-'))
const { SessionManager } = await import('../server/src/claude/sessionManager.js')

const sessions = new SessionManager({})
const SID = 'sess-1'

const rec = (toolId: string, status: BashProcRecord['status']): BashProcRecord => ({
  toolId, command: `cmd ${toolId}`, startedAt: 1_000, status,
  ...(status === 'running' ? {} : { endedAt: 2_000 }),
})

// Setup only — see the note above. The assertions use the public accessor.
function seed(records: BashProcRecord[]): void {
  const m = new Map(records.map((r) => [r.toolId, r]))
  ;(sessions as unknown as { bashProcs: Map<string, Map<string, BashProcRecord>> }).bashProcs.set(SID, m)
}
const idsNow = () => sessions.bashProcsOf(SID).map((r) => r.toolId).sort()

try {
  // ── A SETTLED ROW IS REMOVED ─────────────────────────────────────────────────────────────
  seed([rec('done-1', 'done'), rec('fail-1', 'failed'), rec('run-1', 'running')])
  check('the fixture is in place before anything is cleared',
    idsNow().join(',') === 'done-1,fail-1,run-1', idsNow().join(','))

  let r = sessions.clearBashProcs(SID, ['done-1'])
  check('clearing a settled row removes it', !idsNow().includes('done-1'), idsNow().join(','))
  check('…and reports it removed', r.removed === 1 && r.refused === 0, JSON.stringify(r))

  // ── ★★ A RUNNING ROW IS REFUSED AND LEFT IN PLACE ───────────────────────────────────────
  r = sessions.clearBashProcs(SID, ['run-1'])
  check('★★ clearing a RUNNING row does NOT remove it', idsNow().includes('run-1'), idsNow().join(','))
  check('…and is reported as refused, not removed', r.removed === 0 && r.refused === 1, JSON.stringify(r))

  // A mixed request must clear what it may and leave what it may not — the realistic shape of
  // "Clear finished" racing a relaunch.
  seed([rec('done-2', 'done'), rec('run-2', 'running'), rec('unknown-2', 'unknown')])
  r = sessions.clearBashProcs(SID, ['done-2', 'run-2', 'unknown-2'])
  check('a mixed request clears the settled rows and keeps the running one',
    idsNow().join(',') === 'run-2', idsNow().join(','))
  check('…reporting 2 removed and 1 refused', r.removed === 2 && r.refused === 1, JSON.stringify(r))

  // ── AN UNKNOWN ID IS HARMLESS ───────────────────────────────────────────────────────────
  seed([rec('done-3', 'done')])
  r = sessions.clearBashProcs(SID, ['no-such-id'])
  check('an unknown id removes nothing and refuses nothing', r.removed === 0 && r.refused === 0, JSON.stringify(r))
  check('…and leaves the registry untouched', idsNow().join(',') === 'done-3', idsNow().join(','))
  check('clearing an unknown SESSION is harmless',
    JSON.stringify(sessions.clearBashProcs('no-such-session', ['x'])) === '{"removed":0,"refused":0}',
    JSON.stringify(sessions.clearBashProcs('no-such-session', ['x'])))

  // ── THE BROADCAST, which is what makes the clear cross-device ───────────────────────────
  // Without it the record is gone server-side and every already-connected client keeps showing
  // it until something else happens to repaint — i.e. the bug this replaced, inverted.
  seed([rec('done-4', 'done'), rec('run-4', 'running')])
  let broadcasts = 0
  let lastIds: string[] = []
  const onBroadcast = (id: string, procs: BashProcRecord[]) => { if (id === SID) { broadcasts++; lastIds = procs.map((p) => p.toolId) } }
  sessions.on('bashProcs', onBroadcast)

  sessions.clearBashProcs(SID, ['done-4'])
  check('★ a removal BROADCASTS the new list', broadcasts === 1, String(broadcasts))
  check('…carrying the list WITHOUT the cleared row', lastIds.join(',') === 'run-4', lastIds.join(','))

  // A request that removed nothing must not broadcast: a client repainting an unchanged list
  // is noise, and on a refusal it would redraw the very row the user just tried to clear.
  const before = broadcasts
  sessions.clearBashProcs(SID, ['run-4', 'no-such-id'])
  check('★ a request that removed NOTHING does not broadcast', broadcasts === before, `${before} → ${broadcasts}`)
  sessions.off('bashProcs', onBroadcast)
} finally {
  sessions.shutdown()
  rmSync(process.env.CLAUDETTE_DATA_DIR!, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
