import { describe, it, expect } from 'vitest'
import type { SessionInfo, ProjectInfo } from '@claudette/shared'
import { orderSessions, orderSidebar, type SidebarRow } from './sessionOrder'

// Fresh records per call — a shared object across cases has hidden a regression here before.
const s = (id: string, parentId?: string): SessionInfo =>
  ({ id, name: id, cwd: '/tmp', rootDir: '/tmp', state: 'idle', parentId } as unknown as SessionInfo)
const ids = (rows: { session: SessionInfo; depth: number }[]) => rows.map((r) => r.session.id)
const act = (o: Record<string, number>) => new Map(Object.entries(o))
const black = (...b: string[]) => (id: string) => b.includes(id)

describe('orderSessions', () => {
  it('ranks families by their newest activity', () => {
    expect(ids(orderSessions([s('a'), s('b'), s('c')], act({ a: 1, b: 3, c: 2 })))).toEqual(['b', 'c', 'a'])
  })

  it('keeps server order for equal (zero) activity — the sort is stable', () => {
    expect(ids(orderSessions([s('a'), s('b'), s('c')], act({})))).toEqual(['a', 'b', 'c'])
  })

  it('keeps a subsession under its parent and lifts the family by the child\'s activity', () => {
    const rows = orderSessions([s('p'), s('q'), s('k', 'p')], act({ q: 2, k: 5 }))
    expect(ids(rows)).toEqual(['p', 'k', 'q'])
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 0])
  })

  // ★ The operator's rule: a black (muted) light always sinks to the bottom.
  it('sinks a black family below every non-black one, even the most active', () => {
    expect(ids(orderSessions([s('a'), s('b'), s('c')], act({ a: 9, b: 1, c: 2 }), black('a')))).toEqual(['c', 'b', 'a'])
  })

  it('keeps most-recent-first order inside the black block too', () => {
    expect(ids(orderSessions([s('a'), s('b'), s('c'), s('d')], act({ a: 1, b: 2, c: 3, d: 4 }), black('a', 'b')))).toEqual(['d', 'c', 'b', 'a'])
  })

  it('treats a family as black only when ALL of it is black', () => {
    // muted parent with a non-black child is still a family being watched
    const mixed = orderSessions([s('p'), s('k', 'p'), s('q')], act({ p: 9, k: 1, q: 2 }), black('p'))
    expect(ids(mixed)).toEqual(['p', 'k', 'q'])
    const allBlack = orderSessions([s('p'), s('k', 'p'), s('q')], act({ p: 9, k: 1, q: 2 }), black('p', 'k'))
    expect(ids(allBlack)).toEqual(['q', 'p', 'k'])
  })

  // ★ No pin: the result depends only on the inputs, so a light change re-sorts immediately,
  // the viewed session included. Same call twice with a changed light must change the order.
  it('re-sorts as soon as a light changes — no state carried between calls', () => {
    const list = [s('a'), s('b')]
    const a = act({ a: 2, b: 1 })
    expect(ids(orderSessions(list, a))).toEqual(['a', 'b'])
    expect(ids(orderSessions(list, a, black('a')))).toEqual(['b', 'a'])
    expect(ids(orderSessions(list, a))).toEqual(['a', 'b'])
  })

  it('never drops a session: orphans become roots and a parentId cycle still renders', () => {
    const rows = orderSessions([s('x', 'gone'), s('y', 'z'), s('z', 'y')], act({}))
    expect(ids(rows).sort()).toEqual(['x', 'y', 'z'])
  })
})

// ── PROJECTS ─────────────────────────────────────────────────────────────────────────
// Project → top-level sessions → subsessions. Projects and ungrouped families sort among each
// other by the same two keys as families do: black (muted) last, then newest activity.
const sp = (id: string, projectId?: string, parentId?: string): SessionInfo =>
  ({ id, name: id, cwd: '/w', rootDir: '/w', state: 'idle', parentId, projectId } as unknown as SessionInfo)
