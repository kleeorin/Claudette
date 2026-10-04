// A per-session set of DISMISSED keys, persisted to localStorage.
//
// Extracted from store/agentDismiss.ts when the background-process list needed the same thing.
// Two independent stores, two localStorage keys, one implementation — because the alternative
// was an 80-line copy, and a copy is where the two would silently diverge on the volatile-key
// rule below (the subtle part that took a bug to find).
import { useSyncExternalStore } from 'react'

const EMPTY: readonly string[] = []

// A local transcript-item id (`i7`), minted by a module counter in store/chat that RESTARTS AT
// i1 on every page load. A key like that identifies its subject only within the current load —
// the same string names something completely different after a reload.
//
// ★ SO IT IS KEPT IN MEMORY BUT NEVER PERSISTED. Dismissals were once in-memory only, where a
// volatile key was harmless; writing one to localStorage means a clear recorded as "i7"
// silently pre-hides whatever unrelated item lands on i7 next load. Volatile clears still work
// for the rest of the session — they are just forgotten on the next one, which is the honest
// behaviour when the key cannot outlive the page.
const isVolatileKey = (k: string): boolean => /^i\d+$/.test(k)

export interface DismissStore {
  use: (sessionId: string) => readonly string[]
  dismiss: (sessionId: string, keys: readonly string[]) => void
  prune: (keep: readonly string[]) => void
}

export function makeDismissStore(lsKey: string, cap = 300): DismissStore {
  let state: Record<string, string[]> = load()
  const listeners = new Set<() => void>()

  function load(): Record<string, string[]> {
    try {
      const raw = localStorage.getItem(lsKey)
      const v = raw ? JSON.parse(raw) : null
      if (!v || typeof v !== 'object') return {}
      const out: Record<string, string[]> = {}
      for (const [k, arr] of Object.entries(v as Record<string, unknown>)) {
        if (Array.isArray(arr)) out[k] = arr.filter((x): x is string => typeof x === 'string')
      }
      return out
    } catch { return {} }
  }

  function save(): void {
    try {
      const durable: Record<string, string[]> = {}
      for (const [id, keys] of Object.entries(state)) {
        const keep = keys.filter((k) => !isVolatileKey(k))
        if (keep.length) durable[id] = keep
      }
      localStorage.setItem(lsKey, JSON.stringify(durable))
    } catch { /* quota / private mode — clears just won't persist */ }
  }

  const emit = (): void => { for (const l of listeners) l() }
  const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l) } }

  return {
    /** The keys cleared for a session. Stable identity while unchanged (safe as a dep). */
    use: (sessionId) => useSyncExternalStore(subscribe, () => state[sessionId] ?? EMPTY, () => EMPTY),
    dismiss: (sessionId, keys) => {
      const cur = state[sessionId] ?? EMPTY
      const fresh = keys.filter((k) => !cur.includes(k))
      if (fresh.length === 0) return           // no-op: no spurious re-render
      // Oldest keys drop first, so a long session cannot grow this without bound.
      state = { ...state, [sessionId]: [...cur, ...fresh].slice(-cap) }
      save()
      emit()
    },
    /** Drop the clears of sessions that no longer exist, so keys can't linger forever. */
    prune: (keep) => {
      const alive = new Set(keep)
      const drop = Object.keys(state).filter((id) => !alive.has(id))
      if (drop.length === 0) return
      const next = { ...state }
      for (const id of drop) delete next[id]
      state = next
      save()
      emit()
    },
  }
}
