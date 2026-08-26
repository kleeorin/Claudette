import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { useTerminal, type TerminalAPI } from '../hooks/useTerminal'

// A single shell pane (P1.10/P1.17). Two modes, driven by whether `paneId` is given:
//   • CREATE (no paneId) — spawn a fresh server pty, bind an xterm, and report the new
//     id up via `onCreated` so the parent can persist it.
//   • ATTACH (paneId set) — a reloaded/reopened client rebinds to an EXISTING pty: it
//     replays the server's buffered scrollback, then streams live output. This is how
//     terminals + their processes survive a page refresh.
//
// The pty's lifetime is owned by the PARENT, not this view: unmounting NO LONGER kills
// the pty (that's what makes refresh non-destructive). A pane dies only on an explicit
// close (parent calls api.pane.destroy), when its session is destroyed (server reaps),
// or on server exit. The one exception is a create that resolves after we've already
// unmounted — that pane was never reported, so we destroy it to avoid a leak.
export function TerminalView(
  { cwd, visible, sessionId, paneId, onCreated }: {
    cwd: string
    visible: boolean
    sessionId?: string
    paneId?: string                       // set → attach to this existing pty
    onCreated?: (paneId: string) => void  // create mode → report the new pty id
  },
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const paneIdRef = useRef<string | null>(paneId ?? null)
  const [exited, setExited] = useState(false)

  // Output ordering across the async scrollback replay: live `pane:output` frames that
  // arrive before the replay is written are queued, then flushed after it, so history
  // never interleaves with live output. `ready` starts true in create mode (no
  // scrollback to wait for). `writeToTerm` is xterm's writer, captured from useTerminal.
  const readyRef = useRef<boolean>(!paneId)
  // Which pane this instance has already pulled a snapshot for. Guards against replaying
  // twice when the attach effect re-runs on one instance — see the ATTACH branch below.
  const initialReplayFor = useRef<string | null>(null)
  const queueRef = useRef<string[]>([])
  const writeToTerm = useRef<((data: string) => void) | null>(null)

  // useMemo, not useRef: the ref form evaluated this whole object literal on EVERY
  // render and then threw the new one away (useRef ignores its argument after the
  // first call). It closes only over refs, so an empty dep list is right.
  const termApi = useMemo<TerminalAPI>(() => ({
    sendInput: (data) => { const id = paneIdRef.current; if (id) api.pane.input(id, data) },
    sendResize: (cols, rows) => { const id = paneIdRef.current; if (id) api.pane.resize(id, cols, rows) },
    subscribeOutput: (cb) => {
      writeToTerm.current = cb
      return api.on.paneOutput((id, data) => {
        if (id !== paneIdRef.current) return
        if (!readyRef.current) { queueRef.current.push(data); return }
        cb(data)
      })
    },
  }), [])

  const { fit, focus, getSize, reset } = useTerminal(containerRef, termApi)

  // Kept mounted-but-hidden across tab switches (so scrollback survives); a hidden
  // container fits to 0, so re-fit + focus whenever we become visible again — and
  // resize the pty to match, which also corrects an attached pty whose window is a
  // different size than when it was first spawned (the refresh-reattach case).
  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(() => {
      fit(); focus()
      const id = paneIdRef.current
      const size = getSize()
      if (id && size) api.pane.resize(id, size.cols, size.rows)
    })
  }, [visible, fit, focus, getSize])

  // Pull the pane's server-side buffer into a blank xterm, then flush anything that
  // streamed in while the request was in flight. Used for the initial attach AND after a
  // WS reconnect — `fresh` distinguishes them: a reconnect must wipe the stale screen
  // first, since the snapshot is the whole buffer, not a delta.
  const replayRef = useRef<((id: string, fresh: boolean) => void) | null>(null)
  replayRef.current = (id, fresh) => {
    void api.pane.attach(id).then(({ data, alive }) => {
      if (paneIdRef.current !== id) return
      if (fresh) reset()
      if (data) writeToTerm.current?.(data)
      for (const chunk of queueRef.current) writeToTerm.current?.(chunk)
      queueRef.current = []
      readyRef.current = true
      // A pty that died while we were disconnected never delivered its `pane:exit`;
      // `alive` is the only way back to the truth.
      setExited(!alive)
      requestAnimationFrame(() => {
        fit(); focus()
        const size = getSize()
        if (size) api.pane.resize(id, size.cols, size.rows)
      })
    // PRE-EXISTING GAP, deliberately left as-is: this goes ready WITHOUT flushing
    // `queueRef`, so frames that queued while a FAILED attach was in flight are dropped
    // silently. Always been true; noted here because making the attach clear-first (below)
    // routes more frames through that queue, so it is more reachable than it was. The fix is
    // to flush before setting ready — not done here because an attach that failed leaves the
    // screen with no snapshot under those frames, and which of "partial" or "empty" is the
    // better lie is a call worth making deliberately rather than in passing.
    }).catch(() => { readyRef.current = true })
  }

  // A dropped WS (phone sleeping, laptop suspend, network hop) silently costs the pane
  // every frame emitted while it was down: input still works, but the screen is frozen
  // mid-scrollback — the "stuck terminal". Nothing used to re-sync it. On the way back
  // up, re-queue live output and replay the server's buffer over a cleared screen.
  useEffect(() => {
    let wasDown = false
    return api.on.connected((up) => {
      if (!up) { wasDown = true; return }
      if (!wasDown) return
      wasDown = false
      const id = paneIdRef.current
      if (!id) return
      readyRef.current = false
      replayRef.current?.(id, true)
    })
  }, [])

  useEffect(() => {
    let disposed = false
    let createdId: string | null = null
    const offExit = api.on.paneExit((id) => { if (id === paneIdRef.current) setExited(true) })
    // RE-ARM the pane id. The useRef initializer above runs on the FIRST render only,
    // while the cleanup below nulls this ref — so this effect could re-run with the ref
    // still null. Every guard downstream compares against it: the replay's
    // `paneIdRef.current !== id` bailed, subscribeOutput dropped every live frame, and
    // sendInput no-opped — a reattached terminal that is blank AND dead to typing, with no
    // error anywhere. Found by scratchpad/refresh-survival-check.mjs, whose
    // scrollback-replay assertion cannot pass against a dev server without this.
    //
    // *** THE TRIGGER IS **NOT** A REMOUNT — an earlier draft of this comment said it was,
    // and that would send anyone hunting siblings looking for the wrong thing. A real
    // unmount/remount builds a NEW component instance, so the useRef initializer re-runs
    // and is CORRECT. The bug needs cleanup-then-re-run ON THE SAME INSTANCE, which needs
    // one of: StrictMode's double-invoke, a dep change (the deps here are []), or Vite Fast
    // Refresh / HMR, which re-runs effects while preserving refs. All three are dev-only, so
    // the prod build is unaffected TODAY — but note the enumeration is of DEV paths, not a
    // claim that no prod path could ever exist. The cost was ours, not the user's:
    // terminal reattach was never observable in a dev session, so any future harness would
    // have hit this wall and read it as its own bug.
    // THE SIBLING SIGNATURE TO GREP FOR is not "remount" — it is:
    //     useRef(<prop>)  +  a cleanup that mutates that ref  +  [] deps.
    // Adding a dep to this effect makes it reachable in prod, so treat that as a real
    // change rather than a tidy-up. ***
    paneIdRef.current = paneId ?? null

    if (paneId) {
      // ATTACH: paneIdRef is already this id, so live output starts queueing at once.
      // Pull the buffered scrollback, write it, flush the queue, then go live. (The
      // unmount path nulls paneIdRef, which is what makes a late reply a no-op.)
      //
      // REPLAY AT MOST ONCE PER PANE, per mounted instance. This effect can run more than
      // once on ONE instance (StrictMode / Fast Refresh — see the block above) and the
      // snapshot is the WHOLE buffer, not a delta, so a second replay wrote the whole thing
      // on top of the first and the scrollback appeared doubled.
      //
      // *** THE OBVIOUS FIX DOES NOT WORK, AND IT FAILS INTERMITTENTLY, WHICH IS WORSE. ***
      // The first attempt kept both replays and made the second one clear first
      // (`replay(paneId, true)`, i.e. `reset()` before the write). That reasoning is sound
      // ONLY IF writes are synchronous, and xterm's are not: `write(data, callback?)` fires
      // its callback "when the data was processed by the parser", so data already queued and
      // not yet parsed survives a `reset()` issued after it. Both writes then land after the
      // last reset. Measured over six runs of scratchpad/refresh-survival-check.mjs against
      // that version: 4 doubled, 2 clean, with an IDENTICAL attach log every time
      // ([1,0,0,1,0,0] — six attaches, this pane twice, one marker each). Do not restore it,
      // and do not trust a single green run of any fix here.
      //
      // Skipping the second replay removes the race instead of ordering it: one attach, one
      // write, nothing to interleave. Everything else in the effect still re-arms on the
      // second run (the exit listener, the pane-id ref, the output subscription), which is
      // what those runs are actually for. A genuine remount builds a new instance, so this
      // ref is fresh and the replay happens as it should. The reconnect path above is
      // untouched and still replays with `fresh: true`, correctly: there the socket really
      // did drop and the screen really is stale.
      if (initialReplayFor.current !== paneId) {
        initialReplayFor.current = paneId
        replayRef.current?.(paneId, false)
      }
    } else {
      // CREATE: fit BEFORE create so the pty spawns at the terminal's real size — the
      // shell draws its first prompt at the right width (typed chars don't overwrite the
      // prompt; history recall doesn't shift a line). Re-send the size after create as a
      // backstop for any layout that settled in between, and report the id upward.
      fit()
      const initial = getSize()
      void api.pane.create(cwd, initial?.cols, initial?.rows, sessionId).then(({ id }) => {
        // Unmounted before create resolved → nobody learned this id; destroy it so it
        // doesn't leak as a headless process.
        if (disposed) { void api.pane.destroy(id); return }
        createdId = id
        paneIdRef.current = id
        onCreated?.(id)
        requestAnimationFrame(() => {
          fit(); focus()
          const size = getSize()
          if (size) api.pane.resize(id, size.cols, size.rows)
        })
      })
    }

    return () => {
      disposed = true
      offExit()
      // NOTE: no destroy here — the pty outlives this view (refresh survival). The only
      // cleanup is the disposed-before-create guard above, handled inside the .then.
      void createdId
      paneIdRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full bg-[#1e1e2e] overflow-hidden" onClick={focus}>
      {exited && (
        <div className="shrink-0 px-3 py-1 text-[11px] text-ctp-overlay bg-ctp-mantle border-b border-ctp-surface0">
          shell exited — reopen the terminal tab to start a new one
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 p-1.5" />
    </div>
  )
}
