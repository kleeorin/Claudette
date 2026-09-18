// maxTeamSize — the stored setting ACTUALLY ENFORCED at hire time (server/src/mcp/teamTools.ts).
//
// ★ THE BUG THIS CLOSES. `teamTools.ts` hardcoded a ceiling of 6 while the settings UI offered
// a range up to 12. An operator could type 10, watch it save, watch it persist — and still be
// refused at 6. An ENABLED CONTROL THAT SILENTLY DOES NOTHING, which is the class this repo has
// now corrected several times and the one the settings contract was written to prevent.
//
// ★★ THE REGRESSION THIS FILE EXISTS TO PREVENT, AND THE MOST IMPORTANT ASSERTION IN IT:
// UNSET MUST STILL RESOLVE TO 6, NEVER TO THE CEILING. Nobody has a stored maxTeamSize, so the
// unset branch is the branch EVERY EXISTING INSTALL TAKES. If absent resolved to
// MAX_TEAM_SIZE_LIMIT, every install would have its team cap silently doubled on upgrade with
// no operator action and nothing on screen. "The default is the maximum" is the obvious-looking
// simplification, it is wrong, and it would be invisible in production — a bigger cap only
// shows up as a bill.
//
// Two layers are tested because they fail differently: resolveMaxTeamSize (pure, shared) and
// the ENFORCEMENT POINT in employ_teammate, which is where a correct resolver still gets
// ignored if nobody calls it.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { check, failed as fail } from './assert.mjs'
import {
  MIN_TEAM_SIZE, MAX_TEAM_SIZE_LIMIT, DEFAULT_MAX_TEAM_SIZE, resolveMaxTeamSize,
} from '../shared/src/settings.js'

const dir = mkdtempSync(path.join(tmpdir(), 'claudette-teamsize-'))
process.env.CLAUDETTE_DATA_DIR = dir

const { saveSettings, resetSettingsCache } = await import('../server/src/settings/settingsStore.js')
const { registerTeamTools } = await import('../server/src/mcp/teamTools.js')

