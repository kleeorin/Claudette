// REGRESSION NET for the three sandbox escapes fixed in server/src/claude/sandbox.ts
// (shell injection in which(); realpath-vs-logical mismatch in isUnsafeSymlinkMount and
// in appSourceProtections). Written against the FIXED behaviour, so it FAILS while the
// bugs are present — that is the point: it demonstrates the escape today and becomes the
// guard afterwards.
//
//   npx tsx scratchpad/sandbox-regression-fixes-test.mts
//
// Every check is an ATTACK: `✅ blocked` means the attack failed, `🚨 SUCCEEDED` is a live
// escape. Argv-level + pure-function, no bwrap execution, so it is deterministic.
//
// THE COMMON ROOT CAUSE of #2 and #3 is worth stating once, because it is the thing that
// will regress again: two paths that name the same file are compared with `===` /
// `startsWith` after `path.resolve()`, which does NOT follow symlinks. The moment any
// ANCESTOR of a mount is a symlink, the logical name and the canonical name diverge, the
// comparison silently misses, and the guard built on it fails OPEN. Fixing it means
// comparing like with like — canonical against canonical — on BOTH sides.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { SandboxConfig } from '../shared/src/types'

let pass = 0, fail = 0
const check = (name: string, blocked: boolean, extra = '') => {
  blocked ? pass++ : fail++
  console.log(`${blocked ? '✅ blocked' : '🚨 SUCCEEDED'}  ${name}${extra ? ' — ' + extra : ''}`)
}

// sandbox.ts memoizes appSourceRoot() and the which() cache at module scope, so each case
// that needs a different CLAUDETTE_APP_ROOT must load a FRESH module instance. Same
// cache-busting trick data-dir-test.mts uses.
let seq = 0
const freshSandbox = () => import(`../server/src/claude/sandbox.ts?case${seq++}`)

// Scan a bwrap argv for a bind (rw or ro) of exactly `p`.
const bindsPath = (args: string[], p: string) =>
  args.some((a, i) => (a === '--bind' || a === '--ro-bind') && args[i + 1] === p)
// The mode bwrap would apply to `p`: the LAST bind naming it wins (argv order).
function effectiveMode(args: string[], p: string): 'rw' | 'ro' | 'none' {
  let mode: 'rw' | 'ro' | 'none' = 'none'
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === '--bind' && args[i + 1] === p) mode = 'rw'
    else if (args[i] === '--ro-bind' && args[i + 1] === p) mode = 'ro'
  }
  return mode
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-regress-'))
const cleanup: string[] = [base]

