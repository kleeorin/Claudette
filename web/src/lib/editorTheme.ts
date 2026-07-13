import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

// Editor chrome for the notebook cells. Ported verbatim from ClaudeMaster's
// `renderer/lib/editorTheme.ts` (self-contained hex, close to Claudette's dark
// surfaces). Shared by every cell so they look identical.
export const editorTheme = EditorView.theme({
  '&': { backgroundColor: '#181825', color: '#cdd6f4', borderRadius: '4px' },
  '.cm-content': { padding: '8px 4px', fontFamily: '"JetBrains Mono","Fira Code",monospace', fontSize: '13px', caretColor: '#f5e0dc' },
  '.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-cursor-primary': { borderLeftColor: '#f5e0dc', borderLeftWidth: '2px' },
  '.cm-selectionBackground, ::selection': { backgroundColor: '#45475a88 !important' },
  '.cm-activeLine': { backgroundColor: '#1e1e2e66' },
  '.cm-gutters': { backgroundColor: '#181825', borderRight: '1px solid #313244', color: '#585b70', minWidth: '2rem' },
  '.cm-activeLineGutter': { backgroundColor: '#1e1e2e66' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px' },
})

export const editorHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: '#6c7086', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#cba6f7' },
  { tag: [tags.string, tags.special(tags.string)], color: '#a6e3a1' },
  { tag: tags.number, color: '#fab387' },
  { tag: tags.operator, color: '#89dceb' },
  { tag: tags.function(tags.variableName), color: '#89b4fa' },
  { tag: tags.className, color: '#f9e2af' },
  { tag: tags.bool, color: '#fab387' },
  { tag: tags.null, color: '#fab387' },
  { tag: tags.punctuation, color: '#cdd6f4' },
  { tag: tags.self, color: '#f38ba8' },
]))
