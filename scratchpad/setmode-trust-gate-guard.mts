// THE TRUST GATE ON `setPermissionMode` — elevation on an ALREADY-RUNNING session.
//
// ★★ WHY THIS FILE EXISTS, AND IT IS THE UNCOMFORTABLE PART. ★★
// Two gates were added in response to a user finding a teammate in "allow all" they never
// granted: `downgradeRestoredMode` (boot restore) and `downgradeUntrustedMode` (session
// creation). Each got its own guard. But BOTH of those guards' headers cite THIS gate —
// `setPermissionMode`'s `if (!trusted && isElevatedMode(mode))` — as the reason their own
// door is the only one that needed shutting. They reason FROM it and test it NOWHERE.
//
// MEASURED, not argued. With that one clause neutered to `if (false && …)` in an out-of-repo
// copy of server/:
//     restore-elevation-guard    7 passed, 0 failed   ← unchanged
//     register-mode-gate-guard   7 passed, 0 failed   ← unchanged
//     restore-privilege-guard    8 passed, 0 failed   ← unchanged
//     server typecheck           0 errors             ← unchanged
// Every check in the repo stayed green while the gate protecting LIVE elevation was gone. A
// future "simplification" that drops that clause ships clean through all of them.
//
// That is the shape this repo keeps rediscovering: not an untested feature, but an untested
// thing that other tests DEPEND ON, so the suite's green is load-bearing on an assumption
// nothing verifies. Compare the connector suite's `[4d]`, which sat green throughout the
// entire period its sibling was red because it ran from a state where its flag was already set.
//
// ★ ASSERTS ON THE STORED MODE, never on the return value alone. `setPermissionMode` reports
// `applied: 'error'` on refusal, but a gate that returned an error AND wrote the field anyway
// would pass a return-value-only check while the session ran elevated. The stored value read
// back through `sessions.get(id)` is what the engine's auto-approve actually consults.
//
// MUTATIONS (measured 2026-09-17, `ran=N` alongside because a mutant that fails to PARSE
// yields zero failures exactly like a clean pass):
//   K1  the gate neutered (`!trusted` → `false`)      → the two untrusted-elevated cases red.
//   K2  gate applied to everyone (`!trusted` dropped) → the TRUSTED control reds. Without that
//         control a blanket refusal would look like a fix.
//   K3  only bypassPermissions gated                  → the acceptEdits case reds.
//   K4  gate widened to plan/default                  → the non-privilege control reds.
//   XX  a patch matching no text must REFUSE.
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.CLAUDETTE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claudette-setmode-data-'))
const work = mkdtempSync(path.join(tmpdir(), 'claudette-setmode-cwd-'))

// Shim BEFORE importing SessionManager — create() LAUNCHES, and launch spawns the literal
// command `claude`. Shim and stub live inside `work` because that is the session cwd and so
// the only directory the default sandbox mounts.
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
  const mk = (name: string) =>
    sessions.create(name, work, work, undefined, false, undefined, undefined, undefined,
      undefined, undefined, /* trusted */ true)
  const modeOf = (id: string) => sessions.get(id)?.permissionMode
  const unset = (m: unknown) => m === undefined || m === 'default'

  // ── AN UNTRUSTED CALLER CANNOT ELEVATE A LIVE SESSION ────────────────────────────────────
  const a = mk('untrusted-bypass')
  const ra = await sessions.setPermissionMode(a, 'bypassPermissions', false)
  check('★★ an UNTRUSTED caller cannot switch a live session to bypassPermissions',
    unset(modeOf(a)), `stored as ${String(modeOf(a))}`)
  check('…and the refusal is reported rather than silently ignored',
    ra.applied === 'error', `applied=${String(ra.applied)}`)

  const b = mk('untrusted-acceptEdits')
  await sessions.setPermissionMode(b, 'acceptEdits', false)
  check('★ an UNTRUSTED caller cannot switch a live session to acceptEdits',
    unset(modeOf(b)), `stored as ${String(modeOf(b))}`)

  // ── THE CONTROLS. Without these a gate that refused EVERYTHING would pass. ───────────────
  const c = mk('operator-bypass')
  const rc = await sessions.setPermissionMode(c, 'bypassPermissions', true)
  check('★★ THE OPERATOR (trusted) CAN still elevate a live session',
    modeOf(c) === 'bypassPermissions', `stored as ${String(modeOf(c))}, applied=${String(rc.applied)}`)

  // `plan` and `default` only RAISE prompting, so they are not privileges and an untrusted
  // caller must still be able to ask for them — refusing would be a downgrade of its own.
  const d = mk('untrusted-plan')
  await sessions.setPermissionMode(d, 'plan', false)
  check('an UNTRUSTED caller may still set plan mode (it removes no protection)',
    modeOf(d) === 'plan', `stored as ${String(modeOf(d))}`)

  // ── THE GATE SITS BEFORE THE SESSION LOOKUP, and that ordering is deliberate: an untrusted
  // caller must not be able to use the error text to discover which session ids exist.
  const rUnknown = await sessions.setPermissionMode('no-such-session-id', 'bypassPermissions', false)
  check('an untrusted elevated request for an UNKNOWN id is refused by the gate, not the lookup',
    rUnknown.applied === 'error' && !/no such session/i.test(String(rUnknown.error ?? '')),
    `error=${String(rUnknown.error)}`)

  // ── THE SUMMARY, over the whole set rather than per session ─────────────────────────────
  const elevatedUntrusted = [a, b, d].filter((id) => {
    const m = modeOf(id)
    return m === 'bypassPermissions' || m === 'acceptEdits'
  })
  check('★★ NO session elevated by an untrusted caller holds an elevated mode',
    elevatedUntrusted.length === 0,
    elevatedUntrusted.length
      ? elevatedUntrusted.map((id) => `${sessions.get(id)?.name}=${String(modeOf(id))}`).join(', ')
      : 'none')
} finally {
  // shutdown(), like the sibling guards: create() LAUNCHES, so without this the fake engines
  // outlive the process and orphan themselves.
  sessions.shutdown()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
