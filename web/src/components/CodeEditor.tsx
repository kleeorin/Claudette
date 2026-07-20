import { useEffect, useRef } from 'react'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
} from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { editorTheme, editorHighlight } from '../lib/editorTheme'
import { languageForFilename } from '../lib/codeLanguages'

interface Props {
  initialDoc: string
  filename: string       // drives syntax colouring (languageForFilename)
  readOnly: boolean
  onChange: (text: string) => void
  onSave: () => void
}

// A CodeMirror editor for file editing: syntax-highlighted by filename, editable
// (unless readOnly), with Cmd/Ctrl-S save, undo/redo, find & replace (Cmd/Ctrl-F),
// bracket matching + auto-close, and code folding. Ported from ClaudeMaster.
export function CodeEditor({ initialDoc, filename, readOnly, onChange, onSave }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Keep callbacks in a ref so the editor is built once, not on every render.
  const cbRef = useRef({ onChange, onSave })
  cbRef.current = { onChange, onSave }

  useEffect(() => {
    if (!hostRef.current) return
    const lang = languageForFilename(filename)
    const view = new EditorView({
      state: EditorState.create({
        doc: initialDoc,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          foldGutter(),
          drawSelection(),
          history(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          highlightSelectionMatches(),
          search({ top: true }),
          ...(lang ? [lang] : []),
          editorTheme,
          editorHighlight,
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { cbRef.current.onSave(); return true } },
            indentWithTab,
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbRef.current.onChange(u.state.doc.toString())
          }),
          EditorView.lineWrapping,
        ],
      }),
      parent: hostRef.current,
    })
    viewRef.current = view
    view.focus()
    return () => { view.destroy(); viewRef.current = null }
    // Build once per mounted file; initialDoc/filename are stable per open file.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={hostRef} className="h-full overflow-auto text-[13px]" />
}
