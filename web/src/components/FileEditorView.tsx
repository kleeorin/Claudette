import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import type { FilePreview } from '@claudette/shared'
import { CodeEditor } from './CodeEditor'
import { DiffEditor } from './DiffEditor'
import { MilkdownEditor } from './MilkdownEditor'
import { CsvTableView } from './CsvTableView'
import { basename } from '../lib/paths'
import { useChat } from '../store/chat'
import { applyProposal, filePathOf, isEditTool, isNotebookPath, reconstructDecision } from '../lib/proposals'

// A file-editor tab: fetches the file and dispatches by kind — Milkdown (WYSIWYG)
// for markdown, CodeMirror (syntax-highlighted) for other text, an inline viewer
// for images/PDFs. Text/markdown are editable and save to disk (Cmd/Ctrl-S or the
// Save button); the header shows a dirty ● until saved.
//
// When Claude has a pending Edit/MultiEdit/Write for THIS file (a permission this
// session is waiting on), the editor flips into a review mode: the change renders
// as an inline +/- diff (DiffEditor) with per-hunk Accept/Reject, and only the
// hunks the user keeps land on disk — the whole flow rides the permission prompt.
interface Props {
  path: string
  sessionId?: string   // the session whose pending edit-permission this tab reviews
}

const isMarkdown = (p: string) => /\.(md|markdown|mdx)$/i.test(p)
const isCsv = (p: string) => /\.(csv|tsv)$/i.test(p)

