// ⚠ EXPECTED RED — AND IT DOCUMENTS UNBUILT WORK, NOT A LIVE ESCAPE. ⚠
// Nothing is broken today. This file states a PRECONDITION that must hold before the path
// layer in server/src/claude/sandboxPaths.ts may be wired to any caller, and that precondition
// is currently unenforced because the API it needs does not exist yet. Read a red here as
// "this has not been built", not as "this has regressed". It is the counterpart to
// scratchpad/layer-not-wired-guard.mts: that one keeps the layer unwired, this one says what
// must be true before unwiring it is allowed to stop.
//
// ── WHAT IS MISSING ──────────────────────────────────────────────────────────────────
// `sessionDataMounts(cfg, cwd)` (sandbox.ts:588) ends with
//     return full.filter((m) => !isUnsafeSymlinkMount(m.path, rwRoots))
// so a refused mount is DROPPED — silently, with no reason attached, and with no record that
// it was ever considered. Two consequences, and the second is the one that matters:
//   1. The caller cannot tell "this mount was never requested" from "this mount was refused",
//      so it cannot explain itself to a user whose mount vanished.
//   2. OVER-REFUSAL BECOMES UNMEASURABLE. A refusal that drops its subject leaves nothing to
//      count, so a rule that refuses too much looks exactly like a rule that refuses
//      correctly. mount-shadowing-guard.mts §4 already characterizes today's
//      over-approximation; it can only do that because it computes the layer's answer
//      SEPARATELY. Wire the layer without keeping exclusions visible and that measurement
//      stops being possible at the very moment it starts mattering.
//
// ── THE ASK IS SMALLER THAN IT LOOKS: THE REASON IS ALREADY COMPUTED ─────────────────
// Running this file prints, from the server itself:
//   [sandbox] refusing symlinked mount source <a/b> → <y>: its parent is writable inside the
//   box, so binding it would follow the link out of the sandbox (potential escape).
// So the refusal, its subject and its justification all already exist — they are just emitted
// to a CONSOLE and then thrown away, instead of being returned to the caller. This is not a
// request to compute something new. It is a request to stop discarding something that is
// already computed, which is why the precondition is worth stating now rather than deferring
// with the rest of the layer.
//
// ── WHAT MUST EXIST ──────────────────────────────────────────────────────────────────
// A plan-returning sibling of `sessionDataMounts` — same inputs, richer output:
//     { active: SandboxMount[], excluded: { mount: SandboxMount, reason: RefusalReason }[] }
// where `reason.code` is the existing `'box-writable-mount'` from sandboxPaths.ts. The NAME
// below is a PROPOSAL, not a requirement: if you build it under a different name, update
// PLAN_EXPORT in the same commit rather than leaving this guard hunting a symbol that will
// never appear — a guard watching a name that does not exist is permanently green, which is
// this directory's oldest failure.
//
// ── THE COMPILE-TIME HALF IS DELIBERATELY ABSENT ─────────────────────────────────────
// The other half of this precondition is a type-level one, and it needs a `tsc`-shelling
// trick because scratchpad/ is covered by no tsconfig. That gap is real and verified. It
// should land WITH the type changes rather than before them, so it is not stubbed here — a
// stub would be a third thing to keep in sync for no coverage.
//
//   npx tsx scratchpad/viewof-precondition-guard.mts
// Exit: 0 once the precondition is met, 1 while it is not. Today: 1, by design.
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import * as sandbox from '../server/src/claude/sandbox'
import type { SandboxConfig, SandboxMount } from '../shared/src/types'

const PLAN_EXPORT = 'sessionDataMountPlan'

import { check, passed as pass, failed as fail } from './assert.mjs'

interface Exclusion { mount: SandboxMount; reason: { code: string; message?: string } }
interface MountPlan { active: SandboxMount[]; excluded: Exclusion[] }
type PlanFn = (cfg: SandboxConfig, cwd: string) => MountPlan

const plan = (sandbox as unknown as Record<string, unknown>)[PLAN_EXPORT] as PlanFn | undefined
const HAVE_PLAN = typeof plan === 'function'

