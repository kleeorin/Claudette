import type { NbOutput } from '@claudette/shared'

// Renders one nbformat output dict. Unlike ClaudeMaster's Output (which consumed a
// normalized union), Claudette stores outputs nbformat-native, so we read
// `output_type` and collapse the line-array `text`/`data` values here.

// nbformat stores multi-line strings as arrays of lines; collapse to a string.
function asText(v: unknown): string {
  if (Array.isArray(v)) return v.join('')
  if (typeof v === 'string') return v
  return ''
}
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function MimeContent({ data }: { data: Record<string, unknown> }) {
  const html = asText(data['text/html'])
  if (html) {
    // `nb-html` scopes table styling in index.css that restores pandas DataFrame
    // readability (the global reset strips th/td padding + borders).
    return <div className="text-sm nb-html" dangerouslySetInnerHTML={{ __html: html }} />
  }
  const png = data['image/png']
  if (typeof png === 'string') {
    return <img src={`data:image/png;base64,${png}`} className="max-w-full" alt="" />
  }
  const svg = asText(data['image/svg+xml'])
  if (svg) return <div dangerouslySetInnerHTML={{ __html: svg }} />
  const plain = asText(data['text/plain'])
  if (plain) return <pre className="text-xs text-ctp-text whitespace-pre-wrap font-mono">{plain}</pre>
  return null
}

export function Output({ output }: { output: NbOutput }) {
  switch (output.output_type) {
    case 'stream':
      return (
        <pre className={`text-xs font-mono whitespace-pre-wrap ${output.name === 'stderr' ? 'text-ctp-red' : 'text-ctp-text'}`}>
          {stripAnsi(asText((output as { text?: unknown }).text))}
        </pre>
      )
    case 'execute_result':
    case 'display_data':
      return <MimeContent data={((output as { data?: Record<string, unknown> }).data) ?? {}} />
    case 'error': {
      const e = output as { ename?: string; evalue?: string; traceback?: string[] }
      return (
        <div className="text-xs font-mono text-ctp-red space-y-0.5">
          <div className="font-semibold">{e.ename}: {e.evalue}</div>
          <pre className="whitespace-pre-wrap opacity-80">
            {(e.traceback ?? []).map(stripAnsi).join('\n')}
          </pre>
        </div>
      )
    }
    default:
      return null
  }
}
