import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { FilePreview } from '@claudette/shared'
import { CodeEditor } from './CodeEditor'
import { MilkdownEditor } from './MilkdownEditor'
import { basename } from '../lib/paths'

// A file-editor tab: fetches the file and dispatches by kind — Milkdown (WYSIWYG)
// for markdown, CodeMirror (syntax-highlighted) for other text, an inline viewer
// for images/PDFs. Text/markdown are editable and save to disk (Cmd/Ctrl-S or the
// Save button); the header shows a dirty ● until saved.
interface Props {
  path: string
}

const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p)

export function FileEditorView({ path }: Props) {
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  // Latest editor text + status, in refs so the save callback never goes stale
  // and doesn't force the editors to rebuild on each keystroke. `loadedRef` is the
  // text as last read from / written to disk — dirty is text ≠ loaded, and it's the
  // baseline for the save-time overwrite check.
  const textRef = useRef('')
  const loadedRef = useRef('')
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setDirty(false); dirtyRef.current = false; setSaveErr(null)
    api.fs.read(path).then((p) => {
      if (cancelled) return
      setPreview(p)
      const text = p.kind === 'text' ? p.text : ''
      textRef.current = text
      loadedRef.current = text
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [path])

  // Dirty is a real difference from disk, not "was ever edited" — so Milkdown's
  // initial (re-normalized) emit on load, or typing back to the saved text, doesn't
  // leave a false ● (and a Save that would rewrite normalized bytes).
  const onChange = useCallback((text: string) => {
    textRef.current = text
    const nowDirty = text !== loadedRef.current
    if (nowDirty !== dirtyRef.current) { dirtyRef.current = nowDirty; setDirty(nowDirty) }
  }, [])

  const save = useCallback(async () => {
    if (savingRef.current || !dirtyRef.current) return
    savingRef.current = true; setSaving(true); setSaveErr(null)
    const snapshot = textRef.current
    // Guard against silently clobbering an external change: if disk no longer matches
    // what we loaded (someone edited it) and isn't already our text, confirm first.
    const cur = await api.fs.read(path)
    if (cur.kind === 'text' && cur.text !== loadedRef.current && cur.text !== snapshot) {
      if (!window.confirm('This file changed on disk since you opened it. Overwrite those changes with your version?')) {
        savingRef.current = false; setSaving(false); return
      }
    }
    const r = await api.fs.write(path, snapshot)
    savingRef.current = false; setSaving(false)
    if (r.ok) {
      loadedRef.current = snapshot
      // Only clear dirty if no edits landed during the await — otherwise those
      // keystrokes would be marked saved and lost on close.
      if (textRef.current === snapshot) { dirtyRef.current = false; setDirty(false) }
    } else setSaveErr(r.error)
  }, [path])

  // Container-level Cmd/Ctrl-S (covers Milkdown; CodeEditor also wires it, but save
  // is guarded + dirty-checked so a double fire is a harmless no-op).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save() }
  }

  const name = basename(path)
  const editable = preview?.kind === 'text' && !preview.truncated
  const showSave = preview?.kind === 'text'

  return (
    <div className="flex flex-col h-full bg-ctp-base" onKeyDown={onKeyDown}>
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className="text-xs font-mono text-ctp-text truncate">{name}</span>
        {dirty && <span className="text-ctp-yellow text-xs" title="Unsaved changes">●</span>}
        {preview?.kind === 'text' && preview.truncated && (
          <span className="text-[10px] text-ctp-yellow shrink-0">read-only · truncated (2 MB cap)</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {saveErr && <span className="text-[10px] text-ctp-red truncate max-w-[220px]" title={saveErr}>{saveErr}</span>}
          {showSave && (
            <button
              onClick={() => void save()}
              disabled={!dirty || saving || !editable}
              title={editable ? 'Save (Ctrl/Cmd+S)' : 'Truncated file is read-only'}
              className="text-xs px-3 py-1 rounded-md bg-ctp-accent text-ctp-base font-medium hover:brightness-110 active:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {loading || !preview ? (
          <div className="h-full flex items-center justify-center text-xs text-ctp-overlay">Loading…</div>
        ) : preview.kind === 'image' ? (
          <div className="h-full overflow-auto p-4 flex items-start justify-center">
            <img src={preview.dataUrl} alt={preview.name} className="max-w-full h-auto rounded border border-ctp-surface0" />
          </div>
        ) : preview.kind === 'pdf' ? (
          <iframe src={preview.dataUrl} title={preview.name} className="w-full h-full" />
        ) : preview.kind === 'binary' ? (
          <div className="h-full flex items-center justify-center text-xs text-ctp-overlay">Binary file — no preview.</div>
        ) : preview.kind === 'error' ? (
          <div className="h-full flex items-center justify-center text-xs text-ctp-red px-4 text-center">{preview.message}</div>
        ) : isMarkdown(path) && editable ? (
          <MilkdownEditor key={path} initialDoc={preview.text} readOnly={false} onChange={onChange} />
        ) : (
          <CodeEditor
            key={path}
            initialDoc={preview.text}
            filename={name}
            readOnly={!editable}
            onChange={onChange}
            onSave={() => void save()}
          />
        )}
      </div>
    </div>
  )
}
