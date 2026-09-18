// ★ SECURITY REGRESSION: a server restart must not hand a session back its elevated
// permission mode.
//
// Reported by the user, in their words: "you can't inherit an 'allow all' from a parent, no
// matter what. especially after a restart." A teammate session came back from a restart with
// "allow all" nobody had granted it in this run.
//
// ── WHERE THE HOLE IS, AND WHERE IT IS NOT ──────────────────────────────────────────────────
// "Allow all" is `permissionMode: 'bypassPermissions'`. It is enforced in TWO independent
// places: the CLI launch flag, and `SessionManager`'s own auto-approve path, which answers
// permission requests "without the CLI's cooperation". That second one is why this file
// asserts on the RESTORED SESSION'S STATE rather than on spawn argv — a test that only checked
// `--permission-mode` would pass while the auto-approve path stayed live, which is precisely
// the shape of check that lets a security fix look done and not be.
//
// `setPermissionMode` ALREADY gates elevation: an untrusted caller asking for
// `bypassPermissions` or `acceptEdits` is refused, and its only caller is the auth-gated
// setMode route — i.e. the operator. `register()` does NOT copy a parent's mode either, and a
// teammate hired via `employ_teammate` starts at `default`. So live inheritance is not the bug
// and must not be "fixed": the child below comes back elevated because its OWN persisted
// record says so, and restore trusts the file.
//
// That leaves exactly one door: `restore()`, which replays the persisted mode verbatim under a
// comment reading "a persisted config was already operator-approved". THAT is the unsafe
// assumption this file exists to keep closed. A file on disk is not an operator. Anything able
// to write `sessions.json` can grant itself allow-all on the next boot — sessionPersistence's
// own header already warns of exactly this class for `teamEmploy` and `sandbox`, and
// bypassPermissions is the same class and worse, because it auto-approves every tool call.
//
// ── THE RULE ────────────────────────────────────────────────────────────────────────────────
// Restore must DOWNGRADE the two modes `setPermissionMode` refuses from an untrusted caller —
// `bypassPermissions` and `acceptEdits` — to `default`. It must leave `plan` and `default`
// alone: those only ever RAISE prompting, so replaying them removes no protection. Elevation is
// a LIVE decision and has to be re-granted by a human after a restart.
//
//   node --import tsx scratchpad/restore-elevation-guard.mts
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.CLAUDETTE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claudette-restore-elev-data-'))
const work = mkdtempSync(path.join(tmpdir(), 'claudette-restore-elev-cwd-'))

// Shim BEFORE importing SessionManager — restore() LAUNCHES every session it restores, and
// launch spawns the literal command `claude`. Both the shim and the stub live inside `work`
// because that is the session cwd and therefore the only directory the default sandbox mounts;
// a stub referenced at its scratchpad/ path dies inside the box with MODULE_NOT_FOUND.
// Same pattern as agent-pending-test.mts, and for the same reason.
copyFileSync(path.join(here, 'fake-claude-team.mjs'), path.join(work, 'fake-claude.mjs'))
const shim = path.join(work, 'claude')
writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(path.join(work, 'fake-claude.mjs'))} "$@"\n`)
chmodSync(shim, 0o755)
process.env.PATH = `${work}${path.delimiter}${process.env.PATH ?? ''}`
process.env.FAKE_TURN_MS = '50'

const { SessionManager } = await import('../server/src/claude/sessionManager')
import { check, passed as pass, failed as fail } from './assert.mjs'
// The SAME predicate the fix uses, imported rather than restated — see the note at the filter.
const { isElevatedMode } = await import('../shared/src/types')

const sessions = new SessionManager({})

try {
  // A persisted set shaped like the reported incident: an elevated parent, an elevated CHILD
  // (parentIndex 0), a lone acceptEdits session, and two that were never elevated. The last two
  // are the control — without them a fix that simply blanked every mode would pass.
  const ids = sessions.restore([
    { name: 'parent', cwd: work, permissionMode: 'bypassPermissions' },
    { name: 'child', cwd: work, parentIndex: 0, permissionMode: 'bypassPermissions' },
    { name: 'acceptEdits-one', cwd: work, permissionMode: 'acceptEdits' },
    { name: 'planner', cwd: work, permissionMode: 'plan' },
    { name: 'plain', cwd: work },
    // A child of the ELEVATED parent at index 0, carrying no mode of its own. This is the
    // reported incident's shape and the case the whole file turns on.
    { name: 'child-no-mode', cwd: work, parentIndex: 0 },
  ])

  const modeOf = (i: number) => sessions.get(ids[i])?.permissionMode
  // Read through the same accessor the API and the UI use, so this cannot pass against an
  // internal field the rest of the system never sees.
  const nameOf = (i: number) => sessions.get(ids[i])?.name ?? '(gone)'

  check('restore() produced all six sessions', ids.length === 6, `got ${ids.length}`)

  // 'default' and undefined are both "ask me" — a child that inherited nothing may land on
  // either, so accept both rather than pinning an implementation detail.
  const notElevated = (m: unknown) => m === 'default' || m === undefined

  // ── 1. A SESSION'S OWN MODE PERSISTS ─────────────────────────────────────────────────────
  // The operator's correction: keeping your own elevation across a restart was never the
  // complaint. Forcing a re-grant on every boot is friction with no security return, because
  // the value being replayed is the one the operator themselves set.
  check('★ a parent keeps its OWN bypassPermissions across a restart',
    modeOf(0) === 'bypassPermissions', `${nameOf(0)} restored as ${String(modeOf(0))}`)

  check('★ a SUBSESSION keeps its OWN bypassPermissions across a restart',
    modeOf(1) === 'bypassPermissions', `${nameOf(1)} restored as ${String(modeOf(1))}`)

  check('★ a session keeps its OWN acceptEdits across a restart',
    modeOf(2) === 'acceptEdits', `${nameOf(2)} restored as ${String(modeOf(2))}`)

  // ── 2. BUT A CHILD NEVER ACQUIRES ITS PARENT'S ELEVATION ─────────────────────────────────
  // ★★ THE ASSERTION THIS WHOLE FILE TURNS ON, and the one that separates the two candidate
  // fixes. Index 5 is a child of the elevated parent at index 0 and has NO mode of its own.
  // It must come back unelevated. A "drop every elevation on restore" fix would also pass this
  // — which is exactly why it is paired with the three above, that such a fix FAILS.
  check('★★ a child with no mode of its own does NOT inherit its elevated parent\'s',
    notElevated(modeOf(5)), `${nameOf(5)} restored as ${String(modeOf(5))}`)

  // ── 3. THE CONTROLS ──────────────────────────────────────────────────────────────────────
  check('a persisted plan mode survives (it only raises prompting)',
    modeOf(3) === 'plan', `restored as ${String(modeOf(3))}`)

  check('a session that was never elevated stays unelevated',
    notElevated(modeOf(4)), `restored as ${String(modeOf(4))}`)

} finally {
  // Reap the fake engines restore() spawned. Without this the run leaves five node processes
  // behind — the same orphaning the browser harnesses in this directory guard against.
  sessions.shutdown()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
