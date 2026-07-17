import type { ReactNode } from 'react'
import { basename } from './paths'

// Turn a tool's raw JSON input into something a human can read at a glance —
// used by the permission prompt ("what am I allowing?") and the tool-call rows.
// Each known tool gets a purpose-built summary; everything else falls back to a
// tidy key/value list instead of a single wall-of-JSON line.

// A short verb-phrase headline, e.g. "Run a command", "Write cfg.py".
export function toolHeadline(name: string, input: Record<string, unknown>): string {
  const f = (k: string) => (typeof input?.[k] === 'string' ? (input[k] as string) : undefined)
  const base = (p?: string) => (p ? basename(p) : '')
  switch (name) {
    case 'Bash': return 'Run a shell command'
    case 'Write': return `Write ${base(f('file_path'))}`
    case 'Edit': return `Edit ${base(f('file_path'))}`
    case 'MultiEdit': return `Edit ${base(f('file_path'))}`
    case 'NotebookEdit': return `Edit notebook ${base(f('notebook_path') || f('file_path'))}`
    case 'Read': return `Read ${base(f('file_path'))}`
    case 'Glob': return 'Search files by name'
    case 'Grep': return 'Search file contents'
    case 'WebFetch': return 'Fetch a web page'
    case 'WebSearch': return 'Search the web'
    case 'AskUserQuestion': return 'Ask you a question'
    case 'Task': return 'Launch a subagent'
    default: return name
  }
}

// The single most salient argument, for the compact one-line tool row —
// rendered as `Name(arg)`, à la Claude Code (e.g. `Read(client.ts)`,
// `Bash(npm test)`). Returns undefined when there's nothing worth showing.
export function toolArg(name: string, input: Record<string, unknown>): string | undefined {
  const f = (k: string) => (typeof input?.[k] === 'string' ? (input[k] as string) : undefined)
  const base = (p?: string) => (p ? basename(p) : undefined)
  const oneLine = (s?: string) => s?.replace(/\s+/g, ' ').trim()
  switch (name) {
    case 'Bash': return oneLine(f('command'))
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'Read': return base(f('file_path'))
    case 'NotebookEdit': return base(f('notebook_path') || f('file_path'))
    case 'Glob': return f('pattern')
    case 'Grep': return f('pattern')
    case 'WebFetch': return f('url')
    case 'WebSearch': return f('query')
    case 'Task': return f('description') || f('subagent_type')
    case 'AskUserQuestion': return undefined
    default: {
      // Unknown tool: first string-valued arg, if any.
      const first = Object.values(input ?? {}).find((v) => typeof v === 'string') as string | undefined
      return oneLine(first)
    }
  }
}

