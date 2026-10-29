import { describe, it, expect } from 'vitest'
import { slugify, isolatedUnavailableReason } from './worktreeSession'

describe('slugify — the branch field default (mirrors the server)', () => {
  it('lowercases, collapses non-alphanumerics to single dashes, trims dashes', () => {
    expect(slugify('Fix Login!')).toBe('fix-login')
    expect(slugify('  --Hello__World--  ')).toBe('hello-world')
    expect(slugify('feature/two')).toBe('feature-two')
  })
  it('strips accents and caps at 40 chars without a trailing dash', () => {
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu')
    const s = slugify('a'.repeat(39) + ' b')
    expect(s.length).toBeLessThanOrEqual(40)
    expect(s.endsWith('-')).toBe(false)
  })
  it('falls back to "session" when nothing usable remains', () => {
    expect(slugify('!!!')).toBe('session')
    expect(slugify('')).toBe('session')
  })
})

describe('isolatedUnavailableReason — when the Isolated option is enabled', () => {
  it('enabled only for a repo with at least one commit', () => {
    expect(isolatedUnavailableReason({ hasCommit: true })).toBeNull()
    expect(isolatedUnavailableReason({ hasCommit: false })).toMatch(/no commits/)
    expect(isolatedUnavailableReason(null)).toMatch(/not inside a git repository/)
    expect(isolatedUnavailableReason(undefined)).toMatch(/Checking/)
  })
})
