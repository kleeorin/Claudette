import { useCallback, useRef, useState } from 'react'
import { defaultFindOptions, stepIndex, type FindOptions } from './findMatches'

// The state every find bar keeps: is it open, what's typed, which options are on,
// which match is current. Held here so each editor only has to say WHERE it searches
// and how it reveals a hit — the bookkeeping (focus, stepping, reset-on-retype) is
// identical everywhere and behaves identically as a result.
export function useFind() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [opts, setOptsState] = useState<FindOptions>(defaultFindOptions)
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // Set when the bar has just opened or the query changed: the editor should jump to
  // the nearest match from where the user is looking, not to match #1. Cleared by
  // whoever honours it.
  const seekRef = useRef(false)

  // Ctrl/Cmd-F on an already-open bar re-selects the text instead of doing nothing —
  // the second press is nearly always "search for something else".
  const openFind = useCallback(() => {
    setOpen(true)
    setIndex(0)
    seekRef.current = true
    // The input may not exist yet on the first open; a frame is enough for it to mount.
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  const closeFind = useCallback(() => setOpen(false), [])

  const changeQuery = useCallback((q: string) => {
    setQuery(q)
    setIndex(0)
    seekRef.current = true
  }, [])

  const setOpts = useCallback((next: Partial<FindOptions>) => {
    setOptsState((o) => ({ ...o, ...next }))
    setIndex(0)
    seekRef.current = true
  }, [])

  const step = useCallback((count: number, dir: 1 | -1) => {
    seekRef.current = false
    setIndex((i) => stepIndex(i, count, dir))
  }, [])

  return {
    open, query, replacement, opts, index, inputRef, seekRef,
    setReplacement, setIndex, openFind, closeFind, changeQuery, setOpts, step,
  }
}

export type FindState = ReturnType<typeof useFind>
