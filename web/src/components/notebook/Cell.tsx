import { useEffect, useRef, useState } from 'react'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import type { NbCell } from '@claudette/shared'
import { editorTheme, editorHighlight } from '../../lib/editorTheme'
import { cellSearch } from '../../lib/cellSearch'
import { Markdown } from '../Markdown'
import { Output } from './Output'

interface Props {
  cell: NbCell
  index: number
  selected: boolean
  running: boolean
  locked: boolean          // any lock held on this cell (human is editing / pinned it)
  pinned: boolean          // a sticky 'pin' lock
  onSelect: () => void
  onCodeChange: (code: string) => void
  onEditorFocus: () => void
  onEditorBlur: () => void
  onTogglePin: () => void
  onRun: () => void           // Ctrl/Cmd+Enter — run in place
  onRunAdvance: () => void    // Shift+Enter — run, then move to next cell
  onEscape: () => void        // leave the editor (enter command mode)
  onInsertBelow: () => void   // Alt+Enter — run and insert a cell below
  onMoveUp: () => void
  onMoveDown: () => void
  onToggleType: () => void
  onRemove: () => void
  onDuplicate: () => void
  onReorder: (fromIndex: number) => void
  // Register this cell's editor so the notebook find bar can highlight + scroll to
  // matches inside it (null on unmount).
  registerView: (id: string, view: EditorView | null) => void
  // Markdown rendering (Jupyter-style): a markdown cell shows its RENDERED output
  // unless it's being edited. `rendered` is driven by NotebookView (it owns which
  // markdown cells are in edit mode); double-click / Enter begins editing.
  rendered: boolean
  onBeginEdit: () => void
  // Heading-level collapse: a markdown heading cell (`# …`) can fold the cells
  // beneath it (down to the next same-or-higher heading). NotebookView computes it.
  collapsible: boolean        // this cell is a markdown heading
  collapsed: boolean
  hiddenCount: number         // cells folded under it while collapsed
  onToggleCollapse: () => void
}

// How long after the last keystroke we commit the buffer to the server (an
// `editCell` op). Per-keystroke ops would spam the doc + clear outputs constantly;
// we also flush on blur so nothing is lost.
const COMMIT_DEBOUNCE_MS = 500

