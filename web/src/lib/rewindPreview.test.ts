import { describe, it, expect } from 'vitest'
import type { RewindPreview } from '@claudette/shared'
import { conflictLines, nothingToRestore } from './rewindPreview'

const P = (over: Partial<RewindPreview> = {}): RewindPreview => ({ reverted: [], deleted: [], ...over })

describe('conflictLines — the per-file warning in the rewind confirm', () => {
  it('lists every conflicting file with the sessions that also edited it', () => {
    const lines = conflictLines(P({ conflicts: [
      { path: 'a.ts', sessions: [{ id: 'b1', name: 'Session B' }] },
      { path: 'c.ts', sessions: [{ id: 'b1', name: 'Session B' }, { id: 'c2', name: 'Session C' }] },
    ] }))
    expect(lines).toEqual([{ path: 'a.ts', who: 'Session B' }, { path: 'c.ts', who: 'Session B, Session C' }])
  })

  it('falls back to a short id when a session has no name, rather than an empty "who"', () => {
    expect(conflictLines(P({ conflicts: [{ path: 'x', sessions: [{ id: '0123456789abcdef', name: '' }] }] })))
      .toEqual([{ path: 'x', who: '01234567' }])
  })

  it('is empty for a preview with no conflicts field (an older server)', () => {
    expect(conflictLines(P())).toEqual([])
  })
})

describe('nothingToRestore — never claim "already matches" while edits are left in place', () => {
  it('is true only with nothing to revert, delete or skip', () => {
    expect(nothingToRestore(P())).toBe(true)
  })

  it('is false when files were skipped (e.g. gitignored) — they were edited and stay as they are', () => {
    expect(nothingToRestore(P({ skipped: [{ path: '.env', reason: 'gitignored' }] }))).toBe(false)
  })

  it('is false when something will be reverted or deleted', () => {
    expect(nothingToRestore(P({ reverted: ['a'] }))).toBe(false)
    expect(nothingToRestore(P({ deleted: ['b'] }))).toBe(false)
  })
})
