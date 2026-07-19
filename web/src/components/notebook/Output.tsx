import DOMPurify from 'dompurify'
import { nbText as asText, type NbOutput } from '@claudette/shared'

// Renders one nbformat output dict. Unlike ClaudeMaster's Output (which consumed a
// normalized union), Claudette stores outputs nbformat-native, so we read
// `output_type` and collapse the line-array `text`/`data` values here.

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

// Kernel-produced `text/html` and SVG are attacker-controlled: any library's
// `_repr_html_`, or a hand-crafted `.ipynb` opened from disk, can carry
// `<img onerror>`, `<script>`, `javascript:` URLs, etc. Rendered raw they would
// execute in the app's authenticated origin (full fs/pane/git API) — and a
// sandboxed kernel's HTML would escape confinement through the operator's
// browser. Sanitize before injecting: DOMPurify strips scripts/event handlers/
// unsafe URLs while keeping benign markup (tables, styles) so pandas/plotly
// output still renders. DOMPurify's default profile covers HTML, SVG and MathML.
function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html)
}

// Richest-first: prefer HTML/image/svg over plain text; fall back to any text-ish
// bundle (latex/markdown/json) so an output is never rendered blank just because it
// lacks a `text/plain` alternative.
function MimeContent({ data }: { data: Record<string, unknown> }) {
  const html = asText(data['text/html'])
  if (html) {
    // `nb-html` scopes table styling in index.css that restores pandas DataFrame
    // readability (the global reset strips th/td padding + borders).
    return <div className="text-sm nb-html" dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />
  }
  // Bitmap images (base64-encoded in the mime bundle).
  for (const mime of ['image/png', 'image/jpeg', 'image/gif'] as const) {
    const b64 = data[mime]
    if (typeof b64 === 'string') return <img src={`data:${mime};base64,${b64}`} className="max-w-full" alt="" />
  }
  const svg = asText(data['image/svg+xml'])
  if (svg) return <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(svg) }} />
  const plain = asText(data['text/plain'])
  if (plain) return <pre className="text-xs text-ctp-text whitespace-pre-wrap font-mono">{plain}</pre>
  // Text-ish fallbacks with no text/plain alternative (LaTeX from Math/SymPy,
  // markdown, JSON/vendor bundles like Plotly) — show the source instead of nothing.
  const latex = asText(data['text/latex'])
  if (latex) return <pre className="text-xs text-ctp-text whitespace-pre-wrap font-mono">{latex}</pre>
  const md = asText(data['text/markdown'])
  if (md) return <pre className="text-xs text-ctp-text whitespace-pre-wrap font-mono">{md}</pre>
  const jsonKey = Object.keys(data).find((k) => k === 'application/json' || k.startsWith('application/'))
  if (jsonKey) {
    const v = data[jsonKey]
    const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    return <pre className="text-xs text-ctp-overlay whitespace-pre-wrap font-mono">{text}</pre>
  }
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
