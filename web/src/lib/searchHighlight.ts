import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import { StateField, StateEffect } from '@codemirror/state'

// Find-bar highlighting for every CodeMirror surface in the app — a file's code
// editor, the diff review, and each notebook cell. The owner of the search (which may
// span MANY editors, as in the notebook) computes the match list and pushes the slice
// belonging to each view in here; this just paints them, marking the globally-current
// one distinctly.
//
// Deliberately not @codemirror/search: that package's highlighting is bound to its own
// panel and to one document, and a single logical search here can cover a hundred
// independent cell editors driven by one shared bar.

export interface HighlightRange { from: number; to: number }

// Replace a view's highlighted matches. `activeFrom` is the start offset of the
// globally-current match when it lives in THIS view, else null.
export const setSearchMatches = StateEffect.define<{ matches: HighlightRange[]; activeFrom: number | null }>()

const matchMark = Decoration.mark({ class: 'cm-find-match' })
const activeMark = Decoration.mark({ class: 'cm-find-match cm-find-match-active' })

const searchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setSearchMatches)) {
        const ranges = e.value.matches.map((m) =>
          (m.from === e.value.activeFrom ? activeMark : matchMark).range(m.from, m.to))
        deco = Decoration.set(ranges, true)
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

const searchTheme = EditorView.baseTheme({
  '.cm-find-match': { backgroundColor: 'rgba(249, 226, 175, 0.28)', borderRadius: '2px' },
  '.cm-find-match-active': { backgroundColor: 'rgba(250, 179, 135, 0.65)', outline: '1px solid rgba(250, 179, 135, 0.9)' },
})

export const searchHighlight = [searchField, searchTheme]

/** Class of the currently-selected match — for `scrollIntoView` on the DOM node. */
export const ACTIVE_MATCH_CLASS = 'cm-find-match-active'
