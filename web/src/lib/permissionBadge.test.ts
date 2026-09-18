// The sidebar's elevated-permission warning.
//
// ★ WHAT THIS PINS. A user found a teammate session in "allow all" they never granted, and the
// reason it went unnoticed is that the session LIST said nothing — the mode was visible only
// after opening the session. These cases pin that an elevated session cannot be silent.
//
// This is a MITIGATION, not the fix: the defect is that `restore()` replays a persisted
// elevated mode with `trusted: true`, which is server-side. A test here can only assert that
// the elevation is VISIBLE, never that it was legitimate.
import { describe, it, expect } from 'vitest'
// ★ THE SHARED POPULATION, not a local copy. permissionBadge.fixture.ts used to hold one,
// with a note saying to replace it the moment @claudette/shared exported a runtime list. That
// landed with isElevatedMode, so the fixture is gone and this iterates the real union.
import { PERMISSION_MODES } from '@claudette/shared'
import { isElevated, elevationLabel } from './permissionBadge'

describe('isElevated', () => {
  it('flags exactly the two modes the server refuses from an untrusted caller', () => {
    // Derived from the population rather than hand-listed, so a fifth mode fails loudly here
    // instead of silently defaulting to "not a privilege" — which is the unsafe direction.
    expect(PERMISSION_MODES.filter(isElevated).sort()).toEqual(['acceptEdits', 'bypassPermissions'])
  })

  it('does NOT flag the modes that only raise prompting', () => {
    // Marking these would train the user to ignore the badge, costing exactly the attention
    // the two elevated modes need.
    expect(isElevated('default')).toBe(false)
    expect(isElevated('plan')).toBe(false)
  })

  it('treats an absent mode as not elevated', () => {
    // undefined is how the server represents 'default'. Reading it as elevated would put a
    // warning on every ordinary session.
    expect(isElevated(undefined)).toBe(false)
  })
})

describe('elevationLabel', () => {
  it('gives every elevated mode a label, and nothing else one', () => {
    for (const m of PERMISSION_MODES) {
      expect(elevationLabel(m) !== null, m).toBe(isElevated(m))
    }
    expect(elevationLabel(undefined)).toBeNull()
  })

  it('does NOT collapse the two elevated modes into one message', () => {
    // They are not equally dangerous: bypassPermissions runs EVERY tool unasked, acceptEdits
    // only auto-approves file edits and still prompts for the rest. One shared string would
    // overstate one and understate the other.
    const bypass = elevationLabel('bypassPermissions')!
    const edits = elevationLabel('acceptEdits')!
    expect(bypass.title).not.toBe(edits.title)
    expect(bypass.glyph).not.toBe(edits.glyph)
  })

  it('says plainly that the user did not approve each action', () => {
    // The complaint was not only "it was on", it was "I did not know". The tooltip has to
    // answer what the mode MEANS, not just name it.
    expect(elevationLabel('bypassPermissions')!.title).toMatch(/without asking/i)
  })
})
