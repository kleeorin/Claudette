import { useEffect, useRef } from 'react'
import { EditorView, lineNumbers, highlightActiveLineGutter, drawSelection } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { unifiedMergeView, getChunks } from '@codemirror/merge'
import { bracketMatching } from '@codemirror/language'
import { editorTheme, editorHighlight } from '../lib/editorTheme'
import { languageForFilename } from '../lib/codeLanguages'

interface Props {
  original: string        // base text on disk (the "before")
  proposed: string        // Claude's version (the "after"); the editable doc
  filename: string        // drives syntax colouring
  onDoc: (text: string) => void         // latest accepted text (proposed minus rejected hunks)
  onAllResolved: (text: string) => void  // every hunk decided (accepted/rejected) → commit
}

// A CodeMirror unified-merge view: renders Claude's proposed change as inline +/-
// hunks INSIDE the file's own editor, each with per-hunk Accept/Reject controls
// (via `mergeControls`). Rejecting a hunk reverts that region to `original` in the
// live doc, so `onDoc` always reports exactly the text the user has accepted — the
// caller hands that back as the permission's updatedInput. Ported styling from
// CodeEditor so the diff looks like the rest of the app.
export function DiffEditor({ original, proposed, filename, onDoc, onAllResolved }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const cbRef = useRef({ onDoc, onAllResolved })
  cbRef.current = { onDoc, onAllResolved }

  useEffect(() => {
    if (!hostRef.current) return
    const lang = languageForFilename(filename)
    // Auto-commit when every hunk has been decided in-editor (accepted or rejected),
    // so acting on the LAST hunk here releases the permission everywhere — no separate
    // "Apply" click needed. `sawChunks` guards against firing on an empty diff; `done`
    // makes it fire once (the view unmounts right after).
    let sawChunks = false
    let done = false
    const view = new EditorView({
      state: EditorState.create({
        doc: proposed,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          drawSelection(),
          bracketMatching(),
          ...(lang ? [lang] : []),
          editorTheme,
          editorHighlight,
          // original = disk text; per-hunk Accept/Reject; strike-through deletions.
          unifiedMergeView({ original, mergeControls: true, gutter: true, syntaxHighlightDeletions: true }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbRef.current.onDoc(u.state.doc.toString())
            const cs = getChunks(u.state)
            const n = cs ? cs.chunks.length : null
            if (n && n > 0) sawChunks = true
            if (n === 0 && sawChunks && !done) {
              done = true
              cbRef.current.onAllResolved(u.state.doc.toString())
            }
          }),
          EditorView.lineWrapping,
        ],
      }),
      parent: hostRef.current,
    })
    // Report the initial (all-hunks-accepted) text once; seed sawChunks from the
    // initial diff so a single-hunk change auto-commits on its first decision.
    cbRef.current.onDoc(view.state.doc.toString())
    const init = getChunks(view.state)
    if (init && init.chunks.length > 0) sawChunks = true
    return () => { view.destroy() }
    // Rebuilt per proposal via the caller's `key` — original/proposed are stable.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={hostRef} className="h-full overflow-auto text-[13px]" />
}
