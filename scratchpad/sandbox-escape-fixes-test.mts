// Argv-level unit tests for the sandbox-escape closures (SANDBOX.md). These assert
// the EXACT bwrap/pty spawn specs the fixes produce — no bwrap execution, no nested
// namespaces, no live server — so they're deterministic and run anywhere.
//   npx tsx scratchpad/sandbox-escape-fixes-test.mts
//
// Covers:
//   1. Terminal-pane escape — a pane honours `sandbox.sandboxTerminals` (SANDBOX.md
//      "Revised default", 2026-07-28 / commit 8fbff62): a confined session's pane is a
//      HOST shell by default and only boxes when the operator ticks the flag. Every
//      pane, in every mode, is env-scrubbed of CLAUDETTE_*, and `deny` still fails
//      closed into a data-mount-less box.
//   2. Self-modification escape — a box that rw-mounts the app source gets server/ +
//      shared/ pinned READ-ONLY on top (opt-out flag lifts it).
//   3. Control-plane escape / Fix C — a request for sandbox.enabled=false is forced
//      back on unless the operator opted in.
//   4. Token never appears in a wrapped argv (fix A regression guard).
import path from 'path'
import { fileURLToPath } from 'url'
import { wrapSandbox, wrapCommand, appSourceRoot, sandboxAvailable } from '../server/src/claude/sandbox'
import { paneSpawnSpec } from '../server/src/pane/paneManager'
import { normalizeSandbox } from '../server/src/claude/sessionManager'
import type { SandboxConfig } from '../shared/src/types'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
import { check, passed as pass, failed as fail } from './assert.mjs'
// Poison the env so any leak is unmistakable.
process.env.CLAUDETTE_TOKEN = 'SECRET_TOKEN_SHOULD_NEVER_APPEAR'
process.env.MY_DB_PASSWORD = 'hunter2'

const boxCfg: SandboxConfig = { enabled: true, mounts: [{ path: repo, mode: 'rw' }] }
const hostCanSandbox = sandboxAvailable()
console.log(`(host sandboxAvailable=${hostCanSandbox}; appSourceRoot=${appSourceRoot()})\n`)

// --- 1. Terminal-pane: confinement follows `sandboxTerminals` ----------------
// NOT "a confined session always gets a boxed shell" — that was the pre-2026-07-28
// contract and it is deliberately gone (commit 8fbff62; SANDBOX.md "Revised default").
// Boxing every pane made the terminal useless for the ordinary host work an operator
// opens it for, so the flag opts BACK IN. What that does not give back is the escape:
// driving a pane needs the app token, and --clearenv means no box ever holds one.
{
  const shell = process.env.SHELL || '/bin/bash'
  const withFlag = (v: boolean | undefined): SandboxConfig => ({ ...boxCfg, sandboxTerminals: v })
  // `confined` is only reachable when the host can actually sandbox; otherwise
  // SessionConfinement.resolve yields `host` and there is no box to opt into.
  if (hostCanSandbox) {
    // Default (flag absent) — a HOST shell, by design.
    const dflt = paneSpawnSpec(repo, { mode: 'confined', cfg: withFlag(undefined), cwd: repo })
    check('pane(confined, flag absent): host shell by default', dflt.command === shell, `command=${dflt.command}`)
    check('pane(confined, flag absent): no bwrap wrapper', dflt.args.length === 0, `args=${JSON.stringify(dflt.args)}`)

    // Explicit false — same as absent. Pinned separately so a truthiness bug
    // (`!== false` vs `=== true`) cannot pass by accident.
    const off = paneSpawnSpec(repo, { mode: 'confined', cfg: withFlag(false), cwd: repo })
    check('pane(confined, flag false): host shell', off.command === shell, `command=${off.command}`)

    // Opted in — the box comes back, with the shell as the confined program.
    const on = paneSpawnSpec(repo, { mode: 'confined', cfg: withFlag(true), cwd: repo })
    check('pane(confined, flag true): spawns bwrap, not a bare shell', on.command === 'bwrap', `command=${on.command}`)
    check('pane(confined, flag true): args --clearenv the shell', on.args.includes('--clearenv'))
    check('pane(confined, flag true): the confined program is the shell', on.args[on.args.length - 1] === shell, on.args.slice(-1)[0])
    // The flag may only RAISE confinement, so the opted-in box must still be a real
    // box — not the deny-all one, and not a host shell wearing a bwrap hat.
    const rwSelfBind = (args: string[], p: string) => args.some((a, i) => a === '--bind' && args[i + 1] === p && args[i + 2] === p)
    check('pane(confined, flag true): the session mount is present (a real box, not deny-all)', rwSelfBind(on.args, repo))

    // Scrubbing is unconditional — it is NOT what the flag controls.
    for (const [label, s] of [['flag absent', dflt], ['flag true', on]] as const) {
      check(`pane(confined, ${label}): env carries NO CLAUDETTE_* secret`, !Object.keys(s.env).some((k) => k.startsWith('CLAUDETTE')))
      check(`pane(confined, ${label}): env kept an unrelated var (proves it is not empty)`, s.env.MY_DB_PASSWORD === 'hunter2')
    }
  } else {
    const spec = paneSpawnSpec(repo, { mode: 'host' })
    check('pane(confined): (host cannot sandbox — host mode is a raw shell)', spec.command === shell)
    check('pane(confined): env carries NO CLAUDETTE_* secret', !Object.keys(spec.env).some((k) => k.startsWith('CLAUDETTE')))
    check('pane(confined): env kept an unrelated var (proves it is not empty)', spec.env.MY_DB_PASSWORD === 'hunter2')
  }
}

