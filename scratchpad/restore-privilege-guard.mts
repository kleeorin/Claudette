// CHARACTERIZATION: what ELSE does restore() replay from sessions.json, besides the
// permission mode?
//
// ── READ THIS BEFORE CHANGING AN ASSERTION ──────────────────────────────────────────────────
// ★ THIS FILE RECORDS A DECISION, NOT A LAW. It is deliberately NOT an accusation.
//
// A privilege-escalation hole was fixed in restore(): a persisted `permissionMode` was replayed
// verbatim, so "allow all" survived a restart nobody approved. That fix was scoped ON PURPOSE
// to elevation alone (see downgradeRestoredMode in sessionManager). The remaining persisted
// privileges — sandbox, teamEmploy, connectors — were NOT widened into it, because the boundary
// argued at the time is a real difference in kind:
//
//     `bypassPermissions` removes THE HUMAN.
//     `sandbox: {enabled:false}` removes THE WALLS, while the human still approves every call.
//
// Whether the second deserves the same treatment is a question for the user and was still open
// when this file was written. So every case below is named for WHAT IT MEASURES ("is restored
// unconfined"), never for a violation, and it asserts the behaviour that exists TODAY.
//
// ⚠ SO IF THIS FILE GOES RED, ASK WHICH KIND OF RED IT IS BEFORE "FIXING" ANYTHING:
//   * Someone deliberately widened the restore downgrade (the user ruled "widen")?
//     → CORRECT. Update the expectations here; the file has done its job by making the change
//       visible and deliberate rather than silent.
//   * Nobody decided anything and the behaviour moved anyway?
//     → That is the accidental change this file exists to catch.
// A characterization test is green in the normal case precisely so that either kind of change
// has to be looked at. Writing it inverted — asserting a downgrade nobody has agreed to — would
// have made it a standing red that everyone learns to wave through.
//
// ── THE TRAP, same as the elevation guard ───────────────────────────────────────────────────
// Assert on the RESTORED SESSION'S IN-MEMORY STATE via `sessions.get(id)` — the accessor the API
// and UI both read — never on spawn argv. SessionManager consults this state independently of
// the CLI, so an argv-only check can pass while the live behaviour is untouched.
//
// ── WHY EVERY CASE HERE IS A ROOT SESSION ───────────────────────────────────────────────────
// `register()` has genuine LIVE inheritance for sandbox and connectors: a child with no explicit
// config of its own adopts its parent's. That is deliberate and is a different mechanism from
// restore replaying a file. Mixing them in one fixture would make a failure ambiguous, so the
// privilege cases use roots only (no parentIndex) and inheritance is measured separately at the
// end, labelled as such.
//
//   node --import tsx scratchpad/restore-privilege-guard.mts
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.CLAUDETTE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claudette-restore-priv-data-'))
const work = mkdtempSync(path.join(tmpdir(), 'claudette-restore-priv-cwd-'))
// A second, read-only mount that the DEFAULT sandbox would never contain — the control's
// fingerprint. See the note on the 'confined' fixture below.
const extraMount = mkdtempSync(path.join(tmpdir(), 'claudette-restore-priv-ro-'))

