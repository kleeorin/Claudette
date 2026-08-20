import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
} from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches } from '@codemirror/search'
import { bracketMatching, indentOnInput, foldGutter, foldKeymap } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { editorTheme, editorHighlight } from '../lib/editorTheme'
import { languageForFilename } from '../lib/codeLanguages'
import { useScrollMemory } from '../lib/scrollMemory'
import { searchHighlight, setSearchMatches } from '../lib/searchHighlight'
import { expandReplacement, findMatches, firstMatchFrom, isInvalidQuery, type Match } from '../lib/findMatches'
import type { FindState } from '../lib/useFind'
import { FindBar } from './FindBar'

interface Props {
  initialDoc: string
  filename: string       // drives syntax colouring (languageForFilename)
  readOnly: boolean
  onChange: (text: string) => void
  onSave: () => void
  scrollKey?: string     // remembers where you were when this file reopens
  find: FindState        // owned by the tab, so Ctrl/Cmd-F works before you click in
}

const NO_MATCHES: Match[] = []

// A CodeMirror editor for file editing: syntax-highlighted by filename, editable
// (unless readOnly), with Cmd/Ctrl-S save, undo/redo, find & replace (Cmd/Ctrl-F),
// bracket matching + auto-close, and code folding. Ported from ClaudeMaster.
//
// Find is the app's shared FindBar rather than @codemirror/search's own panel, so the
// query, the option toggles and the keys are identical here, in the diff view, in the
// markdown editor, in the CSV grid and in the notebook. CodeMirror still does the
// painting (searchHighlight) and owns the doc; the bar just says what to look for.
export function CodeEditor({ initialDoc, filename, readOnly, onChange, onSave, scrollKey, find }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Keep callbacks in a ref so the editor is built once, not on every render.
  const cbRef = useRef({ onChange, onSave })
  cbRef.current = { onChange, onSave }

  const findRef = useRef(find)
  findRef.current = find
  // The doc as the search sees it. Only tracked while the bar is open — a mirror of
  // every keystroke into React state would re-render the tab on each character for no
  // benefit when nobody is searching.
  const [doc, setDoc] = useState('')

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
          searchHighlight,
          ...(lang ? [lang] : []),
          editorTheme,
          editorHighlight,
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
          // Highest precedence so Mod-F reaches the app's find bar before any default
          // binding (and before the browser's own find) can claim it.
          Prec.highest(keymap.of([
            { key: 'Mod-f', preventDefault: true, run: () => { findRef.current.openFind(); return true } },
            { key: 'Escape', run: () => { if (!findRef.current.open) return false; findRef.current.closeFind(); return true } },
          ])),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { cbRef.current.onSave(); return true } },
            indentWithTab,
            ...closeBracketsKeymap,
            ...foldKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              cbRef.current.onChange(u.state.doc.toString())
              // Keep the match list honest while typing (including our own replaces).
              if (findRef.current.open) setDoc(u.state.doc.toString())
            }
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

  // Snapshot the doc when the bar opens so the first search sees current text.
  useEffect(() => {
    if (find.open && viewRef.current) setDoc(viewRef.current.state.doc.toString())
  }, [find.open])

  const matches = useMemo(
    () => (find.open && find.query ? findMatches(doc, find.query, find.opts) : NO_MATCHES),
    [find.open, find.query, find.opts, doc],
  )

  // Paint the matches and reveal the current one. A fresh query lands on the first
  // match at or after the cursor rather than at match #1, so searching moves you on
  // from where you are instead of jumping to the top of the file.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (!find.open) {
      view.dispatch({ effects: setSearchMatches.of({ matches: [], activeFrom: null }) })
      // Closing the bar hands the keyboard back to the document — Escape shouldn't
      // leave you typing into nothing.
      if (wasOpenRef.current) { wasOpenRef.current = false; view.focus() }
      return
    }
    wasOpenRef.current = true
    let idx = find.index
    if (find.seekRef.current && matches.length) {
      find.seekRef.current = false
      idx = firstMatchFrom(matches, view.state.selection.main.from)
      if (idx !== find.index) { find.setIndex(idx); return }   // re-runs with the new index
    }
    const active = matches[Math.min(idx, matches.length - 1)]
    view.dispatch({ effects: setSearchMatches.of({ matches, activeFrom: active?.from ?? null }) })
    if (active) {
      view.dispatch({ effects: EditorView.scrollIntoView(active.from, { y: 'center' }) })
    }
  }, [find.open, find.index, matches]) // eslint-disable-line react-hooks/exhaustive-deps

  // Replace via dispatched changes (not a whole-doc rewrite) so undo history, the
  // cursor and the fold state all survive a replace-all on a big file.
  const current = matches[Math.min(find.index, Math.max(0, matches.length - 1))]
  const replaceOne = useCallback(() => {
    const view = viewRef.current
    if (!view || !current) return
    view.dispatch({
      changes: { from: current.from, to: current.to, insert: expandReplacement(find.replacement, current, find.opts) },
    })
    // Stay on the same ordinal: the next match has shifted down into this slot.
    setDoc(view.state.doc.toString())
  }, [current, find.replacement, find.opts])

  const replaceAll = useCallback(() => {
    const view = viewRef.current
    if (!view || !matches.length) return
    view.dispatch({
      changes: matches.map((m) => ({ from: m.from, to: m.to, insert: expandReplacement(find.replacement, m, find.opts) })),
    })
    setDoc(view.state.doc.toString())
    find.setIndex(0)
  }, [matches, find.replacement, find.opts]) // eslint-disable-line react-hooks/exhaustive-deps

  // The host div is the scroller (CodeMirror grows to fit) — remember where the file
  // was left so switching tab/session and back doesn't jump to line 1. Declared after
  // the build effect so the view exists before we restore.
  useScrollMemory(scrollKey ?? null, () => hostRef.current)

  return (
    <div className="flex flex-col h-full min-h-0">
      <FindBar
        find={find}
        count={matches.length}
        invalid={isInvalidQuery(find.query, find.opts)}
        placeholder={`Find in ${filename}…`}
        onReplace={readOnly ? undefined : replaceOne}
        onReplaceAll={readOnly ? undefined : replaceAll}
      />
      <div ref={hostRef} className="flex-1 min-h-0 overflow-auto text-[13px]" />
    </div>
  )
}