// ══════════════════════════════════════════════════════════════════════════════
// 1. SHELL INJECTION in which() — `execFileSync('sh', ['-c', `command -v ${bin}`])`
//    interpolates `bin` into a shell string. wrapCommand() calls which(program), and
//    `program` is caller-supplied (the pane's shell, Jupyter's pythonPath — the latter
//    reachable from a box-planted .venv), so a metacharacter in a path is host RCE.
//
//    The assertion is a SENTINEL: each payload would create a file if the shell ever
//    evaluated it. Testing "no file appeared" is stronger than inspecting the argv,
//    because it catches execution by ANY route, including one added later.
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n=== 1. which() / wrapCommand shell injection ===\n')
{
  const { wrapCommand, resetSandboxProbe } = await freshSandbox()
  const cwd = path.join(base, 'proj1')
  fs.mkdirSync(cwd, { recursive: true })
  const cfg: SandboxConfig = { enabled: true, mounts: [{ path: cwd, mode: 'rw' }] }

  const payloads: Array<{ label: string; make: (sentinel: string) => string }> = [
    { label: '$(...) command substitution', make: (s) => `x$(touch ${s})` },
    { label: 'backtick substitution', make: (s) => 'x`touch ' + s + '`' },
    { label: '; command separator', make: (s) => `x; touch ${s}` },
    // `&&` would SHORT-CIRCUIT here (`command -v x` fails), so it would report "blocked"
    // while proving nothing. `||` is the honest form of the same attack.
    { label: '|| command chain', make: (s) => `x || touch ${s}` },
    { label: '| pipeline', make: (s) => `x | touch ${s}` },
    { label: 'newline-separated command', make: (s) => `x\ntouch ${s}` },
    // Not an injection, but the same interpolation mangles it: an ordinary path with a
    // space is word-split by the shell, so `command -v` resolves the wrong thing.
    { label: 'plain path containing a space', make: () => path.join(base, 'dir with space', 'python3') },
  ]

  for (const [i, p] of payloads.entries()) {
    const sentinel = path.join(base, `pwned-${i}`)
    const program = p.make(sentinel)
    let threw = ''
    try {
      resetSandboxProbe()                       // drop the memoized which() result
      wrapCommand(cfg, cwd, program, [])
    } catch (e) { threw = e instanceof Error ? e.message : String(e) }
    const executed = fs.existsSync(sentinel)
    if (executed) { try { fs.unlinkSync(sentinel) } catch {} }
    check(`which(): ${p.label} does not execute`, !executed,
      executed ? `SENTINEL CREATED by ${JSON.stringify(program)} — host RCE` : (threw ? `rejected: ${threw.slice(0, 80)}` : 'resolved inertly'))
  }

  // A path with a space must RESOLVE, not just fail inertly: the shell word-splits it, so
  // `command -v` sees two arguments and finds nothing. wrapCommand falls back to the raw
  // program, which happens to look the same here — so assert the resolved program is the
  // WHOLE path, which is what a word-splitting fix would get wrong.
  {
    const spacedDir = path.join(base, 'dir with space')
    fs.mkdirSync(spacedDir, { recursive: true })
    const prog = path.join(spacedDir, 'prog')
    fs.writeFileSync(prog, '#!/bin/sh\nexit 0\n'); fs.chmodSync(prog, 0o755)
    resetSandboxProbe()
    const { args } = wrapCommand(cfg, cwd, prog, [])
    const resolved = args[args.length - 1]
    check('which(): a program path containing a space resolves whole (not word-split)',
      resolved === prog, `resolved=${JSON.stringify(resolved)}`)
  }

  // The fix must not break the ordinary case it exists to serve.
  resetSandboxProbe()
  const ok = wrapCommand(cfg, cwd, '/bin/sh', [])
  check('which(): a normal absolute program still wraps', ok.command === 'bwrap' && ok.args.includes('--clearenv'), `command=${ok.command}`)
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. isUnsafeSymlinkMount — realpath(parent) compared against LOGICAL rwRoots.
//    With a symlinked ancestor above the mount the two never match, `boxWritable`
//    goes false, and the box-planted symlink is bound: the guard fails OPEN.
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n=== 2. isUnsafeSymlinkMount under a symlinked ancestor ===\n')
{
  const { wrapSandbox, sandboxPathAccess } = await freshSandbox()

  // real/ is the canonical tree; link -> real is the SYMLINKED ANCESTOR. The session is
  // launched against the LOGICAL path (link/proj), exactly as a caller would name it.
  const real = path.join(base, 'real2'); fs.mkdirSync(real, { recursive: true })
  const link = path.join(base, 'link2'); fs.symlinkSync(real, link)
  const proj = path.join(link, 'proj'); fs.mkdirSync(path.join(real, 'proj'), { recursive: true })
  const secret = path.join(base, 'secret2'); fs.mkdirSync(secret, { recursive: true })
  fs.writeFileSync(path.join(secret, 'key.txt'), 'TOP SECRET')

  // The escape: a confined session plants <cwd>/.claude -> <out-of-mount secret>. Its
  // parent IS box-writable (it is the session's own rw cwd) — just not by the name the
  // guard compares against.
  const planted = path.join(proj, '.claude')
  fs.symlinkSync(secret, planted)

  const cfg: SandboxConfig = { enabled: true, mounts: [{ path: proj, mode: 'rw' }] }
  const { args } = wrapSandbox(cfg, ['--version'], proj)

  check('symlinked <cwd>/.claude under a symlinked ancestor is NOT bound',
    !bindsPath(args, planted), bindsPath(args, planted) ? `bound ${planted} → ${secret}` : '')
  check('the symlink target (out-of-mount secret) is never bound',
    !bindsPath(args, secret), bindsPath(args, secret) ? `bound ${secret} directly` : '')

  // The out-of-band authorizer (notebook MCP tools run UNSANDBOXED) must agree with the
  // box. If it disagrees, the server writes where the box cannot.
  const outside = sandboxPathAccess(cfg, proj, path.join(secret, 'key.txt'))
  check('sandboxPathAccess: a path outside every declared mount is not writable',
    !outside.write, `write=${outside.write} read=${outside.read}`)
  const viaLink = sandboxPathAccess(cfg, proj, path.join(planted, 'key.txt'))
  check('sandboxPathAccess: the planted symlink does not authorize its target',
    !viaLink.write, `write=${viaLink.write} read=${viaLink.read}`)

  // Control: the session's own real cwd must still work, or the fix over-corrected.
  const own = sandboxPathAccess(cfg, proj, path.join(proj, 'notebook.ipynb'))
  check('sandboxPathAccess: the session\'s OWN cwd is still writable (no over-correction)',
    own.write, `write=${own.write}`)
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. appSourceProtections — the ro overlay is emitted only when an rw mount is an
//    ancestor-or-equal of a source dir, compared LOGICALLY. When the app root is
//    canonical and the mount is named through a symlinked ancestor (or vice versa),
//    the comparison misses and the box gets the app's own source WRITABLE.
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n=== 3. appSourceProtections under a symlinked ancestor ===\n')
{
  // Fixture app tree: appSourceRoot() needs server/ + shared/ to look like the app.
  const real = path.join(base, 'real3'); fs.mkdirSync(real, { recursive: true })
  const appReal = path.join(real, 'app')
  for (const d of ['server', 'shared', 'web']) fs.mkdirSync(path.join(appReal, d), { recursive: true })
  const link = path.join(base, 'link3'); fs.symlinkSync(real, link)
  const appLogical = path.join(link, 'app')      // same tree, named through the symlink

  // The mismatch: app root is CANONICAL, the rw mount is the LOGICAL name.
  process.env.CLAUDETTE_APP_ROOT = appReal
  delete process.env.CLAUDETTE_ALLOW_APP_SOURCE_MOUNT
  const { wrapCommand, sandboxPathAccess, appSourceRoot } = await freshSandbox()
  console.log(`   (appSourceRoot=${appSourceRoot()}; rw mount=${appLogical})`)

  const cfg: SandboxConfig = { enabled: true, mounts: [{ path: appLogical, mode: 'rw' }] }
  const { args } = wrapCommand(cfg, appLogical, '/bin/sh', [])

  // The overlay may legitimately be emitted under either name — what must NOT happen is
  // that the source ends up writable. Check both spellings before concluding.
  const serverReal = path.join(appReal, 'server')
  const serverLogical = path.join(appLogical, 'server')
  const modeReal = effectiveMode(args, serverReal)
  const modeLogical = effectiveMode(args, serverLogical)
  const pinned = modeReal === 'ro' || modeLogical === 'ro'
  check('server/ is pinned READ-ONLY despite the symlinked-ancestor mount',
    pinned, `real=${modeReal} logical=${modeLogical}`)

  const sharedPinned = effectiveMode(args, path.join(appReal, 'shared')) === 'ro'
    || effectiveMode(args, path.join(appLogical, 'shared')) === 'ro'
  check('shared/ is pinned READ-ONLY despite the symlinked-ancestor mount', sharedPinned)

  // The authorizer must reach the same verdict as the box, under BOTH spellings of the
  // query. Keep both: sandboxPathAccess canonicalizes the query AND every mount root
  // (canonicalizeForAccess, sandbox.ts:539), which is what makes the two spellings meet,
  // so both must hold and neither is redundant.
  //
  // WHY THE OVERLAY MUST BE EMITTED LOGICALLY, not canonically — recorded here because it
  // is not obvious and the tempting "fix" is to emit at the realpath: `sortShallowFirst`
  // (sandbox.ts:676) orders overlays by RAW STRING depth while the containment test
  // compares CANONICALIZED paths. With a deep logical mount over a shallow real path, a
  // canonically-spelled overlay can sort first and LOSE the last-match-wins race, leaving
  // the app source writable. Same class as the two bugs this file exists for: one
  // representation sorted, a different one matched. Non-blocking while everything is
  // emitted logically; noted for Architect.
  const w1 = sandboxPathAccess(cfg, appLogical, path.join(serverReal, 'index.ts'))
  check('sandboxPathAccess: app server source not writable (canonical spelling)', !w1.write, `write=${w1.write}`)
  const w2 = sandboxPathAccess(cfg, appLogical, path.join(serverLogical, 'index.ts'))
  check('sandboxPathAccess: app server source not writable (symlinked spelling)', !w2.write, `write=${w2.write}`)

  // The rest of a mounted project must stay writable — the overlay is surgical, and a
  // fix that pins the whole mount ro would break every dev-in-app session.
  const w3 = sandboxPathAccess(cfg, appLogical, path.join(appLogical, 'web', 'App.tsx'))
  check('sandboxPathAccess: non-source project files stay writable (no over-correction)', w3.write, `write=${w3.write}`)

  delete process.env.CLAUDETTE_APP_ROOT
}

for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true })
console.log(`\n${pass} blocked, ${fail} finding(s)`)
process.exit(fail === 0 ? 0 : 1)
