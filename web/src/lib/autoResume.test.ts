// The auto-resume eligibility rule. Pure, so the case that actually shipped broken — a
// subsession sharing its parent's directory — is reachable without a server, a restart, or a
// DOM.
//
// ★ WHAT THIS PINS. Auto-resume identifies a session's conversation as "the newest one in this
// cwd". That is a guess, and it is only sound when the directory holds one session. It was not
// merely a display fault: the caller follows the lookup with `resumeInto`, which REPOINTS the
// engine, so a wrong guess moved a session's real context onto another session's conversation
// — overriding a restore the server had already done correctly.
import { describe, it, expect } from 'vitest'
import { cwdIdentifiesSession, mayAutoResume, claudeSessionIdFromEvents, autoResumePlan } from './autoResume'

const ok = {
  session: { cwd: '/w' }, sessions: [{ cwd: '/w' }],
  alreadyTried: false, isFresh: false, hasItems: false, running: false,
}

describe('cwdIdentifiesSession', () => {
  it('identifies a session that is alone in its directory', () => {
    expect(cwdIdentifiesSession({ cwd: '/w' }, [{ cwd: '/w' }])).toBe(true)
  })

  it('REFUSES when a subsession shares its parent\'s directory — the reported bug', () => {
    // SessionInfo.cwd's own comment: "a subsession shares its parent's cwd". So this is not an
    // edge case, it is the guaranteed shape of every parent/subsession pair.
    expect(cwdIdentifiesSession({ cwd: '/w' }, [{ cwd: '/w' }, { cwd: '/w' }])).toBe(false)
  })

  it('REFUSES for two ROOT sessions in one directory, not just parent/child', () => {
    // The same defect with no parentId anywhere. A guard keyed on parentId would have passed
    // this and left the harder-to-recognise half of the bug live.
    expect(cwdIdentifiesSession({ cwd: '/w' }, [{ cwd: '/w' }, { cwd: '/w' }])).toBe(false)
  })

  it('is not confused by sessions in OTHER directories', () => {
    // The count must be scoped to this cwd; counting the whole list would disable auto-resume
    // for everyone the moment a second session existed anywhere.
    expect(cwdIdentifiesSession({ cwd: '/w' }, [{ cwd: '/w' }, { cwd: '/other' }, { cwd: '/x' }])).toBe(true)
  })

  it('tolerates a list that does not yet contain this session', () => {
    // Mid-load the list may not include us. Zero matches is still unambiguous, and the caller
    // has a separate guard for the not-loaded case.
    expect(cwdIdentifiesSession({ cwd: '/w' }, [])).toBe(true)
  })
})

describe('mayAutoResume', () => {
  it('allows the ordinary case: a restored, idle, empty session alone in its directory', () => {
    // The counterweight. A guard that refused everything would also "fix" the bug and would
    // delete the feature, so the permitting case has to be pinned alongside the refusals.
    expect(mayAutoResume(ok)).toBe(true)
  })

  it('refuses a session sharing its directory even when everything else is ideal', () => {
    expect(mayAutoResume({ ...ok, sessions: [{ cwd: '/w' }, { cwd: '/w' }] })).toBe(false)
  })

  it('refuses while the session list has not loaded', () => {
    // `undefined` here means "not loaded yet", NOT "no such session" — nothing in the inputs
    // can tell those apart, and guessing from a half-loaded list is exactly what the cwd count
    // cannot survive.
    expect(mayAutoResume({ ...ok, session: undefined })).toBe(false)
  })

  it('refuses on each independent disqualifier', () => {
    // Kept as separate arms rather than one boolean so a regression names which rule was lost.
    expect(mayAutoResume({ ...ok, alreadyTried: true })).toBe(false)
    expect(mayAutoResume({ ...ok, isFresh: true })).toBe(false)
    expect(mayAutoResume({ ...ok, hasItems: true })).toBe(false)
    expect(mayAutoResume({ ...ok, running: true })).toBe(false)
  })
})

// ── RESUMING BY EXACT ID — the repair the cwd guard was a stopgap for ────────────────────────
const init = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid })

