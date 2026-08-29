import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'

// THE ONE PLACE A CENTRED MODAL BECOMES A PORTAL — and, more importantly, the one place
// `data-overlay-layer` is written.
//
// WHY THE ATTRIBUTE EXISTS. A modal rendered through `createPortal` to `<body>` is not a DOM
// descendant of whatever opened it. Any click-away handler that asks "is this click inside
// my ref?" therefore reads a click inside the modal as OUTSIDE, and closes. That is not
// hypothetical: the chat meta-bar's sandbox chip closed its popover on the first click into
// the folder picker, unmounting SandboxEditor and taking the picker's own `picking` state
// with it — so mounting a folder from the chip was impossible (fixed in 234f998). The right
// dock's SandboxPanel renders the same editor with no click-away handler, which is why the
// identical flow worked there and the bug looked like a UI quirk rather than a missing
// attribute.
//
// So: a click-away handler consults `closest('[data-overlay-layer]')` and returns early —
// leaving its popover open — when the target sits inside an overlay.
//
// *** WHY THIS IS A COMPONENT AND NOT A CONVENTION. ***
// The marker on its own is a rule you have to remember. A portal added without it silently
// reintroduces the bug, and it presents as "the popover closes when I click things" — which
// reads as a UI quirk, so nobody greps for `data-overlay-layer`. Routing the portals through
// one primitive removes the place where it can be forgotten: there is no longer a way to
// write one of these modals and omit the attribute, because you no longer write the
// attribute at all.
//
// *** THE MARKER GOES ON THE OUTERMOST NODE. NOT THE CARD. ***
// Load-bearing, and proven by mutation D in scratchpad/sandbox-chip-picker-guard.mts: with
// the marker on the inner card, the dialog and its rows are still exempt, so most assertions
// stay green and only the BACKDROP case reds — which is exactly the half a user hits when
// they click the dimmed area to dismiss. Keep it on the container below.
//
// WHAT THIS DELIBERATELY DOES NOT OWN — the card, and `stopPropagation` on it.
// Card styling varies at every call site (widths, borders, padding, colour), so wrapping
// children in a card would force ten dialogs to look the same. And the cards keep their own
// `onClick={(e) => e.stopPropagation()}` rather than the container switching to an
// `e.target === e.currentTarget` test, even though that would be tidier and would let the
// call sites drop it. The two are NOT equivalent: `stopPropagation` prevents the click from
// reaching document-level listeners at all, while a target check lets it through and merely
// ignores it. This was a refactor, and that is a behaviour change — so the cards were left
// exactly as they were.
//
// NOT ROUTED THROUGH HERE, on purpose: ClaudetteDeck and ConnectorCatalog build the same
// effect a different way (a separate absolutely-positioned backdrop sibling plus a
// `relative` card, `bg-black/60`, no blur), and the two cursor-positioned context menus
// (NotebookView's cell menu, FileManager's RowMenu) are not centred modals at all. Bending
// either side to fit would have cost more than the duplication saved. They are unmarked; see
// the report accompanying this change.

// Tailwind scans source text for class names, so the z-index literals live HERE rather than
// being interpolated from a caller's string — that keeps them findable by the JIT scanner in
// one file instead of depending on every call site spelling the class out.
const Z = { 50: 'z-50', 70: 'z-[70]' } as const

export function Overlay({ z = 50, onClose, children }: {
  /** Stacking level. 70 sits above a dialog that can itself open one (FileManager's delete
   *  confirmation over the file browser, the notebook prompts over the editor). */
  z?: keyof typeof Z
  /** Backdrop click. Omit for a modal that must be dismissed explicitly. */
  onClose?: () => void
  children: ReactNode
}) {
  return createPortal(
    <div
      data-overlay-layer
      className={`fixed inset-0 ${Z[z]} flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in`}
      onClick={onClose}
    >
      {children}
    </div>,
    document.body,
  )
}
