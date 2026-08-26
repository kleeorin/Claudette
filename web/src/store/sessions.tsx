// SessionsProvider on useReducer. The transitions live in sessionReducer.ts (29 assertions
// green); this file is now wiring: subscribe, dispatch, expose.
//
// ── N2 RESOLVED: `fresh` STAYS IN THE REDUCER. ───────────────────────────────
// Every isFresh consumer was grepped. There is exactly ONE: ChatView.tsx:249, inside the
// auto-resume effect at :247-267, with `isFresh` in its dep array at :267.
//
// The question was whether it needs SYNCHRONOUS truth. It does not, and the reducer is in
// fact STRICTLY SAFER there: in the old code `freshRef.current.add(id)` and `setSessions`
// were two separate writes to two separate places, so the session could in principle appear
// in state without its fresh mark. Here both come from the SAME `created` action, so a
// session and its freshness land atomically — they cannot disagree.
//
// The real risk turned out to be different from the one predicted, and it is about
// CALLBACK IDENTITY, not timing. The old isFresh was `useCallback(..., [])` — deliberately
// stable, so ChatView's effect never re-fired on it. If isFresh closed over the whole store
// its identity would churn on every state event and that effect would re-run constantly.
// So it is derived from the `fresh` SET alone:
//     const isFresh = useCallback((id) => store.fresh.has(id), [store.fresh])
// The reducer returns `state.fresh` unchanged for every action except `created`, so
// isFresh's identity is stable across all ordinary churn and changes only when a session is
// created — which is exactly when that effect should reconsider. Its `autoResumed` guard
// makes the extra run idempotent.
//
// ── WHICH App.tsx HAZARDS THIS REWRITE TOUCHES: NONE. ────────────────────────
// Stated so it can be checked rather than assumed — and checking it corrected an earlier
// claim. sessionReducer.ts's header says H2 (App.tsx ~441-443) is "DIRECTLY IMPROVED".
// THAT IS OVERSTATED AND SHOULD BE READ DOWN. H2's comment says `sessions` gets a new
// identity on "running→idle, a rename, an optimistic patch" — those are all REAL changes,
// and a real change must produce a new array. Identity preservation only removes SPURIOUS
// churn from redundant/no-op events. The effect genuinely wants membership-only, so
// `sessionIdKey` is still required and H2 STANDS. What the reducer buys is a lower firing
// rate, not the removal of the workaround.
// H1 (publishedRef), H3 (pure updaters), H4 (two-flag gating) are all App.tsx-local and
// untouched. This rewrite fixes nothing in App.tsx; it removes three refs from THIS file.
//
// ── WHAT ACTUALLY GOES AWAY HERE ─────────────────────────────────────────────
//   activeRef, prevStateRef, freshRef  — all three existed only to dodge stale closures.
//   The WS subscription effect's dep array becomes []  — it now subscribes ONCE instead of
//     re-subscribing whenever `patch` changed identity.
//   The attention-clearing useEffect — now part of the same transition that changes the
//     active session (withActive), so there is no longer a frame in which the newly-active
//     session still shows its dot.
import {
  createContext, useContext, useEffect, useState, useCallback, useMemo, useReducer, type ReactNode,
} from 'react'
import type { SessionInfo, PermissionMode, SetModeResult, SandboxConfig, AgentInfo } from '@claudette/shared'
import { api, getHealth } from '../api/client'
import { reduceSessionStore, initialSessionStore, type AttentionReason } from './sessionReducer'

