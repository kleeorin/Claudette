import { useEffect, useState } from 'react'
import type { KernelStatus, KernelSpec } from '@claudette/shared'
import { useNotebooks } from '../store/notebooks'
import { basename } from '../lib/paths'

// The "Kernels" sub-tab of the Files dock: a live list of the open notebooks and
// their Jupyter kernels. Click a row to focus that notebook's tab; hover to reveal
// per-kernel controls (interrupt / restart / shut down). Mirrors NotebookView's
// kernel status vocabulary so the two surfaces read the same.
const STATUS_DOT: Record<KernelStatus, string> = {
  none: 'bg-ctp-surface2',
  idle: 'bg-ctp-green',
  busy: 'bg-ctp-yellow animate-pulse',
  starting: 'bg-ctp-overlay animate-pulse',
  dead: 'bg-ctp-red',
}
const STATUS_LABEL: Record<KernelStatus, string> = {
  none: 'no kernel', idle: 'idle', busy: 'busy', starting: 'starting…', dead: 'dead',
}

export function KernelsPanel({ onFocus, onClose }: { onFocus: (notebookId: string) => void; onClose: () => void }) {
  const nb = useNotebooks()
  const [specs, setSpecs] = useState<KernelSpec[] | null>(null)
  const [specDefault, setSpecDefault] = useState<string | undefined>(undefined)

  // Resolve raw kernelspec names (e.g. 'python3') to human display names.
  useEffect(() => {
    let live = true
    nb.kernelSpecs().then((r) => { if (live) { setSpecs(r.specs); setSpecDefault(r.default) } }).catch(() => {})
    return () => { live = false }
  }, [nb])

  const kernelLabel = (kernelName?: string) => {
    const effective = kernelName ?? specDefault
    return specs?.find((s) => s.name === effective)?.displayName ?? effective ?? 'No kernel'
  }

  return (
    <div className="flex flex-col h-full bg-ctp-base overflow-hidden">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className="text-xs font-semibold text-ctp-subtext">Kernels</span>
        <span className="text-[11px] text-ctp-overlay">{nb.open.length || ''}</span>
        <button onClick={onClose} title="Close dock" className="ml-auto text-ctp-overlay hover:text-ctp-text p-0.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {nb.open.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-4 text-center text-xs text-ctp-overlay">
          No open notebooks.
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto py-1">
          {nb.open.map((doc) => {
            const status = nb.kernelFor(doc.notebookId)
            const running = status !== 'none' && status !== 'dead'
            return (
              <div
                key={doc.notebookId}
                onClick={() => onFocus(doc.notebookId)}
                title={doc.path}
                className="group w-full flex items-center gap-2 px-3 py-1.5 text-left cursor-pointer hover:bg-ctp-surface0/50 transition-colors"
              >
                <span className={`shrink-0 w-2 h-2 rounded-full ${STATUS_DOT[status]}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] text-ctp-text">{basename(doc.path)}</span>
                    {doc.dirty && <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-ctp-accent" title="Unsaved changes" />}
                  </div>
                  <div className="truncate text-[11px] text-ctp-overlay">
                    {kernelLabel(doc.kernelName)} · {STATUS_LABEL[status]}
                  </div>
                </div>
                {/* Per-kernel actions — revealed on hover. */}
                <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <KBtn
                    onClick={() => nb.interruptKernel(doc.notebookId)}
                    disabled={status !== 'busy'}
                    title="Interrupt kernel"
                  >⏸</KBtn>
                  <KBtn
                    onClick={() => nb.restartKernel(doc.notebookId)}
                    disabled={!running}
                    title="Restart kernel"
                  >⟳</KBtn>
                  <KBtn
                    onClick={() => nb.shutdownKernel(doc.notebookId)}
                    disabled={!running}
                    title="Shut down kernel"
                    danger
                  >⏻</KBtn>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function KBtn({ children, onClick, title, disabled, danger }: {
  children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean; danger?: boolean
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      disabled={disabled}
      title={title}
      className={`text-xs leading-none px-1 py-0.5 rounded hover:bg-ctp-surface1 disabled:opacity-30 disabled:hover:bg-transparent ${danger ? 'text-ctp-overlay hover:text-ctp-red' : 'text-ctp-overlay hover:text-ctp-text'}`}
    >
      {children}
    </button>
  )
}
