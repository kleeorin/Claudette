// Tests for GPU passthrough (SANDBOX.md "GPU passthrough", SandboxConfig.gpu).
//
// The whole feature turns on one bwrap detail: an ordinary `--bind` of a device node
// carries MS_NODEV, so the node appears inside the box but is DEAD — nvidia-smi reports
// "Insufficient Permissions" and CUDA finds no device, which reads like a broken driver
// rather than a mount problem. Only `--dev-bind` actually grants access. So the tests
// assert the emitted FLAG, not just that the path shows up somewhere in the argv, and —
// on a host that really has a GPU — prove the distinction by running nvidia-smi both ways.
//
// Also covered: the flag is part of sandboxKey (or toggling it wouldn't relaunch), it
// reaches the notebook-kernel box via wrapCommand, and it is trust-gated ON (it WIDENS
// the box, the mirror image of enabled:false being trust-gated OFF).
//
//   npx tsx scratchpad/sandbox-gpu-passthrough-test.mts
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  wrapSandbox, wrapCommand, sandboxKey, sandboxAvailable, sandboxSystemPrompt, gpuDevicePaths,
} from '../server/src/claude/sandbox'
import { normalizeSandbox } from '../server/src/claude/sessionManager'
import type { SandboxConfig } from '../shared/src/types'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbxgpu-'))
const proj = path.join(root, 'proj')
fs.mkdirSync(proj, { recursive: true })

const devs = gpuDevicePaths()
console.log(`(host sandboxAvailable=${sandboxAvailable()}; gpuDevices=${devs.length ? devs.join(' ') : '<none>'})\n`)

const off: SandboxConfig = { enabled: true, mounts: [{ path: proj, mode: 'rw' }] }
const on: SandboxConfig = { ...off, gpu: true }

// Which flag (if any) binds `p` as a mountpoint onto itself?
function bindFlag(args: string[], p: string): string | null {
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i].endsWith('-bind') && args[i + 1] === p && args[i + 2] === p) return args[i]
  }
  return null
}

// --- 1. Discovery -------------------------------------------------------------
// The node set is discovered, never configured. On a host with an NVIDIA card the
// control nodes are mandatory: nvidia0 alone leaves CUDA init failing.
const hasNvidia = fs.existsSync('/dev/nvidia0')
if (hasNvidia) {
  check('discovery: includes the per-card node /dev/nvidia0', devs.includes('/dev/nvidia0'))
  check('discovery: includes /dev/nvidiactl (CUDA init fails without it)', devs.includes('/dev/nvidiactl'))
  check('discovery: includes /dev/nvidia-uvm (unified memory)', devs.includes('/dev/nvidia-uvm'))
} else {
  console.log('… no /dev/nvidia0 on this host; skipping NVIDIA discovery assertions')
}
check('discovery: every returned path exists', devs.every((d) => fs.existsSync(d)))

// --- 2. Off by default --------------------------------------------------------
const argsOff = wrapSandbox(off, ['-p', 'hi'], proj).args
check('gpu off: no --dev-bind of any GPU node',
  devs.every((d) => bindFlag(argsOff, d) === null))
check('gpu off: bwrap still gets its minimal --dev /dev',
  argsOff.some((a, i) => a === '--dev' && argsOff[i + 1] === '/dev'))

// --- 3. On: the RIGHT flag, in the RIGHT place --------------------------------
const argsOn = wrapSandbox(on, ['-p', 'hi'], proj).args
if (devs.length) {
  check('gpu on: every device is bound with --dev-bind',
    devs.every((d) => bindFlag(argsOn, d) === '--dev-bind'),
    devs.map((d) => `${d}=${bindFlag(argsOn, d)}`).join(' '))
  // The MS_NODEV trap: a plain --bind here would look right and silently not work.
  check('gpu on: NO device is bound with a plain --bind/--ro-bind (MS_NODEV would kill it)',
    devs.every((d) => bindFlag(argsOn, d) !== '--bind' && bindFlag(argsOn, d) !== '--ro-bind'))
  // Order decides: --dev /dev mounts a fresh devtmpfs that would wipe an earlier bind.
  const devIdx = argsOn.findIndex((a, i) => a === '--dev' && argsOn[i + 1] === '/dev')
  check('gpu on: --dev-bind lines come AFTER `--dev /dev` (later bind wins)',
    devs.every((d) => argsOn.indexOf(d) > devIdx))
} else {
  check('gpu on, GPU-less host: emits no --dev-bind at all (honest no-op)',
    !argsOn.includes('--dev-bind'))
}

