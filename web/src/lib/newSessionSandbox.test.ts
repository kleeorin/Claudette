import { describe, it, expect } from 'vitest'
import { sandboxSeed } from './newSessionSandbox'

const STARS = [{ path: '/docs', mode: 'ro' as const }, { path: '/w/proj', mode: 'rw' as const }, { path: '/data', mode: 'rw' as const }]

describe('sandboxSeed — what a NEW session\'s sandbox picker starts with', () => {
  it('setting OFF (or absent): the built-in seed, stars stay inert', () => {
    expect(sandboxSeed({ starsOn: false, starred: STARS, cwd: '/w/proj' })).toEqual({ kind: 'builtin' })
    expect(sandboxSeed({ starsOn: undefined, starred: STARS, cwd: '/w/proj' })).toEqual({ kind: 'builtin' })
  })
  it('setting ON: the starred folders as extra mounts, each in its saved mode, the cwd star excluded', () => {
    expect(sandboxSeed({ starsOn: true, starred: STARS, cwd: '/w/proj' })).toEqual({ kind: 'stars', extra: [{ path: '/docs', mode: 'ro' }, { path: '/data', mode: 'rw' }] })
  })
  it('the cwd exclusion tolerates a trailing slash on the typed cwd', () => {
    const r = sandboxSeed({ starsOn: true, starred: STARS, cwd: '/w/proj/' })
    expect(r.kind === 'stars' && r.extra.some((m) => m.path === '/w/proj')).toBe(false)
  })
  it('ON with no stars: the built-in seed', () => {
    expect(sandboxSeed({ starsOn: true, starred: [], cwd: '/w' })).toEqual({ kind: 'builtin' })
  })
  it('a PROJECT default outranks the setting', () => {
    const projectDefault = { enabled: false, mounts: [{ path: '/w/proj', mode: 'ro' as const }] }
    const r = sandboxSeed({ starsOn: true, starred: STARS, cwd: '/w/proj', projectDefault })
    expect(r).toEqual({ kind: 'project', config: projectDefault })
    if (r.kind === 'project') { r.config.mounts.push({ path: '/x', mode: 'rw' }); expect(projectDefault.mounts).toHaveLength(1) }
  })
  it('returned mounts are copies — editing them cannot mutate the star list', () => {
    const stars = [{ path: '/docs', mode: 'ro' as const }]
    const r = sandboxSeed({ starsOn: true, starred: stars, cwd: '/w' })
    if (r.kind === 'stars') r.extra[0].mode = 'rw' as never
    expect(stars[0].mode).toBe('ro')
  })
})
