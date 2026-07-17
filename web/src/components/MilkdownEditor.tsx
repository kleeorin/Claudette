import { useEffect, useRef } from 'react'
import { Crepe } from '@milkdown/crepe'
import { callCommand } from '@milkdown/kit/utils'
import type { CmdKey } from '@milkdown/kit/core'
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
}

export function MilkdownEditor({ initialDoc, readOnly, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<Crepe | null>(null)
  // Keep onChange fresh without rebuilding the editor.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Build the editor once per mount. The parent remounts via `key={path}` when the
  // file changes, so `initialDoc` is effectively mount-time input. `on()` must be
  // wired before `create()`.
  useEffect(() => {
    if (!hostRef.current) return
    const crepe = new Crepe({ root: hostRef.current, defaultValue: initialDoc })
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => onChangeRef.current(markdown))
    })
    crepeRef.current = crepe
    // create() is async; if we unmount before it resolves, tear down once it does.
    let destroyed = false
    void crepe.create().then(() => { if (destroyed) void crepe.destroy() })
    return () => { destroyed = true; crepeRef.current = null; void crepe.destroy() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Reflect readOnly changes without rebuilding the editor.
  useEffect(() => { crepeRef.current?.setReadonly(readOnly) }, [readOnly])

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
        </div>
      )}
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
