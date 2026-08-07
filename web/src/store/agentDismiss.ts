import { useSyncExternalStore } from 'react'

// Cleared (dismissed) agent cards, keyed by session id. Agents are DERIVED from the
// immutable transcript on every render, so there is nothing to delete — clearing one
// records its stable key here and the views filter by it.
//
// This lives in a module store rather than component state because two unrelated
// places read it: the sidebar's per-session agent list and the agent detail tab.
// It's persisted so a card you cleared stays cleared across a reload (a resumed
// conversation replays every past Task, which would otherwise re-clutter the list).
const LS_KEY = 'claudette:agents:dismissed:v1'
const CAP = 300   // per session — oldest keys drop first so a long session can't grow without bound

const EMPTY: readonly string[] = []
let state: Record<string, string[]> = load()
const listeners = new Set<() => void>()

function load(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    const v = raw ? JSON.parse(raw) : null
    if (!v || typeof v !== 'object') return {}
    const out: Record<string, string[]> = {}
    for (const [k, arr] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(arr)) out[k] = arr.filter((x): x is string => typeof x === 'string')
    }
    return out
  } catch { return {} }
}
// A local transcript-item id (`i7`), minted by the module counter in store/chat that
// RESTARTS AT i1 on every page load. agentKey falls back to one for an agent whose
// tool_use id we never saw, so such a key identifies an agent only within the current
// load — the same string names a completely different agent after a reload.
const isVolatileKey = (k: string): boolean => /^i\d+$/.test(k)

// Persist only durable keys. Dismissals were previously in-memory, where a volatile key
// was harmless; writing one to localStorage means a clear recorded as "i7" silently
// pre-hides whatever unrelated agent lands on i7 after a reload (and an agent tab opened
// under such a key breaks, since LOAD re-mints every id). Volatile clears still work for
// the rest of this session — they're just forgotten on the next one, which is the honest
// behaviour when the key can't outlive the page.
function save(): void {
  try {
    const durable: Record<string, string[]> = {}
    for (const [id, keys] of Object.entries(state)) {
      const keep = keys.filter((k) => !isVolatileKey(k))
      if (keep.length) durable[id] = keep
    }
    localStorage.setItem(LS_KEY, JSON.stringify(durable))
  } catch { /* quota / private mode — clears just won't persist */ }
}
function emit(): void { for (const l of listeners) l() }
function subscribe(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l) } }

/** The keys cleared for a session. Stable identity while unchanged (safe as a dep). */
export function useDismissedAgents(sessionId: string): readonly string[] {
  return useSyncExternalStore(subscribe, () => state[sessionId] ?? EMPTY, () => EMPTY)
}

/** Clear one or more agent cards for a session (no-op for keys already cleared). */
export function dismissAgents(sessionId: string, keys: readonly string[]): void {
  const cur = state[sessionId] ?? EMPTY
  const fresh = keys.filter((k) => !cur.includes(k))
  if (fresh.length === 0) return
  state = { ...state, [sessionId]: [...cur, ...fresh].slice(-CAP) }
  save()
  emit()
}

/** Drop the clears of sessions that no longer exist, so keys can't linger forever. */
export function pruneDismissed(keep: readonly string[]): void {
  const alive = new Set(keep)
  const drop = Object.keys(state).filter((id) => !alive.has(id))
  if (drop.length === 0) return
  const next = { ...state }
  for (const id of drop) delete next[id]
  state = next
  save()
  emit()
}
