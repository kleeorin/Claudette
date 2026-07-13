import { useRef } from 'react'
import { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { history } from '@milkdown/kit/plugin/history'
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react'

// WYSIWYG markdown editor (Milkdown, commonmark + gfm). Rendered for .md files in
// the file editor. Emits markdown on every change; the host (FileEditorView) tracks
// dirty state and handles Cmd/Ctrl-S. The editor ships no theme — content is styled
// via `.milkdown-host` in index.css with the ctp palette.
interface Props {
  initialDoc: string
  readOnly: boolean
  onChange: (markdown: string) => void
}

function Inner({ initialDoc, readOnly, onChange }: Props) {
  // Keep onChange fresh without rebuilding the editor.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, initialDoc)
        ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => !readOnly }))
        ctx.get(listenerCtx).markdownUpdated((_, markdown) => onChangeRef.current(markdown))
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener),
  )

  return <Milkdown />
}

export function MilkdownEditor({ initialDoc, readOnly, onChange }: Props) {
  return (
    <MilkdownProvider>
      <div className="milkdown-host h-full overflow-auto px-5 py-4">
        <Inner initialDoc={initialDoc} readOnly={readOnly} onChange={onChange} />
      </div>
    </MilkdownProvider>
  )
}
