import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useTerminal, type TerminalAPI } from '../hooks/useTerminal'

// A single shell pane (P1.10/P1.17). Creates a server-side pty on mount, binds an
// xterm to it (output over WS, input/resize back over WS), and tears the pty down
// on unmount. The parent (App) keeps this mounted once opened so the shell + its
// scrollback survive tab switches.
export function TerminalView({ cwd, visible }: { cwd: string; visible: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const paneIdRef = useRef<string | null>(null)
  const [exited, setExited] = useState(false)

  // The pane id is assigned async (after create), so every call reads it live from
  // the ref; output is filtered to this pane.
  const termApi = useRef<TerminalAPI>({
    sendInput: (data) => { const id = paneIdRef.current; if (id) api.pane.input(id, data) },
    sendResize: (cols, rows) => { const id = paneIdRef.current; if (id) api.pane.resize(id, cols, rows) },
    subscribeOutput: (cb) => api.on.paneOutput((id, data) => { if (id === paneIdRef.current) cb(data) }),
  }).current

  const { fit, focus } = useTerminal(containerRef, termApi)

  // Kept mounted-but-hidden across tab switches (so scrollback survives); a hidden
  // container fits to 0, so re-fit + focus whenever we become visible again.
  useEffect(() => {
    if (visible) requestAnimationFrame(() => { fit(); focus() })
  }, [visible, fit, focus])

  useEffect(() => {
    let disposed = false
    let paneId: string | null = null
    const offExit = api.on.paneExit((id) => { if (id === paneIdRef.current) setExited(true) })
    void api.pane.create(cwd).then(({ id }) => {
      if (disposed) { void api.pane.destroy(id); return }
      paneId = id
      paneIdRef.current = id
      // Re-fit now that the pty exists so its size matches the viewport.
      requestAnimationFrame(() => { fit(); focus() })
    })
    return () => {
      disposed = true
      offExit()
      if (paneId) void api.pane.destroy(paneId)
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
