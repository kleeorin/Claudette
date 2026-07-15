import { EditorView, Decoration, type DecorationSet } from '@codemirror/view'
import { StateField, StateEffect } from '@codemirror/state'

// Per-cell search highlighting for the notebook find bar. The NotebookView owns the
// query and the global match list; it pushes each cell's matches into that cell's
// editor via `setCellMatches`, which paints every occurrence and the currently-
// selected one distinctly. Kept a plain decoration field (not @codemirror/search)
// so a single logical search can span many independent cell editors.

export interface CellMatch { from: number; to: number }

// Replace a cell's highlighted matches. `activeFrom` is the start offset of the
// globally-current match when it lives in THIS cell, else null.
export const setCellMatches = StateEffect.define<{ matches: CellMatch[]; activeFrom: number | null }>()

const matchMark = Decoration.mark({ class: 'cm-nb-match' })
const activeMark = Decoration.mark({ class: 'cm-nb-match cm-nb-match-active' })

const cellSearchField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setCellMatches)) {
        const ranges = e.value.matches.map((m) =>
          (m.from === e.value.activeFrom ? activeMark : matchMark).range(m.from, m.to))
        deco = Decoration.set(ranges, true)
      }
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

const cellSearchTheme = EditorView.baseTheme({
  '.cm-nb-match': { backgroundColor: 'rgba(249, 226, 175, 0.28)', borderRadius: '2px' },
  '.cm-nb-match-active': { backgroundColor: 'rgba(250, 179, 135, 0.65)', outline: '1px solid rgba(250, 179, 135, 0.9)' },
})

export const cellSearch = [cellSearchField, cellSearchTheme]
