import { describe, it, expect } from 'vitest'
import { cwdField } from './defaultCwd'

const base = { edited: false, typed: '', homeDir: '/home/u' }

describe('cwdField — the new-session dialog\'s working directory', () => {
  it('precedence: project cwd, then the default folder, then $HOME', () => {
    expect(cwdField({ ...base, projectCwd: '/p', defaultCwd: '/d' }).value).toBe('/p')
    expect(cwdField({ ...base, defaultCwd: '/d' }).value).toBe('/d')
    expect(cwdField({ ...base }).value).toBe('/home/u')
  })

  it('late arrival: before anything loads the field is empty; whichever arrives fills it', () => {
    expect(cwdField({ ...base, homeDir: '' }).value).toBe('')
    // homeDir first, settings later: the default folder REPLACES the auto-filled $HOME
    expect(cwdField({ ...base, homeDir: '/home/u' }).value).toBe('/home/u')
    expect(cwdField({ ...base, homeDir: '/home/u', defaultCwd: '/d' }).value).toBe('/d')
    // settings first, homeDir later: stays on the default folder
    expect(cwdField({ ...base, homeDir: '', defaultCwd: '/d' }).value).toBe('/d')
  })

  it('a user edit is never overwritten — not by settings, not by $HOME, not even when cleared', () => {
    expect(cwdField({ ...base, edited: true, typed: '/mine', defaultCwd: '/d' }).value).toBe('/mine')
    expect(cwdField({ ...base, edited: true, typed: '', defaultCwd: '/d' }).value).toBe('')
  })

  it('a project-locked dialog ignores the default folder entirely', () => {
    const r = cwdField({ ...base, projectCwd: '/p', defaultCwd: '/d', defaultCwdMissing: true })
    expect(r).toEqual({ value: '/p', note: null })
  })

  it('a deleted default folder falls back to $HOME with a one-line note naming it', () => {
    const r = cwdField({ ...base, defaultCwd: '/gone', defaultCwdMissing: true })
    expect(r.value).toBe('/home/u')
    expect(r.note).toMatch(/\/gone/)
    expect(r.note).not.toMatch(/\n/)
    // …and the note goes away once the user takes over the field
    expect(cwdField({ ...base, edited: true, typed: '/x', defaultCwd: '/gone', defaultCwdMissing: true }).note).toBeNull()
  })
})
