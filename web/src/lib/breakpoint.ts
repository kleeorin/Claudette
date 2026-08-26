// THE PHONE BREAKPOINT — one number, one hook, one query.
//
// Why a module rather than another `window.innerWidth < 768` at the point of use: that literal
// already existed once (App.tsx's `layout` initialiser) and a second copy is how two sources
// start disagreeing. This repo has produced that failure several times over with path
// resolvers, and once already with the visible-viewport height before `--vvh` became a single
// source (see lib/visualViewport.ts).
//
// Why it has to exist in JS at all — this is NOT a convenience. The phone layout cannot be
// expressed in CSS alone: the Claude column and the right dock carry INLINE styles (`sideW`,
// `stackH` + the dock's height, `dockW`) and an inline style beats a Tailwind class, so a
// `md:` variant cannot turn them off. Those have to be gated in JS, which means JS has to know
// the breakpoint.
//
// *** THE QUERY IS `min-width`, NEGATED — NOT `max-width: 767.98px`. ***
// Tailwind's `md:` variant IS `@media (min-width: 768px)`. Negating that IDENTICAL query makes
// this hook and every `md:` class in the tree agree at the boundary BY CONSTRUCTION: there is
// exactly one query in the system and `usePhone()` is its complement. The `max-width: 767.98px`
// spelling is the common idiom and it agrees ALMOST everywhere — it drifts only on fractional
// viewport widths between 767 and 768, which is precisely the kind of gap nobody finds
// deliberately and nobody can reproduce afterwards. scratchpad/layout-check.mjs pins the two
// sides at 767 and 768 in both directions so this cannot rot silently.

import { useSyncExternalStore } from 'react'

/**
 * Tailwind's default `md` breakpoint, in px.
 *
 * `web/tailwind.config.js` declares no `screens` key, so `md` is Tailwind's built-in 768 and
 * there is nothing importable at runtime to derive this from — the number has to be written
 * down once. This is that once.
 */
export const MD_PX = 768

const QUERY = `(min-width: ${MD_PX}px)`

// ONE MediaQueryList for the whole app. Creating one per consumer would attach a listener per
// component for a value that is global to the window, and `useSyncExternalStore` requires a
// stable `getSnapshot` — a fresh `matchMedia()` call per render returns a new object and would
// make React re-read forever.
const mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia(QUERY)
  : null

function subscribe(onChange: () => void): () => void {
  if (!mql) return () => {}
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

// `matches` is "at least md", i.e. desktop — so phone is its negation.
const getSnapshot = (): boolean => (mql ? !mql.matches : false)
// No window (SSR / prerender): assume desktop, which is the same fallback App.tsx's `layout`
// initialiser already takes when `window` is undefined.
const getServerSnapshot = (): boolean => false

/**
 * True below Tailwind's `md` breakpoint — the exact complement of the `md:` variant.
 *
 * Re-renders the caller when the viewport crosses 768px in either direction, which is what
 * makes the phone/desktop layout switch live rather than load-time.
 */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
