import {
  createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode,
} from 'react'
import type { SessionInfo, SessionState, PermissionMode, SetModeResult } from '@claudette/shared'
import { api } from '../api/client'

// Minimal Phase-1 session store: mirrors the server's session set (via the WS
// `session:list`/`state`/`exit` topics + the connect-time snapshot) and exposes
// create/destroy + active selection. ClaudeMaster's full store (tree/subsessions/
// remotes/persistence) is a Phase 2/3 port; this is the slice the chat needs.

interface ContextValue {
  sessions: SessionInfo[]
  activeId: string | null
  setActive: (id: string | null) => void
  connected: boolean
  create: (name: string, cwd: string, opts?: { model?: string }) => Promise<string>
  destroy: (id: string) => Promise<void>
  setMode: (id: string, mode: PermissionMode) => Promise<SetModeResult>
  // Was this session created in THIS app load (vs restored from persistence)? A
  // fresh session stays fresh; a restored one auto-resumes its latest conversation.
  isFresh: (id: string) => boolean
  // Optimistically flip an idle session to 'running' the moment a turn is sent, so
  // the working/thinking indicator + interrupt appear instantly (not after the WS
  // round-trip). The server's real state events reconcile it.
  markBusy: (id: string) => void
  // Sessions that finished a turn (or errored) while you were NOT viewing them — the
  // sidebar shows a red "needs attention" light until you switch to them.
  attention: Set<string>
}

const SessionsContext = createContext<ContextValue | null>(null)

export function SessionsProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const activeRef = useRef<string | null>(null); activeRef.current = activeId
  // Sessions created via create() this app load (not restored) — kept out of the
  // auto-resume path so a brand-new session starts empty.
  const freshRef = useRef<Set<string>>(new Set())
  // Background sessions that finished / errored while unviewed — cleared on view.
  const [attention, setAttention] = useState<Set<string>>(new Set())
  const prevStateRef = useRef<Map<string, SessionState>>(new Map())
  const flagAttention = (id: string) => setAttention((a) => a.has(id) ? a : new Set(a).add(id))

  // Patch a single session's fields in place (state/exit), leaving order intact.
  const patch = useCallback((id: string, fields: Partial<SessionInfo>) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...fields } : s)))
  }, [])

  useEffect(() => {
    const offList = api.on.list((list) => {
      setSessions(list)
      // Default the selection to the first session once one exists.
      if (!activeRef.current && list.length) setActiveId(list[0].id)
    })
    const offState = api.on.stateChange((id, state: SessionState) => {
      const prev = prevStateRef.current.get(id)
      prevStateRef.current.set(id, state)
      patch(id, { state })
      // Turn finished on a session you're not watching → flag it for attention.
      if (state === 'idle' && (prev === 'running' || prev === 'waiting') && id !== activeRef.current) flagAttention(id)
    })
    // `ready` (engine system/init) marks a (re)started engine idle — BUT the CLI
    // inits lazily, so init often lands AFTER the first turn already set 'running'.
    // Clobbering that to idle mid-turn hid the working indicator + interrupt for the
    // whole turn. Only settle to idle when a turn isn't in flight.
    const offReady = api.on.ready((id) =>
      setSessions((prev) => prev.map((s) =>
        s.id === id && s.state !== 'running' && s.state !== 'waiting' ? { ...s, state: 'idle' } : s)))
    const offExit = api.on.exit((id, failed, error) => {
      if (failed) { patch(id, { state: 'exited', exitError: error }); if (id !== activeRef.current) flagAttention(id) }
      else {
        // Normal close: drop the row; move the selection off it if needed.
        setSessions((prev) => prev.filter((s) => s.id !== id))
        if (activeRef.current === id) setActiveId(null)
      }
    })
    const offConn = api.on.connected(setConnected)
    // Pull an initial snapshot too (covers a provider mounted after the WS hello).
    api.http.listSessions().then((list) => {
      setSessions(list)
      if (!activeRef.current && list.length) setActiveId(list[0].id)
    }).catch(() => { /* server not up yet; the WS snapshot will fill in */ })
    return () => { offList(); offState(); offReady(); offExit(); offConn() }
  }, [patch])

  const create = useCallback(async (name: string, cwd: string, opts?: { model?: string }): Promise<string> => {
    const { id } = await api.http.createSession({ name, cwd, model: opts?.model })
    freshRef.current.add(id)   // a user-created session stays fresh (no auto-resume)
    // Optimistically add + select; the next list/state event reconciles.
    setSessions((prev) => prev.some((s) => s.id === id) ? prev
      : [...prev, { id, name, cwd, rootDir: cwd, model: opts?.model, state: 'idle' }])
    setActiveId(id)
    return id
  }, [])

  const destroy = useCallback(async (id: string): Promise<void> => {
    await api.http.destroySession(id)
    setSessions((prev) => prev.filter((s) => s.id !== id))
    if (activeRef.current === id) setActiveId(null)
  }, [])

  // Live permission-mode switch (P1.4). Optimistically reflect the chosen mode; the
  // result tells the UI whether it applied live / on relaunch / needs a restart.
  const setMode = useCallback(async (id: string, mode: PermissionMode): Promise<SetModeResult> => {
    patch(id, { permissionMode: mode })
    const res = await api.http.setMode(id, mode)
    if (res.applied === 'restart' && res.reason) patch(id, { permissionMode: mode })
    return res
  }, [patch])

  const isFresh = useCallback((id: string) => freshRef.current.has(id), [])

  // Viewing a session clears its attention flag (however it became active: click,
  // create, default selection, or Claude focusing it).
  useEffect(() => {
    if (activeId) setAttention((a) => a.has(activeId) ? (() => { const n = new Set(a); n.delete(activeId); return n })() : a)
  }, [activeId])

  // Only idle→running: never override 'waiting' (a live permission prompt) or clobber
  // an already-running / exited session.
  const markBusy = useCallback((id: string) => {
    setSessions((prev) => prev.map((s) => (s.id === id && s.state === 'idle' ? { ...s, state: 'running' } : s)))
  }, [])

  return (
    <SessionsContext.Provider value={{ sessions, activeId, setActive: setActiveId, connected, create, destroy, setMode, isFresh, markBusy, attention }}>
      {children}
    </SessionsContext.Provider>
  )
}

export function useSessions(): ContextValue {
  const ctx = useContext(SessionsContext)
  if (!ctx) throw new Error('useSessions must be used within SessionsProvider')
  return ctx
}
