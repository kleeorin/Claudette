import { existsSync, realpathSync } from 'fs'
import path from 'path'
import type { SandboxMount } from '@claudette/shared'

export type LogicalPath = string & { readonly __logical: unique symbol }
export type RealPath = string & { readonly __real: unique symbol }

export function logical(p: string): LogicalPath {
  return path.resolve(p) as LogicalPath
}

export function real(p: string): RealPath | null {
  const abs = path.resolve(p)
  try { return realpathSync(abs) as RealPath } catch { /* not present; try the parent */ }
  try {
    return path.join(realpathSync(path.dirname(abs)), path.basename(abs)) as RealPath
  } catch { return null }
}

export interface ResolvedMount {
  mode: 'rw' | 'ro'
  logical: LogicalPath
  real: RealPath | null
  exists: boolean
  symlinked: boolean
}

export interface MountView { entries: ResolvedMount[] }

export function viewOf(mounts: SandboxMount[]): MountView {
  const entries = mounts.map((m): ResolvedMount => {
    const lg = logical(m.path)
    const rl = real(m.path)
    return { mode: m.mode, logical: lg, real: rl, exists: existsSync(lg), symlinked: rl !== null && (rl as string) !== (lg as string) }
  })
  // *** THIS SORT MUST NOT BE DELETED. *** It is what makes `entries` equal bwrap's ARGV
  // ORDER, and resolveReach's "last containing entry wins" is meaningful ONLY in that order —
  // without it the rule degrades to "last in some arbitrary order". Now that resolveReach
  // contains no depth arithmetic this will read like dead code to the next person. It is not:
  // the depth here is not a precedence rule, it is how the emission order is PRODUCED.
  const depth = (p: string): number => { let n = 0; for (let i = 0; i < p.length; i++) if (p[i] === path.sep) n++; return n }
  entries.sort((a, b) => depth(a.logical) - depth(b.logical) || a.logical.localeCompare(b.logical))
  return { entries }
}

function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep)
}

// Which mounts actually expose `target` INSIDE THE BOX — the box-space resolution, pulled
// out as a pure function over ResolvedMount[] so a test can construct a shadowing pair by
// hand. THE ENFORCEMENT BOUNDARY AND THE TESTABILITY BOUNDARY ARE DELIBERATELY DIFFERENT
// FUNCTIONS: viewOf enforces (and will get a closed constructor in step (ii)); this computes
// and stays open. The order-not-depth case cannot be produced through viewOf at all — viewOf
// sorts shallow-first, so in production a deeper mount is always emitted later and depth and
// order coincide. That coincidence is exactly what hid this fault, and it is why the fixture
// proving it has to be hand-built.
//
// R1 — `entriesInEmissionOrder` IS SEMANTIC INPUT. The name carries the obligation to every
// call site. Do NOT sort inside this function: that would destroy the very information it
// exists to read, and make it unable to model the case it was written for.
//
// The rule, in two steps, and NEITHER of them is about depth:
//   1. OWNER. bwrap applies binds in argv order and a bind covers its dest AND everything
//      beneath it, so a later bind covers an earlier one INCLUDING AN EARLIER DEEPER ONE.
//      The owner of a box path is simply the LAST entry whose LOGICAL root contains it.
//   2. ANY-GRANTS, NOT LAST-WINS. Two unrelated mountpoints can expose the same real bytes
//      with neither shadowing the other — both are live in the box at once — so asking only
//      "the last one" silently denies a write the box CAN perform. Measured against real
//      bwrap: the box wrote the file while the old code returned write:false.
export function resolveReach(entriesInEmissionOrder: ResolvedMount[], target: RealPath): ResolvedMount[] {
  // A mount bwrap will not bind contributes nothing — it cannot expose and it cannot shadow.
  const live = entriesInEmissionOrder.filter((m) => m.exists && m.real !== null)
  const out: ResolvedMount[] = []
  for (const m of live) {
    if (!contains(m.real as string, target as string)) continue
    // Map the host path into box space through THIS mount.
    const rel = (target as string) === (m.real as string)
      ? ''
      : (target as string).slice((m.real as string).length + 1)
    const boxPath = rel ? path.join(m.logical, rel) : (m.logical as string)
    // Step 1: is this mount still the owner of its own box path, or has a later bind
    // covered it? Depth never enters — only position in emission order.
    let owner: ResolvedMount | undefined
    for (const c of live) if (contains(c.logical, boxPath)) owner = c
    if (owner === m) out.push(m)
  }
  return out
}

export function boxCanReach(view: MountView, p: string, need: 'read' | 'write'): boolean {
  const target = real(p)
  if (target === null) return false
  // Step 2: ANY survivor grants. Not "the last survivor decides".
  const reach = resolveReach(view.entries, target)
  return need === 'write' ? reach.some((m) => m.mode === 'rw') : reach.length > 0
}

export interface RefusalReason {
  code: 'box-writable-mount'
  message: string
  mount: LogicalPath
}

export function refuseIfBoxCouldHavePlaced(view: MountView, p: string): RefusalReason | undefined {
  const target = logical(p)
  for (const m of view.entries) {
    if (m.mode !== 'rw' || !m.exists) continue
    const viaLogical = contains(m.logical, target)
    const viaReal = m.real !== null && contains(m.real, target)
    if (!viaLogical && !viaReal) continue
    return {
      code: 'box-writable-mount',
      mount: m.logical,
      message: `${target} lies inside the box-writable mount ${m.logical}`
        + (m.symlinked && m.real ? ` (which binds ${m.real})` : ''),
    }
  }
  return undefined
}

export function overlayPathFor(view: MountView, target: RealPath): LogicalPath | null {
  let best: ResolvedMount | undefined
  for (const m of view.entries) {
    if (!m.exists || m.real === null) continue
    if (contains(m.real, target)) best = m
  }
  if (!best || best.real === null) return null
  if ((target as string) === (best.real as string)) return best.logical
  const rel = (target as string).slice((best.real as string).length + 1)
  return path.join(best.logical, rel) as LogicalPath
}
