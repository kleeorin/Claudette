// Unsent composer text, kept per session. ChatView is keyed by session id, so
// switching sessions REMOUNTS it and its local `draft` state dies with it — start
// typing, glance at another session, come back, and the half-written message was
// gone. Stored in localStorage (rather than a module map) so it also survives a
// reload, like the composer history next to it in ChatView.
const PREFIX = 'claudette:draft:'
const key = (id: string) => PREFIX + id

/** The unsent text for a session, or '' if there is none. */
export function loadDraft(id: string): string {
  try { return localStorage.getItem(key(id)) ?? '' } catch { return '' }
}

/** Remember (or, for empty text, forget) a session's unsent text. */
export function saveDraft(id: string, text: string): void {
  try {
    if (text) localStorage.setItem(key(id), text)
    else localStorage.removeItem(key(id))
  } catch {
    // Quota or disabled storage. Drop any older copy rather than leave one behind:
    // restoring a stale prefix of what you typed is worse than restoring nothing.
    try { localStorage.removeItem(key(id)) } catch { /* nothing more we can do */ }
  }
}

/** Drop the drafts of sessions that no longer exist, so they can't linger forever. */
export function pruneDrafts(keep: readonly string[]): void {
  try {
    const alive = new Set(keep.map(key))
    const drop: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(PREFIX) && !alive.has(k)) drop.push(k)
    }
    for (const k of drop) localStorage.removeItem(k)
  } catch { /* private mode — nothing was persisted to prune */ }
}