try {
  // ── 1. THE RESOLVER ─────────────────────────────────────────────────────────────────────
  // ★ THE REGRESSION CASE, ASSERTED EXPLICITLY AND FIRST.
  // MUTATION THAT TURNS THIS RED: `return stored ?? MAX_TEAM_SIZE_LIMIT` in resolveMaxTeamSize.
  check('★ UNSET resolves to 6 — today\'s behaviour, preserved exactly',
    resolveMaxTeamSize(undefined) === DEFAULT_MAX_TEAM_SIZE,
    `got ${resolveMaxTeamSize(undefined)}, expected ${DEFAULT_MAX_TEAM_SIZE}`)
  // Pins the two apart, so the assertion above cannot pass by coincidence if someone sets the
  // default equal to the ceiling. Without this, 6===6 and 12===12 are indistinguishable when
  // DEFAULT is edited to 12.
  check('★ …and the default is NOT the ceiling (else the assertion above is vacuous)',
    DEFAULT_MAX_TEAM_SIZE !== MAX_TEAM_SIZE_LIMIT,
    `default=${DEFAULT_MAX_TEAM_SIZE} ceiling=${MAX_TEAM_SIZE_LIMIT}`)

  check('a stored value is honoured', resolveMaxTeamSize(10) === 10, `${resolveMaxTeamSize(10)}`)
  check(`the floor is honoured (${MIN_TEAM_SIZE})`,
    resolveMaxTeamSize(MIN_TEAM_SIZE) === MIN_TEAM_SIZE, `${resolveMaxTeamSize(MIN_TEAM_SIZE)}`)
  check(`the ceiling is honoured (${MAX_TEAM_SIZE_LIMIT})`,
    resolveMaxTeamSize(MAX_TEAM_SIZE_LIMIT) === MAX_TEAM_SIZE_LIMIT,
    `${resolveMaxTeamSize(MAX_TEAM_SIZE_LIMIT)}`)
  // CLAMPED, not honoured and not defaulted. Out-of-range can only arrive from a hand-edited
  // settings.json, since the store validates the save path.
  check('above the ceiling is CLAMPED to the ceiling, not honoured',
    resolveMaxTeamSize(MAX_TEAM_SIZE_LIMIT + 50) === MAX_TEAM_SIZE_LIMIT,
    `${resolveMaxTeamSize(MAX_TEAM_SIZE_LIMIT + 50)}`)
  check('below the floor is CLAMPED to the floor, not defaulted to 6',
    resolveMaxTeamSize(-3) === MIN_TEAM_SIZE, `${resolveMaxTeamSize(-3)}`)
  check('NaN falls back to the default rather than clamping to a bound',
    resolveMaxTeamSize(NaN) === DEFAULT_MAX_TEAM_SIZE, `${resolveMaxTeamSize(NaN)}`)

  // ── 2. THE ENFORCEMENT POINT ────────────────────────────────────────────────────────────
  // A correct resolver still does nothing if the hire path never calls it, so drive the real
  // employ_teammate handler. Captured from registerTeamTools rather than re-implemented: the
  // question is what the SHIPPING handler does.
  // Matches AppControlMcpServer.register({ name, handler }) with handler(sid, args) — captured
  // from the real registrar rather than re-implemented, so the assertions below exercise the
  // SHIPPING handler and not a paraphrase of it.
  type Handler = (sid: string, args: Record<string, unknown>) => Promise<unknown> | unknown
  const handlers = new Map<string, Handler>()
  const server = {
    register: (tool: { name: string; handler: Handler }) => { handlers.set(tool.name, tool.handler) },
  } as never

  const COORD = 'coordinator-session'
  let roster: Array<{ id: string; name: string }> = []
  const sessions = {
    get: (id: string) => (id === COORD ? { id: COORD, cwd: '/tmp', rootDir: '/tmp', parentId: undefined } : undefined),
    childrenOf: () => roster,
    canEmploy: () => true,
    create: (name: string) => { const id = `hire-${roster.length + 1}`; roster.push({ id, name }); return id },
    list: () => [{ id: COORD, cwd: '/tmp', rootDir: '/tmp' }, ...roster],
  } as never

  registerTeamTools(server, sessions, {} as never)
  const employ = handlers.get('employ_teammate')
  check('the employ_teammate handler was registered (else nothing below is exercised)',
    typeof employ === 'function', [...handlers.keys()].join(', '))

  // Hiring until refused, and reporting the count, is what makes this test independent of the
  // numbers: it measures the cap the SHIPPING CODE enforces rather than asserting a literal.
  const hireUntilRefused = async (limit = 40): Promise<number> => {
    roster = []
    for (let i = 0; i < limit; i++) {
      const r = await employ!(COORD, { role: 'general', name: `t${i}` }) as { error?: string }
      if (r && typeof r === 'object' && 'error' in r && r.error) return roster.length
    }
    return -1   // never refused within `limit` — a cap that does not bind is a failure, not a pass
  }

  // ★ THE HEADLINE: with nothing stored, the enforced cap must still be 6.
  // MUTATION THAT TURNS THIS RED: resolve unset to MAX_TEAM_SIZE_LIMIT.
  resetSettingsCache()
  const unsetCap = await hireUntilRefused()
  check('★ with NO stored setting, hiring is refused at 6 (no silent doubling on upgrade)',
    unsetCap === DEFAULT_MAX_TEAM_SIZE, `refused after ${unsetCap} hires, expected ${DEFAULT_MAX_TEAM_SIZE}`)

  // ★ THE FIX ITSELF: a stored 10 must permit a 7th hire, where today's hardcoded 6 refuses.
  // MUTATION THAT TURNS THIS RED: restore the local `const MAX_TEAM_SIZE = 6`.
  saveSettings({ maxTeamSize: 10 })
  const storedCap = await hireUntilRefused()
  check('★ a stored 10 is ENFORCED — the control is no longer lying',
    storedCap === 10, `refused after ${storedCap} hires, expected 10`)
  check('★ …and that is strictly more than the old hardcoded ceiling',
    storedCap > DEFAULT_MAX_TEAM_SIZE, `${storedCap} vs ${DEFAULT_MAX_TEAM_SIZE}`)

  saveSettings({ maxTeamSize: MIN_TEAM_SIZE })
  check(`a stored floor of ${MIN_TEAM_SIZE} is enforced`,
    (await hireUntilRefused()) === MIN_TEAM_SIZE, '')

  // The setting is read PER HIRE, not cached at module load — otherwise a change in the panel
  // would need a server restart, which is its own silent no-op.
  // MUTATION THAT TURNS THIS RED: hoist maxTeamSize() to a module-level const.
  saveSettings({ maxTeamSize: 8 })
  check('a settings change applies to the very next hire, with no restart',
    (await hireUntilRefused()) === 8, '')

  // ── 3. LOWERING THE CAP NEVER DISMISSES ANYONE ──────────────────────────────────────────
  // The cap governs NEW HIRES only. The panel promises this explicitly, and it is the property
  // an operator is most likely to test by accident.
  roster = []
  saveSettings({ maxTeamSize: 8 })
  for (let i = 0; i < 8; i++) await employ!(COORD, { role: 'general', name: `keep${i}` })
  check('eight teammates were hired under a cap of 8', roster.length === 8, `${roster.length}`)
  saveSettings({ maxTeamSize: 2 })   // lower it well below the current roster
  const after = await employ!(COORD, { role: 'general', name: 'one-too-many' }) as { error?: string }
  check('★ lowering the cap below the roster dismisses NOBODY', roster.length === 8,
    `roster is now ${roster.length}, expected all 8 kept`)
  check('…and only the NEXT hire is refused', typeof after?.error === 'string', JSON.stringify(after))
  // ★ THIS ASSERTION WAS VACUOUS UNTIL 2026-09-17 AND COULD NOT FAIL FOR ITS OWN REASON.
  // It read `after.error.includes('2')`. The refusal names the roster — "(keep0, keep1,
  // keep2, …)" — so the substring "2" is present whatever cap is quoted: a message saying
  // "limit of 8", i.e. the OLD cap, passed it. The half the name actually promises ("not the
  // old one") was the half nothing checked.
  // Pinned on the PHRASE now, plus the negative, because "names the new cap" and "does not
  // name the old one" are two claims and only asserting both makes the name true. Matching
  // `limit of N` rather than the whole sentence keeps this green when the message gains
  // clauses — it is deliberately not a full-text pin.
  //
  // MUTATIONS (measured 2026-09-17, on a COPY; ran=18 on every one — constant, so none died on
  // a parse error and scored a fake pass):
  //   T1      teamTools quotes `roster.length` instead of `cap`, i.e. names the OLD cap
  //           → red=1. Caught.
  //   T1-old  the IDENTICAL mutant, measured against the ORIGINAL `includes('2')` assertion
  //           → red=0. SURVIVED. That pair is the whole evidence: the message said "limit of
  //           8" — the old cap, the exact thing this check is named for — and the old
  //           assertion passed, because the roster string contains "keep2".
  //   T2      the cap number dropped from the message entirely → red=1. Caught.
  //   XX      a patch matching no text must REFUSE — it did, 0 matches, no run performed.
  check('…with the refusal naming the new cap, not the old one',
    typeof after?.error === 'string' && /\blimit of 2\b/.test(after.error) && !/\blimit of 8\b/.test(after.error),
    after?.error ?? '')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

process.exit(fail === 0 ? 0 : 1)
