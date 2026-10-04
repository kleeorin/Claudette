// The background-process panel's decisions. Pure, so every case is reachable without a DOM —
// including the two that a render test could not stage at all: a process settled to 'unknown'
// by an engine death, and elapsed time on a client whose clock is behind the server's.
//
// ★ WHAT THESE TESTS EXIST TO PIN.
//   1. A LIVE PROCESS IS NEVER LOST FROM THE BADGE. The whole panel exists to answer "is my
//      build still going?", so a rule that misclassifies a running process as finished makes
//      the feature worse than absent — it answers confidently and wrongly.
//   2. 'unknown' IS NOT A FAILURE. After a server restart the outcome of a background shell
//      is genuinely unknowable. Painting it red tells the user their test run broke when it
//      may well have passed, and it is the single arm most likely to be "tidied" into the
//      failed branch by someone who reads it as a leftover.
//
// ★★ THE POPULATION IS QUERIED, NEVER HAND-LISTED. Every case below iterates
// BASH_PROC_STATES rather than naming the four states, per the rule in scratchpad/assert.mjs
// about not enumerating a population that will grow. A fifth lifecycle state must turn this
// file RED on arrival; a hand-written list would leave it green while the new state fell
// through to a default arm nobody looked at.
import { describe, it, expect } from 'vitest'
import { BASH_PROC_STATES, type BashProcRecord } from '@claudette/shared'
import {
  isLiveBashProc, bashProcDot, bashProcStatusText, bashProcBadge,
  bashProcElapsed, formatDuration, bashProcLabel, bashOutputAvailable, bashProcKillable,
  shouldPollOutput, outputDisplay,
} from './bashProcLights'

const proc = (over: Partial<BashProcRecord> = {}): BashProcRecord => ({
  toolId: 'toolu_1', command: 'npm test', startedAt: 1_000, status: 'running', ...over,
})

describe('the lifecycle population', () => {
  // Guards the guard. Every other test in this file iterates BASH_PROC_STATES, so an
  // accidentally empty or single-valued export would make all of them vacuously green —
  // the classic "0 tests ran, suite passed" shape, one layer in.
  it('is non-trivial and contains the states the panel reasons about', () => {
    expect(BASH_PROC_STATES.length).toBeGreaterThanOrEqual(5)
    expect(BASH_PROC_STATES).toContain('running')
    expect(BASH_PROC_STATES).toContain('stopped')
    expect(BASH_PROC_STATES).toContain('unknown')
  })

  it('has exactly one live state, and it is running', () => {
    // Derived, not asserted state-by-state: this is the assertion that reds if a fifth state
    // is added and someone forgets to decide whether it is live.
    expect(BASH_PROC_STATES.filter(isLiveBashProc)).toEqual(['running'])
  })

  it('gives every state a dot and a status word', () => {
    for (const s of BASH_PROC_STATES) {
      expect(bashProcDot(s).cls, s).toMatch(/^bg-ctp-/)
      expect(bashProcDot(s).title, s).toBeTruthy()
      expect(bashProcStatusText(s).label, s).toBeTruthy()
      expect(bashProcStatusText(s).text, s).toMatch(/^text-ctp-/)
    }
  })

  it('pulses exactly the live states', () => {
    // The pulse IS the "still going" signal — running and done are both green and are told
    // apart by nothing else — so it has to track liveness rather than merely happen to.
    for (const s of BASH_PROC_STATES) {
      expect(bashProcDot(s).cls.includes('animate-pulse'), s).toBe(isLiveBashProc(s))
    }
  })

  // ★ ADDED AFTER 'stopped' ARRIVED AS A FIFTH STATE, because of what the existing cases did
  // NOT catch. When the population grew, two assertions reded (liveness and the pulse) and
  // typecheck reded at all three exhaustive switches — but "gives every state a dot and a
  // status word" PASSED, because the default arm returns a well-shaped grey dot and
  // String(status) for anything it does not recognise. So the shape checks alone cannot tell
  // a state that was DESIGNED from one that merely fell through.
  //
  // Uniqueness can. 'stopped' and 'unknown' deliberately share a grey dot — neither is a
  // success and neither is a failure — so the WORD is the only channel left carrying the
  // difference between "you stopped it" and "we lost track of it". If two states ever render
  // the same label, they are indistinguishable to the user in every channel at once, and that
  // is true whether it happened by design or by falling through a default nobody looked at.
  it('gives every state a DISTINCT status word, so no two are indistinguishable', () => {
    const labels = BASH_PROC_STATES.map((st) => bashProcStatusText(st).label)
    expect(new Set(labels).size).toBe(BASH_PROC_STATES.length)
  })

  it('paints only the failed state red', () => {
    // Stated over the whole population rather than as "unknown is not red", so a future
    // state cannot quietly join the accusing colour either.
    for (const s of BASH_PROC_STATES) {
      const red = bashProcDot(s).cls.includes('red') || bashProcStatusText(s).text.includes('red')
      expect(red, s).toBe(s === 'failed')
    }
  })
})

