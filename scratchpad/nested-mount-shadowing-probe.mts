// PROBE (analysis only): does the out-of-band authorizer over-approximate REACH when one
// mount nests inside another with a different source? Architect's hypothesis, untested.
//
// bwrap layers binds by DEST. Mount M1 (src /x → dest /a) then M2 (src /y → dest /a/b):
// inside the box, /a/b shows /y, so /x/b is SHADOWED and unreachable. If sandboxPathAccess
// still reports /x/b/f reachable, the unsandboxed notebook tools would authorize a write
// the box itself cannot perform — an over-approximation in the fail-OPEN direction.
//
// NOT exotic: "mount my project, and mount the shared data dir inside it" is an ordinary
// operator configuration.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { sandboxPathAccess } from '../server/src/claude/sandbox.ts'
import type { SandboxConfig } from '../shared/src/index.ts'

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nest-')))
try {
  const x = path.join(root, 'x')          // M1 source
  const y = path.join(root, 'y')          // M2 source, mounted INSIDE M1's dest
  mkdirSync(path.join(x, 'b'), { recursive: true })
  mkdirSync(y, { recursive: true })
  writeFileSync(path.join(x, 'b', 'f'), 'shadowed by the nested mount\n')
  writeFileSync(path.join(y, 'visible'), 'this is what the box sees at <dest>/b\n')

  // dest paths: /a and /a/b. Use x itself as the dest root so logical==real for M1,
  // isolating the nesting effect from the symlink effect.
  const cfg: SandboxConfig = {
    enabled: true,
    mounts: [{ path: x, mode: 'rw' }, { path: path.join(x, 'b'), mode: 'rw' }],
  }
  // Wait: M2's dest is <x>/b and its SOURCE is also <x>/b in that spelling. To make source
  // differ from dest we need the config to name y. bwrap binds src→dest; SandboxMount has
  // one path, so Claudette can only express dest==src. Record that.
  const shadowed = path.join(x, 'b', 'f')
  const a = sandboxPathAccess(cfg, x, shadowed)
  console.log(`mounts: rw ${x}   rw ${path.join(x, 'b')}`)
  console.log(`sandboxPathAccess("${shadowed}") => read=${a.read} write=${a.write}`)
  console.log(`\nNOTE: SandboxMount carries ONE path, so a mount's source and dest are always`)
  console.log(`the same string. A mount whose source differs from its dest is NOT expressible`)
  console.log(`in this config type — which is what bounds the hypothesis. See report.`)
} finally { rmSync(root, { recursive: true, force: true }) }
