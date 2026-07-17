import { memo, useMemo } from 'react'
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// react-markdown sanitizes hrefs to a safe-protocol allowlist (http(s)/mailto/…),
// which strips our custom `wiki:` scheme to '' before the anchor renders. Let
// wiki: URLs through untouched; everything else keeps the default sanitization.
const wikiUrlTransform = (url: string): string =>
  url.startsWith('wiki:') ? url : defaultUrlTransform(url)

// --- Wikilinks (`[[target]]` / `[[target|alias]]`) -------------------------
// Opt-in (DocView passes `onWikiLink`; ChatView doesn't, so its rendering is
// unchanged). A tiny remark plugin rewrites `[[…]]` inside *text* nodes into
// link nodes with a `wiki:` url — text nodes never live inside code/inlineCode
// (those carry a raw `value`, no children), so fenced code is left alone.
interface MdNode { type: string; value?: string; url?: string; title?: string | null; children?: MdNode[] }
const WIKI_RE = /\[\[([^\][]+)\]\]/g

function splitWiki(value: string): MdNode[] {
  const out: MdNode[] = []
  let last = 0
  for (const m of value.matchAll(WIKI_RE)) {
    const i = m.index ?? 0
    if (i > last) out.push({ type: 'text', value: value.slice(last, i) })
    const [target, alias] = m[1].split('|')
    out.push({ type: 'link', url: `wiki:${target.trim()}`, title: null, children: [{ type: 'text', value: (alias ?? target).trim() }] })
    last = i + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function walkWiki(node: MdNode): void {
  if (!Array.isArray(node.children)) return
  const next: MdNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value?.includes('[[')) next.push(...splitWiki(child.value))
    else { walkWiki(child); next.push(child) }
  }
  node.children = next
}

function remarkWikiLinks() {
  return (tree: MdNode) => walkWiki(tree)
}

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

export const Markdown = memo(function Markdown({
  text, onWikiLink,
}: { text: string; onWikiLink?: (target: string) => void }) {
  // Only enable the wikilink plugin + clickable `wiki:` anchors when a handler is
  // given, so the ChatView code path is untouched (links stay inert there).
  const plugins = useMemo(() => (onWikiLink ? [remarkGfm, remarkWikiLinks] : [remarkGfm]), [onWikiLink])
  const comps = useMemo<Components>(() => {
    if (!onWikiLink) return components
    return {
      ...components,
      a: ({ node, href, children, ...p }) => {
        if (href?.startsWith('wiki:')) {
          const target = href.slice('wiki:'.length)
          return (
            <button
              type="button"
              onClick={() => onWikiLink(target)}
              title={`Open ${target}`}
              className="text-ctp-mauve underline decoration-ctp-mauve/40 hover:decoration-ctp-mauve cursor-pointer"
            >
              {children}
            </button>
          )
        }
        return (
          <a className="text-ctp-blue underline decoration-ctp-blue/40 hover:decoration-ctp-blue cursor-pointer"
            title={href} onClick={(e) => e.preventDefault()} {...p}>{children}</a>
        )
      },
    }
  }, [onWikiLink])

  return (
    <div className="cm-markdown">
      <ReactMarkdown
        remarkPlugins={plugins}
        components={comps}
        urlTransform={onWikiLink ? wikiUrlTransform : undefined}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