describe('unknown is an outcome, not a failure', () => {
  it('reads as grey and says what is actually unknown', () => {
    expect(bashProcDot('unknown').cls).toBe('bg-ctp-overlay')
    expect(bashProcStatusText('unknown').label).toBe('outcome unknown')
    // The word must not accuse. "failed"/"error" here would be a false claim about the
    // user's own build, made at the one moment we know least.
    expect(bashProcStatusText('unknown').label).not.toMatch(/fail|error/i)
  })

  it('is terminal — it does not keep pulsing forever', () => {
    expect(isLiveBashProc('unknown')).toBe(false)
  })
})

describe('stopped is the user\'s own doing, not an error', () => {
  it('reads as neither a success nor a failure', () => {
    // Measured as the SECOND most common shell outcome in the corpus (completed 15, stopped
    // 12, failed 2), and it is what pressing Kill in this very panel produces — so painting
    // it red would report the user's own deliberate action back to them as a fault.
    expect(bashProcDot('stopped').cls).toBe('bg-ctp-overlay')
    expect(bashProcStatusText('stopped').text).not.toContain('red')
    expect(bashProcStatusText('stopped').text).not.toContain('green')
  })

  it('is terminal, and is NOT collapsed into unknown', () => {
    expect(isLiveBashProc('stopped')).toBe(false)
    // The CLI told us the process was stopped, which is strictly more than "we do not know".
    // Collapsing the two would discard real information and assert something false.
    expect(bashProcStatusText('stopped').label).not.toBe(bashProcStatusText('unknown').label)
  })

  it('renders stopped as inert grey, the same treatment the agent list uses', () => {
    // ⚠ WORDED AS A LOCAL CLAIM ON PURPOSE. An earlier version said this "agrees with the
    // agent list", which it did not check — it never imported AgentStatusDot, so the stated
    // invariant could break while this stayed green. Importing a JSX component into a pure
    // test to read one class string is not worth the coupling, so the claim was narrowed to
    // what is actually asserted. The agreement is real today (AgentDetail renders a stopped
    // agent bg-ctp-overlay) and is recorded here as context, not as a guarantee.
    expect(bashProcDot('stopped').cls).toBe('bg-ctp-overlay')
    expect(bashProcDot('stopped').title).toBe('stopped')
  })
})

describe('bashProcBadge', () => {
  it('draws nothing at all when the session has no background processes', () => {
    // null rather than {total: 0}: the caller must be able to omit the element, matching the
    // kernels badge, which is absent rather than showing a zero.
    expect(bashProcBadge([])).toBeNull()
  })

  it('counts every process but pulses only for the live ones', () => {
    const badge = bashProcBadge([
      proc({ toolId: 'a', status: 'running' }),
      proc({ toolId: 'b', status: 'done' }),
      proc({ toolId: 'c', status: 'failed' }),
      proc({ toolId: 'd', status: 'stopped' }),
      proc({ toolId: 'e', status: 'unknown' }),
    ])
    // total, not live: a finished process is still the thing the user backgrounded it to go
    // and read. A count that emptied itself the moment the build finished would hide the
    // answer exactly when it arrived.
    expect(badge).toEqual({ total: 5, live: 1 })
  })

  it('keeps a badge with a zero live count when everything has settled', () => {
    expect(bashProcBadge([proc({ status: 'done' })])).toEqual({ total: 1, live: 0 })
  })
})

