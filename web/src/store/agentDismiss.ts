// Cleared (dismissed) agent cards, keyed by session id. Agents are DERIVED from the immutable
// transcript on every render, so there is nothing to delete — clearing one records its stable
// key here and the views filter by it.
//
// This lives in a module store rather than component state because two unrelated places read
// it: the sidebar's per-session agent list and the agent detail tab. It is persisted so a card
// you cleared stays cleared across a reload (a resumed conversation replays every past Task,
// which would otherwise re-clutter the list).
//
// The mechanics — including the volatile-key rule that took a bug to find — now live in
// store/dismissStore.ts, shared with the background-process list. The public API here is
// unchanged; only the body moved.
import { makeDismissStore } from './dismissStore'

const store = makeDismissStore('claudette:agents:dismissed:v1')

/** The keys cleared for a session. Stable identity while unchanged (safe as a dep). */
export const useDismissedAgents = store.use
/** Clear one or more agent cards for a session (no-op for keys already cleared). */
export const dismissAgents = store.dismiss
/** Drop the clears of sessions that no longer exist, so keys can't linger forever. */
export const pruneDismissed = store.prune
