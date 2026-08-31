import { useSyncExternalStore } from 'react'
// THE VISIBLE height of the window, published as a CSS custom property.
//
// Why this exists as a shared module rather than a fix in one component. On iOS the software
// keyboard does NOT shrink the layout viewport: `100vh`, `innerHeight` and even `100dvh` all
// keep reporting the full screen while the keyboard covers ~40% of it. Only
// `window.visualViewport` reports what the user can actually see. That single fact has now
// produced two separate defects in this codebase:
//
//   1. AskUserQuestionCard sized itself with `max-h-[60vh]`. Measured at 390×844: Submit at
//      669px passes a check against innerHeight (844) and is HIDDEN BY 161px once the
//      keyboard leaves ~508px visible — and the card's own free-text input is what raises
//      the keyboard, so the interaction that needs Submit is the one that hides it.
//   2. The terminal dock kept a saved pixel height with the keyboard up, so the bottom of
//      the terminal — the prompt — was clipped away by an `overflow-hidden` shell.
//
// Two point-fixes for one root cause is how this repo ended up with several disagreeing path
// resolvers. So: one source of truth. Both consumers now read `--vvh` from CSS: the
// AskUserQuestion card caps itself at `calc(var(--vvh,100vh)*0.55)`, and App.tsx bounds the
// terminal dock with `boundedDockH()`. Measured by scratchpad/xterm-vvh-probe.mjs.
//
// *** THE DEFECT (2) DESCRIBED HERE WAS MISDIAGNOSED, and the wrong diagnosis is worth
// keeping because it would send the next reader to the wrong file. It used to read: "xterm's
// FitAddon re-fits from a ResizeObserver gated on `contentRect.width`, so a keyboard never
// triggers a re-fit at all." That is wrong twice. A ResizeObserver fires on ANY box change
// including a height-only one, and `contentRect.width > 0` is a LIVENESS test (is the pane
// hidden?), not a width-CHANGED test — so it passes and `fit()` runs. useTerminal was never
// the problem. What was missing was a BOX THAT CHANGES: the dock's height was an absolute
// pixel value that ignored `--vvh` entirely, so there was nothing for the observer to
// observe. Bounding the dock in CSS was enough on its own — the existing observer re-fits,
// measured 30 rows -> 16 as `--vvh` went 844 -> 508. No JS subscription was needed, and one
// would have cost a re-render of App on every visualViewport `scroll` event. ***
//
// HONEST LIMIT, NARROWED. headless Chrome has no software keyboard and `visualViewport.height`
// there always equals `innerHeight`, so the KEYBOARD TRIGGER still cannot be driven directly.
// But the visual viewport itself is NOT beyond reach: `Emulation.setPageScaleFactor` makes it
// shorter than the layout viewport and a wheel event pans it — see
// scratchpad/visual-viewport-pan-probe.mjs. Harnesses set `--vvh` directly to stand in for
// the keyboard, which tests every consumer of this module faithfully.

const PROP = '--vvh'

/** The visible viewport height in px, falling back to innerHeight where unsupported. */
export function visibleHeight(): number {
  return Math.round(window.visualViewport?.height ?? window.innerHeight)
}

function publish(): void {
  document.documentElement.style.setProperty(PROP, `${visibleHeight()}px`)
}

/**
 * Start publishing `--vvh` and keep it current. Idempotent, and safe to call before any
 * consumer mounts. Returns a teardown for tests; the app never needs it.
 */
export function trackVisibleHeight(): () => void {
  publish()
  const vv = window.visualViewport
  // `resize` covers the keyboard appearing/disappearing; `scroll` covers iOS shifting the
  // visual viewport when a focused input is pushed into view. The window `resize` fallback
  // keeps desktop and unsupported browsers correct.
  vv?.addEventListener('resize', publish)
  vv?.addEventListener('scroll', publish)
  window.addEventListener('resize', publish)
  return () => {
    vv?.removeEventListener('resize', publish)
    vv?.removeEventListener('scroll', publish)
    window.removeEventListener('resize', publish)
  }
}

// --- reading the visible height FROM React -------------------------------------------
// A subscription, unlike the CSS consumers above, because some bounds cannot be expressed in
// CSS: App.tsx clamps the stacked column's `stackH` and derives the terminal dock's reserve
// from the SAME number, and two `calc()` strings cannot share an intermediate value.
// Computing it twice is how the column once reserved a height the dock no longer occupied.
//
// *** IT READS `--vvh` ITSELF, NOT `visualViewport.height`. ***
// That looks like the indirect choice and it is the correct one: it makes the JS bound and
// every CSS bound read ONE value rather than two that merely usually agree. They can come
// apart — anything that sets `--vvh` without moving the visual viewport (a harness
// simulating a keyboard, a future feature reserving space) would leave a JS bound reading
// the raw viewport while the CSS around it used the published number, and the two would
// disagree about the same layout. Reading the published variable makes that impossible.
// `visibleHeight()` remains the fallback for the window before the first publish.
//
// The MutationObserver watches the style attribute the publisher writes, so the store tracks
// the variable however it is set. That is cheap despite `publish()` running on every
// visualViewport `scroll`: useSyncExternalStore re-renders only when the SNAPSHOT changes,
// and a pan republishes the same number, so a scroll costs one Object.is comparison and no
// render.
function readPublished(): number {
  if (typeof document === 'undefined') return 0
  const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(PROP))
  return Number.isFinite(raw) && raw > 0 ? raw : visibleHeight()
}

function subscribeHeight(onChange: () => void): () => void {
  const vv = window.visualViewport
  vv?.addEventListener('resize', onChange)
  window.addEventListener('resize', onChange)
  const mo = new MutationObserver(onChange)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
  return () => {
    vv?.removeEventListener('resize', onChange)
    window.removeEventListener('resize', onChange)
    mo.disconnect()
  }
}

/** The visible viewport height, re-rendering the caller when it changes. */
export function useVisibleHeight(): number {
  return useSyncExternalStore(subscribeHeight, readPublished, () => 0)
}