// Rich, readable detail for a tool's input.
export function ToolDetail({ name, input }: { name: string; input: unknown }): ReactNode {
  const o = (input ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined)

  switch (name) {
    case 'Bash':
      return (
        <div className="space-y-1">
          {str('description') && <div className="text-ctp-subtext">{str('description')}</div>}
          <pre className="font-mono text-[11px] bg-ctp-crust/60 rounded px-2 py-1 whitespace-pre-wrap">{str('command')}</pre>
        </div>
      )
    case 'Write':
      return (
        <div className="space-y-1">
          <Path p={str('file_path')} />
          <Preview text={str('content') ?? ''} />
        </div>
      )
    case 'Edit':
      return (
        <div className="space-y-1">
          <Path p={str('file_path')} />
          <Replace from={str('old_string')} to={str('new_string')} />
        </div>
      )
    case 'MultiEdit': {
      const edits = Array.isArray(o.edits) ? (o.edits as Array<Record<string, unknown>>) : []
      return (
        <div className="space-y-1">
          <Path p={str('file_path')} />
          <div className="text-ctp-subtext">{edits.length} edit{edits.length === 1 ? '' : 's'}</div>
          {edits.slice(0, 3).map((e, i) => (
            <Replace key={i} from={String(e.old_string ?? '')} to={String(e.new_string ?? '')} />
          ))}
          {edits.length > 3 && <div className="text-ctp-overlay text-[11px]">…{edits.length - 3} more</div>}
        </div>
      )
    }
    case 'NotebookEdit':
      return (
        <div className="space-y-1">
          <Path p={str('notebook_path') || str('file_path')} />
          {str('edit_mode') && <div className="text-ctp-subtext">{str('edit_mode')} · cell {String(o.cell_id ?? o.cell_number ?? '')}</div>}
          <Preview text={str('new_source') ?? str('source') ?? ''} />
        </div>
      )
    case 'Read':
      return <Path p={str('file_path')} extra={rangeHint(o)} />
    case 'Glob':
    case 'Grep':
      return (
        <div className="space-y-0.5">
          {str('pattern') && <KV k="pattern" v={str('pattern')!} mono />}
          {str('path') && <KV k="path" v={str('path')!} />}
          {str('glob') && <KV k="glob" v={str('glob')!} />}
        </div>
      )
    case 'WebFetch':
      return <div className="space-y-0.5"><KV k="url" v={str('url') ?? ''} /><Wrap text={str('prompt')} /></div>
    case 'WebSearch':
      return <KV k="query" v={str('query') ?? ''} />
    case 'Task':
      return (
        <div className="space-y-0.5">
          <KV k="agent" v={str('subagent_type') ?? ''} />
          <KV k="task" v={str('description') ?? ''} />
          <Wrap text={str('prompt')} />
        </div>
      )
    case 'AskUserQuestion': {
      const questions = Array.isArray(o.questions) ? (o.questions as Array<Record<string, unknown>>) : []
      return (
        <div className="space-y-2">
          {questions.map((q, i) => (
            <div key={i}>
              <div className="text-ctp-text font-medium">{String(q.question ?? '')}</div>
              <ul className="mt-0.5 ml-3 list-disc text-ctp-subtext">
                {(Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : []).map((op, j) => (
                  <li key={j}><span className="text-ctp-text">{String(op.label ?? '')}</span>
                    {op.description ? <span className="text-ctp-overlay"> — {truncate(String(op.description), 90)}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )
    }
    default:
      return <KVList o={o} />
  }
}

// --- small building blocks ---------------------------------------------------

function Path({ p, extra }: { p?: string; extra?: string }) {
  if (!p) return null
  return <div className="font-mono text-[11px] text-ctp-blue break-all">{p}{extra ? <span className="text-ctp-overlay"> {extra}</span> : null}</div>
}

function Preview({ text }: { text: string }) {
  const lines = text.split('\n')
  const shown = lines.slice(0, 8)
  return (
    <pre className="font-mono text-[11px] bg-ctp-crust/60 rounded px-2 py-1 whitespace-pre-wrap">
      {shown.join('\n')}{lines.length > shown.length ? `\n… +${lines.length - shown.length} more lines` : ''}
    </pre>
  )
}

function Replace({ from, to }: { from?: string; to?: string }) {
  return (
    <div className="font-mono text-[11px] space-y-0.5">
      <div className="bg-ctp-red/10 text-ctp-red rounded px-2 py-0.5 whitespace-pre-wrap">- {truncate(from ?? '', 200)}</div>
      <div className="bg-ctp-green/10 text-ctp-green rounded px-2 py-0.5 whitespace-pre-wrap">+ {truncate(to ?? '', 200)}</div>
    </div>
  )
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="text-[11px]">
      <span className="text-ctp-overlay">{k}: </span>
      <span className={`text-ctp-subtext break-all ${mono ? 'font-mono' : ''}`}>{truncate(v, 200)}</span>
    </div>
  )
}

function Wrap({ text }: { text?: string }) {
  if (!text) return null
  return <div className="text-[11px] text-ctp-subtext whitespace-pre-wrap">{truncate(text, 300)}</div>
}

// Tidy fallback: one line per top-level field, values stringified + truncated.
function KVList({ o }: { o: Record<string, unknown> }) {
  const keys = Object.keys(o)
  if (keys.length === 0) return <div className="text-ctp-overlay text-[11px] italic">no arguments</div>
  return (
    <div className="space-y-0.5">
      {keys.map((k) => (
        <KV key={k} v={typeof o[k] === 'string' ? (o[k] as string) : safeJson(o[k])} k={k} />
      ))}
    </div>
  )
}

function rangeHint(o: Record<string, unknown>): string {
  const parts: string[] = []
  if (o.offset != null) parts.push(`from ${o.offset}`)
  if (o.limit != null) parts.push(`${o.limit} lines`)
  return parts.length ? `(${parts.join(', ')})` : ''
}

export function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s }
function safeJson(v: unknown): string { try { return JSON.stringify(v) } catch { return String(v) } }