describe('bashProcElapsed', () => {
  it('grows with the clock while running', () => {
    expect(bashProcElapsed({ startedAt: 1_000 }, 4_000)).toBe(3_000)
  })

  it('freezes at its own span once ended, ignoring now', () => {
    // A finished process must not keep ticking, and must read the same whenever it is looked
    // at — so `now` is genuinely unused on this path rather than merely usually equal.
    expect(bashProcElapsed({ startedAt: 1_000, endedAt: 3_500 }, 9_999_999)).toBe(2_500)
  })

  it('says UNKNOWN rather than doing arithmetic on an unusable start time', () => {
    // MEASURED, not imagined: fed to the raw subtraction, `startedAt: 0` renders
    // "496961h 21m" and an absent one renders "NaNh NaNm" — both in the detail header. A
    // record settled in BULK (a notification carrying several <task-id>s and no
    // <tool-use-id>) can reach the client without a real start time, and a user seeing
    // either of those reports the panel as broken rather than the timestamp as missing.
    expect(bashProcElapsed({ startedAt: 0 }, 9_999)).toBeNull()
    expect(bashProcElapsed({ startedAt: NaN }, 9_999)).toBeNull()
    expect(bashProcElapsed({ startedAt: undefined as unknown as number }, 9_999)).toBeNull()
    expect(bashProcElapsed({ startedAt: -1 }, 9_999)).toBeNull()
  })

  it('still returns a real span for a usable start time', () => {
    // The guard above must not swallow the ordinary case — a null here would blank the
    // duration on every healthy process, which is a worse outcome than the bug it fixes.
    expect(bashProcElapsed({ startedAt: 1 }, 3_001)).toBe(3_000)
  })

  it('clamps at zero when the browser clock lags the server clock', () => {
    // startedAt is the SERVER's clock and `now` is the BROWSER's. A client a few seconds
    // behind would otherwise render a brand-new process counting backwards from the future.
    expect(bashProcElapsed({ startedAt: 5_000 }, 1_000)).toBe(0)
  })
})

describe('formatDuration', () => {
  it('shows seconds under a minute, because that is the aliveness cue', () => {
    // The reason this is not lib/ago.ts: `ago` says "just now" for everything under a
    // minute, which erases the ticking seconds that tell a watcher the process is alive.
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(4_400)).toBe('4s')
    expect(formatDuration(59_999)).toBe('59s')
  })

  it('shows minutes and seconds, then hours and minutes', () => {
    expect(formatDuration(60_000)).toBe('1m 0s')
    expect(formatDuration(134_000)).toBe('2m 14s')
    expect(formatDuration(3_600_000)).toBe('1h 0m')
    expect(formatDuration(3_780_000)).toBe('1h 3m')
  })

  it('never renders a negative span', () => {
    expect(formatDuration(-5_000)).toBe('0s')
  })
})

describe('bashProcLabel', () => {
  it('prefers the description the model wrote', () => {
    expect(bashProcLabel({ command: 'npm test', description: 'Run the full QA baseline' }))
      .toBe('Run the full QA baseline')
  })

  it('falls back to the command when there is no description', () => {
    expect(bashProcLabel({ command: 'npm test' })).toBe('npm test')
  })

  it('ignores a whitespace-only description rather than rendering a blank row', () => {
    expect(bashProcLabel({ command: 'npm test', description: '   ' })).toBe('npm test')
  })

  it('collapses a multi-line command to its first non-empty line', () => {
    // Backgrounded commands are routinely heredocs. Pasted whole into a sidebar row this
    // blows the layout out; into a tab strip it pushes every other tab off screen.
    expect(bashProcLabel({ command: '\n\nnpm run build\nnpm test\n' })).toBe('npm run build')
  })

  it('truncates to the caller-supplied width with an ellipsis', () => {
    const out = bashProcLabel({ command: 'x'.repeat(200) }, 10)
    expect(out).toHaveLength(10)
    expect(out.endsWith('…')).toBe(true)
  })

  it('never returns an empty string, so a tab is never nameless', () => {
    expect(bashProcLabel({ command: '   \n  \n' })).toBe('background command')
  })
})

