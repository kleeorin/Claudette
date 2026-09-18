// The file panel's ordering. Pure, so the cases that matter are reachable without a DOM —
// and the cases that matter here are all ties and absences, which a render test cannot stage
// reliably: two files written in the same second, a file with no extension, a directory with
// no size.
//
// ★ WHAT THIS PINS, beyond "it sorts".
//   1. FOLDERS STAY FIRST in every ordering and every direction. Navigation must not depend
//      on the current sort; a "Z → A" that sends folders to the bottom makes moving around
//      the tree a function of a display preference.
//   2. THE INPUT IS NEVER MUTATED. `entries` is React state and `Array.sort` sorts in place,
//      so a comparator applied directly to it edits state outside a setter.
//   3. TIES ARE DETERMINISTIC. Without a name fallback, equal keys leave the order to
//      whatever the server returned, so an unrelated refresh reshuffles the list.
import { describe, it, expect } from 'vitest'
import type { DirEntry } from '@claudette/shared'
import {
  SORT_KEYS, SORT_LABEL, SORT_DIR_LABEL, DEFAULT_DIR,
  fileExt, sortEntries, loadSort, saveSort, DEFAULT_SORT,
} from './fileSort'

const f = (name: string, over: Partial<DirEntry> = {}): DirEntry =>
  ({ name, isDir: false, size: 0, mtimeMs: 0, ...over })
const d = (name: string, over: Partial<DirEntry> = {}): DirEntry =>
  ({ name, isDir: true, size: 0, mtimeMs: 0, ...over })
const names = (xs: readonly DirEntry[]) => xs.map((x) => x.name)

describe('the key population', () => {
  it('is non-trivial and every key has a label and a default direction', () => {
    // Guards the guard: the cases below iterate SORT_KEYS, so an empty or truncated
    // population would make them vacuously green.
    expect(SORT_KEYS.length).toBeGreaterThanOrEqual(4)
    for (const k of SORT_KEYS) {
      expect(SORT_LABEL[k], k).toBeTruthy()
      expect(SORT_DIR_LABEL[k].asc, k).toBeTruthy()
      expect(SORT_DIR_LABEL[k].desc, k).toBeTruthy()
      expect(['asc', 'desc']).toContain(DEFAULT_DIR[k])
    }
  })

  it('gives date and size a DESCENDING default, because that is what picking them means', () => {
    // Someone choosing "Date modified" is asking what changed recently. Answering with the
    // oldest files first is a different question.
    expect(DEFAULT_DIR.date).toBe('desc')
    expect(DEFAULT_DIR.size).toBe('desc')
    expect(DEFAULT_DIR.name).toBe('asc')
  })

  it('never labels two directions the same way for one key', () => {
    // A key whose two directions read identically gives the user no way to tell which is on.
    for (const k of SORT_KEYS) expect(SORT_DIR_LABEL[k].asc, k).not.toBe(SORT_DIR_LABEL[k].desc)
  })
})

describe('folders come first, always', () => {
  it('keeps directories above files in EVERY key and BOTH directions', () => {
    // The strong claim, asserted over the whole population rather than for one key, because
    // the failure would be per-key and easy to introduce in a single switch arm.
    const input = [f('a.txt', { mtimeMs: 900, size: 9 }), d('zz'), f('b.txt'), d('aa', { mtimeMs: 1 })]
    for (const key of SORT_KEYS) {
      for (const dir of ['asc', 'desc'] as const) {
        const out = sortEntries(input, { key, dir })
        const firstFile = out.findIndex((e) => !e.isDir)
        const lastDir = out.map((e) => e.isDir).lastIndexOf(true)
        expect(lastDir, `${key}/${dir}`).toBeLessThan(firstFile)
      }
    }
  })
})