// --- 1b. host mode → raw shell, but still token-scrubbed --------------------
{
  const spec = paneSpawnSpec(repo, { mode: 'host' })
  check('pane(host): raw host shell', spec.command === (process.env.SHELL || '/bin/bash'))
  check('pane(host): env STILL scrubs CLAUDETTE_*', !Object.keys(spec.env).some((k) => k.startsWith('CLAUDETTE')))
}

// --- 1c. FAIL CLOSED: an unresolved session (deny) never yields a host shell -
if (hostCanSandbox) {
  const spec = paneSpawnSpec(repo, { mode: 'deny' })
  const rwSelfBind = (args: string[], p: string) => args.some((a, i) => a === '--bind' && args[i + 1] === p && args[i + 2] === p)
  check('pane(deny): spawns bwrap (a data-mount-less box), NOT a host shell', spec.command === 'bwrap', `command=${spec.command}`)
  check('pane(deny): repo is NOT writably bound (deny-all box reaches nothing)', !rwSelfBind(spec.args, repo))
}

// --- 2. Self-modification escape: app source pinned read-only ----------------
// Helper: find the mode bwrap would apply to `p` = the LAST bind touching it (bwrap
// applies binds in argv order, later wins). Scans --bind (rw) / --ro-bind (ro) pairs.
function effectiveMode(args: string[], p: string): 'rw' | 'ro' | 'none' {
  let mode: 'rw' | 'ro' | 'none' = 'none'
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === '--bind' && args[i + 1] === p) mode = 'rw'
    else if (args[i] === '--ro-bind' && args[i + 1] === p) mode = 'ro'
  }
  return mode
}
if (hostCanSandbox) {
  const serverDir = path.join(repo, 'server')
  const sharedDir = path.join(repo, 'shared')

  delete process.env.CLAUDETTE_ALLOW_APP_SOURCE_MOUNT
  const wrapped = wrapCommand(boxCfg, repo, '/bin/bash', [])
  check('self-mod: repo itself is bound rw (project stays writable)', effectiveMode(wrapped.args, repo) === 'rw', effectiveMode(wrapped.args, repo))
  check('self-mod: server/ pinned READ-ONLY on top', effectiveMode(wrapped.args, serverDir) === 'ro', effectiveMode(wrapped.args, serverDir))
  check('self-mod: shared/ pinned READ-ONLY on top', effectiveMode(wrapped.args, sharedDir) === 'ro', effectiveMode(wrapped.args, sharedDir))

  // A box that does NOT mount the repo must not have source revealed at all.
  const elsewhere = wrapCommand({ enabled: true, mounts: [{ path: '/tmp', mode: 'rw' }] }, '/tmp', '/bin/bash', [])
  check('self-mod: source NOT revealed to an unrelated box', effectiveMode(elsewhere.args, serverDir) === 'none')

  // Opt-out flag lifts the protection (dev-in-app): no ro overlay is emitted, so
  // server/ inherits the parent repo's rw bind (no explicit bind of its own = 'none').
  process.env.CLAUDETTE_ALLOW_APP_SOURCE_MOUNT = '1'
  const wrappedAllow = wrapCommand(boxCfg, repo, '/bin/bash', [])
  check('self-mod: flag removes the read-only pin (server/ stays writable via repo)', effectiveMode(wrappedAllow.args, serverDir) !== 'ro', effectiveMode(wrappedAllow.args, serverDir))
  delete process.env.CLAUDETTE_ALLOW_APP_SOURCE_MOUNT

  // Same overlay applies to a claude session (wrapSandbox), not just wrapCommand.
  const claudeWrap = wrapSandbox(boxCfg, ['--version'], repo)
  check('self-mod: wrapSandbox also pins server/ read-only', effectiveMode(claudeWrap.args, serverDir) === 'ro')
} else {
  check('self-mod: (skipped — host cannot sandbox)', true)
}

// --- 3. Control-plane escape / Fix C: confinement not lowerable --------------
{
  delete process.env.CLAUDETTE_ALLOW_UNSANDBOXED
  const forced = normalizeSandbox({ enabled: false, mounts: [{ path: repo, mode: 'rw' }] }, repo)
  check('Fix C: enabled:false is forced back ON (no operator opt-in)', forced.enabled === true)

  process.env.CLAUDETTE_ALLOW_UNSANDBOXED = '1'
  const allowed = normalizeSandbox({ enabled: false, mounts: [{ path: repo, mode: 'rw' }] }, repo)
  check('Fix C: operator flag permits an unconfined session', allowed.enabled === false)
  delete process.env.CLAUDETTE_ALLOW_UNSANDBOXED

  const dflt = normalizeSandbox(undefined, repo)
  check('Fix C: default (no config) is sandboxed with cwd rw', dflt.enabled === true && dflt.mounts.some((m) => m.mode === 'rw'))
}

// --- 4. Token never appears in a wrapped argv (fix A regression) -------------
if (hostCanSandbox) {
  const claudeWrap = wrapSandbox(boxCfg, ['--version'], repo)
  const joined = claudeWrap.args.join(' ')
  check('fix A: CLAUDETTE_TOKEN value absent from the claude argv', !joined.includes('SECRET_TOKEN_SHOULD_NEVER_APPEAR'))
  check('fix A: claude argv --clearenv present', claudeWrap.args.includes('--clearenv'))
} else {
  check('fix A: (skipped — host cannot sandbox)', true)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
