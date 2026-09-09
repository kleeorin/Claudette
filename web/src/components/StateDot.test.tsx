// StateDot — the DOM wiring the pure tests in lib/sessionLights.test.ts cannot reach.
// Those pin WHICH light shows; these pin that the control is reachable, that its state is
// readable by assistive tech, and — the one with a real bug behind it — that clicking it does
// not also select the session.
//
// ★ ASSERTIONS ARE ON STRUCTURE, NOT ON CLASS NAMES OR PROSE. `data-dot` carries the semantic
// state and `aria-pressed` carries the toggle; both are contracts. The Tailwind strings are
// presentation and will churn, and a test that pinned them would go green the moment someone
// reworded a colour while the behaviour broke.
//
// MUTATIONS (measured 2026-09-04):
//   M8  delete `e.stopPropagation()` from the button's onClick
//       → "muting does not select the session" reds ALONE. This is a real defect, not a
//         hypothetical: the row's own onClick selects the session, so without it the user is
//         switched into the session they just said they are not using.
//   M9  render a <span> for every dot instead of a <button> when muteable
//       → the role/keyboard cases red; the non-muteable cases stay green.
//   M10 hardcode `aria-pressed={false}`
//       → the aria-pressed case reds alone.
//   M11 drop the `!onToggleMute` arm of the early return (render a button with no handler)
//       → "a dot with no handler is not a control" reds.
//   XX  a patch matching no text must REFUSE.
//
// ⚠ METHOD NOTE, ADDED 2026-09-08 AND IT APPLIES TO EVERY MUTATION RECORD ABOVE.
// The records above name which assertions turned red. They do NOT record how many assertions
// EXECUTED, and that number is the one that tells you the run was real. A mutant that fails to
// PARSE — a stray bracket, a shell-escaping accident — produces zero failures, exactly like a
// clean pass. Counting only failures cannot tell them apart.
//
// Both directions are wrong and one is worse. On a mutation you expect to red, a crash reads
// as "this assertion is vacuous": you chase a phantom, which wastes time but corrects itself.
// On a CONTROL you expect to stay green, a crash reads as A PASSING CONTROL — silently, with
// nothing to chase — and a control's entire job is to prove the harness still works.
//
// Measured here rather than argued, by injecting a syntax error into a mutant:
//     clean control  → exit 0, failures counted 0, totals line "12/12 passed"
//     crashed mutant → exit 1, failures counted 0, totals line "?"
// The failure count is IDENTICAL. Only the executed count separates them.
//
// The runs behind the records above did print a totals line and it was read at the time, so
// they are not suspect — but the DURABLE record omits it, which leaves a future reader one
// assumption short of a proof. Stated rather than quietly relied on. New records in this
// repo should carry `ran=N` alongside the red set; `MIN_ASSERTIONS` in
// scratchpad/session-reducer-test.mts is the same instrument pointed at the suite instead of
// at a mutation run.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { StateDot } from './StateDot'
import type { DotState } from '../lib/sessionLights'

afterEach(cleanup)

const dot = () => document.querySelector('[data-dot]') as HTMLElement

describe('StateDot', () => {
  it('publishes the semantic state on data-dot for every kind of light', () => {
    for (const d of ['attention', 'running', 'waiting', 'exited', 'idle', 'muted'] as DotState[]) {
      cleanup()
      render(<StateDot dot={d} onToggleMute={() => {}} />)
      expect(dot().getAttribute('data-dot')).toBe(d)
    }
  })

  it('a quiet dot is a real button — focusable and keyboard-operable', () => {
    render(<StateDot dot="idle" onToggleMute={() => {}} />)
    const b = screen.getByRole('button')
    expect(b.getAttribute('aria-label')).toBeTruthy()
    expect(b.getAttribute('title')).toBeTruthy()
  })

  it('a busy dot offers no control at all', () => {
    for (const d of ['running', 'waiting', 'exited', 'attention'] as DotState[]) {
      cleanup()
      render(<StateDot dot={d} onToggleMute={() => {}} />)
      expect(screen.queryByRole('button')).toBeNull()
    }
  })

  it('a dot with no handler is not a control', () => {
    render(<StateDot dot="idle" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('aria-pressed reflects whether it is muted', () => {
    render(<StateDot dot="muted" onToggleMute={() => {}} />)
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true')
    cleanup()
    render(<StateDot dot="idle" onToggleMute={() => {}} />)
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false')
  })

  it('clicking toggles the mute', () => {
    const onToggleMute = vi.fn()
    render(<StateDot dot="idle" onToggleMute={onToggleMute} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggleMute).toHaveBeenCalledTimes(1)
  })

  // ★ THE ONE WITH A REAL BUG BEHIND IT. The sidebar row wraps this dot in a div whose
  // onClick selects the session. Without stopPropagation, muting a session ALSO switches the
  // user into it — the exact opposite of "I am not using this one".
  it('muting does not also select the session (the click must not reach the row)', () => {
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <StateDot dot="idle" onToggleMute={() => {}} />
      </div>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(rowClick).not.toHaveBeenCalled()
  })
})