describe('sortEntries', () => {
  it('does not mutate its input', () => {
    // React state. `Array.sort` is in-place, so a comparator applied to `entries` directly
    // would reorder state without a setter.
    const input = [f('b'), f('a')]
    const copy = [...input]
    sortEntries(input, { key: 'name', dir: 'asc' })
    expect(input).toEqual(copy)
  })

  it('orders by name, case-insensitively, matching the server', () => {
    expect(names(sortEntries([f('b.txt'), f('A.txt')], { key: 'name', dir: 'asc' }))).toEqual(['A.txt', 'b.txt'])
    expect(names(sortEntries([f('A.txt'), f('b.txt')], { key: 'name', dir: 'desc' }))).toEqual(['b.txt', 'A.txt'])
  })

  it('orders by date, newest first when descending', () => {
    const out = sortEntries([f('old', { mtimeMs: 1 }), f('new', { mtimeMs: 99 })], { key: 'date', dir: 'desc' })
    expect(names(out)).toEqual(['new', 'old'])
  })

  it('orders by size, largest first when descending', () => {
    const out = sortEntries([f('small', { size: 1 }), f('big', { size: 99 })], { key: 'size', dir: 'desc' })
    expect(names(out)).toEqual(['big', 'small'])
  })

  it('orders by type, and files with no extension group together', () => {
    const out = sortEntries([f('c.ts'), f('README'), f('a.md'), f('LICENSE')], { key: 'type', dir: 'asc' })
    // Extensionless sort as '' and therefore lead; among themselves the name fallback orders
    // them, which is why LICENSE precedes README rather than the input order surviving.
    expect(names(out)).toEqual(['LICENSE', 'README', 'a.md', 'c.ts'])
  })

  it('★ breaks ties by NAME so the order cannot depend on what the server returned', () => {
    // Equal mtimes are extremely common — anything written by one command. Without the
    // fallback these keep server order, so an unrelated refresh reshuffles the list.
    const same = [f('c', { mtimeMs: 5 }), f('a', { mtimeMs: 5 }), f('b', { mtimeMs: 5 })]
    expect(names(sortEntries(same, { key: 'date', dir: 'desc' }))).toEqual(['a', 'b', 'c'])
    // …and the reversed order does NOT reverse the tie-break: equal rows must not swap
    // places purely from toggling direction, which reads as the sort being broken.
    expect(names(sortEntries(same, { key: 'date', dir: 'asc' }))).toEqual(['a', 'b', 'c'])
  })

  it('is deterministic regardless of the order it is handed', () => {
    // The same set arriving in a different order must render identically; otherwise the
    // panel appears to reorder itself on refresh.
    const a = sortEntries([f('x.ts'), f('y.ts'), f('z.ts')], { key: 'type', dir: 'asc' })
    const b = sortEntries([f('z.ts'), f('x.ts'), f('y.ts')], { key: 'type', dir: 'asc' })
    expect(names(a)).toEqual(names(b))
  })

  it('handles an empty listing', () => {
    expect(sortEntries([], { key: 'name', dir: 'asc' })).toEqual([])
  })
})

describe('fileExt', () => {
  it('reads a plain extension, lower-cased', () => {
    expect(fileExt('Notes.MD')).toBe('md')
    expect(fileExt('a.tar.gz')).toBe('gz')
  })

  it('treats a DOTFILE as having no extension', () => {
    // `.gitignore` is a hidden file, not a "gitignore file". Reading it as an extension
    // would scatter dotfiles through the listing by their own names.
    expect(fileExt('.gitignore')).toBe('')
    expect(fileExt('.env')).toBe('')
  })

  it('returns nothing for a name with no usable extension', () => {
    expect(fileExt('README')).toBe('')
    expect(fileExt('archive.')).toBe('')   // trailing dot names no type
    expect(fileExt('')).toBe('')
  })
})

describe('loadSort', () => {
  it('falls back to the default when nothing is stored', () => {
    localStorage.clear()
    expect(loadSort()).toEqual(DEFAULT_SORT)
  })

  it('round-trips a saved preference', () => {
    saveSort({ key: 'date', dir: 'desc' })
    expect(loadSort()).toEqual({ key: 'date', dir: 'desc' })
  })

  it('★ REJECTS an unrecognised key rather than passing it to the comparator', () => {
    // The value is user-reachable via devtools or a stale build. An unknown key would reach
    // the comparator's `never` arm on every comparison, so it is validated here rather than
    // merely parsed.
    localStorage.setItem('claudette:files:sort:v1', JSON.stringify({ key: 'colour', dir: 'asc' }))
    expect(loadSort().key).toBe(DEFAULT_SORT.key)
  })

  it('repairs a bad direction without discarding a good key', () => {
    localStorage.setItem('claudette:files:sort:v1', JSON.stringify({ key: 'size', dir: 'sideways' }))
    expect(loadSort()).toEqual({ key: 'size', dir: DEFAULT_DIR.size })
  })

  it('survives a value that is not JSON at all', () => {
    // A broken preference must never stop the panel rendering.
    localStorage.setItem('claudette:files:sort:v1', '{{{not json')
    expect(loadSort()).toEqual(DEFAULT_SORT)
  })
})