// Shim BEFORE importing SessionManager — restore() LAUNCHES what it restores, and launch spawns
// the literal command `claude`. Shim and stub live inside `work` because that is the session cwd
// and therefore the only directory the default box mounts. Same pattern as agent-pending-test.
copyFileSync(path.join(here, 'fake-claude-team.mjs'), path.join(work, 'fake-claude.mjs'))
const shim = path.join(work, 'claude')
writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(path.join(work, 'fake-claude.mjs'))} "$@"\n`)
chmodSync(shim, 0o755)
process.env.PATH = `${work}${path.delimiter}${process.env.PATH ?? ''}`
process.env.FAKE_TURN_MS = '50'

const { SessionManager } = await import('../server/src/claude/sessionManager')
import { check, passed as pass, failed as fail } from './assert.mjs'

const sessions = new SessionManager({})

try {
  const ids = sessions.restore([
    // The three privileges under examination, each on its own ROOT session.
    { name: 'unconfined', cwd: work, sandbox: { enabled: false, mounts: [] } },
    { name: 'hirer', cwd: work, teamEmploy: true },
    { name: 'granted', cwd: work, connectors: ['github'], accountConnectors: ['gdrive'] },
    // CONTROLS. A fix that simply blanked every persisted privilege would pass the three cases
    // above and fail these — losing a legitimate confinement is a WORSE bug than replaying one.
    // ★ THE CONFINED CONTROL CARRIES DETAIL THE DEFAULT COULD NEVER PRODUCE, and that is not
    // decoration — an earlier version of this fixture used `{enabled:true, mounts:[cwd rw]}` and
    // was WORTHLESS. register() substitutes a default box of exactly that shape when a session
    // carries no sandbox at all, so a blanket wipe that threw the persisted config away scored
    // an identical result and the control passed. Measured, not theorised: mutation W2 (drop
    // every persisted sandbox, including a legitimate enabled:true) went GREEN against the old
    // fixture. The extra mount and sandboxTerminals are values the default never sets, so
    // "kept it" and "lost it and got lucky" are now distinguishable.
    { name: 'confined', cwd: work, sandbox: {
      enabled: true,
      mounts: [{ path: work, mode: 'rw' }, { path: extraMount, mode: 'ro' }],
      sandboxTerminals: true,
    } },
    { name: 'plain', cwd: work },
    // Measured separately and labelled: LIVE parent inheritance, not restore replay.
    { name: 'child-of-unconfined', cwd: work, parentIndex: 0 },
  ])

  const s = (i: number) => sessions.get(ids[i])
  check('restore() produced all six sessions', ids.length === 6, `got ${ids.length}`)

  // ── WHAT RESTORE REPLAYS ──────────────────────────────────────────────────────────────────
  check('a persisted sandbox-disabled session is restored UNCONFINED (sandbox.enabled === false)',
    s(0)?.sandbox?.enabled === false,
    `sandbox=${JSON.stringify(s(0)?.sandbox)}`)

  check('a persisted teamEmploy grant is restored ABLE TO HIRE (teamEmploy === true)',
    s(1)?.teamEmploy === true,
    `teamEmploy=${String(s(1)?.teamEmploy)}`)

  check('a persisted catalog-connector grant is restored GRANTED',
    (s(2)?.connectors ?? []).includes('github'),
    `connectors=${JSON.stringify(s(2)?.connectors)}`)

  check('a persisted ACCOUNT-connector grant is restored GRANTED',
    (s(2)?.accountConnectors ?? []).includes('gdrive'),
    `accountConnectors=${JSON.stringify(s(2)?.accountConnectors)}`)

  // ── CONTROLS: a blanket wipe must not pass as a fix ───────────────────────────────────────
  // Asserts the DETAIL, not merely `enabled === true` — see the fixture note above for the
  // mutation that proved the weaker form could not fail.
  const confined = s(3)?.sandbox
  check('★ CONTROL: a persisted ENABLED sandbox keeps its confinement AND its exact config',
    confined?.enabled === true
      && confined?.sandboxTerminals === true
      && (confined?.mounts ?? []).some((m) => m.path === extraMount && m.mode === 'ro'),
    `sandbox=${JSON.stringify(confined)}`)

  check('★ CONTROL: a session with no persisted grants is restored without them',
    s(4)?.teamEmploy !== true && !(s(4)?.connectors ?? []).includes('github'),
    `teamEmploy=${String(s(4)?.teamEmploy)} connectors=${JSON.stringify(s(4)?.connectors)}`)

  // ── LIVE INHERITANCE, measured separately so it cannot be mistaken for replay ─────────────
  // register() adopts the parent's sandbox when a child carries none of its own. Recorded here
  // because it is the OTHER route by which a restored session can end up unconfined, and anyone
  // reasoning about restore alone would miss it.
  check('(context, not a verdict) a child with no sandbox of its own adopts its parent\'s',
    s(5)?.sandbox?.enabled === false,
    `child sandbox=${JSON.stringify(s(5)?.sandbox)}`)

  // ── THE POPULATION SUMMARY ────────────────────────────────────────────────────────────────
  // Printed rather than asserted: it is the blast-radius figure a human needs in order to RULE
  // on the open question, and a number is more useful here than a pass/fail.
  const replayed = [
    s(0)?.sandbox?.enabled === false ? 'sandbox:disabled' : null,
    s(1)?.teamEmploy === true ? 'teamEmploy' : null,
    (s(2)?.connectors ?? []).length ? 'connectors' : null,
    (s(2)?.accountConnectors ?? []).length ? 'accountConnectors' : null,
  ].filter(Boolean)
  console.log(`\n   privileges replayed verbatim by restore(): ${replayed.length}/4 — ${replayed.join(', ') || 'none'}`)
  console.log('   permissionMode is NOT among them: the elevation downgrade landed and is guarded')
  console.log('   by scratchpad/restore-elevation-guard.mts.')
} finally {
  // Reap the fake engines restore() spawned; otherwise this run orphans six node processes.
  sessions.shutdown()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
