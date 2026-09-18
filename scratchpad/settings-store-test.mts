// The app-settings store (server/src/settings/settingsStore.ts) — the operator's app-wide
// defaults and team ceiling.
//
// Drives the REAL module against a throwaway CLAUDETTE_DATA_DIR, so every assertion is about
// what actually lands on disk rather than a re-implementation of it. The env var is set before
// the first store call rather than before the import, which is safe because dataDir() reads
// process.env on every call (util/dataDir.ts) — and with the override set it also skips
// migrateLegacy entirely, so this never touches ~/.claude.
//
// WHAT THIS IS REALLY FOR. Two things, and neither is "does it round-trip".
//
//  1. THE TWO VERBS MUST NOT RE-MERGE. save SETS and never clears; reset CLEARS one key. The
//     contract was split because a nullable save carries three states in a type that says two.
//     A `save({key: null})` that silently cleared would rebuild the merged verb through the
//     back door and nothing else in the codebase would notice, so it is asserted here.
//  2. THE LOAD PATH MUST ENFORCE WHAT THE SAVE PATH PROMISES. settings.json is hand-editable,
//     and sandboxDefaults.ts records the lesson at length: a guard that restores a SUBSET of
//     the invariants its callers assume is worse than none, because the survivors look
//     validated. So every bad value refused on save is also asserted dropped on load.
//
// ⚠ NOTE WHAT THIS FILE DOES NOT AND CANNOT TEST: that any of these settings DO anything.
// It tests STORAGE. Whether a key is obeyed is a separate question tested elsewhere —
// `maxTeamSize` is obeyed at the hire path (team-size-setting-test.mts); defaultModel,
// defaultAgentId and defaultPermissionMode are still read by nothing. A fully green run here
// is compatible with all four being inert.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { check, failed as fail } from './assert.mjs'
import {
  APP_SETTINGS_KEYS, MIN_TEAM_SIZE, MAX_TEAM_SIZE_LIMIT,
} from '../shared/src/settings.js'
// PERMISSION_MODES lives beside the PermissionMode union in types.ts, NOT in settings.ts —
// importing it from settings.js made this file throw at MODULE LOAD, before a single
// assertion ran. It went unnoticed because the file was never registered in run-suite.sh:
// a crash-on-import and a clean pass are indistinguishable from outside, which is the exact
// claim registration-lint's header makes.
import { PERMISSION_MODES, isElevatedMode } from '../shared/src/types.js'

const dir = mkdtempSync(path.join(tmpdir(), 'claudette-settings-'))
process.env.CLAUDETTE_DATA_DIR = dir

const store = await import('../server/src/settings/settingsStore.js')
const { getSettings, saveSettings, resetSetting, resetSettingsCache } = store

const file = path.join(dir, 'settings.json')
// Assert against the BYTES ON DISK, not the in-memory return value: the cache would happily
// report a value that never got written.
const onDisk = (): Record<string, unknown> =>
  existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}

