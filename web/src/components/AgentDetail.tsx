import { useEffect, useMemo, useRef } from 'react'
import { useChat, collectAgents, agentKey, isAgentLive, type AgentView, type TranscriptItem } from '../store/chat'
import { useSessions } from '../store/sessions'
import { Markdown } from './Markdown'
import { ToolRow, ResultRow } from './ChatView'

// One subagent, opened as a full content tab: its task prompt, its COMPLETE chain of
// thought (thinking blocks rendered in full, not collapsed), every tool call it made,
// and its final result. The sidebar list is the glanceable summary; this is the
// "what was it actually doing" view, with room to read.
export function AgentDetail({ sessionId, agentId }: { sessionId: string; agentId: string }) {
  const { transcriptFor, tasksFor, stopTask } = useChat()
  const { sessions } = useSessions()
  const session = sessions.find((s) => s.id === sessionId)
  const items = transcriptFor(sessionId)
  const tasks = tasksFor(sessionId)
  const agent = useMemo(
    () => collectAgents(items, tasks).find((a) => agentKey(a) === agentId),
    [items, tasks, agentId],
  )
  const turnActive = session?.state === 'running' || session?.state === 'waiting'
  const active = !!agent && isAgentLive(agent, turnActive)

  // Follow the agent's activity while it runs, but only while parked at the bottom —
  // scrolling up to read an earlier step stays undisturbed.
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const stepCount = agent?.steps.length ?? 0
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !active || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [stepCount, active])
  const onScroll = () => {
    const el = scrollRef.current
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  if (!agent) {
    return (
      <div className="h-full flex items-center justify-center bg-ctp-base">
        <div className="text-center space-y-1">
          <div className="text-sm text-ctp-subtext">This agent is no longer in the transcript.</div>
          <div className="text-xs text-ctp-overlay">It was cleared, or the conversation was reset.</div>
        </div>
      </div>
    )
  }

  const failed = agent.result?.isError === true
  const status = failed ? { label: 'failed', text: 'text-ctp-red', dot: 'bg-ctp-red' }
    : agent.result ? { label: 'done', text: 'text-ctp-green', dot: 'bg-ctp-green' }
    : active ? { label: 'running', text: 'text-ctp-mauve', dot: 'bg-ctp-mauve animate-pulse' }
    : { label: 'stopped', text: 'text-ctp-overlay', dot: 'bg-ctp-overlay' }
  const calls = agent.steps.filter((s) => s.kind === 'tool_use').length

  return (
    <div className="h-full flex flex-col bg-ctp-base min-h-0">
      <div className="shrink-0 px-4 py-2.5 border-b border-ctp-surface0 bg-ctp-mantle">
        <div className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 text-ctp-mauve" aria-hidden>◈</span>
          <span className="shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded bg-ctp-mauve/15 text-ctp-mauve">{agent.type}</span>
          <span className="min-w-0 truncate text-sm font-medium text-ctp-text">{agent.description}</span>
          <span className={`ml-auto shrink-0 flex items-center gap-1.5 text-[11px] ${status.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />{status.label}
          </span>
          {/* Stoppable only while running AND with a task id from the CLI (a resumed
              conversation replays the Task but never its task_started). Stops just this
              agent — the session's turn carries on. */}
          {active && agent.taskId && agent.toolId && (
            <button
              onClick={() => stopTask(sessionId, agent.toolId!)}
              title="Stop this agent (the turn keeps running)"
              className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-ctp-surface1 text-ctp-subtext hover:text-ctp-red hover:border-ctp-red/50 transition-colors"
            >
              Stop
            </button>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-ctp-overlay">
          {calls} tool call{calls === 1 ? '' : 's'}
          {session && <span> · in {session.name}</span>}
        </div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {agent.prompt && (
          <section className="space-y-1">
            <h3 className="text-[10px] uppercase tracking-wide text-ctp-overlay">Task prompt</h3>
            <pre className="whitespace-pre-wrap font-mono text-[11.5px] text-ctp-subtext bg-ctp-mantle/60 border border-ctp-surface0 rounded-md p-2.5">
              {agent.prompt}
            </pre>
          </section>
        )}

        <section className="space-y-1">
          <h3 className="text-[10px] uppercase tracking-wide text-ctp-overlay">Thought process</h3>
          {agent.steps.length === 0 ? (
            <div className="text-xs text-ctp-overlay italic">{active ? 'Starting…' : 'No activity was recorded for this agent.'}</div>
          ) : (
            <div className="space-y-1.5">
              {agent.steps.map((s) => <Step key={s.id} item={s} />)}
            </div>
          )}
          {active && agent.steps.length > 0 && (
            <div className="flex items-center gap-2 pt-1 text-[11px] text-ctp-mauve">
              <span className="w-1.5 h-1.5 rounded-full bg-ctp-mauve animate-pulse" />Working…
            </div>
          )}
        </section>

        {agent.result && (
          <section className="space-y-1">
            <h3 className={`text-[10px] uppercase tracking-wide ${failed ? 'text-ctp-red/80' : 'text-ctp-overlay'}`}>{failed ? 'Error' : 'Result'}</h3>
            <div className={`text-xs ${failed ? 'text-ctp-red' : 'text-ctp-subtext'}`}>
              <Markdown text={agent.result.content} />
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

// One step of the agent's own activity. Thinking is shown IN FULL here (this view
// exists to read it), unlike the compact rows used inside the conversation.
function Step({ item }: { item: TranscriptItem }) {
  if (item.kind === 'tool_use') return <ToolRow name={item.name} input={item.input} />
  if (item.kind === 'tool_result') return <ResultRow content={item.content} isError={item.isError} />
  if (item.kind === 'thinking') {
    if (!item.text.trim()) return null   // signature-only block — nothing to read
    return (
      <div className="flex items-start gap-2 animate-fade-in">
        <span className="shrink-0 text-ctp-mauve/80 leading-5" aria-hidden>💭</span>
        <div className="min-w-0 whitespace-pre-wrap text-[12px] leading-5 italic text-ctp-subtext/90 break-words">
          {item.text}
        </div>
      </div>
    )
  }
  if (item.kind === 'text') return <div className="text-xs text-ctp-subtext animate-fade-in"><Markdown text={item.text} /></div>
  return null
}

// The label a freshly-opened agent tab carries (the pane keeps it, so the strip
// doesn't have to re-derive it from the transcript on every token).
export function agentTabLabel(a: AgentView): string {
  return a.description || a.type || 'agent'
}

// Compact status pill shared by the sidebar list. Exported here so the sidebar and
// this view can't drift on what "running" looks like.
export function AgentStatusDot({ agent, turnActive }: { agent: AgentView; turnActive: boolean }) {
  const failed = agent.result?.isError === true
  const live = isAgentLive(agent, turnActive)
  const cls = failed ? 'bg-ctp-red'
    : agent.result ? 'bg-ctp-green'
    : live ? 'bg-ctp-mauve animate-pulse'
    : 'bg-ctp-overlay'
  const title = failed ? 'failed' : agent.result ? 'done' : live ? 'running' : 'stopped'
  return <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${cls}`} title={title} />
}