const pr = (id: string, createdAt = 0, collapsed?: boolean): ProjectInfo => ({ id, name: id, cwd: '/w', createdAt, ...(collapsed ? { collapsed } : {}) })
// 'P:<id>' for a header, the session id for a session row (indented ones prefixed with '>').
const rowsOf = (rows: SidebarRow[]) => rows.map((r) => r.kind === 'project' ? `P:${r.project.id}` : `${r.projectId ? '>' : ''}${r.session.id}`)

describe('orderSidebar — the project level', () => {
  it('puts a project header above its sessions, families in project order inside', () => {
    const rows = orderSidebar([sp('a', 'p1'), sp('b', 'p1'), sp('k', undefined, 'a')], [pr('p1')], act({ a: 1, b: 3, k: 2 }))
    expect(rowsOf(rows)).toEqual(['P:p1', '>b', '>a', '>k'])
  })

  it('ranks a project by the newest activity anywhere inside it — a subsession lifts it', () => {
    const rows = orderSidebar([sp('a', 'p1'), sp('k', undefined, 'a'), sp('u')], [pr('p1')], act({ a: 1, k: 9, u: 5 }))
    expect(rowsOf(rows)).toEqual(['P:p1', '>a', '>k', 'u'])
  })

  it('sorts ungrouped families AMONG projects by the same keys', () => {
    const rows = orderSidebar([sp('a', 'p1'), sp('u'), sp('b', 'p2')], [pr('p1'), pr('p2')], act({ a: 2, u: 3, b: 1 }))
    expect(rowsOf(rows)).toEqual(['u', 'P:p1', '>a', 'P:p2', '>b'])
  })

  it('sinks a project only when ALL its sessions are black', () => {
    const list = [sp('a', 'p1'), sp('b', 'p1'), sp('u')]
    const a = act({ a: 9, b: 8, u: 1 })
    expect(rowsOf(orderSidebar(list, [pr('p1')], a, black('a')))).toEqual(['P:p1', '>b', '>a', 'u'])
    // all black → the project sinks; inside it the black block keeps most-recent-first (a=9, b=8)
    expect(rowsOf(orderSidebar(list, [pr('p1')], a, black('a', 'b')))).toEqual(['u', 'P:p1', '>a', '>b'])
  })

  it('a collapsed project shows its header (with the count) and hides its sessions', () => {
    const rows = orderSidebar([sp('a', 'p1'), sp('k', undefined, 'a'), sp('u')], [pr('p1', 0, true)], act({ a: 5, u: 1 }))
    expect(rowsOf(rows)).toEqual(['P:p1', 'u'])
    const head = rows[0] as Extract<SidebarRow, { kind: 'project' }>
    expect(head.count).toBe(2)
  })

  it('keeps a project with NO sessions (it outlives its last one), sorted as idle', () => {
    const rows = orderSidebar([sp('u')], [pr('empty')], act({ u: 1 }))
    expect(rowsOf(rows)).toEqual(['u', 'P:empty'])
    expect((rows[1] as Extract<SidebarRow, { kind: 'project' }>).count).toBe(0)
  })

  it('a DANGLING projectId renders as an ungrouped top-level row, like a missing parent', () => {
    const rows = orderSidebar([sp('a', 'gone'), sp('b', 'p1')], [pr('p1')], act({ a: 2, b: 1 }))
    expect(rowsOf(rows)).toEqual(['a', 'P:p1', '>b'])
  })

  it('a subsession follows its PARENT\'s project, whatever projectId it carries', () => {
    const rows = orderSidebar([sp('a', 'p1'), sp('k', 'p2', 'a')], [pr('p1'), pr('p2')], act({ a: 2 }))
    expect(rowsOf(rows)).toEqual(['P:p1', '>a', '>k', 'P:p2'])
  })

  it('never drops a session, and with no projects matches orderSessions exactly', () => {
    const list = [sp('a'), sp('b'), sp('k', undefined, 'a'), sp('x', undefined, 'gone')]
    const a = act({ a: 1, b: 2, x: 3 })
    expect(orderSidebar(list, [], a).map((r) => r.kind === 'session' ? r.session.id : '')).toEqual(ids(orderSessions(list, a)))
  })
})
