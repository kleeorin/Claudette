// Unit tests for the SessionConfinement seam (SANDBOX.md): the single resolver every
// server-side actor uses to confine work done on behalf of a session. The property that
// matters is the FAIL-CLOSED default — an unknown/unresolved session must map to `deny`
// (most restrictive), never `host`, which was the fail-open root cause behind the
// notebook-MCP / venv-probe / unowned-kernel escapes.
//
//   npx tsx scratchpad/session-confinement-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SessionConfinement, type SessionBox } from '../server/src/claude/sessionConfinement'
import { sandboxAvailable } from '../server/src/claude/sandbox'
import type { SandboxConfig } from '../shared/src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'confine-'))
const proj = path.join(root, 'proj'); fs.mkdirSync(proj, { recursive: true })
const secret = path.join(root, 'secret'); fs.mkdirSync(secret, { recursive: true })
const canBox = sandboxAvailable()

// A tiny session table the resolver looks into — mirrors SessionManager.get().
const table: Record<string, SessionBox> = {
  confined: { sandbox: { enabled: true, mounts: [{ path: proj, mode: 'rw' }] } as SandboxConfig, cwd: proj },
  optedOut: { sandbox: { enabled: false, mounts: [] } as SandboxConfig, cwd: proj },   // operator opt-out
  noSandbox: { cwd: proj },                                                            // legacy: no sandbox field
}
const c = new SessionConfinement((id) => table[id])

// --- resolve() modes ---------------------------------------------------------
check('unknown session → deny (FAIL CLOSED, not host)', c.resolve('ghost').mode === 'deny', c.resolve('ghost').mode)
check('undefined sessionId → deny', c.resolve(undefined).mode === 'deny', c.resolve(undefined).mode)
check('sandbox.enabled=false (operator opt-out) → host', c.resolve('optedOut').mode === 'host', c.resolve('optedOut').mode)
check('no sandbox field → host', c.resolve('noSandbox').mode === 'host', c.resolve('noSandbox').mode)
// A sandbox-enabled session is `confined` only when the host can actually sandbox; on a
// host that can't, it honestly degrades to `host` (matching the "sandbox unavailable" badge).
check(`sandbox-enabled session → ${canBox ? 'confined' : 'host'} (host canBox=${canBox})`,
  c.resolve('confined').mode === (canBox ? 'confined' : 'host'), c.resolve('confined').mode)

// --- authorizePath(): the fail-closed default carries through ----------------
check('authorizePath: unknown session denied a write in-project', !c.authorizePath('ghost', path.join(proj, 'x'), 'write'))
check('authorizePath: unknown session denied a read in-project', !c.authorizePath('ghost', path.join(proj, 'x'), 'read'))
check('authorizePath: host (opted-out) session allowed anywhere', c.authorizePath('optedOut', path.join(secret, 'x'), 'write'))
if (canBox) {
  check('authorizePath: confined write inside a rw mount allowed', c.authorizePath('confined', path.join(proj, 'x'), 'write'))
  check('authorizePath: confined write OUTSIDE mounts denied', !c.authorizePath('confined', path.join(secret, 'x'), 'write'))
} else {
  check('authorizePath: (host cannot sandbox — confined path gating not exercised)', true)
  check('authorizePath: (host cannot sandbox — confined path gating not exercised)', true)
}

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