interface ContextValue {
  sessions: SessionInfo[]
  activeId: string | null
  setActive: (id: string | null) => void
  connected: boolean
  create: (name: string, cwd: string, opts?: { model?: string; agentId?: string; parentId?: string; rootDir?: string; sandbox?: SandboxConfig }) => Promise<string>
  // Spawn a child session under `parentId` (shares the parent's cwd/rootDir, carries
  // parentId so the server appends the report-to-parent instruction). Own role + sandbox.
  spawnSubsession: (parentId: string, opts?: { name?: string; agentId?: string; sandbox?: SandboxConfig }) => Promise<string | null>
  // Change a session's role (relaunches, resume-preserving) / rename it in place.
  setAgent: (id: string, agentId: string) => Promise<void>
  rename: (id: string, name: string) => Promise<void>
  // The selectable roles (fetched once); empty until loaded. `general` always exists.
  agents: AgentInfo[]
  destroy: (id: string) => Promise<void>
  setMode: (id: string, mode: PermissionMode) => Promise<SetModeResult>
  // Whether THIS host can actually confine sessions (bwrap present + userns ok).
  // false ⇒ the sandbox controls explain it's unavailable + how to enable it.
  sandboxAvailable: boolean
  // The host GPU device nodes a sandboxed session can be handed (SandboxConfig.gpu).
  // Empty ⇒ no GPU here, and the sandbox controls hide the passthrough toggle.
  gpuDevices: string[]
  // The server user's home directory — the default cwd for new sessions, terminals,
  // and the folder picker. Empty until the health probe resolves (app startup).
  homeDir: string
  // Update a session's bwrap sandbox config (enable/disable, mounts). Applies on the
  // next launch; the caller relaunches to bring it into force.
  setSandbox: (id: string, sandbox: SandboxConfig) => Promise<void>
  // Grant/revoke this session's right to hire teammates itself (employ_teammate).
  setTeamEmploy: (id: string, teamEmploy: boolean) => Promise<void>
  // Was this session created in THIS app load (vs restored from persistence)? A
  // fresh session stays fresh; a restored one auto-resumes its latest conversation.
  isFresh: (id: string) => boolean
  // Optimistically flip an idle session to 'running' the moment a turn is sent, so
  // the working/thinking indicator + interrupt appear instantly (not after the WS
  // round-trip). The server's real state events reconcile it.
  markBusy: (id: string) => void
  // Sessions that finished a turn (or errored) while you were NOT viewing them — the
  // sidebar shows a red "needs attention" light until you switch to them.
  // ReadonlySet, not Set: it is reducer-owned state now, and a consumer mutating it would
  // corrupt the store silently. THE ONE TYPE-LEVEL CHANGE IN THIS FILE — if any consumer
  // needs a mutable Set the typecheck will say so, and that consumer is the bug.
  attention: ReadonlyMap<string, AttentionReason>
}

const SessionsContext = createContext<ContextValue | null>(null)

