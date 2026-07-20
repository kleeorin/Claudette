// PROBE: does the notebook-MCP path authorizer (sandboxPathAccess / sessionDataMounts)
// diverge from the bwrap box for a BOX-PLANTED symlinked obligatory mount source?
//
// The bwrap box drops a box-writable symlinked mount via isUnsafeSymlinkMount. The
// authorizer canonicalizes the mount ROOT with realpath, so a symlinked <cwd>/.claude
// resolves to its TARGET and that target becomes an authorized rw root — letting the
// UNSANDBOXED notebook server write a .ipynb outside the box's real mounts.
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { sandboxPathAccess, sessionDataMounts, sandboxAvailable } from '../server/src/claude/sandbox.ts'
import type { SandboxConfig } from '../shared/src/index.ts'

const root = mkdtempSync(path.join(tmpdir(), 'sbx-symauth-'))
try {
  const proj = path.join(root, 'proj')        // the confined session's rw cwd
  const secret = path.join(root, 'secret')     // OUTSIDE every declared mount
  mkdirSync(proj, { recursive: true })
  mkdirSync(secret, { recursive: true })

  // The box (rw cwd) plants <cwd>/.claude -> secret. Its parent (proj) is box-writable.
  symlinkSync(secret, path.join(proj, '.claude'))

  // The session config: only proj is a declared rw mount (plus obligatory ~/.claude).
  const cfg: SandboxConfig = { enabled: true, mounts: [{ path: proj, mode: 'rw' }] }

  console.log(`(sandboxAvailable=${sandboxAvailable()})`)
  console.log('declared mounts (cfg):', JSON.stringify(cfg.mounts))
  console.log('sessionDataMounts roots the authorizer trusts:')
  for (const m of sessionDataMounts(cfg, proj)) console.log(`   ${m.mode}  ${m.path}`)

  // The escape target: a .ipynb OUTSIDE proj and OUTSIDE ~/.claude — reachable only via
  // the planted <cwd>/.claude -> secret symlink.
  const target = path.join(secret, 'evil.ipynb')
  const acc = sandboxPathAccess(cfg, proj, target)
  console.log(`\nsandboxPathAccess("${target}") => read=${acc.read} write=${acc.write}`)

  // Sanity: the target is genuinely outside the declared mounts.
  const insideDeclared =
    target === proj || target.startsWith(proj + path.sep) ||
    target.startsWith(path.resolve(process.env.HOME || '', '.claude') + path.sep)
  console.log(`target is inside a DECLARED mount? ${insideDeclared}`)

  if (acc.write && !insideDeclared) {
    console.log('\n❌ GAP: authorizer permits WRITE outside the declared mounts via a')
    console.log('   box-planted symlinked <cwd>/.claude — the unsandboxed notebook server')
    console.log('   would write the .ipynb to the symlink target on the host.')
    process.exitCode = 2
  } else {
    console.log('\n✅ authorizer refused the out-of-mount write (no divergence).')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
