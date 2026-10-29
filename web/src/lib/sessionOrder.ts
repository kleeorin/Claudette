import type { SessionInfo, ProjectInfo } from '@claudette/shared'

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

// ── PROJECTS ─────────────────────────────────────────────────────────────────────────────
// The sidebar with a level above families: Project → top-level sessions → subsessions.
//
// A family's project is its ROOT's projectId — only top-level sessions carry one, and a
// subsession belongs to its parent's project whatever it might carry itself. A projectId
// naming no known project is treated like a missing parent: the family renders as an ordinary
// ungrouped row, so nothing can vanish from the sidebar.
//
// GROUPS — each project, and each ungrouped family — sort among each other by the same two keys
// families always used: black (muted) last, then newest activity. A project's rank is the
// newest activity anywhere inside it, and it is black only when ALL its sessions are black. A
// project with no sessions is kept (projects outlive their last session) and, having nothing
// to watch, sorts like an all-black group. Inside a project, families order exactly as
// orderSessions orders them. A collapsed project contributes its header only; `count` is every
// session in it, subsessions included, so a collapsed header still says what it is hiding.
export type SidebarRow =
  | { kind: 'project'; project: ProjectInfo; count: number }
  | { kind: 'session'; session: SessionInfo; depth: number; projectId?: string }

export function orderSidebar(
  sessions: SessionInfo[],
  projects: ProjectInfo[],
  activity: ReadonlyMap<string, number>,
  isBlack: (id: string) => boolean = () => false,
): SidebarRow[] {
  // orderSessions already yields families in order, each root followed by its subtree. Cut that
  // stream into families (a depth-0 row starts one), then group families by the root's project.
  const flat = orderSessions(sessions, activity, isBlack)
  const known = new Map(projects.map((p) => [p.id, p]))
  type Family = { rows: { session: SessionInfo; depth: number }[]; rank: number; black: boolean }
  const families: Family[] = []
  for (const r of flat) {
    if (r.depth === 0 || !families.length) families.push({ rows: [], rank: 0, black: true })
    const f = families[families.length - 1]
    f.rows.push(r)
    f.rank = Math.max(f.rank, activity.get(r.session.id) ?? 0)
    f.black = f.black && isBlack(r.session.id)
  }
  type Group = { project?: ProjectInfo; families: Family[]; rank: number; black: boolean; order: number }
  const groups: Group[] = []
  const byProject = new Map<string, Group>()
  // Initial order is first appearance, so the stable sort below keeps server order on ties.
  for (const f of families) {
    const pid = f.rows[0].session.projectId
    const project = pid ? known.get(pid) : undefined
    if (!project) { groups.push({ families: [f], rank: f.rank, black: f.black, order: groups.length }); continue }
    let g = byProject.get(project.id)
    if (!g) { g = { project, families: [], rank: 0, black: true, order: groups.length }; byProject.set(project.id, g); groups.push(g) }
    g.families.push(f)
    g.rank = Math.max(g.rank, f.rank)
    g.black = g.black && f.black
  }
  for (const p of [...projects].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!byProject.has(p.id)) groups.push({ project: p, families: [], rank: 0, black: true, order: groups.length })
  }
  // ★ REDUNDANT TODAY, KEPT ON PURPOSE — measured by mutation (2026-10-26). `flat` already
  // arrives sorted by (black, rank), so a group's first appearance IS its best family's place
  // and its first family's rank IS its max: removing this sort, or replacing the Math.max above
  // with "first family's rank", changes no output for any input (both mutants survive every
  // test, and no test could kill them). It stays so this function's order does not silently
  // depend on orderSessions' — change that sort and this one is what still holds.
  groups.sort((a, b) => (Number(a.black) - Number(b.black)) || (b.rank - a.rank) || (a.order - b.order))
  const out: SidebarRow[] = []
  for (const g of groups) {
    if (!g.project) { for (const r of g.families[0].rows) out.push({ kind: 'session', ...r }); continue }
    out.push({ kind: 'project', project: g.project, count: g.families.reduce((n, f) => n + f.rows.length, 0) })
    if (g.project.collapsed) continue
    for (const f of g.families) for (const r of f.rows) out.push({ kind: 'session', ...r, projectId: g.project.id })
  }
  return out
}
