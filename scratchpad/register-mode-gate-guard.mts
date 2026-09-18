// THE TRUST GATE ON `permissionMode` AT SESSION CREATION — `register()`'s own check, as
// distinct from the restore downgrade that `restore-elevation-guard.mts` covers.
//
// ★ WHAT THIS PINS, AND WHY IT IS A SECOND LINE RATHER THAN THE FIRST.
// `register()` is the single funnel every session passes through. `permissionMode` used to
// flow through it into the session object with NO trust check, unlike its two siblings:
// `sandbox` is gated by normalizeSandbox(…, trusted || !!inherited), and `teamEmploy` was
// deliberately removed from create()'s parameters after this exact shape bit us there.
//
// ★★ NO LIVE HOLE EXISTS TODAY, and this file should not be read as claiming one. Every door
// was traced: `/api/session/create` is auth-gated and passes trusted:true; `employ_teammate`
// — the in-process, possibly-sandboxed caller — passes only seven arguments, so the mode
// arrives `undefined`; `setPermissionMode`'s only caller is the auth-gated setMode route; and
// `restore()`, the one door that DID bypass the gate, was shut by downgradeRestoredMode. What
// changed is the KIND of protection: caller discipline became a gate. Caller discipline is
// invisible when it lapses, and this function has already had one such lapse.
//
// ★ THE TRAP THIS FILE IS WRITTEN AROUND: assert on the session's STORED permissionMode, never
// on spawn argv. The auto-approve lives in `claudeEngine.ts` (the `handlePermission` path,
// around the "Allow all (bypassPermissions): auto-approve every tool" comment) and reads
// `this.mode`, seeded from the spawn CONFIG — not from argv. So the guidance holds while the
// citation an earlier draft gave did not: `sessionManager.ts` mentions bypassPermissions only
// in comments. Corrected after review caught the wrong file being named here.
// `canUseTool`, so an argv-only check would pass while the auto-approve path stayed live.
// Everything below reads through `sessions.get(id).permissionMode` — the same accessor the API
// and the UI use.
//
// MUTATIONS (measured 2026-09-16, `ran=N` reported alongside, because a mutant that fails to
// PARSE yields zero failures exactly like a clean pass):
// All four measured at ran=7 — constant across every mutant, which is what shows none crashed
// rather than failing. Red sets are what was MEASURED; two of them contradict what I predicted
// before running, and the measured version is the one kept:
//   G1  the gate deleted (mode passed through untrusted)
//         → 3 red: both untrusted-elevated cases AND the summary assertion.
//   G2  gate applied to EVERYONE (`trusted` ignored, so the operator is refused too)
//         → 2 red: BOTH trusted controls. I predicted the starred one alone; the acceptEdits
//           control reds with it, which is the more useful signal — it shows the regression is
//           not specific to the mode that gets the most attention.
//   G3  only bypassPermissions gated, acceptEdits let through
//         → 2 red: the acceptEdits case AND the summary. I predicted "alone". The summary
//           assertion catching it is exactly why it is written over the whole set rather than
//           per session.
//   G4  gate also downgrades `plan` (which removes no protection)
//         → 1 red: the plan control, alone. Predicted correctly.
//   XX  a patch matching no text must REFUSE — it did, 0 matches, no run performed.
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.CLAUDETTE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claudette-regmode-data-'))
const work = mkdtempSync(path.join(tmpdir(), 'claudette-regmode-cwd-'))

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
  // create(name, cwd, rootDir, parentId, resume, claudeSessionId, agentId, model,
  //        permissionMode, sandbox, trusted)
  const mk = (name: string, mode: string | undefined, trusted: boolean) =>
    sessions.create(name, work, work, undefined, false, undefined, undefined, undefined,
      mode as never, undefined, trusted)

  const modeOf = (id: string) => sessions.get(id)?.permissionMode
  // 'default' and undefined are both "ask me" — the gate may land on either, so accept both
  // rather than pinning how the downgrade happens to be written.
  const notElevated = (m: unknown) => m === 'default' || m === undefined

  // ── THE SECURITY ASSERTIONS: an UNTRUSTED caller cannot create an elevated session ───────
  const uBypass = mk('untrusted-bypass', 'bypassPermissions', false)
  check('★ an UNTRUSTED caller asking for bypassPermissions does not get it',
    notElevated(modeOf(uBypass)), `stored as ${String(modeOf(uBypass))}`)

  const uAccept = mk('untrusted-acceptEdits', 'acceptEdits', false)
  check('★ an UNTRUSTED caller asking for acceptEdits does not get it',
    notElevated(modeOf(uAccept)), `stored as ${String(modeOf(uAccept))}`)

  // The employ_teammate shape: an in-process caller that passes no mode at all. It must remain
  // unelevated, and must not be broken by the gate either.
  const uNone = mk('untrusted-default', undefined, false)
  check('an UNTRUSTED caller passing no mode is unaffected',
    notElevated(modeOf(uNone)), `stored as ${String(modeOf(uNone))}`)

  // ── THE CONTROLS. Without these a gate that refused EVERYONE would pass. ─────────────────
  const tBypass = mk('operator-bypass', 'bypassPermissions', true)
  check('★★ THE OPERATOR (trusted) CAN still create a bypassPermissions session',
    modeOf(tBypass) === 'bypassPermissions', `stored as ${String(modeOf(tBypass))}`)

  const tAccept = mk('operator-acceptEdits', 'acceptEdits', true)
  check('the operator (trusted) can still create an acceptEdits session',
    modeOf(tAccept) === 'acceptEdits', `stored as ${String(modeOf(tAccept))}`)

  // `plan` only RAISES prompting, so it is not a privilege and must survive from any caller —
  // downgrading it would be a security regression of its own, and a deliberate restriction the
  // user would be annoyed to lose.
  const uPlan = mk('untrusted-plan', 'plan', false)
  check('an UNTRUSTED caller may still ask for plan mode (it removes no protection)',
    modeOf(uPlan) === 'plan', `stored as ${String(modeOf(uPlan))}`)

  // ── THE SUMMARY ASSERTION, stated over the whole set rather than per-session ─────────────
  const untrustedIds = [uBypass, uAccept, uNone]
  const anyElevated = untrustedIds.filter((id) => {
    const m = modeOf(id)
    return m === 'bypassPermissions' || m === 'acceptEdits'
  })
  check('★★ NO session created by an untrusted caller holds an elevated mode',
    anyElevated.length === 0,
    anyElevated.length ? anyElevated.map((id) => `${sessions.get(id)?.name}=${String(modeOf(id))}`).join(', ') : 'none')
} finally {
  // shutdown(), like the sibling guard: create() LAUNCHES, so without this the fake engines
  // outlive the process and orphan themselves.
  sessions.shutdown()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
