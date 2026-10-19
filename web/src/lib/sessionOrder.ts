import type { SessionInfo } from '@claudette/shared'

// Flatten the server's session list into display order: every subsession sits
// directly under its parent (nested to any depth). A session whose parent isn't in the list
// (closed, or not yet loaded) is treated as top-level so it can never vanish from the sidebar.
//
// Extracted from App.tsx (2026-10-19) because nothing imports App.tsx: an ordering rule
// written there is invisible to every test. See sessionOrder.test.ts.
//
// ── BLACK LIGHTS LAST ────────────────────────────────────────────────────────────────
// A family whose every session shows the BLACK light (muted — StateDot's `muted`) sinks below
// every family with any other light, regardless of activity. The operator asked for exactly
// this: a muted session is one you have said you do not want to watch, so it should not
// compete for the top with ones you do. A family is black only when ALL of it is black — a
// muted parent with a running subsession is still a family you are watching. Within the
// black block, families keep the same most-recently-active order as above it.
//
// ── MOST RECENTLY ACTIVE FIRST, BY FAMILY ────────────────────────────────────────────
// Top-level rows are ordered by the newest activity ANYWHERE IN THE FAMILY — a parent and
// its subsessions travel together as a block, so a subsession doing the work lifts its whole
// family and the parent→child structure is never broken to do it. That was the operator's
// choice over floating the subsession out on its own.
//
// Within a family, children keep creation order. Sorting there too would mean a nested list
// reshuffling at two levels, which is harder to track than it is useful.
//
// `activity` is a monotonic counter from the store, bumped when a SESSION acts — not when
// you send to it. Sessions with no recorded activity yet (restored from persistence, never
// touched this load) rank 0 and therefore sort below anything that has moved, keeping their
// relative creation order because the sort is stable.
//
// ── NO PIN ───────────────────────────────────────────────────────────────────────────
// The session you are viewing used to hold its index until you left it. Removed 2026-10-19 on
// the operator's call: a light change must re-sort the list immediately, the viewed row
// included, not only once you click elsewhere. This function is pure, so the order is a
// function of (sessions, activity, which rows are black) and nothing else — there is no
// hidden previous-render state left to make a light change wait.
export function orderSessions(
  sessions: SessionInfo[],
  activity: ReadonlyMap<string, number>,
  isBlack: (id: string) => boolean = () => false,
): { session: SessionInfo; depth: number }[] {
  const byParent = new Map<string, SessionInfo[]>()
  const ids = new Set(sessions.map((s) => s.id))
  const roots: SessionInfo[] = []
  for (const s of sessions) {
    const pid = s.parentId && ids.has(s.parentId) && s.parentId !== s.id ? s.parentId : null
    if (!pid) { roots.push(s); continue }
    const kids = byParent.get(pid) ?? []; kids.push(s); byParent.set(pid, kids)
  }
  const out: { session: SessionInfo; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (s: SessionInfo, depth: number) => {
    if (seen.has(s.id)) return   // guards a parentId cycle from recursing forever
    seen.add(s.id)
    out.push({ session: s, depth })
    for (const k of byParent.get(s.id) ?? []) walk(k, depth + 1)
  }
  // Rank and blackness of each root's WHOLE subtree, from the same parent map that walk()
  // renders, so neither can disagree with the nesting on screen.
  const family = (s: SessionInfo, guard = new Set<string>()): { rank: number; black: boolean } => {
    if (guard.has(s.id)) return { rank: 0, black: true }   // same parentId-cycle guard as walk()
    guard.add(s.id)
    let rank = activity.get(s.id) ?? 0
    let black = isBlack(s.id)
    for (const k of byParent.get(s.id) ?? []) {
      const f = family(k, guard)
      rank = Math.max(rank, f.rank)
      black = black && f.black
    }
    return { rank, black }
  }
  const ranked = roots.map((s) => ({ s, ...family(s) }))
  // Stable by construction: Array.prototype.sort is stable in every engine this ships to,
  // so equal keys (including the all-zero case on a cold load) keep server order.
  ranked.sort((a, b) => (Number(a.black) - Number(b.black)) || (b.rank - a.rank))
  for (const { s: r } of ranked) walk(r, 0)
  for (const s of sessions) if (!seen.has(s.id)) out.push({ session: s, depth: 0 })   // cycle leftovers
  return out
}
