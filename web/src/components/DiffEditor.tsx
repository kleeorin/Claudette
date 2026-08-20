import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, drawSelection } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { unifiedMergeView, getChunks } from '@codemirror/merge'
import { bracketMatching } from '@codemirror/language'
import { editorTheme, editorHighlight } from '../lib/editorTheme'
import { languageForFilename } from '../lib/codeLanguages'
import { searchHighlight, setSearchMatches } from '../lib/searchHighlight'
import { findMatches, firstMatchFrom, isInvalidQuery, type Match } from '../lib/findMatches'
import type { FindState } from '../lib/useFind'
import { FindBar } from './FindBar'

interface Props {
  original: string        // base text on disk (the "before")
  proposed: string        // Claude's version (the "after"); the editable doc
  filename: string        // drives syntax colouring
  find: FindState         // shared with the file's own editor, so the query survives the flip
  onDoc: (text: string) => void         // latest accepted text (proposed minus rejected hunks)
  onAllResolved: (text: string) => void  // every hunk decided (accepted/rejected) → commit
}

// A CodeMirror unified-merge view: renders Claude's proposed change as inline +/-
// hunks INSIDE the file's own editor, each with per-hunk Accept/Reject controls
// (via `mergeControls`). Rejecting a hunk reverts that region to `original` in the
// live doc, so `onDoc` always reports exactly the text the user has accepted — the
// caller hands that back as the permission's updatedInput. Ported styling from
// CodeEditor so the diff looks like the rest of the app.
const NO_MATCHES: Match[] = []

export function DiffEditor({ original, proposed, filename, find, onDoc, onAllResolved }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const cbRef = useRef({ onDoc, onAllResolved })
  cbRef.current = { onDoc, onAllResolved }

  // Find only — no replace. This surface exists to DECIDE on a proposed change, and a
  // free-hand rewrite of the hunks here would be answered back as Claude's own edit.
  // Search still earns its place: a change deep in a long file is easier to reach by
  // name than by scrolling.
  const findRef = useRef(find)
  findRef.current = find
  const [doc, setDoc] = useState('')

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
          searchHighlight,
          Prec.highest(keymap.of([
            { key: 'Mod-f', preventDefault: true, run: () => { findRef.current.openFind(); return true } },
            { key: 'Escape', run: () => { if (!findRef.current.open) return false; findRef.current.closeFind(); return true } },
          ])),
          // original = disk text; per-hunk Accept/Reject; strike-through deletions.
          unifiedMergeView({ original, mergeControls: true, gutter: true, syntaxHighlightDeletions: true }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              cbRef.current.onDoc(u.state.doc.toString())
              // Accepting/rejecting a hunk rewrites the doc — re-search against it.
              if (findRef.current.open) setDoc(u.state.doc.toString())
            }
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
    viewRef.current = view
    // Report the initial (all-hunks-accepted) text once; seed sawChunks from the
    // initial diff so a single-hunk change auto-commits on its first decision.
    cbRef.current.onDoc(view.state.doc.toString())
    const init = getChunks(view.state)
    if (init && init.chunks.length > 0) sawChunks = true
    // Open ON the change rather than at line 1: an edit deep in a long file would
    // otherwise land you in untouched code with no hint where it went. We centre the
    // FIRST hunk (later ones are a scroll away). Deferred a frame so CodeMirror has
    // measured the deletion widgets — scrolling before that targets a stale height.
    let raf = 0
    const first = init?.chunks[0]
    if (first) {
      raf = requestAnimationFrame(() => {
        const pos = Math.min(first.fromB, view.state.doc.length)
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
      })
    }
    return () => { if (raf) cancelAnimationFrame(raf); view.destroy(); viewRef.current = null }
    // Rebuilt per proposal via the caller's `key` — original/proposed are stable.
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (find.open && viewRef.current) setDoc(viewRef.current.state.doc.toString())
  }, [find.open])

  const matches = useMemo(
    () => (find.open && find.query ? findMatches(doc, find.query, find.opts) : NO_MATCHES),
    [find.open, find.query, find.opts, doc],
  )

  // Same reveal rule as the code editor: a fresh query starts from the cursor (which
  // sits on the first hunk when the view opens), so the first hit is the one nearest
  // the change you're reviewing.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (!find.open) {
      view.dispatch({ effects: setSearchMatches.of({ matches: [], activeFrom: null }) })
      if (wasOpenRef.current) { wasOpenRef.current = false; view.focus() }
      return
    }
    wasOpenRef.current = true
    let idx = find.index
    if (find.seekRef.current && matches.length) {
      find.seekRef.current = false
      idx = firstMatchFrom(matches, view.state.selection.main.from)
      if (idx !== find.index) { find.setIndex(idx); return }
    }
    const active = matches[Math.min(idx, matches.length - 1)]
    view.dispatch({ effects: setSearchMatches.of({ matches, activeFrom: active?.from ?? null }) })
    if (active) view.dispatch({ effects: EditorView.scrollIntoView(active.from, { y: 'center' }) })
  }, [find.open, find.index, matches]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col h-full min-h-0">
      <FindBar
        find={find}
        count={matches.length}
        invalid={isInvalidQuery(find.query, find.opts)}
        placeholder={`Find in ${filename}…`}
      />
      <div ref={hostRef} className="flex-1 min-h-0 overflow-auto text-[13px]" />
    </div>
  )
}
