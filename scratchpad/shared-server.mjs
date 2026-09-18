// WHOSE SERVER IS ON :4321? — the question nothing used to ask.
//
//   import { assertSharedServerIsOurs } from './shared-server.mjs'
//   assertSharedServerIsOurs()        // top of any srv4321: harness, before it connects
//
// ── THE HAZARD ───────────────────────────────────────────────────────────────────────
// `.suite-run.lock` stops a second FULL RUN and warns off EDITS to the fingerprinted trees.
// It does not stop a SINGLE-FILE run, and single-file runs were never the problem anyone
// pictured.
//
// CORRECTED 2026-09-02. This header used to say "no harness binds :4321 — all nineteen that
// mention the port only CONNECT." BOTH HALVES ARE FALSE. `super-editor-test.mjs` does
// `proxy.listen(4321, '127.0.0.1', ...)` — it binds. And the count is nine registered srv4321
// entries, not nineteen; eighteen files mention the port in live code.
//
// The correction matters because the false version misstates WHY this guard is needed. Binding
// the port and OWNING the server were treated as one thing and are two. The runner-side path is
// already guarded — `start_shared_server` probes `ss`, sets FOREIGN_4321=yes and SKIPS rather
// than adopting. The UNGUARDED route is DIRECT INVOCATION (`node scratchpad/<harness>.mjs`),
// which is what every one of those harness headers documents as its usage and where no runner
// exists to probe anything. The true statement is `f113c46`'s: a harness cannot tell whose
// server it is because `/api/health` returns ok/version/ts/sandboxAvailable and nothing
// identifying, so "whose server is this?" is unanswerable from inside a harness.
// The only binder is run-suite.sh's start_shared_server.
//
// So a single-file run started while a full run owns the port does not fail on a busy port.
// *** IT SUCCEEDS, AGAINST THE OTHER RUN'S SERVER. *** It creates sessions, injects websocket
// frames and mutates state inside the very server the full run is measuring. The single-file
// run prints a plausible result; the full run's numbers are quietly wrong; nothing in either
// output says so.
//
// run-suite already guards the other direction — start_shared_server refuses to start when
// :4321 is already held. That check is one-directional by construction: it asks "is someone
// already here?" before starting, and nothing asks "does someone already own this?" after.
// Binding the port and owning the server were treated as one thing. They are two.
//
// ── WHY THIS REFUSES RATHER THAN WARNS, AND WHY THAT IS SAFE ─────────────────────────
// A guard that refuses on a STALE owner file would make single-file runs useless after any
// crashed run, and everyone would learn to bypass it — worse than the hazard it prevents.
// That is the usual argument for warning instead of refusing.
//
// It does not apply here, because staleness is DECIDABLE. The run lock cannot probe its
// holder — its own comment says so: "a dead holder in another session cannot be probed", which
// is why it falls back to a one-hour timer. But this guard is about a PORT, and `ss` reads
// HOST sockets across sandbox boundaries even though `ps`/`pgrep` and /proc do not. So:
//
//   owner file present AND :4321 currently held  → someone really owns it   → REFUSE
//   owner file present AND :4321 NOT held        → the run died; file stale → PROCEED
//
// No timer, no guessing, and a false refusal needs a live listener to exist — at which point
// refusing is correct anyway. Deciding staleness precisely is what let the safer option be
// the usable one; the two choices are one choice.
import { existsSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'

const OWNER_FILE = '.suite-server.lock'
const PORT = 4321

/** True when something is LISTENING on 127.0.0.1:PORT right now. Host-wide: `ss` sees
 *  sockets belonging to other sandboxes, which is the whole reason this check is possible. */
export function portIsHeld(port = PORT) {
  try {
    const out = execFileSync('ss', ['-ltn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split('\n').some((l) => l.includes(`127.0.0.1:${port}`))
  } catch {
    // No `ss` — cannot decide, so do not invent a refusal. Say nothing and let the run proceed;
    // a guard that fires on its own missing tooling is a guard nobody keeps.
    return false
  }
}

/** The recorded owner, or null when there is no file. */
export function readOwner(file = OWNER_FILE) {
  if (!existsSync(file)) return null
  try {
    const txt = readFileSync(file, 'utf8')
    const get = (k) => (txt.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1] ?? '').trim()
    return { runId: get('run'), session: get('session'), started: get('started'), raw: txt }
  } catch {
    return null
  }
}

/**
 * Refuse to run when a full suite run owns the shared :4321 server and we are not part of it.
 *
 * run-suite exports CLAUDETTE_SUITE_RUN to the harnesses it launches; a matching value means
 * this process IS that run's child and may proceed. Anything else — no variable, or a
 * different run's id — is a single-file run walking into someone else's server.
 */
export function assertSharedServerIsOurs({ file = OWNER_FILE, port = PORT, exitCode = 1 } = {}) {
  const owner = readOwner(file)
  if (!owner) return true                       // nobody claims it
  if (!portIsHeld(port)) return true            // claimed, but nothing is listening: stale file
  if (process.env.CLAUDETTE_SUITE_RUN && process.env.CLAUDETTE_SUITE_RUN === owner.runId) return true
  // Same escape hatch, and deliberately the SAME variable run-suite already documents for the
  // mirror case ("use the server that is there, results are not trustworthy"), so there is one
  // name to learn rather than two for the identical judgement call.
  if (process.env.ALLOW_FOREIGN_4321 === '1') {
    console.error(`note: :${port} is owned by another run and ALLOW_FOREIGN_4321=1 — proceeding.`)
    console.error(`      Both this result AND that run's numbers are now untrustworthy.`)
    return true
  }

  console.error(`REFUSING TO RUN: a full suite run owns the shared :${port} server.`)
  console.error(`  run:     ${owner.runId || '(unrecorded)'}`)
  console.error(`  session: ${owner.session || '(unrecorded)'}`)
  console.error(`  started: ${owner.started || '(unrecorded)'}`)
  console.error(`Connecting now would create sessions and inject frames into the server that`)
  console.error(`run is measuring — its numbers would be wrong and nothing would say so.`)
  console.error(`Wait for it to finish, or ALLOW_FOREIGN_4321=1 if you know that run is dead.`)
  process.exit(exitCode)
}
