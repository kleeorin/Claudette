import { useEffect, useRef, useState } from 'react'
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
  const queueRef = useRef<string[]>([])
  const writeToTerm = useRef<((data: string) => void) | null>(null)

  const termApi = useRef<TerminalAPI>({
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
  }).current

  const { fit, focus, getSize } = useTerminal(containerRef, termApi)

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

  useEffect(() => {
    let disposed = false
    let createdId: string | null = null
    const offExit = api.on.paneExit((id) => { if (id === paneIdRef.current) setExited(true) })

    if (paneId) {
      // ATTACH: paneIdRef is already this id, so live output starts queueing at once.
      // Pull the buffered scrollback, write it, flush the queue, then go live. Re-fit +
      // resize so the pty matches this (possibly new) window size.
      void api.pane.attach(paneId).then(({ data }) => {
        if (disposed) return
        if (data) writeToTerm.current?.(data)
        for (const chunk of queueRef.current) writeToTerm.current?.(chunk)
        queueRef.current = []
        readyRef.current = true
        requestAnimationFrame(() => {
          fit(); focus()
          const size = getSize()
          if (size) api.pane.resize(paneId, size.cols, size.rows)
        })
      }).catch(() => { readyRef.current = true })
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