describe('claudeSessionIdFromEvents', () => {
  it('reads the conversation id off a replayed init', () => {
    expect(claudeSessionIdFromEvents([init('conv-a')])).toBe('conv-a')
  })

  it('takes the LAST init when a session was relaunched mid-life', () => {
    // A sandbox or role change relaunches the engine and emits a fresh init. The newest one
    // names the conversation the engine is on NOW; taking the first would resume into the
    // conversation it left.
    expect(claudeSessionIdFromEvents([init('old'), { type: 'assistant' }, init('new')])).toBe('new')
  })

  it('returns undefined when no init is present — a real state, not an error', () => {
    // The transcript ring is capped, so a long-running session can evict its init; a session
    // whose engine never started has never emitted one. Both must fall back, not throw.
    expect(claudeSessionIdFromEvents([{ type: 'assistant' }, { type: 'result' }])).toBeUndefined()
    expect(claudeSessionIdFromEvents([])).toBeUndefined()
  })

  it('ignores a non-init system event and a malformed session_id', () => {
    expect(claudeSessionIdFromEvents([{ type: 'system', subtype: 'compact', session_id: 'x' }])).toBeUndefined()
    expect(claudeSessionIdFromEvents([{ type: 'system', subtype: 'init', session_id: 42 }])).toBeUndefined()
    // Empty string is not an id. It would sail through a truthiness-free check and produce a
    // readConversation for '' — a request that can only fail, made instead of the cwd fallback
    // that would have worked.
    expect(claudeSessionIdFromEvents([init('')])).toBeUndefined()
  })
})

describe('autoResumePlan', () => {
  const known = { ...ok, claudeSessionId: 'conv-mine' }

  it('★ resumes a SUBSESSION by its own id, the case the cwd guard could never serve', () => {
    // Two sessions in one directory — cwdIdentifiesSession says no, and said no before this
    // change, which is why a restored subsession came back empty. Knowing the id answers the
    // question the guard was protecting against, so the guard is not consulted at all.
    const plan = autoResumePlan({ ...known, sessions: [{ cwd: '/w' }, { cwd: '/w' }] })
    expect(plan).toEqual({ kind: 'byId', conversationId: 'conv-mine' })
  })

  it('prefers the exact id even when the cwd guess would also have worked', () => {
    // Alone in the directory, so byCwd was available. byId is still correct and strictly
    // better: it never repoints the engine.
    expect(autoResumePlan(known)).toEqual({ kind: 'byId', conversationId: 'conv-mine' })
  })

  it('falls back to the cwd guess when the id is not known yet', () => {
    expect(autoResumePlan({ ...ok, claudeSessionId: undefined })).toEqual({ kind: 'byCwd' })
  })

  it('skips when the id is unknown AND the directory is ambiguous', () => {
    // The stopgap's behaviour, preserved exactly for the case that still has no better answer.
    expect(autoResumePlan({ ...ok, claudeSessionId: undefined, sessions: [{ cwd: '/w' }, { cwd: '/w' }] }))
      .toEqual({ kind: 'skip' })
  })

  it('applies every disqualifier to the byId path too, not just to the guess', () => {
    // The blockers are about whether resuming is WANTED — a running turn, a transcript already
    // on screen — and none of them stop mattering because we happen to know the id. This is the
    // arm that would rot if the two paths kept separate copies of the list.
    expect(autoResumePlan({ ...known, alreadyTried: true })).toEqual({ kind: 'skip' })
    expect(autoResumePlan({ ...known, isFresh: true })).toEqual({ kind: 'skip' })
    expect(autoResumePlan({ ...known, hasItems: true })).toEqual({ kind: 'skip' })
    expect(autoResumePlan({ ...known, running: true })).toEqual({ kind: 'skip' })
    expect(autoResumePlan({ ...known, session: undefined })).toEqual({ kind: 'skip' })
  })

  it('keeps mayAutoResume and the plan agreeing about the guess', () => {
    // Two rules of the same shape drifting apart is this repo's recurring defect; they share
    // `resumeBlocked` precisely so they cannot. Asserted rather than described.
    for (const sessions of [[{ cwd: '/w' }], [{ cwd: '/w' }, { cwd: '/w' }]]) {
      const args = { ...ok, sessions }
      const viaPlan = autoResumePlan({ ...args, claudeSessionId: undefined }).kind === 'byCwd'
      expect(viaPlan).toBe(mayAutoResume(args))
    }
  })
})
