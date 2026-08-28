// One set of file/folder glyphs, DRAWN rather than typed.
//
// These were emoji — 📁 / 📄 / 📓 — and an emoji is rendered by whichever emoji font the
// platform happens to ship. On this host 📁 comes out a desaturated manila that sits close
// enough to 📄's white page that a folder does not read as a folder at a glance, which is
// the entire job of the icon. Nothing in the app could fix that: the colour of an emoji is
// not addressable from CSS.
//
// An inline SVG inherits `currentColor`, so the colour becomes a theme token like every
// other colour in the app, and it renders identically on every platform.
//
// ── WHY THE FOLDER IS SOLID AND THE PAGES ARE OUTLINES ──────────────────────────────
// Colour alone is a weak signal at 16px, and it is the signal that fails first — on a
// hover row, for a colour-blind reader, or in a future light theme. So the folder differs
// in WEIGHT as well as hue: a solid yellow block against two thin outlined pages. That
// distinction survives losing the colour entirely, which is the test an icon should pass.
// It also means nothing here has to knock a shape out in the background colour — a
// knockout hard-codes `base` and quietly goes wrong the moment the glyph sits on `mantle`
// or a hover fill, which is most of the places these are actually used.
export type FileKind = 'folder' | 'notebook' | 'file'

export function fileKind(isDir: boolean, isNotebook: boolean): FileKind {
  return isDir ? 'folder' : isNotebook ? 'notebook' : 'file'
}

// Colour lives HERE, not at the call sites: several components render these, and a
// per-call className is several chances for the folder yellow to drift into four slightly
// different yellows. `className` is still accepted for layout, and an explicit text-* in
// it wins because it comes last.
const TONE: Record<FileKind, string> = {
  folder:   'text-ctp-yellow',
  notebook: 'text-ctp-peach',
  file:     'text-ctp-overlay',
}

export function FileIcon({ kind, className = '' }: { kind: FileKind; className?: string }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 16 16" aria-hidden
      className={`shrink-0 ${TONE[kind]} ${className}`}
    >
      {kind === 'folder' ? (
        // Tab and body are one path so there is no seam between them at any zoom.
        <path
          fill="currentColor"
          d="M1.5 4A1.5 1.5 0 0 1 3 2.5h2.9c.4 0 .78.16 1.06.44l1.06 1.06H13A1.5 1.5 0 0 1 14.5 5.5v7A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5V4Z"
        />
      ) : (
        <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round">
          {/* Page + folded corner, shared by both file kinds so they stay a family. */}
          <path d="M4.25 2.15h4.6l3.4 3.4v8.3a.9.9 0 0 1-.9.9h-7.1a.9.9 0 0 1-.9-.9V3.05a.9.9 0 0 1 .9-.9Z" />
          <path d="M8.85 2.15v3.4h3.4" />
          {kind === 'notebook' && (
            // Cell bars — the one mark that separates a notebook from a plain file without
            // changing the silhouette, so the two still read as the same family.
            <path d="M5.9 8.3h4.2M5.9 10.6h4.2" />
          )}
        </g>
      )}
    </svg>
  )
}