// --- 4. The kernel box gets it too --------------------------------------------
// Most GPU work runs in a notebook, not the CLI, and kernels are confined via wrapCommand.
const kern = wrapCommand(on, proj, 'python3', ['-c', 'pass']).args
const kernOff = wrapCommand(off, proj, 'python3', ['-c', 'pass']).args
if (devs.length) {
  check('wrapCommand (notebook kernel): gpu on → devices --dev-bind’d',
    devs.every((d) => bindFlag(kern, d) === '--dev-bind'))
  check('wrapCommand (notebook kernel): gpu off → no devices',
    devs.every((d) => bindFlag(kernOff, d) === null))
}

// --- 5. Toggling relaunches ---------------------------------------------------
// sandboxKey is what launchStale() compares; if gpu weren't in it, ticking the box would
// leave the running engine on its old devices with no "pending" mark and no relaunch.
check('sandboxKey: differs between gpu on and off',
  sandboxKey(on, proj) !== sandboxKey(off, proj),
  `${sandboxKey(off, proj)} vs ${sandboxKey(on, proj)}`)

// --- 6. Trust gate ------------------------------------------------------------
// gpu WIDENS the box, so an untrusted caller (anything in-process / not the auth-gated
// operator route) must not be able to turn it on — mirror image of enabled:false.
check('normalizeSandbox: UNTRUSTED gpu:true is refused',
  normalizeSandbox(on, proj, /* trusted */ false).gpu !== true)
check('normalizeSandbox: TRUSTED gpu:true is kept',
  normalizeSandbox(on, proj, /* trusted */ true).gpu === true)
check('normalizeSandbox: gpu survives the forced-on branch (untrusted enabled:false)',
  normalizeSandbox({ ...on, enabled: false }, proj, false).enabled === true)
check('normalizeSandbox: absent gpu stays absent (no accidental default-on)',
  normalizeSandbox(off, proj, true).gpu !== true)

// --- 7. The session is told ---------------------------------------------------
const promptOn = sandboxSystemPrompt(on, proj)
const promptOff = sandboxSystemPrompt(off, proj)
check('system prompt: gpu off → told it has NO GPU (so it won’t report a broken driver)',
  /NO GPU access/.test(promptOff))
check('system prompt: gpu on → told the GPU is passed through',
  devs.length ? /GPU IS passed through/.test(promptOn) : /NO GPU access/.test(promptOn))

// --- 8. LIVE proof (needs a real GPU + a working bwrap) -----------------------
// This is the assertion the whole design rests on. Runs nvidia-smi inside a box built
// both ways; --bind must FAIL and --dev-bind must SUCCEED.
const bwrapOk = sandboxAvailable() && spawnSync('bwrap', ['--version']).status === 0
if (hasNvidia && bwrapOk && spawnSync('nvidia-smi', ['-L']).status === 0) {
  const nodes = devs.filter((d) => fs.statSync(d).isCharacterDevice())
  const run = (flag: string) => spawnSync('bwrap', [
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    ...nodes.flatMap((d) => [flag, d, d]),
    '--', 'nvidia-smi', '-L',
  ], { encoding: 'utf8' })
  const plain = run('--bind')
  const devBind = run('--dev-bind')
  check('LIVE: plain --bind → nvidia-smi FAILS (MS_NODEV; the node is present but dead)',
    plain.status !== 0, (plain.stdout + plain.stderr).trim().split('\n')[0])
  check('LIVE: --dev-bind → nvidia-smi SUCCEEDS and enumerates the GPU',
    devBind.status === 0 && /GPU 0:/.test(devBind.stdout),
    devBind.stdout.trim().split('\n')[0])
  // And the real emitter's argv works end-to-end, not just a hand-built one.
  const real = wrapSandbox(on, [], proj).args
  const upTo = real.slice(0, real.length - 1)   // drop the trailing `claude`
  const live = spawnSync('bwrap', [...upTo, 'nvidia-smi', '-L'], { encoding: 'utf8' })
  check('LIVE: wrapSandbox’s own argv gives the box a working GPU',
    live.status === 0 && /GPU 0:/.test(live.stdout),
    (live.stdout + live.stderr).trim().split('\n')[0])
} else {
  console.log('… skipping LIVE checks (needs a working bwrap + an NVIDIA GPU on this host)')
}

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
