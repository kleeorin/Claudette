import { useEffect, useState } from 'react'
import { useChat } from '../store/chat'
import { useSessions } from '../store/sessions'
import {
  bashProcDot, bashProcStatusText, bashProcElapsed, formatDuration,
  bashProcLabel, bashOutputAvailable, isLiveBashProc, bashProcKillable,
} from '../lib/bashProcLights'
import type { BashProcRecord } from '@claudette/shared'

// One background process, opened as a full content tab: the command in full, how long it has
// been going, how it ended, and what the CLI said about it. The sidebar list is the
// glanceable summary; this is the "what did I actually put in the background" view.
//
// Deliberately simpler than AgentDetail, because a background process HAS no chain of
// thought — it is one command. The scroll-position machinery AgentDetail carries exists for
// a growing list of agent steps and would be dead weight here.

// How often the elapsed reading re-renders while something is running.
//
// ONE SECOND, AND `now` COMES FROM A TIMER RATHER THAN Date.now() AT RENDER. A component that
// simply called the clock in its body would look correct in every test and freeze in the app:
// nothing else about a running process changes between the launch broadcast and the settle
// broadcast, so there would be no re-render to move it, and the one number the user is
// watching would sit still for the entire run.
const TICK_MS = 1000

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    // Re-read on mount as well as on each tick: a tab reopened after being away would
    // otherwise show the stale `now` captured at first mount for up to a second.
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [active])
  return now
}

