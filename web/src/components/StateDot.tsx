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
    // Not a black FILL. A filled black dot on this sidebar (bg #1d1e23, #24262c when the row
    // is active) is very nearly invisible, which defeats the whole point of "so i know im not
    // using it". An unlit ring reads as off AND stays visible: the crust fill is darker than
    // every surface behind it, and the surface2 rim is what you actually see.
    muted: 'bg-ctp-crust ring-1 ring-ctp-surface2 hover:ring-ctp-overlay',
    idle: 'bg-ctp-surface2 hover:brightness-125',
  }
  const title: Record<DotState, string> = {
    attention: 'Finished — needs your attention',
    running: 'running',
    waiting: 'waiting',
    exited: 'exited',
    muted: 'Muted — you marked this session as one you are not using. Click to un-mute; it also relights by itself on the next activity.',
    idle: 'Idle — click to mute this light while you are not using this session',
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
      // ⚠ THE RESULTING SIZE IS UNVERIFIED IN FACT — BUT IT IS VERIFIABLE, AND HERE IS HOW.
      // Treat "~26px" as the intent, not a measurement: nobody has run the experiment. It was
      // deferred by the operator, NOT blocked. An earlier version of this comment said it
      // could not be measured because no browser was available here; that was wrong, and the
      // wrong version is worse than no note at all, because it tells the next reader not to
      // bother trying.
      //
      // The browser is `.chrome-headless/chrome/*/chrome-linux64/chrome` — inside the repo,
      // so inside every sandbox, reachable and executable from a CONFINED session (measured
      // 2026-09-08). `run-suite.sh` finds it the same way; ask the runner rather than probing
      // /usr/bin, where the path appears to exist and is not reachable from a box.
      //
      // THE EXPERIMENT: `elementFromPoint` at the dot's centre ±10px against a real layout.
      // NOT getBoundingClientRect on the ::after, which reports the intended box whether or
      // not anything can actually be clicked there. Confirmed on a synthetic fixture that a
      // point outside the element but inside an `inset:-8px` ::after does resolve to the
      // element, so the technique measures what it claims to.
      //
      // THREE THINGS THAT COST AN AFTERNOON, written down rather than rediscovered:
      //  1. Drive it over CDP. `--dump-dom` hung on a `data:` URL and dropped the
      //     script-mutated title on a `file://` one.
      //  2. Put the probe where `node_modules` resolves beside it, or `ws` fails with
      //     ERR_MODULE_NOT_FOUND.
      //  3. ★ ASSERT ON THE ARTEFACT'S CONTENT, NEVER ON THE EXIT CODE. A headless probe here
      //     exited 0 and wrote a 417-byte BLANK png — its fixture had put `#4a3` in a `data:`
      //     URL, where `#` starts the fragment, so the stylesheet never arrived. A blank
      //     screenshot is exactly as green as a correct one. Floor the byte size, sample a
      //     pixel, or probe the text through CDP.
      //
      // `web/dist` is CURRENT for this component: rebuilt 2026-09-08 20:02:49 and confirmed by
      // CONTENT rather than timestamp — data-dot, after:-inset-2, z-10 and aria-pressed are all
      // in the built asset. Note that run-suite's staleness banner may still read NO SIGNAL,
      // because it compares mtimes and a COMMENT-ONLY edit to this file is enough to trip it.
      // That banner is a prompt to check the bundle, not a verdict on it.
      className={`${base} relative z-10 after:absolute after:-inset-2 after:content-[''] cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ctp-accent ${map[dot]}`}
    />
  )
}
