// How the file panel orders a directory listing — extracted from FileManager for the reason
// lib/sessionLights.ts gives in its own header: NOTHING IN THIS REPO IMPORTS FileManager.tsx,
// so a comparator written inline there is invisible to every suite at once. Sorting is all
// edge cases (ties, missing extensions, unreadable stats), which is exactly the shape that
// looks right on the happy path and is wrong on real directories.
import type { DirEntry } from '@claudette/shared'

// The orderings offered. Exported as a runtime array, not a bare union, so the menu renders
// FROM the population and a new key cannot be added without appearing in the UI — the
// "do not enumerate a population that will grow" rule, applied where the population IS the UI.
export const SORT_KEYS = ['name', 'date', 'type', 'size'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export type SortDir = 'asc' | 'desc'
export interface SortPref { key: SortKey; dir: SortDir }

// Menu labels, and the word for each direction. The direction words are PER KEY on purpose:
// "A→Z" and "Newest first" describe the same `asc`/`desc` flag, and a single pair of labels
// would read as nonsense on one of them ("ascending" tells you nothing about dates).
export const SORT_LABEL: Record<SortKey, string> = {
  name: 'Name', date: 'Date modified', type: 'Type', size: 'Size',
}
export const SORT_DIR_LABEL: Record<SortKey, { asc: string; desc: string }> = {
  name: { asc: 'A → Z', desc: 'Z → A' },
  date: { asc: 'Oldest first', desc: 'Newest first' },
  type: { asc: 'A → Z', desc: 'Z → A' },
  size: { asc: 'Smallest first', desc: 'Largest first' },
}

// The direction a key should START in when you pick it. Choosing `desc` for date and size is
// not a preference, it is what the click MEANS: someone selecting "Date modified" is asking
// "what changed recently", and handing them the oldest files first answers a question nobody
// asked. Name and type read naturally ascending.
export const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: 'asc', date: 'desc', type: 'asc', size: 'desc',
}

// The extension used by the `type` ordering, lower-cased and WITHOUT the dot.
// A leading dot is a hidden file, not an extension: `.gitignore` has no type, and treating
// "gitignore" as one would scatter dotfiles through the listing by their names.
// A trailing dot yields '' too — `archive.` has no meaningful type.
export function fileExt(name: string): string {
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return ''
  return name.slice(i + 1).toLowerCase()
}

const byName = (a: DirEntry, b: DirEntry): number =>
  // `sensitivity: 'base'` matches what the server's own listDir does, so the client's
  // "Name" ordering is the same ordering the server already returned rather than a
  // subtly different one that makes the list appear to jump on first sort.
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

// ★ ORDER A COPY, NEVER THE INPUT. `entries` is React state; `Array.prototype.sort` mutates
// in place, so sorting it directly would edit state outside a setter — the list would
// sometimes update without a re-render and sometimes re-render with the previous order,
// depending on what else happened to run.
export function sortEntries(entries: readonly DirEntry[], pref: SortPref): DirEntry[] {
  const sign = pref.dir === 'asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    // ★ DIRECTORIES ALWAYS FIRST, IN EVERY ORDERING, AND THE DIRECTION NEVER FLIPS THEM.
    // This is deliberately NOT part of the sort the user chose. Folders are how you move
    // around; scattering them through a date ordering — or worse, sending them to the bottom
    // on "Z → A" — makes navigation depend on the current sort, which is the one thing a
    // file panel must not do. It also matches what the server already returns, so the first
    // render and the first sort agree.
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1

    let cmp = 0
    switch (pref.key) {
      case 'name': cmp = byName(a, b); break
      // Directories carry mtime too, so date ordering is meaningful within the folder group.
      case 'date': cmp = a.mtimeMs - b.mtimeMs; break
      case 'type': cmp = fileExt(a.name).localeCompare(fileExt(b.name)); break
      // Directories are all size 0 (the server does not walk them), so within the folder
      // group this comparator ties for every pair and the name tie-break below does the
      // work. That is the honest outcome: we have no folder sizes to sort by, and inventing
      // an ordering would imply we did.
      case 'size': cmp = a.size - b.size; break
      default: {
        const _exhaustive: never = pref.key
        void _exhaustive
        cmp = byName(a, b)
      }
    }
    // ★ ALWAYS FALL BACK TO NAME, ASCENDING, AND NOT MULTIPLIED BY `sign`.
    // Two files written in the same second, or sharing an extension, are extremely common —
    // without a tie-break their relative order comes from whatever the server happened to
    // return, so the list would reshuffle on an unrelated refresh and look like a bug.
    // The fallback stays ascending in both directions on purpose: reversing it too would
    // make equal-key rows swap places purely from toggling direction, which reads as the
    // sort being broken rather than reversed.
    return cmp !== 0 ? cmp * sign : byName(a, b)
  })
}

// --- persistence ------------------------------------------------------------------------
// A file panel that forgets your ordering every time you open it is a panel you re-sort every
// time. Stored under one key; a read failure (private mode, quota, hand-edited value) falls
// back to the default rather than throwing, because a broken preference must never stop the
// panel rendering.
const LS_KEY = 'claudette:files:sort:v1'
export const DEFAULT_SORT: SortPref = { key: 'name', dir: 'asc' }

// VALIDATED ON READ, not merely parsed. The value is user-reachable (devtools, a stale build,
// a future rename of a key), and an unrecognised key would fall through the switch above to
// its `never` arm on every single comparison.
export function loadSort(): SortPref {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_SORT
    const v = JSON.parse(raw) as Partial<SortPref>
    const key = (SORT_KEYS as readonly string[]).includes(v.key as string) ? (v.key as SortKey) : DEFAULT_SORT.key
    const dir: SortDir = v.dir === 'asc' || v.dir === 'desc' ? v.dir : DEFAULT_DIR[key]
    return { key, dir }
  } catch { return DEFAULT_SORT }
}

export function saveSort(pref: SortPref): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(pref)) } catch { /* quota / private mode */ }
}