export function FileEditorView({ path, sessionId }: Props) {
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  // Bumped to remount the editor with fresh disk content — e.g. after Claude's
  // proposal is applied, so the view shows the new text live (not the stale load).
  const [reloadKey, setReloadKey] = useState(0)

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

  // Load fresh disk text into the editor (new baseline, clean, remounted). Used to
  // reflect an applied proposal live.
  const applyText = useCallback((text: string) => {
    setPreview((prev) => (prev && prev.kind === 'text' ? { ...prev, text } : prev))
    textRef.current = text
    loadedRef.current = text
    dirtyRef.current = false; setDirty(false)
    setReloadKey((k) => k + 1)
  }, [])

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

  // --- inline proposal review -------------------------------------------------
  const { pendingFor, respond } = useChat()
  const pending = sessionId ? pendingFor(sessionId) : undefined
  const proposal =
    pending && isEditTool(pending.toolName) && !isNotebookPath(path) && filePathOf(pending.input) === path
      ? pending
      : undefined

  // The authoritative "before" text = the file as it is on disk RIGHT NOW (Claude
  // edits disk, not our buffer). Re-read when a proposal appears — or after the user
  // saves pending edits — so the diff is against current bytes.
  const [baseText, setBaseText] = useState<string | null>(null)
  useEffect(() => {
    if (!proposal) { setBaseText(null); return }
    let cancelled = false
    api.fs.read(path).then((p) => { if (!cancelled) setBaseText(p.kind === 'text' ? p.text : '') })
    return () => { cancelled = true }
  }, [proposal?.requestId, dirty, path])

  const applied = useMemo(
    () => (proposal && baseText != null ? applyProposal(baseText, proposal.toolName, proposal.input) : null),
    [proposal?.requestId, baseText], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Latest accepted text from the diff view (proposed minus rejected hunks).
  const resultRef = useRef('')
  // Set when we answer the permission from HERE (apply/deny) — so the resolve effect
  // knows the editor already reflects the outcome and skips its disk poll.
  const handledRef = useRef(false)
  const applyDecision = useCallback(() => {
    if (!proposal || !sessionId || baseText == null) return
    const decision = reconstructDecision(proposal.toolName, proposal.input, baseText, resultRef.current)
    // Resolve the permission AND swap the editor to the accepted text at once, so the
    // change is live here the instant you apply — no waiting on the chat prompt, no
    // stale view. (The CLI writes the same bytes to disk right after.)
    handledRef.current = true
    if (decision.behavior === 'allow') applyText(resultRef.current)
    respond(sessionId, proposal.requestId, decision)
  }, [proposal, sessionId, baseText, respond, applyText])
  const denyDecision = useCallback(() => {
    if (!proposal || !sessionId) return
    handledRef.current = true   // editor stays on the current (unchanged) file
    respond(sessionId, proposal.requestId, { behavior: 'deny', message: 'Rejected by user' })
  }, [proposal, sessionId, respond])

  // Review mode is live when we have a proposal we could cleanly apply as a diff.
  // A dirty buffer blocks it (applying would clobber unsaved edits) until saved;
  // an un-applyable proposal (a match went missing) falls through to the plain
  // permission card in the chat.
  const canReview = !!proposal && applied?.ok === true
  const reviewing = canReview && !dirty && baseText != null   // diff view is live
  const reviewBlocked = canReview && dirty                    // save first to review

  // When a proposal we were reviewing resolves from ELSEWHERE — Allowed/Denied on the
  // chat card, or auto-answered — pull the file fresh from disk so the editor reflects
  // what landed (an apply/deny from here already updated it: handledRef). We poll
  // because the CLI writes the file a moment AFTER the permission is answered; stop as
  // soon as the bytes change (or after a short window for a deny / no-op).
  const reviewedRef = useRef<{ base: string } | null>(null)
  useEffect(() => {
    if (reviewing && baseText != null) { reviewedRef.current = { base: baseText }; return }
    const was = reviewedRef.current
    if (!was) return
    reviewedRef.current = null
    if (handledRef.current) { handledRef.current = false; return }  // answered here — already reflected
    let cancelled = false
    let tries = 0
    const poll = async () => {
      if (cancelled) return
      const p = await api.fs.read(path)
      const text = p.kind === 'text' ? p.text : null
      if (text != null && (text !== was.base || tries >= 15)) { applyText(text); return }
      tries++
      setTimeout(() => void poll(), 200)
    }
    void poll()
    return () => { cancelled = true }
  }, [reviewing]) // eslint-disable-line react-hooks/exhaustive-deps

  const name = basename(path)
  const editable = preview?.kind === 'text' && !preview.truncated
  const showSave = preview?.kind === 'text' && !reviewing

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

      {/* Proposal review bar — Claude's pending Edit/MultiEdit/Write for this file */}
      {reviewing && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-ctp-blue/10 border-b border-ctp-blue/30">
          <span className="text-[11px] text-ctp-blue font-medium">
            ✎ Claude proposes changes — accept/reject each hunk (deciding them all applies), or apply now
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={applyDecision}
              title="Write the accepted hunks to disk"
              className="text-xs px-3 py-1 rounded-md bg-ctp-green/80 hover:bg-ctp-green text-ctp-base font-medium transition"
            >
              Apply accepted
            </button>
            <button
              onClick={denyDecision}
              title="Reject the whole change"
              className="text-xs px-3 py-1 rounded-md bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-subtext transition"
            >
              Reject all
            </button>
          </div>
        </div>
      )}
      {reviewBlocked && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-ctp-yellow/10 border-b border-ctp-yellow/30">
          <span className="text-[11px] text-ctp-yellow">
            Claude wants to edit this file — save or discard your unsaved edits to review the change.
          </span>
          <button
            onClick={denyDecision}
            className="ml-auto text-xs px-3 py-1 rounded-md bg-ctp-surface0 hover:bg-ctp-surface1 text-ctp-subtext transition"
          >
            Reject
          </button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 min-h-0">
        {reviewing && baseText != null && applied ? (
          <DiffEditor
            key={proposal!.requestId}
            original={baseText}
            proposed={applied.proposed}
            filename={name}
            onDoc={(t) => { resultRef.current = t }}
            onAllResolved={(t) => { resultRef.current = t; applyDecision() }}
          />
        ) : loading || !preview ? (
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
          <MilkdownEditor key={`${path}#${reloadKey}`} initialDoc={preview.text} readOnly={false} onChange={onChange} />
        ) : isCsv(path) ? (
          <CsvTableView key={`${path}#${reloadKey}`} initialText={preview.text} filename={name} readOnly={!editable} onChange={onChange} />
        ) : (
          <CodeEditor
            key={`${path}#${reloadKey}`}
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
