// Per-session MODEL: stored on request, applied on the user's NEXT TURN, forceable now.
//
// ★ WHY A THIRD POLICY EXISTS, since the obvious question is "why not just relaunch?".
// `--model` is a spawn argument (claudeEngine: `if (opts.model) a.push('--model', opts.model)`),
// read once, so a model change cannot be hot-swapped — it needs a relaunch, like sandbox and
// role. But the three want DIFFERENT timing:
//   · setAgent      → relaunchApply immediately. A role change alters tools and charter, so
//                     continuing to run on the old one is wrong.
//   · setSandbox    → scheduleApply, idle-debounced. Confinement is a safety boundary and
//                     must not wait on a user.
//   · setModel      → NEITHER. It changes nothing about what the session is ALLOWED to do, so
//                     killing a running turn — or discarding a just-finished one the user is
//                     still reading — is a worse trade than using the new model from the next
//                     message onward. Force is available for "apply now".
//
// ★★ THE ASSERTION THAT IS NOT THE OBVIOUS ONE. The easy test is "the model eventually
// applies". The one that pins the FEATURE is the NEGATIVE: setModel must NOT relaunch. If
// someone later "simplifies" setModel to call relaunchApply like its sibling, every
// application case here still passes — the model does get applied — and only the
// engine-identity assertion reds. That is the whole difference between this policy and
// setAgent's, and it is one line away from being lost.
//
// ⚠ EXPECTED RED UNTIL scratchpad/feat-model-dropdown.{shared,server}.patch LAND.
// `setModel`, `modelPending` and `applyModelForTurn` do not exist in the tree yet — server/src
// and shared/src were read-only to the session that wrote this. Measured RED here and GREEN
// against a copy with both patches applied, so it is known to FLIP rather than merely known
// to fail.
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { check, passed as pass, failed as fail } from './assert.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(path.join(tmpdir(), 'claudette-model-data-'))
const work = mkdtempSync(path.join(tmpdir(), 'claudette-model-cwd-'))
process.env.CLAUDETTE_DATA_DIR = dir

copyFileSync(path.join(here, 'fake-claude-team.mjs'), path.join(work, 'fake-claude.mjs'))
const shim = path.join(work, 'claude')
writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(path.join(work, 'fake-claude.mjs'))} "$@"\n`)
chmodSync(shim, 0o755)
process.env.PATH = `${work}${path.delimiter}${process.env.PATH ?? ''}`
process.env.FAKE_TURN_MS = '20'

const { SessionManager } = await import('../server/src/claude/sessionManager.js')
const sessions = new SessionManager({}) as unknown as {
  create: (...a: unknown[]) => string
  // ★ get() returns SessionInfo, NOT the internal Session — it has no `engine`. An earlier
  // draft of this file compared `get(id).engine` across a relaunch to prove one happened;
  // both sides were `undefined`, so the comparison asserted NOTHING and the headline negative
  // ("setModel does not relaunch") passed vacuously. Launches are counted off the 'ready'
  // event instead, which the manager emits once per successful launch.
  get: (id: string) => { model?: string } | undefined
  on: (ev: string, fn: (...a: unknown[]) => void) => void
  setModel: (id: string, m: string | undefined) => boolean
  modelPending: (id: string) => boolean
  applyModelForTurn: (id: string) => Promise<void>
  relaunchApply: (id: string) => void
  list: () => { id: string }[]
  shutdown: () => void
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))

// One tick per successful launch of our session — the observable that says whether a relaunch
// actually happened. Counting an EVENT the manager emits, rather than inspecting state it
// might expose differently, is what stops this from silently measuring nothing again.
let launches = 0
let watched = ''
sessions.on('ready', (...a: unknown[]) => { if (a[0] === watched) launches++ })

// ★ CAPABILITY GUARD — an EXPECTED RED MUST REPORT, NOT CRASH.
// Without this the first call to a missing method throws, the process dies, and the run
// produces ZERO failures — indistinguishable from a clean pass to anything counting reds, and
// it names nothing useful to whoever reads the log. This turns "the API is not there yet" into
// one explicit failing assertion that says which patch supplies it.
const missing = (['setModel', 'modelPending', 'applyModelForTurn'] as const)
  .filter((m) => typeof (sessions as unknown as Record<string, unknown>)[m] !== 'function')
if (missing.length) {
  check('the per-session model API exists (setModel / modelPending / applyModelForTurn)',
    false, `missing: ${missing.join(', ')} — apply scratchpad/feat-model-dropdown.{shared,server}.patch`)
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(1)
}

try {
  const id = sessions.create('ModelQA', work, work, undefined, false, undefined, undefined, 'opus')
  watched = id
  await settle()
  const launchesAfterStart = launches

  check('a session starts with no pending model (it launched with what it was given)',
    sessions.modelPending(id) === false, String(sessions.modelPending(id)))

  // ── setModel STORES, AND MUST NOT RELAUNCH ───────────────────────────────────────────────
  sessions.setModel(id, 'sonnet')
  await settle()
  check('setModel records the request on the session',
    sessions.get(id)?.model === 'sonnet', String(sessions.get(id)?.model))
  check('★ …and reports it as PENDING, because the engine still runs the old one',
    sessions.modelPending(id) === true, String(sessions.modelPending(id)))
  check('★★ …and does NOT relaunch — no further launch happened',
    launches === launchesAfterStart, `launches ${launchesAfterStart} -> ${launches}`)

  // ── THE FORCE BUTTON APPLIES IT NOW ──────────────────────────────────────────────────────
  sessions.relaunchApply(id)
  await settle(900)
  check('★ force (relaunchApply) brings the pending model into force',
    sessions.modelPending(id) === false, String(sessions.modelPending(id)))
  check('…by actually relaunching (one more launch than before)',
    launches === launchesAfterStart + 1, `launches ${launchesAfterStart} -> ${launches}`)

  // ── THE NEXT TURN APPLIES IT ─────────────────────────────────────────────────────────────
  const launchesBeforeTurn = launches
  sessions.setModel(id, 'fable')
  await settle()
  check('a second change is pending again', sessions.modelPending(id) === true, '')
  await sessions.applyModelForTurn(id)
  await settle(300)
  check('★★ applyModelForTurn (the next-turn hook) brings it into force',
    sessions.modelPending(id) === false, String(sessions.modelPending(id)))
  check('…by relaunching exactly once, and only after the replacement was up',
    launches === launchesBeforeTurn + 1, `launches ${launchesBeforeTurn} -> ${launches}`)

  // ── AND IT IS A NO-OP WHEN NOTHING IS PENDING ────────────────────────────────────────────
  // Almost every send takes this path; a relaunch here would restart the engine on every
  // message the user types.
  const launchesIdle = launches
  await sessions.applyModelForTurn(id)
  await settle(300)
  check('★ applyModelForTurn with nothing pending does NOT relaunch',
    launches === launchesIdle, `launches ${launchesIdle} -> ${launches}`)

  // ── '' MEANS "let the CLI choose", NOT A MODEL NAMED EMPTY ───────────────────────────────
  sessions.setModel(id, '')
  check("setModel('') normalises to undefined rather than storing an empty string",
    sessions.get(id)?.model === undefined, String(sessions.get(id)?.model))
} finally {
  sessions.shutdown()
  rmSync(dir, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