// ★ THE BLIND SPOT THE POPULATION RULE ITSELF CREATES, pinned here.
// Every other case in this file iterates BASH_PROC_STATES, which is right — it is what makes
// a new state red this file on arrival. But it means no case can ever REACH a `default:` arm,
// because the array by definition contains only states that exist. So the "fails in the safe
// direction" claims written in those default branches had zero coverage: the comments asserted
// a behaviour nothing checked, and would have gone on asserting it after someone changed it.
// A cast is the only way in, and it is worth the ugliness for the one thing it buys.
describe('the default arms — reachable only by cast, and deliberately asymmetric', () => {
  const bogus = 'bogus-future-state' as unknown as (typeof BASH_PROC_STATES)[number]

  it('treats an unrecognised state as LIVE for the badge, so it cannot vanish', () => {
    // Safe direction for a DISPLAY: a state we do not understand still shows up and can be
    // looked at, rather than silently dropping out of the count.
    expect(isLiveBashProc(bogus)).toBe(true)
  })

  it('still renders a well-formed dot and label rather than crashing', () => {
    expect(bashProcDot(bogus).cls).toMatch(/^bg-ctp-/)
    expect(bashProcStatusText(bogus).text).toMatch(/^text-ctp-/)
  })

  it('★ REFUSES TO OFFER A KILL for an unrecognised state, the OPPOSITE default', () => {
    // The same unknown input, the opposite answer, and that asymmetry is the entire reason
    // bashProcKillable does not reuse isLiveBashProc. "Show it anyway" is safe for a badge;
    // "offer to destroy it anyway" is not. If someone later rewrites bashProcKillable in
    // terms of isLiveBashProc — which looks like a tidy simplification and is identical for
    // every state that exists today — this is the case that stops it.
    expect(bashProcKillable({ status: bogus, shellId: 'abc123' })).toBe(false)
  })
})

describe('bashProcKillable — the one destructive control', () => {
  it('offers a kill for exactly one state, and only with a shell id', () => {
    // Over the whole population rather than a hand-picked pair, so a new state is not
    // silently granted a kill button.
    for (const st of BASH_PROC_STATES) {
      expect(bashProcKillable({ status: st, shellId: 'abc123' }), `${st} +shellId`).toBe(st === 'running')
      expect(bashProcKillable({ status: st }), `${st} -shellId`).toBe(false)
    }
  })

  it('hides the button when the shell id has not arrived yet', () => {
    // The ack carrying the id lands a moment after the launch, and a conversation resumed
    // from disk never replays it. Without it the kill cannot be routed — and the CLI answers
    // an unroutable stop with SUCCESS, so a button here would silently do nothing while
    // reporting that it had worked.
    expect(bashProcKillable({ status: 'running' })).toBe(false)
    expect(bashProcKillable({ status: 'running', shellId: '' })).toBe(false)
    expect(bashProcKillable({ status: 'running', shellId: 'abc123' })).toBe(true)
  })
})