try {
  // --- a fresh install ------------------------------------------------------------------
  check('a fresh install has no settings', Object.keys(getSettings()).length === 0,
    JSON.stringify(getSettings()))
  check('and writes no file until something is saved', !existsSync(file), file)

  // --- the SET-ONLY verb -----------------------------------------------------------------
  const s1 = saveSettings({ defaultModel: 'opus' })
  check('saving one key succeeds', s1.ok === true, JSON.stringify(s1))
  check('and it reaches the FILE, not just the cache', onDisk().defaultModel === 'opus',
    JSON.stringify(onDisk()))

  saveSettings({ maxTeamSize: 4 })
  check('saving a SECOND key leaves the first untouched (save is set-only, not replace)',
    onDisk().defaultModel === 'opus' && onDisk().maxTeamSize === 4,
    `got ${JSON.stringify(onDisk())} — an omitted key must be preserved, not dropped`)

  // ★ THE ANTI-MERGE ASSERTION. If this ever goes green-by-clearing, the two verbs have
  // silently become one again.
  // MUTATION THAT TURNS THIS RED: in saveSettings, replace the null/undefined refusal with
  // `delete next[k]`.
  const nulled = saveSettings({ defaultModel: null })
  check('save with an explicit null is REFUSED, not treated as a clear',
    nulled.ok === false, JSON.stringify(nulled))
  check('…and the refused save changed nothing on disk', onDisk().defaultModel === 'opus',
    `got ${JSON.stringify(onDisk())}`)

  const undef = saveSettings({ defaultModel: undefined })
  check('save with an explicit undefined is refused the same way', undef.ok === false,
    JSON.stringify(undef))

  check('saving an unknown key is refused', saveSettings({ nonsense: 1 }).ok === false,
    JSON.stringify(saveSettings({ nonsense: 1 })))

  // VALIDATE-ALL-BEFORE-WRITE-ANY. A partial application leaves the operator with half an
  // edit applied and an error message, unable to tell which half landed.
  // MUTATION THAT TURNS THIS RED: move the persist() inside the validation loop.
  const mixed = saveSettings({ defaultAgentId: 'reviewer', maxTeamSize: 999 })
  check('a batch with one bad key is refused WHOLE — the good key is not written either',
    mixed.ok === false && onDisk().defaultAgentId === undefined,
    `ok=${mixed.ok} disk=${JSON.stringify(onDisk())}`)

  // --- reset -----------------------------------------------------------------------------
  const r1 = resetSetting('defaultModel')
  check('reset clears exactly its own key', r1.ok === true && onDisk().defaultModel === undefined,
    JSON.stringify(onDisk()))
  check('…and leaves its siblings alone', onDisk().maxTeamSize === 4, JSON.stringify(onDisk()))

  check('resetting an UNKNOWN key is a refusal, not a silent success',
    resetSetting('nonsense').ok === false, JSON.stringify(resetSetting('nonsense')))
  check('resetting a key that is merely UNSET is a success (the intent is already true)',
    resetSetting('defaultAgentId').ok === true, JSON.stringify(resetSetting('defaultAgentId')))

  // --- maxTeamSize bounds, DERIVED from the exported constants ---------------------------
  // Deliberately not retyped as 1/12/0/13: if the bounds move, this test must move with them,
  // and a hand-typed 12 would keep passing against a limit that had become 20.
  resetSettingsCache()
  check(`maxTeamSize accepts the floor (${MIN_TEAM_SIZE})`,
    saveSettings({ maxTeamSize: MIN_TEAM_SIZE }).ok === true, `${MIN_TEAM_SIZE}`)
  check(`maxTeamSize accepts the ceiling (${MAX_TEAM_SIZE_LIMIT})`,
    saveSettings({ maxTeamSize: MAX_TEAM_SIZE_LIMIT }).ok === true, `${MAX_TEAM_SIZE_LIMIT}`)
  check(`maxTeamSize refuses one below the floor (${MIN_TEAM_SIZE - 1})`,
    saveSettings({ maxTeamSize: MIN_TEAM_SIZE - 1 }).ok === false, `${MIN_TEAM_SIZE - 1}`)
  check(`maxTeamSize refuses one above the ceiling (${MAX_TEAM_SIZE_LIMIT + 1})`,
    saveSettings({ maxTeamSize: MAX_TEAM_SIZE_LIMIT + 1 }).ok === false, `${MAX_TEAM_SIZE_LIMIT + 1}`)
  // MEASURED, and the first version of this comment was wrong about which check does the work.
  // Dropping Number.isInteger from settingsStore turns the FRACTION case red and leaves NaN
  // GREEN — because the bounds are written as an acceptance (`v >= MIN && v <= MAX`) and every
  // comparison with NaN is false, so NaN is already refused without isInteger's help. Both
  // cases are kept, for different reasons: the fraction pins isInteger, and NaN pins the
  // acceptance FORM of the bounds. Rewriting them as a rejection (`if (v < MIN || v > MAX)`)
  // would let NaN through both comparisons, and this is the assertion that would catch it.
  // MUTATION THAT TURNS THE FRACTION RED: drop Number.isInteger from the maxTeamSize check.
  // MUTATION THAT TURNS NaN RED: rewrite those bounds as a rejection.
  check('maxTeamSize refuses NaN (pins the ACCEPTANCE form of the bounds)',
    saveSettings({ maxTeamSize: NaN }).ok === false, 'NaN')
  check('maxTeamSize refuses a fraction inside the range (pins Number.isInteger)',
    saveSettings({ maxTeamSize: 2.5 }).ok === false, '2.5')
  check('maxTeamSize refuses a numeric STRING (the wire is JSON; "4" is not 4)',
    saveSettings({ maxTeamSize: '4' }).ok === false, '"4"')

  // ★ THE WEB COPY OF THESE BOUNDS MUST NOT DRIFT FROM THE SHARED ONE.
  // web/src/lib/settingsLogic.ts still declares its own MIN/MAX today rather than re-exporting
  // from @claudette/shared. Two validators that must agree, with two sources of truth, is the
  // drift this repo keeps correcting — so until that file re-exports, they are pinned HERE.
  // Read as text rather than imported: settingsLogic.ts is a web module and importing it drags
  // in the web tsconfig's path aliases for no benefit; the numbers are what matter.
  const logic = readFileSync(path.join(import.meta.dirname, '../web/src/lib/settingsLogic.ts'), 'utf8')
  const webMax = logic.match(/MAX_TEAM_SIZE_LIMIT\s*=\s*(\d+)/)?.[1]
  const webMin = logic.match(/MIN_TEAM_SIZE\s*=\s*(\d+)/)?.[1]
  // Fail if the pattern stops matching, rather than comparing undefined === undefined and
  // calling it agreement — a regex that matches nothing must not read as a pass.
  check('the web bounds are still findable in settingsLogic.ts (else this guard is inert)',
    webMax !== undefined && webMin !== undefined, `max=${webMax} min=${webMin}`)
  check('the web maxTeamSize ceiling agrees with the shared one',
    Number(webMax) === MAX_TEAM_SIZE_LIMIT, `web=${webMax} shared=${MAX_TEAM_SIZE_LIMIT}`)
  check('the web maxTeamSize floor agrees with the shared one',
    Number(webMin) === MIN_TEAM_SIZE, `web=${webMin} shared=${MIN_TEAM_SIZE}`)

  // --- defaultPermissionMode: ITERATE the population, never hand-list it ------------------
  // A fifth mode added to PERMISSION_MODES must fail loudly here rather than being silently
  // uncovered by a test that listed four by hand.
  check('PERMISSION_MODES is non-empty (else the loops below assert nothing)',
    PERMISSION_MODES.length > 0, `${PERMISSION_MODES.length}`)

  // ★ ELEVATION IS A LIVE DECISION, NOT A PERSISTED ATTRIBUTE. A stored default that elevates
  // would grant privilege to every FUTURE session with no human present at the moment it is
  // taken — the sibling of the case downgradeRestoredMode covers for a restored session.
  //
  // Both populations are DERIVED from PERMISSION_MODES via isElevatedMode rather than listed,
  // so a fifth mode lands in whichever loop its own classification puts it in and is never
  // silently uncovered. Both are guarded as non-empty: if either partition were empty its loop
  // would assert nothing while still reading as a pass, which is the failure these tests exist
  // to prevent one level down.
  const elevated = PERMISSION_MODES.filter(isElevatedMode)
  const safe = PERMISSION_MODES.filter((m) => !isElevatedMode(m))
  check('there is at least one ELEVATED mode (else the refusal loop asserts nothing)',
    elevated.length > 0, JSON.stringify(elevated))
  check('there is at least one NON-elevated mode (else the acceptance loop asserts nothing)',
    safe.length > 0, JSON.stringify(safe))

  for (const m of safe) {
    check(`defaultPermissionMode accepts the non-elevated mode "${m}"`,
      saveSettings({ defaultPermissionMode: m }).ok === true, m)
  }
  // MUTATION THAT TURNS THIS RED: drop the isElevatedMode branch from CHECKS.
  for (const m of elevated) {
    const r = saveSettings({ defaultPermissionMode: m })
    check(`★ defaultPermissionMode REFUSES the elevated mode "${m}"`, r.ok === false, JSON.stringify(r))
    // The message is rendered verbatim to the operator, so it must say WHY, not just "no".
    check(`…and the refusal for "${m}" explains itself`,
      r.ok === false && /elevat/i.test(r.error), r.ok === false ? r.error : '')
  }
  check('defaultPermissionMode refuses a junk string',
    saveSettings({ defaultPermissionMode: 'banana' }).ok === false, 'banana')

  // --- free-text keys --------------------------------------------------------------------
  check('defaultModel refuses an empty string (absent already means "no preference")',
    saveSettings({ defaultModel: '   ' }).ok === false, '"   "')
  check('defaultModel refuses a non-string', saveSettings({ defaultModel: 7 }).ok === false, '7')

  // --- THE LOAD PATH ENFORCES WHAT THE SAVE PATH PROMISES ---------------------------------
  // GOOD KEYS ON BOTH SIDES OF THE BAD ONES, deliberately. sandbox-defaults-test records why:
  // with a lone bad entry, "drop the bad ones" and "empty the whole thing" produce the SAME
  // result, so the assertion cannot tell the fix from the bug. Survivors either side prove
  // dropping is selective.
  // MUTATION THAT TURNS THIS RED: make load() return the parsed object without the CHECKS loop.
  writeFileSync(file, JSON.stringify({
    defaultModel: 'sonnet',              // good — before
    maxTeamSize: -3,                     // bad: below the floor
    defaultPermissionMode: 'banana',     // bad: not a mode
    defaultAgentId: 'reviewer',          // good — after
  }))
  resetSettingsCache()
  const loaded = getSettings()
  check('the load path DROPS a hand-edited out-of-range maxTeamSize',
    loaded.maxTeamSize === undefined, JSON.stringify(loaded))
  check('the load path DROPS a hand-edited bogus permission mode',
    loaded.defaultPermissionMode === undefined, JSON.stringify(loaded))
  check('…while the good key BEFORE the bad ones survives', loaded.defaultModel === 'sonnet',
    JSON.stringify(loaded))
  check('…and the good key AFTER the bad ones survives', loaded.defaultAgentId === 'reviewer',
    JSON.stringify(loaded))

  // ★ AND THE ELEVATED DEFAULT MUST BE DROPPED ON *LOAD*, NOT MERELY REFUSED ON SAVE.
  // This is the half that actually matters for this rule: settings.json is hand-editable, so
  // refusing the value at the save door while honouring it at the load door would leave the
  // whole protection bypassable with a text editor. Good keys on BOTH SIDES again, so "drop the
  // elevated key" is distinguishable from "empty the file".
  // MUTATION THAT TURNS THIS RED: drop the isElevatedMode branch from CHECKS (it is the SAME
  // table both doors use, which is exactly why this costs nothing).
  for (const m of elevated) {
    writeFileSync(file, JSON.stringify({
      defaultModel: 'sonnet',          // good — before
      defaultPermissionMode: m,        // elevated: must not survive a hand edit
      defaultAgentId: 'reviewer',      // good — after
    }))
    resetSettingsCache()
    const l = getSettings()
    check(`★ a hand-edited elevated "${m}" is DROPPED on load, not honoured`,
      l.defaultPermissionMode === undefined, JSON.stringify(l))
    check(`…while the good key BEFORE it survives ("${m}" case)`, l.defaultModel === 'sonnet',
      JSON.stringify(l))
    check(`…and the good key AFTER it survives ("${m}" case)`, l.defaultAgentId === 'reviewer',
      JSON.stringify(l))
  }

  // A file that parses but is not an object at all.
  writeFileSync(file, JSON.stringify([1, 2, 3]))
  resetSettingsCache()
  check('a settings.json holding an ARRAY loads as empty rather than being iterated',
    Object.keys(getSettings()).length === 0, JSON.stringify(getSettings()))

  // --- an UNPARSEABLE file is moved aside, not overwritten --------------------------------
  // Starting empty caches {}, so the operator's very next save would persist that straight over
  // the bytes they need. The move is what makes recovery not depend on them reacting faster
  // than their own next click.
  // MUTATION THAT TURNS THIS RED: delete the renameSync block from the catch in load().
  const corruptBytes = '{ this is not json at all'
  writeFileSync(file, corruptBytes)
  resetSettingsCache()
  check('an unparseable settings.json loads as empty rather than throwing',
    Object.keys(getSettings()).length === 0, JSON.stringify(getSettings()))
  const corruptFiles = readdirSync(dir).filter((f) => f.endsWith('.corrupt'))
  check('…and the unreadable file was MOVED ASIDE to a .corrupt name',
    corruptFiles.length === 1, `found ${JSON.stringify(readdirSync(dir))}`)
  check('…and the .corrupt copy still holds the ORIGINAL bytes',
    corruptFiles.length === 1
      && readFileSync(path.join(dir, corruptFiles[0]!), 'utf8') === corruptBytes,
    `got ${corruptFiles.length === 1 ? JSON.stringify(readFileSync(path.join(dir, corruptFiles[0]!), 'utf8')) : 'no file'}`)

  // A SECOND corruption must not discard the first one's copy — that would reintroduce the very
  // failure the move exists to prevent, one level along.
  writeFileSync(file, 'also not json {{{')
  resetSettingsCache()
  getSettings()
  check('a second corruption keeps BOTH copies (unique .corrupt names)',
    readdirSync(dir).filter((f) => f.endsWith('.corrupt')).length === 2,
    JSON.stringify(readdirSync(dir)))

  // --- the key set is exhaustive ----------------------------------------------------------
  // `satisfies` makes APP_SETTINGS_KEYS fail to compile if it names a key that is NOT in
  // AppSettings. It cannot catch the other direction — a key added to AppSettings and forgotten
  // here — because no type-level construct can enumerate an interface at runtime. So that
  // direction is asserted: every key must have a validator, and a new key with no CHECKS entry
  // would sail through save() unvalidated.
  for (const k of APP_SETTINGS_KEYS) {
    check(`the settable key "${k}" has a validator (an unvalidated key accepts anything)`,
      saveSettings({ [k]: Symbol('never-valid') as unknown }).ok === false, k)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

process.exit(fail === 0 ? 0 : 1)
