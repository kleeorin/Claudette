// SANDBOX AVAILABILITY PROBE — true latched, FALSE NOT latched, failures logged with why.
// Field bug: a server restarted right after an OOM kill probed while the box was thrashing,
// the probe failed, and the false was cached for the server's life — every enabled:true session
// ran UNCONFINED, silently. Now a failure is re-probed after 30s (throttled), a later success
// sticks, resetSandboxProbe() still forces a fresh probe, and each failure logs status / signal /
// error code / stderr. Drives the REAL probe() against fake `bwrap` scripts on PATH, with the
// throttle clock injected.
//   npx tsx scratchpad/sandbox-probe-retry-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { check, passed, failed } from './assert.mjs'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-retry-')))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* best effort */ } })
const REAL_PATH = process.env.PATH ?? ''

const sb = await import('../server/src/claude/sandbox') as Record<string, unknown>
const sandboxAvailable = sb.sandboxAvailable as () => boolean
const resetSandboxProbe = sb.resetSandboxProbe as () => void
const setClock = sb.setSandboxProbeClockForTest as undefined | ((f: (() => number) | null) => void)
if (!setClock) console.log('⚠ setSandboxProbeClockForTest absent — expect RED')

// A fake bwrap whose behaviour is swapped by rewriting the script; each run is counted.
const fake = path.join(TMP, 'bin'); fs.mkdirSync(fake)
const count = path.join(TMP, 'runs')
const setFake = (body: string) => fs.writeFileSync(path.join(fake, 'bwrap'), `#!/bin/sh\necho x >> ${count}\n${body}\n`, { mode: 0o755 })
const runs = () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length : 0)
const DENY = 'echo "bwrap: setting up uid map: Permission denied" >&2; exit 1'
const OK = 'exit 0'
process.env.PATH = `${fake}:${REAL_PATH}`

let t = 1_000_000
setClock?.(() => t)
const warns: string[] = []
const origWarn = console.warn
console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }

try {
  // 1. a failing probe returns false and SAYS WHY
  setFake(DENY); resetSandboxProbe()
  check('1a a failing probe → false', sandboxAvailable() === false)
  const w = warns.at(-1) ?? ''
  check('1b …and is logged with status, signal, error and stderr', /probe FAILED/.test(w) && /status=1/.test(w) && /signal=none/.test(w) && /error=none/.test(w) && /uid map: Permission denied/.test(w), w)

  // 2. false is NOT latched, but re-probing is throttled
  setFake(OK)
  const r0 = runs()
  t += 10_000
  check('2a within 30s of a failure: still false, and bwrap is NOT spawned again', sandboxAvailable() === false && runs() === r0, `runs ${r0}→${runs()}`)
  t += 21_000
  check('2b after 30s: re-probed, and the host that recovered now reads TRUE', sandboxAvailable() === true && runs() === r0 + 1)
  check('2c the recovery is logged', /now SUCCEEDS after an earlier failure/.test(warns.at(-1) ?? ''), warns.at(-1))

  // 3. true IS latched — no further probes, even if bwrap would now fail
  setFake(DENY)
  const r1 = runs()
  t += 3_600_000
  check('3a true is cached for good: no re-probe, still true', sandboxAvailable() === true && sandboxAvailable() === true && runs() === r1)

  // 4. resetSandboxProbe still forces a fresh probe
  resetSandboxProbe()
  check('4a resetSandboxProbe → fresh probe (now failing) → false', sandboxAvailable() === false && runs() === r1 + 1)

  // 5. the other failure shapes are told apart in the log
  setFake('sleep 10'); resetSandboxProbe()
  const t0 = Date.now()
  sandboxAvailable()
  const wt = warns.at(-1) ?? ''
  check('5a a TIMEOUT is logged as such (signal + ETIMEDOUT), not as a denial', /signal=SIGTERM/.test(wt) && /error=ETIMEDOUT/.test(wt) && Date.now() - t0 < 9000, wt)
  const shOnly = path.join(TMP, 'shonly'); fs.mkdirSync(shOnly)
  fs.symlinkSync(fs.realpathSync('/bin/sh'), path.join(shOnly, 'sh'))
  process.env.PATH = shOnly
  resetSandboxProbe()
  sandboxAvailable()
  const we = warns.at(-1) ?? ''
  check('5b bwrap MISSING is logged as ENOENT', /error=ENOENT/.test(we) || /ENOENT/.test(we), we)
  process.env.PATH = REAL_PATH

  // 6. the real host: unchanged behaviour where bwrap works
  resetSandboxProbe()
  const real = sandboxAvailable()
  console.log(`(real host probe: ${real})`)
  check('6a nothing above disturbed the real probe on this host (bwrap works here)', real === true)
} finally {
  console.warn = origWarn
  process.env.PATH = REAL_PATH
  setClock?.(null)
  resetSandboxProbe()
}
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
