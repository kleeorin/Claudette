import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Crepe } from '@milkdown/crepe'
import { callCommand } from '@milkdown/kit/utils'
import { editorViewCtx, type CmdKey } from '@milkdown/kit/core'
import type { EditorView as ProseView } from '@milkdown/kit/prose/view'
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  wrapInBlockquoteCommand,
  createCodeBlockCommand,
  toggleLinkCommand,
  insertHrCommand,
} from '@milkdown/kit/preset/commonmark'
import { toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/nord-dark.css'
import { useScrollMemory } from '../lib/scrollMemory'
import { findHighlightPlugin, findInDoc, paintFind, type ProseHit } from '../lib/proseSearch'
import { expandReplacement, isInvalidQuery } from '../lib/findMatches'
import type { FindState } from '../lib/useFind'
import { FindBar } from './FindBar'

// WYSIWYG markdown editor — Milkdown "Crepe", the batteries-included build. Crepe
// ships CONTEXTUAL controls (a floating selection toolbar, a slash (/) menu, a block
// drag-handle), but no always-visible toolbar; we add a persistent formatting bar on
// top and drive it through Crepe's underlying editor (`crepe.editor.action`) with the
// commonmark/gfm commands, so its buttons stay in lock-step with the keyboard shortcuts
// and the floating toolbar. Rendered for .md files in the file editor; emits markdown
// on every change so the host (FileEditorView) can track dirty state + handle Ctrl/Cmd-S.
// Crepe brings its own theme (nord-dark); its palette is remapped to the app's ctp
// colors in index.css under `.milkdown-host .milkdown`.
interface Props {
  initialDoc: string
  readOnly: boolean
  onChange: (markdown: string) => void
  scrollKey?: string   // remembers where you were when this file reopens
  find: FindState      // owned by the tab, so Ctrl/Cmd-F doesn't wait on editor focus
}

const NO_HITS: ProseHit[] = []

export function MilkdownEditor({ initialDoc, readOnly, onChange, scrollKey, find }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<Crepe | null>(null)
  // Keep onChange fresh without rebuilding the editor.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Bumped whenever the document changes, to re-run the search against fresh text.
  const [docVersion, setDocVersion] = useState(0)

  // Build the editor once per mount. The parent remounts via `key={path}` when the
  // file changes, so `initialDoc` is effectively mount-time input. `on()` must be
  // wired before `create()`.
  useEffect(() => {
    if (!hostRef.current) return
    const crepe = new Crepe({ root: hostRef.current, defaultValue: initialDoc })
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => { onChangeRef.current(markdown); setDocVersion((v) => v + 1) })
    })
    // Find highlighting rides along as a ProseMirror plugin — Crepe has no find of its
    // own, and decorations leave the document (and so the markdown we save) untouched.
    crepe.editor.use(findHighlightPlugin)
    crepeRef.current = crepe
    // create() is async; if we unmount before it resolves, tear down once it does.
    let destroyed = false
    void crepe.create().then(() => { if (destroyed) void crepe.destroy(); else setDocVersion((v) => v + 1) })
    return () => { destroyed = true; crepeRef.current = null; void crepe.destroy() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The live ProseMirror view, or null before create() resolves / after teardown.
  // Milkdown seeds `editorViewCtx` with an EMPTY OBJECT until the view exists, so a
  // plain null check isn't enough — reaching for `.state` on that placeholder is what
  // an unguarded call gets you.
  const proseView = useCallback((): ProseView | null => {
    try {
      let v: ProseView | undefined
      crepeRef.current?.editor.action((ctx) => { v = ctx.get(editorViewCtx) })
      return v?.state ? v : null
    } catch { return null }   // editor not ready
  }, [])

  const hits = useMemo(() => {
    if (!find.open || !find.query) return NO_HITS
    const view = proseView()
    return view ? findInDoc(view.state.doc, find.query, find.opts) : NO_HITS
    // docVersion is the dependency that matters — the doc itself isn't React state.
  }, [find.open, find.query, find.opts, docVersion, proseView])

  const activeHit = hits.length ? hits[Math.min(find.index, hits.length - 1)] : undefined

  // Repaint the highlights and scroll the current match into view. The DOM node is the
  // reliable scroll target here: ProseMirror positions aren't pixel offsets, and the
  // decoration we just dispatched is exactly the element we want on screen.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    // Nothing to clear until the bar has actually painted something — skip the whole
    // effect on mount rather than pushing a no-op transaction into a fresh editor.
    if (!find.open && !wasOpenRef.current) return
    const view = proseView()
    if (!view) return
    if (!find.open) {
      wasOpenRef.current = false
      view.dispatch(view.state.tr.setMeta(...paintFind([], null)))
      view.focus()
      return
    }
    wasOpenRef.current = true
    find.seekRef.current = false
    view.dispatch(view.state.tr.setMeta(...paintFind(hits, activeHit?.docFrom ?? null)))
    if (activeHit) {
      requestAnimationFrame(() => {
        hostRef.current?.querySelector('.pm-find-match-active')?.scrollIntoView({ block: 'center' })
      })
    }
  }, [find.open, hits, activeHit?.docFrom]) // eslint-disable-line react-hooks/exhaustive-deps

  // Replacements go through the editor's own transactions, so undo works and the
  // markdown listener fires — which keeps the file's dirty ● honest.
  const replaceOne = useCallback(() => {
    const view = proseView()
    if (!view || !activeHit) return
    view.dispatch(view.state.tr.insertText(expandReplacement(find.replacement, activeHit, find.opts), activeHit.docFrom, activeHit.docTo))
  }, [activeHit, find.replacement, find.opts, proseView])

  const replaceAll = useCallback(() => {
    const view = proseView()
    if (!view || !hits.length) return
    const tr = view.state.tr
    // Back to front: an earlier replacement would otherwise shift every position after it.
    for (let i = hits.length - 1; i >= 0; i--) {
      tr.insertText(expandReplacement(find.replacement, hits[i], find.opts), hits[i].docFrom, hits[i].docTo)
    }
    view.dispatch(tr)
    find.setIndex(0)
  }, [hits, find.replacement, find.opts, proseView]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reflect readOnly changes without rebuilding the editor.
  useEffect(() => { crepeRef.current?.setReadonly(readOnly) }, [readOnly])

  // The host is the scroller; remember its offset so reopening the file lands where
  // you left it (create() is async, so the restore keeps re-applying until content
  // exists — see useScrollMemory).
  useScrollMemory(scrollKey ?? null, () => hostRef.current)

  // Dispatch a command against the live editor. Commands act on the editor's CURRENT
  // selection (ProseMirror keeps it even while a button is focused); the buttons'
  // onMouseDown preventDefault keeps that selection from collapsing on click.
  const run = <T,>(key: CmdKey<T>, payload?: T) => {
    try { crepeRef.current?.editor.action(callCommand(key, payload)) } catch { /* editor not ready */ }
  }
  const addLink = () => {
    const href = window.prompt('Link URL')
    if (href) run(toggleLinkCommand.key, { href })
  }

  return (
    <div className="flex flex-col h-full">
      {!readOnly && (
        <div className="shrink-0 flex flex-wrap items-center gap-0.5 px-2 py-1 bg-ctp-mantle border-b border-ctp-surface0">
          <TB title="Bold (Ctrl/Cmd+B)" onClick={() => run(toggleStrongCommand.key)}><b>B</b></TB>
          <TB title="Italic (Ctrl/Cmd+I)" onClick={() => run(toggleEmphasisCommand.key)}><i>I</i></TB>
          <TB title="Strikethrough" onClick={() => run(toggleStrikethroughCommand.key)}><span className="line-through">S</span></TB>
          <TB title="Inline code" onClick={() => run(toggleInlineCodeCommand.key)}><span className="font-mono">{'<>'}</span></TB>
          <Sep />
          <TB title="Heading 1" onClick={() => run(wrapInHeadingCommand.key, 1)}>H1</TB>
          <TB title="Heading 2" onClick={() => run(wrapInHeadingCommand.key, 2)}>H2</TB>
          <TB title="Heading 3" onClick={() => run(wrapInHeadingCommand.key, 3)}>H3</TB>
          <Sep />
          <TB title="Bullet list" onClick={() => run(wrapInBulletListCommand.key)}>•</TB>
          <TB title="Ordered list" onClick={() => run(wrapInOrderedListCommand.key)}>1.</TB>
          <TB title="Quote" onClick={() => run(wrapInBlockquoteCommand.key)}>❝</TB>
          <TB title="Code block" onClick={() => run(createCodeBlockCommand.key)}><span className="font-mono">{'{}'}</span></TB>
          <Sep />
          <TB title="Link" onClick={addLink}>🔗</TB>
          <TB title="Divider" onClick={() => run(insertHrCommand.key)}>―</TB>
          <Sep />
          <TB title="Find & replace (Ctrl/Cmd+F)" onClick={find.openFind}>⌕</TB>
        </div>
      )}
      <FindBar
        find={find}
        count={hits.length}
        invalid={isInvalidQuery(find.query, find.opts)}
        placeholder="Find in document…"
        onReplace={readOnly ? undefined : replaceOne}
        onReplaceAll={readOnly ? undefined : replaceAll}
      />
      <div ref={hostRef} className="milkdown-host flex-1 min-h-0 overflow-auto" />
    </div>
  )
}

// A toolbar button. onMouseDown preventDefault so clicking doesn't blur the editor
// (which would drop the selection the command needs to act on).
function TB({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="min-w-[26px] h-6 px-1.5 flex items-center justify-center rounded text-xs text-ctp-subtext hover:bg-ctp-surface0 hover:text-ctp-text transition-colors"
    >
      {children}
    </button>
  )
}

function Sep() {
  return <span className="mx-0.5 w-px h-4 bg-ctp-surface0" />
}
