import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject, KeyboardEvent } from 'react'
import { api } from '../api/client'
import type { DirEntry } from '@claudette/shared'

// `@`-mention path autocomplete for the composer — the interactive citation picker
// Claude Code has. Typing `@` starts a path anchored at the session's cwd; the menu
// lists the matching directory (from the server's fs API), Up/Down select, Enter/Tab
// complete. Completing a folder appends `name/` and keeps the menu open so you can
// drill in; completing a file inserts its path and closes. Paths stay in the form
// you're typing (relative to cwd, or absolute if you started with `/`).
//
// Note: the picker browses the real host fs (server-side, unsandboxed), so you *can*
// cite a path outside a sandboxed session's mounts — Claude will then report it's
// outside the sandbox (see sandboxSystemPrompt). Anchoring at cwd keeps the common
// case in-sandbox.

export interface MentionItem { name: string; isDir: boolean }

interface Args {
  draft: string
  setDraft: (v: string) => void
  taRef: RefObject<HTMLTextAreaElement>
  cwd: string
}

interface Mention { start: number; fragment: string }

export interface MentionComplete {
  active: boolean
  items: MentionItem[]
  sel: number
  dir: string
  // Recompute the mention from the textarea's current value + caret. Call on every
  // change and on caret moves (keyup/click).
  sync: (value: string, caret: number) => void
  // Handle a keydown while the menu is open; returns true if it consumed the event.
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  apply: (index: number) => void
  close: () => void
}

export function useMentionComplete({ draft, setDraft, taRef, cwd }: Args): MentionComplete {
  const [mention, setMention] = useState<Mention | null>(null)
  const [items, setItems] = useState<MentionItem[]>([])
  const [sel, setSel] = useState(0)
  const [dir, setDir] = useState('')
  const reqRef = useRef(0)

  const close = useCallback(() => { setMention(null); setItems([]); setSel(0) }, [])

  const sync = useCallback((value: string, caret: number) => {
    setMention(detectMention(value, caret))
  }, [])

  // Fetch the listing whenever the mention's target directory/filter changes.
  useEffect(() => {
    if (!mention) { setItems([]); return }
    const { dir: listDir, filter } = resolveListing(cwd, mention.fragment)
    setDir(listDir)
    const req = ++reqRef.current
    api.fs.list(listDir).then((res) => {
      if (req !== reqRef.current) return   // a newer keystroke superseded this fetch
      if (!('entries' in res) || !res.entries) { setItems([]); return }
      const f = filter.toLowerCase()
      const matched = res.entries
        .filter((e: DirEntry) => e.name.toLowerCase().startsWith(f))
        .sort((a: DirEntry, b: DirEntry) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
        .slice(0, 8)
        .map((e: DirEntry) => ({ name: e.name, isDir: e.isDir }))
      setItems(matched)
      setSel(0)
    }).catch(() => { if (req === reqRef.current) setItems([]) })
  }, [mention, cwd])

  const apply = useCallback((index: number) => {
    if (!mention || !items[index]) return
    const item = items[index]
    // Replace the fragment's trailing segment with the chosen entry, preserving the
    // leading dir portion the user already typed (e.g. `src/comp` → `src/components/`).
    const cut = mention.fragment.lastIndexOf('/')
    const prefix = cut >= 0 ? mention.fragment.slice(0, cut + 1) : ''
    const completed = prefix + item.name + (item.isDir ? '/' : '')
    const before = draft.slice(0, mention.start)
    const caret = mention.start + 1 + completed.length   // +1 for '@'
    const after = draft.slice((taRef.current?.selectionStart ?? draft.length))
    const next = `${before}@${completed}${after}`
    setDraft(next)
    // Restore caret just past the inserted path; re-detect keeps the menu open for a
    // folder (so you keep drilling) and effectively closes it for a file (empty list).
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (ta) { ta.selectionStart = ta.selectionEnd = caret; ta.focus() }
      setMention(item.isDir ? { start: mention.start, fragment: completed } : null)
    })
  }, [mention, items, draft, setDraft, taRef])

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!mention || items.length === 0) {
      // Allow Escape to dismiss even when the list is momentarily empty.
      if (mention && e.key === 'Escape') { e.preventDefault(); close(); return true }
      return false
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setSel((s) => (s + 1) % items.length); return true
      case 'ArrowUp': e.preventDefault(); setSel((s) => (s - 1 + items.length) % items.length); return true
      case 'Enter': case 'Tab': e.preventDefault(); apply(sel); return true
      case 'Escape': e.preventDefault(); close(); return true
      default: return false
    }
  }, [mention, items, sel, apply, close])

  return { active: !!mention && items.length > 0, items, sel, dir, sync, onKeyDown, apply, close }
}

// --- pure path helpers (POSIX) ----------------------------------------------

// Find an active `@…` token: the last `@` at/ before the caret that sits at a word
// boundary (start-of-text or after whitespace) with no whitespace between it and the
// caret. Returns its start index and the fragment typed after it, or null.
function detectMention(text: string, caret: number): Mention | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') {
      const before = i === 0 ? '' : text[i - 1]
      return before === '' || /\s/.test(before) ? { start: i, fragment: text.slice(i + 1, caret) } : null
    }
    if (/\s/.test(ch)) return null   // hit whitespace before an `@` → not in a mention
  }
  return null
}

function normalizePosix(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..') }
    else out.push(s)
  }
  return (abs ? '/' : '') + out.join('/')
}

// Given the cwd and the typed fragment, decide which directory to list and the
// prefix to filter its entries by.
function resolveListing(cwd: string, fragment: string): { dir: string; filter: string } {
  if (fragment === '') return { dir: cwd, filter: '' }
  const abs = fragment.startsWith('/') ? fragment : `${cwd}/${fragment}`
  const norm = normalizePosix(abs)
  if (fragment.endsWith('/')) return { dir: norm || '/', filter: '' }
  const cut = norm.lastIndexOf('/')
  return { dir: cut <= 0 ? '/' : norm.slice(0, cut), filter: norm.slice(cut + 1) }
}
