import { useMemo } from 'react'
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
// unsafe URLs while keeping benign markup (tables) so pandas output still renders.
//
// The default profile stops script execution, but still permits markup that makes
// the operator's browser issue EXTERNAL requests — `<img src=http://…>`, `<style>`
// / inline `url()` / `@import`, `<link rel=stylesheet>`. From kernel output those
// are a tracking / data-exfil / tailnet-SSRF channel from the authenticated origin.
// The hook below neutralizes them: resource URLs must be inline `data:` (so base64
// images still render), remote CSS is dropped, and anchors get noopener/noreferrer.
const isDataUri = (v: string): boolean => /^\s*data:/i.test(v)
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element
  if (typeof el.getAttribute !== 'function') return
  const tag = el.tagName?.toUpperCase()
  // Resource-loading URL attributes: allow only inline data: URIs; drop anything remote.
  for (const attr of ['src', 'srcset', 'poster', 'background']) {
    const v = el.getAttribute(attr)
    if (v && !isDataUri(v)) el.removeAttribute(attr)
  }
  // SVG resource refs (<image>/<use> href / xlink:href). Keep in-document fragment
  // refs (#id) and data: URIs; drop remote. Anchors (<a href>) are handled below.
  for (const attr of ['href', 'xlink:href']) {
    const v = el.getAttribute(attr)
    if (v && tag !== 'A' && !isDataUri(v) && !v.trimStart().startsWith('#')) el.removeAttribute(attr)
  }
  // Inline CSS that fetches remotely (url()/@import).
  const style = el.getAttribute('style')
  if (style && /url\s*\(|@import/i.test(style)) el.removeAttribute('style')
  // Keep anchor navigation, but block opener/referrer leakage.
  if (tag === 'A' && el.getAttribute('href')) {
    el.setAttribute('rel', 'noopener noreferrer')
    el.setAttribute('target', '_blank')
  }
})

function sanitizeHtml(html: string): string {
  // FORBID <style>/<link>/<base> outright — external CSS + inline stylesheets are the
  // remaining request channel the per-attribute hook can't fully cover.
  return DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'link', 'base'], ADD_ATTR: ['target'] })
}

// Richest-first: prefer HTML/image/svg over plain text; fall back to any text-ish
// bundle (latex/markdown/json) so an output is never rendered blank just because it
// lacks a `text/plain` alternative.
function MimeContent({ data }: { data: Record<string, unknown> }) {
  const html = asText(data['text/html'])
  const svg = asText(data['image/svg+xml'])
  // Sanitizing (DOMPurify parses the whole blob) is memoized so a re-render that
  // doesn't change the output — e.g. a sibling cell ticking — doesn't re-sanitize.
  const cleanHtml = useMemo(() => (html ? sanitizeHtml(html) : ''), [html])
  const cleanSvg = useMemo(() => (svg ? sanitizeHtml(svg) : ''), [svg])
  if (html) {
    // `nb-html` scopes table styling in index.css that restores pandas DataFrame
    // readability (the global reset strips th/td padding + borders).
    return <div className="text-sm nb-html" dangerouslySetInnerHTML={{ __html: cleanHtml }} />
  }
  // Bitmap images (base64-encoded in the mime bundle).
  for (const mime of ['image/png', 'image/jpeg', 'image/gif'] as const) {
    const b64 = data[mime]
    if (typeof b64 === 'string') return <img src={`data:${mime};base64,${b64}`} className="max-w-full" alt="" />
  }
  if (svg) return <div dangerouslySetInnerHTML={{ __html: cleanSvg }} />
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
