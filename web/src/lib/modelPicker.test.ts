// The per-session model picker's decisions. Pure, so the cases that matter are reachable
// without a DOM — including the one a render test would struggle to stage: a pending model
// change while a turn is running, where "apply now" costs the user that turn.
//
// ★ WHAT THIS FILE EXISTS TO PIN.
//   1. The free-text field is the ONLY route to a full model id, which is the user's actual
//      goal here (their `opus` alias resolves to Opus 5; 5.5 needs the full id). A blank
//      submission must CLEAR the override, not set a model named "".
//   2. Apply-now is a RESTART. Offering it mid-turn without saying so lets a user lose a turn
//      to a button they read as "sooner". The warning is part of the returned value, so a
//      caller cannot render the control and forget the consequence.
// MUTATIONS (measured 2026-10-01 against a COPY at web/.mut-src, never the live file; ran=N
// reported because a mutant that fails to PARSE yields zero failures exactly like a clean
// pass). All five measured at ran=242 — constant, so none crashed rather than failed:
//   P1  blank free-text sets a model named "" instead of clearing  → red=2
//   P2  currentModelChoice drops the trim                          → red=2
//   P3  the interrupt warning removed from the apply-now label     → red=1, alone
//   P4  pending text borrows the sandbox "Applying changes…"       → red=1, alone
//   P5  MODEL_OPTIONS re-listed instead of reusing settingsLogic   → red=1, alone
//   XX  a patch matching no text REFUSED (0 matches, no run performed)
// P3 and P4 reding alone is the point: each is a single wording decision with a real cost
// (a lost turn; a claim that something is happening when nothing is), and nothing else sees it.
import { describe, it, expect } from 'vitest'
import { MODEL_ALIASES } from './settingsLogic'
import {
  currentModelChoice, normalizeModelInput, modelPendingNotice, MODEL_OPTIONS,
  isSelected, seedCustomId, isSameModel,
} from './modelPicker'

describe('currentModelChoice', () => {
  it('reads an absent override as the account default', () => {
    expect(currentModelChoice(undefined)).toEqual({ kind: 'default' })
  })

  it('reads blank and whitespace-only as the account default too', () => {
    // Matches the server: setModel() trims and treats a blank as undefined. If this disagreed,
    // a cleared field would render as a selected custom id of '' while the server had cleared
    // the override — the control describing a state the server is not in.
    expect(currentModelChoice('')).toEqual({ kind: 'default' })
    expect(currentModelChoice('   ')).toEqual({ kind: 'default' })
  })

  it('recognises every known alias as an alias, derived from the population', () => {
    // Iterated, not hand-listed: a fourth family added to MODEL_ALIASES must be covered here
    // without anyone remembering to come back.
    for (const a of MODEL_ALIASES) {
      expect(currentModelChoice(a), a).toEqual({ kind: 'alias', alias: a })
    }
  })

  it('★ keeps a full model id as custom AND preserves the id', () => {
    // The id is the payload. Classifying it merely as "not an alias" would lose the string the
    // user typed, which is the only thing that selects Opus 5.5.
    expect(currentModelChoice('claude-opus-5-5')).toEqual({ kind: 'custom', id: 'claude-opus-5-5' })
  })

  it('trims a padded id rather than treating the padding as part of it', () => {
    expect(currentModelChoice('  claude-opus-5-5  ')).toEqual({ kind: 'custom', id: 'claude-opus-5-5' })
  })
})

describe('MODEL_OPTIONS', () => {
  it('is the settingsLogic population, not a second copy', () => {
    // Identity, not deep-equality: a re-listed array would pass a deep compare today and drift
    // the first time a family is added.
    expect(MODEL_OPTIONS).toBe(MODEL_ALIASES)
  })
})

describe('normalizeModelInput', () => {
  it('★ clears the override on a blank submission', () => {
    // Not a model named "" or " ". This is the same rule the server applies, stated on the
    // client so the field does not briefly show something the server will never store.
    expect(normalizeModelInput('')).toBeUndefined()
    expect(normalizeModelInput('   ')).toBeUndefined()
  })

  it('passes a real id through, trimmed', () => {
    expect(normalizeModelInput('  claude-opus-5-5 ')).toBe('claude-opus-5-5')
  })
})