export function Cell(props: Props) {
  const { cell, index, selected, running, locked, pinned, rendered, collapsible, collapsed, hiddenCount, onSelect, onMoveUp, onMoveDown, onToggleType, onRemove, onDuplicate, onReorder, onTogglePin, onBeginEdit, onToggleCollapse } = props
  const editorRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const cbRef = useRef(props)
  cbRef.current = props
  // True while this editor holds focus — the local buffer is then authoritative and
  // we must NOT let an incoming server update (e.g. our own echoed edit arriving
  // late) clobber what the user is typing. This is the per-cell reconcile guard.
  const focusedRef = useRef(false)
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isCode = cell.cellType === 'code'
  const isMarkdown = cell.cellType === 'markdown'
  // A markdown cell shows the CodeMirror editor only while being edited; otherwise
  // its rendered output. Code/raw cells always show the editor.
  const showEditor = !isMarkdown || !rendered
  const [outputCollapsed, setOutputCollapsed] = useState(false)
  const outputs = cell.outputs ?? []

  const commit = (code: string) => cbRef.current.onCodeChange(code)
  const scheduleCommit = (code: string) => {
    if (commitTimer.current) clearTimeout(commitTimer.current)
    commitTimer.current = setTimeout(() => commit(code), COMMIT_DEBOUNCE_MS)
  }
  const flushCommit = (code: string) => {
    if (commitTimer.current) { clearTimeout(commitTimer.current); commitTimer.current = null }
    commit(code)
  }

  useEffect(() => {
    if (!editorRef.current || !showEditor) return
    const lang: Extension[] = cell.cellType === 'markdown' ? [markdown()] : cell.cellType === 'code' ? [python()] : []
    // For markdown, running/leaving blurs the editor first — the blur handler is the
    // single "exit edit" path (commits the buffer, then NotebookView re-renders it).
    const leave = (v: EditorView) => { if (isMarkdown) v.contentDOM.blur() }
    const runKeys = [
      { key: 'Shift-Enter', run: (v: EditorView) => { leave(v); cbRef.current.onRunAdvance(); return true } },
      { key: 'Mod-Enter', run: (v: EditorView) => { leave(v); cbRef.current.onRun(); return true } },
      { key: 'Alt-Enter', run: () => { cbRef.current.onInsertBelow(); return true } },
      { key: 'Escape', run: (v: EditorView) => { v.contentDOM.blur(); cbRef.current.onEscape(); return true } },
    ]
    const view = new EditorView({
      state: EditorState.create({
        doc: cell.source,
        extensions: [
          lineNumbers(),
          ...lang,
          editorTheme,
          editorHighlight,
          cellSearch,
          keymap.of([...runKeys, indentWithTab, ...defaultKeymap]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) scheduleCommit(u.state.doc.toString())
          }),
          EditorView.domEventHandlers({
            focus: () => { focusedRef.current = true; cbRef.current.onEditorFocus() },
            blur: (_e, v) => {
              focusedRef.current = false
              flushCommit(v.state.doc.toString())   // commit before the lock releases
              cbRef.current.onEditorBlur()
            },
          }),
          EditorView.lineWrapping,
        ],
      }),
      parent: editorRef.current,
    })
    viewRef.current = view
    cbRef.current.registerView(cell.id, view)
    return () => { cbRef.current.registerView(cell.id, null); view.destroy(); viewRef.current = null }
  }, [cell.id, cell.cellType, showEditor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Push EXTERNAL source changes (a Claude edit, a reload) into the built editor —
  // but never while the user is typing here (focusedRef), and only when the text
  // actually differs, so we never clobber the active buffer.
  useEffect(() => {
    const view = viewRef.current
    if (!view || focusedRef.current) return
    if (view.state.doc.toString() === cell.source) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: cell.source } })
  }, [cell.source])

  const label = isCode ? `[${running ? '*' : (cell.executionCount ?? ' ')}]:` : isMarkdown ? 'md' : 'raw'
  // A rendered markdown cell wears no editor chrome (Jupyter-like) — just a hover/
  // selected tint; the editor and code cells keep their border.
  const borderClass = running ? 'border border-ctp-yellow rounded'
    : locked ? 'border border-ctp-mauve/70 rounded'
    : showEditor ? 'border border-ctp-surface1 focus-within:border-ctp-accent rounded'
    : 'border border-transparent rounded hover:bg-ctp-surface0/30'

  return (
    <div
      className={`group flex gap-2 rounded ${selected ? 'ring-1 ring-ctp-accent/50' : ''}`}
      onMouseDown={onSelect}
      onFocus={onSelect}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
      onDrop={(e) => {
        const from = Number(e.dataTransfer.getData('application/x-cell-index'))
        if (!Number.isNaN(from)) { e.preventDefault(); onReorder(from) }
      }}
    >
      {/* Gutter: collapse caret (heading cells) / execution label + lock badge + drag handle */}
      <div
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-cell-index', String(index)) }}
        title="Drag to reorder"
        className="w-12 shrink-0 text-right pt-1.5 text-xs text-ctp-overlay font-mono select-none cursor-grab active:cursor-grabbing"
      >
        {collapsible ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleCollapse() }}
            title={collapsed ? 'Expand section' : 'Collapse section'}
            className="text-ctp-overlay hover:text-ctp-text px-0.5"
          >
            {collapsed ? '▸' : '▾'}
          </button>
        ) : label}
        {locked && <span title={pinned ? 'Pinned (locked for Claude)' : 'You are editing this cell'} className="ml-1 text-ctp-mauve">{pinned ? '🔒' : '✎'}</span>}
      </div>

      <div className="flex-1 min-w-0 space-y-1">
        <div data-cell-id={cell.id} className={`transition-colors ${borderClass}`}>
          {showEditor ? (
            <div ref={editorRef} />
          ) : cell.source.trim() ? (
            <div
              onDoubleClick={onBeginEdit}
              title="Double-click to edit"
              className="px-3 py-1.5 text-[13px] text-ctp-text cursor-text"
            >
              <Markdown text={cell.source} />
            </div>
          ) : (
            <button onClick={onBeginEdit} className="w-full text-left px-3 py-2 text-xs text-ctp-overlay italic hover:text-ctp-subtext">
              Empty markdown cell — double-click to edit
            </button>
          )}
        </div>

        {/* Collapsed-section hint: how many cells are folded away below this heading. */}
        {collapsed && hiddenCount > 0 && (
          <button
            onClick={onToggleCollapse}
            className="text-[10px] text-ctp-overlay hover:text-ctp-text pl-3"
            title="Expand section"
          >
            ⋯ {hiddenCount} cell{hiddenCount > 1 ? 's' : ''} hidden
          </button>
        )}

        {isCode && outputs.length > 0 && (
          <div className="flex gap-1.5">
            <button
              onClick={() => setOutputCollapsed((v) => !v)}
              title={outputCollapsed ? 'Show output' : 'Hide output (click this bar)'}
              aria-label={outputCollapsed ? 'Show output' : 'Hide output'}
              className="shrink-0 w-2.5 self-stretch rounded-sm bg-ctp-surface1 hover:bg-ctp-accent/70 transition-colors"
            />
            {outputCollapsed ? (
              <button onClick={() => setOutputCollapsed(false)} className="text-[10px] text-ctp-overlay hover:text-ctp-text py-0.5">
                {outputs.length} output{outputs.length > 1 ? 's' : ''} hidden — show
              </button>
            ) : (
              <div className="min-w-0 flex-1 space-y-1 pb-1 max-h-96 overflow-auto">
                {outputs.map((o, i) => <Output key={i} output={o} />)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Per-cell actions — appear on hover */}
      <div className="w-5 shrink-0 self-start mt-1.5 flex flex-col items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-ctp-overlay">
        <CellBtn onClick={onTogglePin} title={pinned ? 'Unpin (allow Claude to edit)' : 'Pin (lock for Claude)'} active={pinned}>{pinned ? '🔒' : '🔓'}</CellBtn>
        <CellBtn onClick={onMoveUp} title="Move up">↑</CellBtn>
        <CellBtn onClick={onMoveDown} title="Move down">↓</CellBtn>
        <CellBtn onClick={onToggleType} title={isCode ? 'Convert to markdown' : 'Convert to code'}>{isCode ? 'M' : '{}'}</CellBtn>
        <CellBtn onClick={onDuplicate} title="Duplicate cell">⧉</CellBtn>
        <CellBtn onClick={onRemove} title="Delete cell" danger>✕</CellBtn>
      </div>
    </div>
  )
}

function CellBtn({ children, onClick, title, danger, active }: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean; active?: boolean }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={title}
      className={`text-[10px] leading-none px-0.5 py-0.5 rounded hover:bg-ctp-surface0 ${active ? 'text-ctp-mauve' : ''} ${danger ? 'hover:text-ctp-red' : 'hover:text-ctp-text'}`}
    >
      {children}
    </button>
  )
}