describe('malformed records off the wire', () => {
  // ★ WHY THESE WERE INVISIBLE TO EVERY OTHER TEST IN THIS FILE: they all build fixtures
  // through the `proc()` helper above, which always supplies `command` and `startedAt`. And
  // typecheck cannot help either — these records arrive via JSON.parse off a socket, so the
  // declared type is an assertion about a server rather than a fact about the value.
  it('labels a record with no command at all instead of throwing', () => {
    // This one blanked the SIDEBAR, not just its own row: bashProcLabel is called during
    // BashProcLine's render, so the TypeError unmounted the whole SessionRow subtree.
    expect(bashProcLabel({} as unknown as BashProcRecord)).toBe('background command')
    expect(bashProcLabel({ command: null } as unknown as BashProcRecord)).toBe('background command')
  })

  it('still prefers a description when only the command is missing', () => {
    expect(bashProcLabel({ description: 'Run the build' } as unknown as BashProcRecord)).toBe('Run the build')
  })

  it('reports no duration for a record with no start time, rather than NaN', () => {
    // Unguarded this rendered the literal string "running for NaNh NaNm" in the detail
    // header, because Math.max(0, NaN) is NaN, not 0.
    expect(bashProcElapsed({} as unknown as BashProcRecord, 9_999)).toBeNull()
    // ★ THE NASTIER VARIANT, and the reason this returns null rather than falling back to
    // `now`: `now - null` is `now`, so a null start does NOT produce visible garbage — it
    // produces a plausible, confident, WRONG duration. A fallback to `now` would render "0s"
    // here, which is the same class of quiet lie.
    expect(bashProcElapsed({ startedAt: null } as unknown as BashProcRecord, 9_999)).toBeNull()
  })
})

describe('bashOutputAvailable', () => {
  it('offers output while the engine lives and withdraws it once the engine is gone', () => {
    // Levelled DOWN on purpose, and this is the assertion that pins it. An unconfined
    // session's output file survives on the real /tmp; a confined session's dies with its
    // namespace. Keying this on confinement instead would make the panel remember for some
    // sessions and forget for others, with nothing on screen explaining the difference.
    expect(bashOutputAvailable(true)).toBe(true)
    expect(bashOutputAvailable(false)).toBe(false)
  })
})

describe('the output pane — when to poll', () => {
  it('polls exactly one state, and only while the engine is alive', () => {
    // Over the population, so a new state is not silently granted an endless poll.
    for (const st of BASH_PROC_STATES) {
      expect(shouldPollOutput(st, true), `${st} engine up`).toBe(st === 'running')
      expect(shouldPollOutput(st, false), `${st} engine gone`).toBe(false)
    }
  })

  it('★ does NOT poll an unrecognised state — the opposite default to the badge', () => {
    // isLiveBashProc treats an unknown state as live (safe for a badge: it still shows).
    // Reused here that would poll forever for a state we do not understand. Pinned so a
    // "tidy" rewrite onto isLiveBashProc reds.
    const bogus = 'bogus-future-state' as unknown as (typeof BASH_PROC_STATES)[number]
    expect(isLiveBashProc(bogus)).toBe(true)
    expect(shouldPollOutput(bogus, true)).toBe(false)
  })
})

describe('the output pane — what to show', () => {
  it('renders output, carrying the truncation flag through', () => {
    expect(outputDisplay({ ok: true, retrievable: true, output: 'hi\n', truncated: true }))
      .toEqual({ kind: 'output', text: 'hi\n', truncated: true })
  })

  it('treats EMPTY output as output, not as an error or a reason', () => {
    // A command that has written nothing yet is an ordinary state.
    expect(outputDisplay({ ok: true, retrievable: true, output: '', truncated: false }).kind).toBe('output')
  })

  it('passes a not-retrievable reason through VERBATIM', () => {
    const reason = 'Nothing has been written to the output file yet.'
    expect(outputDisplay({ ok: true, retrievable: false, reason })).toEqual({ kind: 'reason', text: reason })
  })

  it('★ keeps ok:false and a thrown request as ERRORS, never as an ordinary reason', () => {
    // ok:false means the client asked about a row the server does not have — a bug to
    // surface. Rendering it like "not yet" would hide it behind the most innocent message.
    expect(outputDisplay({ ok: false, error: 'no such background process' }))
      .toEqual({ kind: 'error', text: 'no such background process' })
    expect(outputDisplay(new Error('GET /api/… failed: 404')).kind).toBe('error')
  })

  it('never renders a blank error', () => {
    expect(outputDisplay(new Error('')).text).not.toBe('')
    expect(outputDisplay({ ok: false, error: '' }).text).not.toBe('')
  })
})
