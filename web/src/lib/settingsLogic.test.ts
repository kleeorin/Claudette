// App-settings decisions, tested without a DOM.
//
// MUTATIONS (measured 2026-09-08), each with `ran=N`, per the rule in scratchpad/assert.mjs:
// a mutant that fails to parse yields zero failures exactly like a clean pass, so a red set
// without an executed count is one assumption short of a proof.
// All runs ran=18 — the executed count held constant across every mutation, which is what
// establishes that none of them crashed instead of failing.
//   S1  isLocked always returns false
//       → TWO reds, not the one I predicted: the pure locked case AND the panel's
//         override-disables case. Both layers see it, which is the right outcome and worth
//         recording accurately rather than as the tidier single red.
//         This is the silent-no-op class: an operator edits a control that cannot do
//         anything, because the environment is dictating the value.
//   S2  overrideFor matches on anything (returns overrides[0])
//       → TWO reds: the wrong-key case and the panel's leaves-others-editable case. A lookup
//         that returns SOMEONE ELSE'S override disables the wrong control and, worse, leaves
//         the overridden one editable.
//   S3  parseTeamSize accepts an empty string as 0 rather than null
//       → TWO reds since the two-verb change: the pure unset case, and the panel's
//         every-clearable-control-routes-through-reset case — because a 0 is a SAVE where a
//         clear was meant. null and 0 are different requests (reset to fallback versus a team
//         of nobody), and conflating them is how "clear this field" silently becomes a
//         setting. Re-measured at ran=19; the earlier "alone" was correct before that test
//         existed, which is why a count in a record is a measurement with a date.
//   S4  parseTeamSize drops the upper bound
//       → TWO reds: the pure above-maximum case and the panel's refuses-and-does-not-save
//         case.
//   S5  isCustomModel treats every value as custom
//       → the alias case reds, alone; the free-text case stays green, which is the asymmetry
//         showing the two are pinned separately rather than as one check written twice.
//   XX  a patch matching no text must REFUSE, not silently run the unmutated file.
import { describe, it, expect } from 'vitest'
import {
  isLocked, overrideFor, parseTeamSize, isCustomModel,
  MAX_TEAM_SIZE_LIMIT, MIN_TEAM_SIZE,
} from './settingsLogic'
import type { SettingsOverride } from './settingsContract'

const OV = (key: string, env: string, value = 'x'): SettingsOverride => ({ key, env, value })

describe('override precedence — the rule that stops a silent no-op', () => {
  it('a setting the environment dictates is locked', () => {
    expect(isLocked('maxTeamSize', [OV('maxTeamSize', 'CLAUDETTE_MAX_TEAM_SIZE', '4')])).toBe(true)
  })

  it('a setting nothing dictates is not locked', () => {
    expect(isLocked('maxTeamSize', [])).toBe(false)
  })

  // ★ THE LOOKUP MUST BE KEYED. An override for a DIFFERENT setting must not lock this one —
  // that would disable a control the operator can legitimately edit while leaving the one the
  // environment actually controls enabled, which is the failure inverted.
  it('an override for another key locks nothing here', () => {
    expect(isLocked('defaultModel', [OV('maxTeamSize', 'CLAUDETTE_MAX_TEAM_SIZE')])).toBe(false)
  })

  it('the override carries which variable and what value, for the label', () => {
    const o = overrideFor('defaultModel', [OV('defaultModel', 'CLAUDETTE_DEFAULT_MODEL', 'opus')])
    expect(o?.env).toBe('CLAUDETTE_DEFAULT_MODEL')
    expect(o?.value).toBe('opus')
  })
})

describe('parseTeamSize', () => {
  // Empty means RESET, not zero. Those are different requests to the server.
  it('an empty entry is a reset, not a value', () => {
    expect(parseTeamSize('')).toEqual({ value: null })
    expect(parseTeamSize('   ')).toEqual({ value: null })
  })
  it('accepts a number inside the range', () => {
    expect(parseTeamSize('4')).toEqual({ value: 4 })
    expect(parseTeamSize(String(MIN_TEAM_SIZE))).toEqual({ value: MIN_TEAM_SIZE })
    expect(parseTeamSize(String(MAX_TEAM_SIZE_LIMIT))).toEqual({ value: MAX_TEAM_SIZE_LIMIT })
  })
  it('refuses above the hard maximum', () => {
    expect('error' in parseTeamSize(String(MAX_TEAM_SIZE_LIMIT + 1))).toBe(true)
  })
  it('refuses below the floor, and refuses non-numbers', () => {
    expect('error' in parseTeamSize('0')).toBe(true)
    expect('error' in parseTeamSize('four')).toBe(true)
    expect('error' in parseTeamSize('2.5')).toBe(true)
  })
})

describe('defaultModel', () => {
  it('an alias is not custom', () => {
    expect(isCustomModel('opus')).toBe(false)
    expect(isCustomModel('sonnet')).toBe(false)
    expect(isCustomModel('fable')).toBe(false)
  })
  it('a pinned full id is custom', () => {
    expect(isCustomModel('claude-fable-5')).toBe(true)
  })
  // Absent is a value in this contract — it means "the CLI chooses", which is what every
  // existing install does today.
  it('absent is neither an alias nor custom', () => {
    expect(isCustomModel(undefined)).toBe(false)
  })
})
