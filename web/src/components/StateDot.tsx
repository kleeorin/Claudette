import { isMuteable, type DotState } from '../lib/sessionLights'

// The per-session status light — EVERY branch of it, attention included, so there is one
// place that answers "which dot is this session showing". It used to be two call sites (an
// inline attention span and this component) and splitting them is how one of them would end
// up with a rule the other does not have.
//
// WHICH dot to show is decided by `dotState` in lib/sessionLights.ts, not here: that ordering
// is the safety invariant of the mute feature and it is worth testing exhaustively without a
// DOM. This component only paints what it is told.
//
// ★ THE STATE IS CARRIED BY `data-dot`, NOT BY THE CLASS STRING. Tests assert on that
// attribute, so restyling a colour cannot silently turn a status assertion green — the class
// names are presentation and are expected to churn; the semantic state is not.
export function StateDot({ dot, onToggleMute }: { dot: DotState; onToggleMute?: () => void }) {
  const map: Record<DotState, string> = {
    attention: 'bg-ctp-red shadow-[0_0_8px_2px] shadow-ctp-red/60 animate-pulse',
    running: 'bg-ctp-green shadow-[0_0_8px_2px] shadow-ctp-green/60 animate-pulse',
    waiting: 'bg-ctp-yellow shadow-[0_0_8px_2px] shadow-ctp-yellow/60 animate-pulse',
    exited: 'bg-ctp-red',
    // ★ A FILLED BLACK DISC. The previous rationale here said the opposite — that a black
    // fill would be "very nearly invisible" on this sidebar, so it used ctp-crust with a
    // surface2 rim instead. MEASURED 2026-09-10 IN THE BROWSER, THAT WAS BACKWARDS:
    //     fill vs sidebar #1d1e23   ·  vs active row #24262c
    //       #000 black      1.26              1.39
    //       #131417 crust   1.11              1.22   ← the "safer" choice was the dimmer one
    // Crust sits almost exactly on top of the sidebar. Black is the MORE distinguishable of
    // the two, so the fill it rejected was better than the fill it chose.
    //
    // And the rim is why it read wrong. surface2 against a crust fill measures 2.11 — the rim
    // out-contrasts its own middle, so the eye sees an OUTLINE, not a disc. Worse, surface2 is
    // the exact colour of the idle dot's fill, so a muted dot looked like an idle dot with its
    // centre knocked out. Dropping the rim to surface1 gives 1.68 against the fill (a soft
    // edge, not an outline) while still reading 1.33 against the sidebar, so the dot stays
    // findable. surface0 was measured too and rejected: 1.10 against the sidebar is invisible,
    // which loses the "where do I press" half of the problem to fix the "what is it" half.
    muted: 'bg-black ring-1 ring-ctp-surface1 hover:ring-ctp-surface2',
    // ★ IDLE GETS A HOVER RING — a desktop-only hint, and only on hover, so it never makes a
    // resting idle dot look like a muted one (which carries a ring at rest). The press cue
    // that survives TOUCH is `active:scale-90` on the button itself, below: on a phone neither
    // `cursor: pointer` nor the `title` tooltip exists, so a hover-only affordance would fix
    // nothing for the reported complaint. Both are presentation; neither touches `data-dot`.
    idle: 'bg-ctp-surface2 hover:brightness-125 hover:ring-1 hover:ring-ctp-surface1',
  }
  const title: Record<DotState, string> = {
    attention: 'Finished — needs your attention',
    running: 'running',
    waiting: 'waiting',
    exited: 'exited',
    muted: 'Dimmed — you marked this session as one you are not using. Tap to restore it; it also relights by itself the next time this session does anything.',
    idle: 'Idle — tap to dim this light while you are not using this session',
  }
  const base = 'inline-block w-2.5 h-2.5 rounded-full shrink-0'

  // ── DECISION: THE ELEMENT TYPE VARIES WITH STATE, DELIBERATELY ──────────────────────────
  // A busy, exited or attention dot renders a <span>; only a quiet one is a <button>. The
  // obvious alternative — one stable <button> that is `disabled` when not muteable — was
  // considered and rejected, because it buys neither thing it appears to buy:
  //   · FOCUS is dropped either way. A focused element that becomes `disabled` is blurred by
  //     the browser, so the remount is not what loses it; disabling loses it too.
  //   · TAB STOPS are identical either way. Disabled buttons are skipped in tab order, so a
  //     stable-disabled design contributes exactly the same stops as this one.
  // What differs is honesty: a status light on a running session is NOT a control that
  // happens to be unavailable, it is not a control at all, and announcing a permanently
  // disabled button to a screen reader for a decorative dot is worse than announcing nothing.
  // The cost accepted is React unmounting across the boundary on every state change, which
  // for a 10px leaf node with no internal state is not a cost worth paying to avoid.
  if (!isMuteable(dot) || !onToggleMute) {
    return <span data-dot={dot} className={`${base} ${map[dot]}`} title={title[dot]} />
  }
  return (
    <button
      type="button"
      data-dot={dot}
      aria-pressed={dot === 'muted'}
      // The row is itself a click target that selects the session, and this button bubbles
      // into it — without stopPropagation, muting would ALSO switch the user into the very
      // session they just said they are not using.
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onToggleMute() }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation() }}
      title={title[dot]}
      aria-label={dot === 'muted' ? 'Un-mute this session status light' : 'Mute this session status light'}
      // `after:-inset-2` expands the 10px dot's hit area without changing layout — this ships
      // to a phone, and growing the element itself would shift the row. `z-10` is load-bearing
      // rather than cosmetic: the pseudo-element paints in normal document order, so without a
      // stacking bump the session-name block that follows it in this flex row would paint over
      // the part extending to the right, and the usable target would be smaller on exactly the
      // side the thumb comes from.
      // ★ HIT AREA: 40 × 40 CSS px, MEASURED 2026-09-10 in a real browser — not computed.
      // `after:-inset-[15px]` expands the 10px dot by 15 a side. Walked outward with
      // elementFromPoint from the dot's centre until it stopped resolving to the dot.
      //
      // ⚠ 44×44 WAS ASKED FOR AND IS NOT REACHABLE HERE. The sweep, measured at each inset:
      //     inset   size     steals the session name?
      //       8     26×26    no      ← what shipped
      //      12     34×34    no
      //      15     40×40    no      ← chosen: the largest CLEAN square
      //      16     42×41    no      (height already fighting the next row)
      //      17     44×40    YES     ← width hits 44 only by eating the name
      //      20     48×37    YES     (height SHRINKS — neighbours are winning the overlap)
      // Two independent ceilings, and both bite before 44. HEIGHT is capped by row pitch:
      // rows sit ~40px apart, so a taller target overlaps the row above and below, and past
      // inset 16 the measured height DROPS as adjacent expanded areas win points from each
      // other. WIDTH is capped by the session name, which begins close enough that inset 17
      // swallows its first characters — and a tap on a session's name that mutes it instead
      // of opening it is a worse bug than a small target.
      // 40×40 is the largest size where neither happens: no neighbour theft, no other row's
      // dot centre covered, and the height exactly meets the row pitch rather than crossing
      // it. Still under the 44 that WCAG 2.5.5 and Apple HIG want; the remaining 4px are not
      // available without taking them from a control the user needs more.
      //
      // MEASURE IT THIS WAY IF YOU CHANGE IT: elementFromPoint on a grid outward from the
      // centre, and ALSO probe the session name, the ⋯ actions button and the ✕ close button
      // to see whether the expanded area has swallowed them. NOT getBoundingClientRect on the
      // ::after — that reports the intended box whether or not anything is clickable there,
      // and would have reported a clean 44 for the inset that steals the name.
      //
      // Method notes, so the next measurement costs minutes rather than an afternoon: drive
      // it over CDP (`--dump-dom` hung on a `data:` URL and dropped script-mutated titles on
      // `file://`); put the probe where node_modules resolves or `ws` fails; and ASSERT ON
      // THE ARTEFACT'S CONTENT, never the exit code — a probe here once exited 0 having
      // written a 417-byte blank png, which is exactly as green as a correct one.
      // Measure at DESKTOP width: at phone width the sidebar is a drawer translated
      // off-screen (`-translate-x-full`), so elementFromPoint returns null and every reading
      // is 1×1 — a false zero that looks like a broken hit area rather than a hidden one.
      className={`${base} relative z-10 after:absolute after:-inset-[15px] after:content-[''] cursor-pointer transition-all active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ctp-accent ${map[dot]}`}
    />
  )
}
