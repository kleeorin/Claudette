// The shared dismiss store — the mechanics behind BOTH the agent list's "clear" and the
// background-process list's.
//
// ★ THIS CODE WAS UNTESTED FOR ITS WHOLE LIFE. It shipped as store/agentDismiss.ts with no
// test file at all, and was only extracted when the background-process panel needed the same
// behaviour. Extraction is the moment to add the coverage, not a reason to defer it: one copy
// serving two features means a defect now shows up in two places at once.
//
// ★★ THE RULE THAT TOOK A BUG TO FIND, and the one most likely to be "simplified" away:
// a VOLATILE key (`i7` — a transcript-item id minted by a counter that restarts at i1 every
// page load) must work for the rest of the session but must NEVER be written to localStorage.
// Persisting one means a clear recorded as "i7" silently pre-hides whatever unrelated item
// lands on i7 after the next reload. The two cases below pin both halves of that: active now,
// absent from disk.
import { describe, it, expect, beforeEach } from 'vitest'
import { makeDismissStore } from './dismissStore'

const read = (k: string): Record<string, string[]> => JSON.parse(localStorage.getItem(k) ?? '{}')

beforeEach(() => localStorage.clear())

describe('makeDismissStore', () => {
  it('records a dismissal and persists it under its own key', () => {
    const s = makeDismissStore('test:alpha')
    s.dismiss('sess-1', ['toolu_a', 'toolu_b'])
    expect(read('test:alpha')['sess-1']).toEqual(['toolu_a', 'toolu_b'])
  })

  it('★★ two stores are INDEPENDENT — the whole point of the extraction', () => {
    // Agents and background processes share an implementation and must not share a namespace.
    // If this ever regressed, clearing an agent card would hide a background process with a
    // coincidentally equal id, and vice versa.
    const agents = makeDismissStore('test:agents')
    const procs = makeDismissStore('test:procs')
    agents.dismiss('sess-1', ['shared-id'])
    expect(read('test:agents')['sess-1']).toEqual(['shared-id'])
    expect(read('test:procs')).toEqual({})
    expect(procs.use === agents.use).toBe(false)
  })

  it('is a no-op for a key already dismissed, so nothing re-renders for nothing', () => {
    const s = makeDismissStore('test:beta')
    s.dismiss('sess-1', ['a'])
    const before = localStorage.getItem('test:beta')
    s.dismiss('sess-1', ['a'])
    expect(localStorage.getItem('test:beta')).toBe(before)
  })

  it('★ does NOT persist a volatile key…', () => {
    const s = makeDismissStore('test:vol')
    s.dismiss('sess-1', ['i7', 'toolu_real'])
    // `i7` names a different item after a reload, so writing it would pre-hide a stranger.
    expect(read('test:vol')['sess-1']).toEqual(['toolu_real'])
  })

  it('★ …while a session that dismissed ONLY volatile keys writes no entry at all', () => {
    // The `if (keep.length)` arm: an empty array would be a session entry that hides nothing
    // and never expires.
    const s = makeDismissStore('test:vol2')
    s.dismiss('sess-1', ['i1', 'i2'])
    expect(read('test:vol2')['sess-1']).toBeUndefined()
  })

  it('rehydrates from localStorage on construction', () => {
    localStorage.setItem('test:rehydrate', JSON.stringify({ 'sess-1': ['kept'] }))
    const s = makeDismissStore('test:rehydrate')
    s.dismiss('sess-1', ['added'])
    expect(read('test:rehydrate')['sess-1']).toEqual(['kept', 'added'])
  })

  it('survives a corrupt localStorage value rather than throwing at import time', () => {
    // A module-level store that throws on construction takes the whole app down; this one is
    // built during render of the sidebar.
    localStorage.setItem('test:corrupt', 'not json at all')
    expect(() => makeDismissStore('test:corrupt')).not.toThrow()
  })

  it('caps a session, dropping the OLDEST keys first', () => {
    const s = makeDismissStore('test:cap', 3)
    s.dismiss('sess-1', ['a', 'b', 'c', 'd'])
    // Oldest-first, so the most recently cleared rows are the ones that stay hidden.
    expect(read('test:cap')['sess-1']).toEqual(['b', 'c', 'd'])
  })

  it('prunes sessions that no longer exist, and keeps the ones that do', () => {
    const s = makeDismissStore('test:prune')
    s.dismiss('gone', ['x'])
    s.dismiss('alive', ['y'])
    s.prune(['alive'])
    expect(read('test:prune')).toEqual({ alive: ['y'] })
  })

  it('prune with an empty keep-list is not a special case — it clears everything', () => {
    // Worth pinning because the CALLER must not call this before its session list has loaded;
    // an empty list here legitimately means "no sessions exist", and the store cannot tell
    // that from "not loaded yet". Same hazard as pruneMutes in lib/sessionLights.
    const s = makeDismissStore('test:prune2')
    s.dismiss('sess-1', ['x'])
    s.prune([])
    expect(read('test:prune2')).toEqual({})
  })
})
