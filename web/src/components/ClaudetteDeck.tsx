import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ConnectorCatalog } from './ConnectorCatalog'

// The Claudette deck — the app's first GLOBAL settings surface, opened from the mark in
// the sidebar header.
//
// Why it is not a right-dock panel like Files / Git / Permissions / Sandbox: every one of
// those takes a `session` and edits that session only. What lives here is install-wide —
// one connector catalog, one strict-MCP switch, credentials shared by every session. Put
// global state in a per-session panel and someone edits a connector URL meaning "for this
// session" and silently changes it for all of them. Keeping the two scopes on two surfaces
// is the whole point; see CONNECTORS.md.
//
// A modal overlay rather than a fifth dock tab for the same reason: the dock is the
// per-session column, and this deliberately isn't about the active session.
//
// Tabbed from the start even though there is one tab, because the ask is explicitly "other
// general config too" — the next section drops in as another DECK_TABS entry with no
// restructuring.

type DeckTab = 'connectors'

const DECK_TABS: { id: DeckTab; label: string; hint: string }[] = [
  { id: 'connectors', label: 'Connectors', hint: 'External MCP servers this install can grant to sessions' },
]

export function ClaudetteDeck({ onClose, cwd }: { onClose: () => void; cwd: string }) {
  const [tab, setTab] = useState<DeckTab>('connectors')

  // PORTALLED to document.body, like every other modal here (ConfirmDialog et al). Not
  // optional: the trigger lives in the sidebar `<aside>`, which carries a `translate-x-0`
  // for its slide-in — and a CSS transform makes an element the containing block for
  // `position: fixed` descendants. Rendered in place, `inset-0` resolves to the SIDEBAR,
  // so the deck comes up squeezed into a 260px column instead of centred on the viewport.
  return createPortal(
    <div data-overlay-layer className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      {/* Marked by hand, not via <Overlay>: this is a full-screen stacked layer with the
          same click-away hazard, but a different CONSTRUCTION — a separate absolutely
          positioned backdrop sibling plus a `relative` card, rather than container-click
          with stopPropagation on the card. Expressing both shapes in one primitive would
          mean two dismissal modes and two backdrop styles inside it, which is worse than
          this one attribute. See Overlay.tsx for what the marker is for; the cursor-
          positioned row/kernel menus deliberately do NOT carry it, because a menu is not a
          layer over the whole screen and its own dismissal IS the click. */}
      {/* Click-away closes. Nothing here is a staged form — every control writes through
          immediately — so there is no half-finished edit to lose. */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-3xl max-h-[85vh] flex flex-col rounded-lg bg-ctp-base border border-ctp-surface1 shadow-pop overflow-hidden">
        <div className="h-11 shrink-0 flex items-center gap-3 px-4 bg-ctp-mantle border-b border-ctp-surface0">
          <span className="text-sm font-semibold tracking-tight text-ctp-text">Claudette</span>
          <span className="text-[10px] uppercase tracking-wider text-ctp-overlay">settings · applies to every session</span>
          <button onClick={onClose} className="ml-auto text-ctp-overlay hover:text-ctp-text p-1" aria-label="Close">✕</button>
        </div>

        <div className="shrink-0 flex items-center gap-1 px-3 pt-2 bg-ctp-mantle border-b border-ctp-surface0">
          {DECK_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={t.hint}
              className={`px-3 py-1.5 text-xs rounded-t transition-colors ${
                tab === t.id
                  ? 'bg-ctp-base text-ctp-text border border-ctp-surface0 border-b-ctp-base -mb-px'
                  : 'text-ctp-overlay hover:text-ctp-text'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {tab === 'connectors' && <ConnectorCatalog cwd={cwd} />}
        </div>
      </div>
    </div>,
    document.body,
  )
}