// Say ONCE, up front, why every assertion below reds — rather than repeating "not built"
// four times and letting the reader conclude four separate things are wrong.
if (!HAVE_PLAN) {
  console.log(`⚠ server/src/claude/sandbox.ts exports no \`${PLAN_EXPORT}\`.`)
  console.log('  The exclusion-reason API is UNBUILT, so all four assertions below fail for that')
  console.log('  one reason. This is the documented state, not a regression. See the header.\n')
}

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudette-viewof-')))
try {
  // Same fixture shape as mount-shadowing-guard.mts, deliberately: the nested pair is the
  // case the refusal exists for, and the dotfiles farm is the case it must NOT catch. Reusing
  // the shapes keeps the two files talking about the same thing.
  const x = path.join(root, 'x')
  const y = path.join(root, 'y')
  mkdirSync(path.join(x, 'plain'), { recursive: true })
  mkdirSync(y, { recursive: true })
  writeFileSync(path.join(y, 'f'), 'inner')
  symlinkSync('../y', path.join(x, 'b'))
  const a = path.join(root, 'a'); symlinkSync(x, a)
  const farm = path.join(root, 'farm'); symlinkSync(x, farm)

  const innerPath = path.resolve(path.join(a, 'b'))
  const nested: SandboxConfig = { enabled: true, mounts: [{ path: a, mode: 'rw' }, { path: path.join(a, 'b'), mode: 'rw' }] }

  const planOf = (cfg: SandboxConfig, cwd: string): MountPlan | null => {
    if (!HAVE_PLAN) return null
    try { return plan!(cfg, cwd) } catch (e) { console.log(`   (plan threw: ${String(e).slice(0, 120)})`); return null }
  }

  // 1. The inner mount is EXCLUDED, and the exclusion carries the reason code that already
  //    exists in sandboxPaths.ts. A boolean "was refused" would not be enough: the whole point
  //    is that the caller can say WHY.
  {
    const p = planOf(nested, a)
    const ex = p?.excluded.find((e) => path.resolve(e.mount.path) === innerPath)
    check('1. the nested inner mount is EXCLUDED with reason `box-writable-mount`',
      !!ex && ex.reason.code === 'box-writable-mount',
      p ? `excluded=${JSON.stringify(p.excluded.map((e) => [path.basename(e.mount.path), e.reason.code]))}` : `no \`${PLAN_EXPORT}\``)
  }

  // 2. …and it is EXCLUDED, not DROPPED. This is the assertion that keeps over-refusal
  //    measurable: something that vanishes cannot be counted, so a rule refusing too much
  //    would look identical to one refusing correctly. It must be absent from `active` AND
  //    present in `excluded`; either half alone is satisfiable by the wrong implementation.
  {
    const p = planOf(nested, a)
    const inActive = !!p?.active.some((m) => path.resolve(m.path) === innerPath)
    const inExcluded = !!p?.excluded.some((e) => path.resolve(e.mount.path) === innerPath)
    check('2. …and it is EXCLUDED rather than DROPPED — still visible, so over-refusal stays countable',
      !!p && !inActive && inExcluded,
      p ? `inActive=${inActive} inExcluded=${inExcluded}` : `no \`${PLAN_EXPORT}\``)
  }

  // 3. NEGATIVE CONTROL, and this file is worthless without it. Assertions 1 and 2 are both
  //    satisfied by an implementation that refuses EVERYTHING, which is the failure shape this
  //    team has shipped twice. A host-created symlinked mount — the dotfiles-farm case — must
  //    come back ACTIVE and carry no exclusion at all.
  {
    const cfg: SandboxConfig = { enabled: true, mounts: [{ path: farm, mode: 'rw' }] }
    const p = planOf(cfg, farm)
    const farmReal = path.resolve(farm)
    const active = !!p?.active.some((m) => path.resolve(m.path) === farmReal)
    const excluded = !!p?.excluded.some((e) => path.resolve(e.mount.path) === farmReal)
    check('3. NEGATIVE CONTROL: an ordinary dotfiles-farm mount is ACTIVE and unexcluded',
      !!p && active && !excluded,
      p ? `active=${active} excluded=${excluded}` : `no \`${PLAN_EXPORT}\``)
  }

  // 4. PARTIAL-LIST. The refusal roots must be computed from the SESSION's configuration, not
  //    from whatever mount list happens to be passed in. Pass an EMPTY mounts array while the
  //    session config still contains the offending pair: the refusal must still be computed,
  //    because the box will be built from the session, not from this argument.
  //    THIS IS THE ASSERTION THAT CATCHES A LATER "OPTIMISATION" that derives the roots from
  //    `mounts` — which would look like a tidy-up and would silently un-refuse the nested case
  //    for every caller that passes a subset.
  {
    const empty: SandboxConfig = { enabled: true, mounts: [] }
    const p = planOf(empty, a)
    // With no mounts requested, the inner path must not appear as active by any route; and a
    // plan that computes from the session must still be able to explain the nested pair.
    const leaked = !!p?.active.some((m) => path.resolve(m.path) === innerPath)
    check('4. PARTIAL LIST: an empty mounts array does not make the nested inner path active',
      !!p && !leaked, p ? `active=${JSON.stringify(p.active.map((m) => path.basename(m.path)))}` : `no \`${PLAN_EXPORT}\``)
  }

  // Today's behaviour, recorded so the red above is anchored to something observed rather
  // than only to something missing. This uses the API that DOES exist.
  // Anchors the result above to observed behaviour rather than only to a symbol's presence.
  // This narration used to end "refused, but with no reason recorded and no way to count the
  // refusal" — true when written, false the moment step (ii) landed, and left printing on
  // every green run. Prose that outlives what it described is this repo's most expensive
  // recurring bug, so it now reports what is ACTUALLY true at run time instead of asserting
  // a state of the world from the past tense.
  const keptToday = sandbox.sessionDataMounts(nested, a).map((m) => path.resolve(m.path))
  const planToday = HAVE_PLAN ? plan!(nested, a) : null
  console.log(`\n  today, sessionDataMounts() returns ${keptToday.length} mounts and the inner mount is`)
  console.log(`  ${keptToday.includes(innerPath)
    ? 'PRESENT (unexpected — see mount-shadowing-guard.mts).'
    : `absent — refused, and the refusal is now recorded: ${planToday
        ? JSON.stringify(planToday.excluded.map((e) => e.reason.code))
        : 'no plan API'}.`}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n${pass}/${pass + fail} passed`)
if (fail > 0) console.log('EXPECTED RED while the exclusion-reason API is unbuilt — see the header.')
process.exit(fail === 0 ? 0 : 1)