describe('modelPendingNotice', () => {
  it('says nothing when the running engine already has the requested model', () => {
    expect(modelPendingNotice(false, 'idle')).toBeNull()
    expect(modelPendingNotice(false, 'running')).toBeNull()
  })

  it('★ never says "applying" — nothing is in flight until the next send', () => {
    // The sandbox banner says "Applying changes…" because the SERVER auto-applies a pending
    // sandbox the moment the session is idle. A pending MODEL is applied inside the next send
    // (applyModelForTurn), so while idle nothing is happening, and borrowing that wording
    // would assert activity that is not occurring.
    for (const st of ['idle', 'running', 'waiting', 'exited'] as const) {
      const n = modelPendingNotice(true, st)
      expect(n, st).not.toBeNull()
      expect(n!.text, st).not.toMatch(/applying/i)
      expect(n!.text, st).toMatch(/next message/i)
    }
  })

  it('★★ warns IN THE LABEL that applying now ends a turn in progress', () => {
    // The consequence rides on the value a caller must already render to show the button, so
    // it cannot be dropped by a call site that renders the control and forgets the warning.
    for (const st of ['running', 'waiting'] as const) {
      const n = modelPendingNotice(true, st)!
      expect(n.applyNow, st).toBe(true)
      expect(n.interrupts, st).toBe(true)
      expect(n.label, st).toMatch(/ends this turn/i)
    }
  })

  it('does not warn about an interruption when nothing is running', () => {
    // A warning on an idle session would train the user to ignore it on the one that matters.
    for (const st of ['idle', 'exited'] as const) {
      const n = modelPendingNotice(true, st)!
      expect(n.interrupts, st).toBe(false)
      expect(n.label, st).not.toMatch(/ends this turn/i)
      expect(n.applyNow, st).toBe(true)
    }
  })

  it('offers apply-now in every pending state, so the control never silently disappears', () => {
    for (const st of ['idle', 'running', 'waiting', 'exited'] as const) {
      expect(modelPendingNotice(true, st)!.applyNow, st).toBe(true)
    }
  })
})


describe('isSelected — which row carries the ✓', () => {
  it('ticks the default row only when there is no override', () => {
    expect(isSelected({ kind: 'default' }, { kind: 'default' })).toBe(true)
    expect(isSelected({ kind: 'alias', alias: 'opus' }, { kind: 'default' })).toBe(false)
    expect(isSelected({ kind: 'custom', id: 'claude-opus-5-5' }, { kind: 'default' })).toBe(false)
  })

  it('ticks exactly the matching alias row, across the whole population', () => {
    for (const a of MODEL_ALIASES) {
      const choice = currentModelChoice(a)
      for (const row of MODEL_ALIASES) {
        expect(isSelected(choice, { kind: 'alias', alias: row }), `${a} vs ${row}`).toBe(a === row)
      }
    }
  })

  it('★★ ticks the custom row from the SESSION state, never from typed text', () => {
    // isSelected takes no argument for the field's contents — the wrong version is
    // unwriteable, not merely discouraged. This case pins the consequence: on a session with
    // NO custom override the custom row is unticked, whatever a user may be typing.
    expect(isSelected({ kind: 'custom', id: 'claude-opus-5-5' }, { kind: 'custom' })).toBe(true)
    expect(isSelected({ kind: 'default' }, { kind: 'custom' })).toBe(false)
    expect(isSelected({ kind: 'alias', alias: 'sonnet' }, { kind: 'custom' })).toBe(false)
  })

  it('never ticks two rows at once for any single choice', () => {
    // A second tick would make the menu claim the session is on two models.
    const rows: Parameters<typeof isSelected>[1][] = [
      { kind: 'default' }, { kind: 'custom' },
      ...MODEL_ALIASES.map((a) => ({ kind: 'alias' as const, alias: a })),
    ]
    const choices = [
      currentModelChoice(undefined),
      currentModelChoice('claude-opus-5-5'),
      ...MODEL_ALIASES.map((a) => currentModelChoice(a)),
    ]
    for (const c of choices) {
      const ticked = rows.filter((r) => isSelected(c, r)).length
      expect(ticked, JSON.stringify(c)).toBe(1)
    }
  })
})

describe('seedCustomId', () => {
  it('★ is empty for an alias — an alias is not a full model id', () => {
    // Seeding from session.model unconditionally put `sonnet` in a box labelled "Full model
    // id", which both misdescribes it and makes Enter re-post the alias through the custom path.
    for (const a of MODEL_ALIASES) expect(seedCustomId(a), a).toBe('')
  })

  it('is empty when there is no override', () => {
    expect(seedCustomId(undefined)).toBe('')
    expect(seedCustomId('   ')).toBe('')
  })

  it('shows the id when the session really is on a custom one', () => {
    expect(seedCustomId('claude-opus-5-5')).toBe('claude-opus-5-5')
  })
})

describe('isSameModel — the no-op guard', () => {
  it('treats undefined, empty and whitespace as the same "account default"', () => {
    // All three mean "no override" to the server, so picking one while on another must not post.
    for (const a of [undefined, '', '   ']) {
      for (const b of [undefined, '', '  ']) {
        expect(isSameModel(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(true)
      }
    }
  })

  it('matches an identical model regardless of padding', () => {
    expect(isSameModel('opus', 'opus')).toBe(true)
    expect(isSameModel(' claude-opus-5-5 ', 'claude-opus-5-5')).toBe(true)
  })

  it('★ does NOT match genuinely different models, including clearing one', () => {
    // The guard must not swallow a real change — that would be a picker that silently does
    // nothing, which is worse than one that posts redundantly.
    expect(isSameModel('opus', 'sonnet')).toBe(false)
    expect(isSameModel('opus', undefined)).toBe(false)
    expect(isSameModel(undefined, 'claude-opus-5-5')).toBe(false)
  })
})
