import { useEffect, useRef } from 'react'
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/nord-dark.css'

// WYSIWYG markdown editor — Milkdown "Crepe", the batteries-included build. Unlike
// the bare kit, Crepe ships the usual controls: a floating selection toolbar
// (bold/italic/code/link…), a slash (/) menu, a block drag-handle, and link/image/
// table tooling. Rendered for .md files in the file editor; emits markdown on every
// change so the host (FileEditorView) can track dirty state + handle Cmd/Ctrl-S.
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

  return <div ref={hostRef} className="milkdown-host h-full overflow-auto" />
}