export function SessionsProvider({ children }: { children: ReactNode }) {
  const [store, dispatch] = useReducer(reduceSessionStore, initialSessionStore)
  const { sessions, activeId, attention } = store
  // State that is NOT part of the session machine: connection status and three facts
  // fetched once at startup. Deliberately left as plain useState — folding them into the
  // reducer would put non-transitional data behind a transition vocabulary.
  const [connected, setConnected] = useState(false)
  const [sandboxAvailable, setSandboxAvailable] = useState(false)
  const [gpuDevices, setGpuDevices] = useState<string[]>([])
  const [homeDir, setHomeDir] = useState('')
  const [agents, setAgents] = useState<AgentInfo[]>([])

  const patch = useCallback((id: string, fields: Partial<SessionInfo>) => {
    dispatch({ type: 'patch', id, fields })
  }, [])

  // Subscribe ONCE. `dispatch` is stable, and every rule these handlers used to apply
  // inline — don't clobber a running session on ready, flag attention only for a finished
  // turn on a session you are not watching, keep a failed exit's row — now lives in the
  // reducer where it is tested. This dep array was [patch] and is now []: the store no
  // longer needs a ref to read its own current value.
  useEffect(() => {
    const offList = api.on.list((list) => dispatch({ type: 'list', sessions: list }))
    const offState = api.on.stateChange((id, state) => dispatch({ type: 'state', id, state }))
    const offReady = api.on.ready((id) => dispatch({ type: 'ready', id }))
    const offExit = api.on.exit((id, failed, error) => dispatch({ type: 'exit', id, failed, error }))
    // A reconnect also retires any optimistic row the server never got to acknowledge —
    // otherwise a drop between a create and its broadcast strands that id in `unacked`
    // permanently, and since `list` carries unacknowledged rows through, that shows up as a
    // phantom session that never disappears.
    //
    // `wasDown` is required, not decorative: `client.ts` emits `connected(true)` from
    // `sock.onopen` UNCONDITIONALLY, so without the latch this fires on the FIRST connect as
    // well as on genuine reconnects. That is harmless only for as long as nothing creates a
    // session before the socket opens — true today (the sole `create(` call is user-driven and
    // there is no auto-create on load), and it would quietly stop being true the moment
    // anything restores a last session, follows a deep link, or spawns a subsession from a URL.
    // `TerminalView`'s connected handler already uses exactly this latch, so this is the house
    // pattern rather than a new idea.
    //
    // SEEDED, because `connected` is a plain channel with NO REPLAY: a subscriber learns nothing
    // about where it came in, and a bare `false` gets one of the two cases wrong whichever way
    // you pick. Mount while the socket is up and the first emit reads as a reconnect; mount
    // mid-outage and we never observe a down-edge, so the genuine reconnect that follows is not
    // treated as one — and since `createSession` is HTTP and succeeds while the WS is down, a
    // session created in that window strands its id in `unacked` permanently.
    //
    // THE SEED IS `hasEverConnected() && !isConnected()`, AND `!isConnected()` ALONE IS WRONG —
    // this was tried and reviewed out. readyState cannot distinguish *never connected yet* from
    // *was connected and dropped*, which is the entire question here, and a freshly constructed
    // socket is CONNECTING rather than OPEN. Worse, `SessionsProvider` is nested inside
    // `AuthGate` and React runs child effects first, while `ensureWs()` is called only from
    // `AuthGate`'s effect — so at this point `ws` is still null. Either fact alone makes a
    // readyState-only seed read "down" on every healthy startup, dispatching `reconnected` on
    // first connect: precisely the bug the latch exists to prevent, reintroduced through another
    // door. It was a silent no-op only because `unacked` is empty then.
    //
    // The four cases this seed gets right: healthy first mount → false (not a reconnect);
    // remount/outage after a prior connection → true (is a reconnect); app loaded while the
    // server is down and never connected → false, correctly, since HTTP creates fail too and
    // there is nothing to strand; StrictMode's second effect run → correct either side of onopen.
    let wasDown = api.hasEverConnected() && !api.isConnected()
    const offConn = api.on.connected((up) => {
      setConnected(up)
      if (!up) { wasDown = true; return }
      if (!wasDown) return
      wasDown = false
      dispatch({ type: 'reconnected' })
    })
    // Pull an initial snapshot too (covers a provider mounted after the WS hello).
    api.http.listSessions()
      .then((list) => dispatch({ type: 'list', sessions: list }))
      .catch(() => { /* server not up yet; the WS snapshot will fill in */ })
    return () => { offList(); offState(); offReady(); offExit(); offConn() }
  }, [])

  const create = useCallback(async (name: string, cwd: string, opts?: { model?: string; agentId?: string; parentId?: string; rootDir?: string; sandbox?: SandboxConfig }): Promise<string> => {
    const rootDir = opts?.rootDir ?? cwd
    const { id } = await api.http.createSession({ name, cwd, rootDir, model: opts?.model, agentId: opts?.agentId, parentId: opts?.parentId, sandbox: opts?.sandbox })
    // ONE action where there used to be three statements (mark fresh, add optimistically,
    // select). They were always meant to be one thing.
    dispatch({
      type: 'created',
      session: { id, name, cwd, rootDir, model: opts?.model, agentId: opts?.agentId, parentId: opts?.parentId, sandbox: opts?.sandbox, state: 'idle' },
    })
    return id
  }, [])

  // A subsession shares its parent's working directory + root, carries parentId, and
  // gets its own role. Name defaults to "<parent> · sub". Passing no `sandbox` is the
  // normal case and is meaningful: the server then gives the teammate its coordinator's
  // confinement rather than the generic default ("sandboxed together" — see SANDBOX.md).
  const spawnSubsession = useCallback(async (parentId: string, opts?: { name?: string; agentId?: string; sandbox?: SandboxConfig }): Promise<string | null> => {
    const parent = sessions.find((s) => s.id === parentId)
    if (!parent) return null
    return create(opts?.name?.trim() || `${parent.name} · sub`, parent.cwd, {
      parentId, rootDir: parent.rootDir, agentId: opts?.agentId, sandbox: opts?.sandbox,
    })
  }, [sessions, create])

  const setAgent = useCallback(async (id: string, agentId: string): Promise<void> => {
    patch(id, { agentId })   // optimistic; the server's session:list broadcast reconciles
    await api.http.setAgent(id, agentId)
  }, [patch])

  const rename = useCallback(async (id: string, name: string): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    patch(id, { name: trimmed })
    await api.http.rename(id, trimmed)
  }, [patch])

  const destroy = useCallback(async (id: string): Promise<void> => {
    await api.http.destroySession(id)
    // Drops the row AND moves the selection off it if it was active — one transition.
    dispatch({ type: 'destroyed', id })
  }, [])

  // Live permission-mode switch (P1.4). Optimistically reflect the chosen mode; the
  // result tells the UI whether it applied live / on relaunch / needs a restart.
  const setMode = useCallback(async (id: string, mode: PermissionMode): Promise<SetModeResult> => {
    patch(id, { permissionMode: mode })
    const res = await api.http.setMode(id, mode)
    // Preserved verbatim from the old code. Note it is now PROVABLY a no-op: the patch
    // above already set this value, and patchSessions returns the same state when no field
    // changes. Left in place rather than deleted, because removing dead code is a separate
    // change from moving live code, and mixing the two is how a refactor hides a decision.
    if (res.applied === 'restart' && res.reason) patch(id, { permissionMode: mode })
    return res
  }, [patch])

  // Learn once whether this host can sandbox (drives the sandbox controls' messaging).
  useEffect(() => { getHealth().then((h) => { setSandboxAvailable(!!h.sandboxAvailable); setGpuDevices(h.gpuDevices ?? []); if (h.homeDir) setHomeDir(h.homeDir) }).catch(() => {}) }, [])

  // Fetch the selectable roles once (drives the role pickers + sidebar badge).
  useEffect(() => { api.http.listAgents().then(setAgents).catch(() => {}) }, [])

  const setSandbox = useCallback(async (id: string, sandbox: SandboxConfig): Promise<void> => {
    patch(id, { sandbox })   // optimistic; the server's session:list broadcast reconciles `sandboxed`
    await api.http.setSandbox(id, sandbox)
  }, [patch])

  // "Employ team allowed": may this session hire/dismiss teammates on its own? Off by
  // default. Messaging between existing sessions never depends on this — only roster
  // management does, because that is the part that spends money without being asked.
  const setTeamEmploy = useCallback(async (id: string, teamEmploy: boolean): Promise<void> => {
    patch(id, { teamEmploy })   // optimistic; session:list reconciles
    await api.http.setTeamEmploy(id, teamEmploy)
  }, [patch])

  // Keyed on the `fresh` SET, not on `store` — see the N2 note at the top of this file.
  // The reducer returns state.fresh unchanged for every action but `created`, so this
  // identity is stable across ordinary state churn and ChatView's auto-resume effect
  // (ChatView.tsx:249, its only consumer) re-runs only when a session is created.
  const isFresh = useCallback((id: string) => store.fresh.has(id), [store.fresh])

  // Selecting a session ALSO clears its attention flag, in the same transition. The old
  // code did this in a useEffect on activeId, which ran after render and caught every path
  // (click, create, default-select, exit) only because they all happened to route through
  // activeId. Now every path calls withActive on purpose.
  const setActive = useCallback((id: string | null) => { dispatch({ type: 'setActive', id }) }, [])

  const markBusy = useCallback((id: string) => { dispatch({ type: 'markBusy', id }) }, [])

  // Memoize so unrelated session-state churn doesn't hand every consumer a new
  // context object identity and re-render them all. Most of these callbacks are now
  // permanently stable (they close over nothing but `dispatch`), so this list is shorter
  // in practice than it looks.
  const value = useMemo(
    () => ({ sessions, activeId, setActive, connected, create, spawnSubsession, setAgent, rename, agents, destroy, setMode, sandboxAvailable, gpuDevices, homeDir, setSandbox, setTeamEmploy, isFresh, markBusy, attention }),
    [sessions, activeId, setActive, connected, create, spawnSubsession, setAgent, rename, agents, destroy, setMode, sandboxAvailable, gpuDevices, homeDir, setSandbox, setTeamEmploy, isFresh, markBusy, attention],
  )
  return (
    <SessionsContext.Provider value={value}>
      {children}
    </SessionsContext.Provider>
  )
}

export function useSessions(): ContextValue {
  const ctx = useContext(SessionsContext)
  if (!ctx) throw new Error('useSessions must be used within SessionsProvider')
  return ctx
}