export function BashProcDetail({ sessionId, toolId }: { sessionId: string; toolId: string }) {
  const { bashProcsFor, killBash } = useChat()
  const { sessions } = useSessions()
  const session = sessions.find((s) => s.id === sessionId)
  const proc = bashProcsFor(sessionId).find((p) => p.toolId === toolId)
  const live = !!proc && isLiveBashProc(proc.status)
  const now = useNow(live)

  if (!proc) {
    return (
      <div className="h-full flex items-center justify-center bg-ctp-base">
        <div className="text-center space-y-1">
          <div className="text-sm text-ctp-subtext">This background process is no longer in the registry.</div>
          <div className="text-xs text-ctp-overlay">The session was cleared, or the server dropped an old record.</div>
        </div>
      </div>
    )
  }

  const elapsed = bashProcElapsed(proc, now)
  const status = bashProcStatusText(proc.status)
  const dot = bashProcDot(proc.status)
  // The engine is what makes the output file reachable at all, so its absence — not the
  // process's own status — is what withdraws the output pane. A finished process in a live
  // session still has a readable file; a running one in a dead session does not.
  const engineAlive = !!session && session.state !== 'exited'

  return (
    <div className="h-full flex flex-col bg-ctp-base min-h-0">
      <div className="shrink-0 px-4 py-2.5 border-b border-ctp-surface0 bg-ctp-mantle">
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 text-ctp-green" aria-hidden>▶</span>
          <span className="min-w-0 truncate text-sm font-medium text-ctp-text">{bashProcLabel(proc, 200)}</span>
          <span className={`ml-auto shrink-0 flex items-center gap-1.5 text-[11px] ${status.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${dot.cls}`} />{status.label}
          </span>
          {/* Same single rule as the sidebar row's ■, from lib/bashProcLights rather than
              restated here. It used to be written out inline in both places, which is how a
              later "the sidebar already checks this" tidy-up could have dropped the shellId
              half here with every suite still green — and an unroutable kill is answered by
              the CLI with SUCCESS, so nothing would have reported the no-op. */}
          {bashProcKillable(proc) && (
            <button
              onClick={() => killBash(sessionId, proc.toolId)}
              title="Kill this background process (the turn keeps running)"
              className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-ctp-surface1 text-ctp-subtext hover:text-ctp-red hover:border-ctp-red/50 transition-colors"
            >
              Kill
            </button>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-ctp-overlay">
          {/* "ran"/"running for" rather than a bare duration: the same number means two
              different things depending on whether it is still moving. And when the start
              time is unusable — a record settled in bulk may carry no real one — we say so
              instead of rendering the arithmetic, which produces "NaNh NaNm" or a duration of
              several decades. */}
          {elapsed === null
            ? (live ? 'running · duration unknown' : 'duration unknown')
            : `${live ? 'running for ' : 'ran '}${formatDuration(elapsed)}`}
          {proc.exitCode !== undefined && <span> · exit {proc.exitCode}</span>}
          {proc.shellId && <span> · <span className="font-mono">{proc.shellId}</span></span>}
          {session && <span> · in {session.name}</span>}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        <section className="space-y-1">
          <h3 className="text-[10px] uppercase tracking-wide text-ctp-overlay">Command</h3>
          {/* IN FULL, and wrapped rather than truncated — this view exists to answer "what
              exactly did I put in the background", which a clipped heredoc cannot. The
              sidebar row is where the short form lives. */}
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] text-ctp-subtext bg-ctp-mantle/60 border border-ctp-surface0 rounded-md p-2.5">
            {proc.command}
          </pre>
        </section>

        {/* Only when it adds something. The description is the label at the top of this very
            pane, so repeating it here would be a section that says what the header just said. */}
        {proc.description && bashProcLabel(proc, 200) !== proc.description && (
          <section className="space-y-1">
            <h3 className="text-[10px] uppercase tracking-wide text-ctp-overlay">Description</h3>
            <div className="text-xs text-ctp-subtext">{proc.description}</div>
          </section>
        )}

        {proc.status === 'stopped' && (
          <section className="space-y-1">
            <h3 className="text-[10px] uppercase tracking-wide text-ctp-overlay">Outcome</h3>
            {/* Neither a success nor a failure, and worded so it does not read as either. This
                is usually the result of the user pressing Kill in this very panel, so
                reporting it back to them as an error would be describing their own deliberate
                action as something having gone wrong. */}
            <div className="text-xs text-ctp-subtext">
              This command was stopped before it finished. Whatever it had already done is
              done; anything after that point never ran.
            </div>
          </section>
        )}

        {proc.status === 'unknown' && (
          <section className="space-y-1">
            <h3 className="text-[10px] uppercase tracking-wide text-ctp-overlay">Outcome</h3>
            {/* Says what we do not know and WHY, rather than leaving a grey dot to be read as
                a failure. The process may well have finished perfectly — the engine that
                would have reported it is simply gone, and a background shell is a child of
                that engine, so it did not outlive it either. */}
            <div className="text-xs text-ctp-subtext">
              This session's engine stopped while the command was still running, so its outcome
              was never reported. The command did not survive the engine, but whether it had
              already finished — and with what result — is not recorded anywhere.
            </div>
          </section>
        )}

        {proc.summary && (
          <section className="space-y-1">
            <h3 className={`text-[10px] uppercase tracking-wide ${proc.status === 'failed' ? 'text-ctp-red/80' : 'text-ctp-overlay'}`}>Summary</h3>
            <div className={`text-xs ${proc.status === 'failed' ? 'text-ctp-red' : 'text-ctp-subtext'}`}>{proc.summary}</div>
          </section>
        )}

        <BashProcOutput proc={proc} engineAlive={engineAlive} />
      </div>
    </div>
  )
}

// The output section — deliberately ONE component, so wiring the real thing is a change to
// this function and nothing else.
//
// WHY IT IS NOT WIRED YET. The output file IS reachable while the engine lives: measured for
// an unconfined session on the real /tmp, and for a confined one through the live process's
// own /proc entry. But reaching it is a filesystem read, and a browser cannot do that. The
// server endpoint that performs it has an agreed shape and is built after the transport:
//
//   GET /api/session/:id/bashProc/:toolId/output
//     → { ok: true,  retrievable: true,  output: string, truncated: boolean }
//     → { ok: true,  retrievable: false, reason: string }
//     → { ok: false, error: string }
//
// Note `retrievable: false` carries a REASON rather than an empty `output`, and when this is
// wired that reason must be rendered as-is: "nothing has been written yet" and "we can no
// longer reach the output" both look like a blank pane, and only the reason tells them apart.
// Until then this says where the output is rather than pretending there is none.
function BashProcOutput({ proc, engineAlive }: { proc: BashProcRecord; engineAlive: boolean }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[10px] uppercase tracking-wide text-ctp-overlay">Output</h3>
      <div className="text-xs text-ctp-overlay italic">
        {bashOutputAvailable(engineAlive) ? (
          <>
            Written to <span className="font-mono not-italic">{proc.outputFile ?? "the session's task output file"}</span>.
            Reading it from here isn't wired up yet.
          </>
        ) : (
          // The honest end state, and it applies to EVERY session rather than only the
          // confined ones. A confined session's output file lives on a private tmpfs that
          // dies with the process; an unconfined session's survives on the real /tmp. We
          // deliberately withdraw it for both, because a panel that remembers for some
          // sessions and forgets for others — with nothing on screen explaining which — is
          // an inconsistency the user would have to discover for themselves.
          <>This session's engine has stopped, so the command's output is no longer retrievable.</>
        )}
      </div>
    </section>
  )
}

// The label a freshly-opened background-process tab carries, mirroring agentTabLabel — the
// pane keeps it so the tab strip never has to re-derive it.
export function bashProcTabLabel(p: BashProcRecord): string {
  return bashProcLabel(p, 40)
}

// Compact status dot shared with the sidebar list, mirroring AgentStatusDot. Exported from
// here for the same reason that one is: so the list and this view cannot drift on what
// "running" looks like.
export function BashProcStatusDot({ status }: { status: BashProcRecord['status'] }) {
  const { cls, title } = bashProcDot(status)
  return <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${cls}`} title={title} />
}
