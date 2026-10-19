import { describe, it, expect } from 'vitest'
import type { SessionInfo } from '@claudette/shared'
import { orderSessions } from './sessionOrder'

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
