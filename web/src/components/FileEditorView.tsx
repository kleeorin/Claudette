import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import type { FilePreview } from '@claudette/shared'
import { CodeEditor } from './CodeEditor'
import { DiffEditor } from './DiffEditor'
import { MilkdownEditor } from './MilkdownEditor'
import { CsvTableView } from './CsvTableView'
import { ConfirmDialog } from './ConfirmDialog'
import { basename } from '../lib/paths'
import { useScrollMemory } from '../lib/scrollMemory'
import { errText } from '../lib/errText'
import { peekBuffer, setBuffer } from '../lib/buffers'
import { useChat } from '../store/chat'
import { applyProposal, filePathOf, isEditTool, isNotebookPath, reconstructDecision } from '../lib/proposals'
import { useFind } from '../lib/useFind'
import { isFindKey } from './FindBar'

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
  const [refreshing, setRefreshing] = useState(false)
  const [confirmRefresh, setConfirmRefresh] = useState(false)
  // Live sync: the file moved on disk while we hold unsaved edits (stale), or was deleted
  // out from under us (gone). Both are BANNERS, never modals — these fire because a
  // background process touched a file, and a dialog that appears while you are typing is
  // the wrong shape for news you did not ask for.
  const [staleOnDisk, setStaleOnDisk] = useState(false)
  const [goneFromDisk, setGoneFromDisk] = useState(false)

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
    setStaleOnDisk(false); setGoneFromDisk(false)
    api.fs.read(path).then((p) => {
      if (cancelled) return
      const disk = p.kind === 'text' ? p.text : ''
      loadedRef.current = disk
      // Edits made earlier and never saved come back with the file — this view is
      // unmounted whenever another tab or session is on screen, so without the buffer
      // a glance elsewhere discarded them. The baseline stays DISK text, so the dirty
      // marker and the save-time overwrite check still measure against reality.
      // peekBuffer takes the fresh disk text and returns nothing when the file moved
      // underneath the edit — so a stale buffer can no longer shadow a changed file.
      const kept = p.kind === 'text' ? peekBuffer(path, disk) : undefined
      const text = kept ?? disk
      textRef.current = text
      dirtyRef.current = text !== disk
      setDirty(text !== disk)
      setPreview(p.kind === 'text' ? { ...p, text } : p)
      setLoading(false)
    }).catch((e) => {
      // `api.fs.read` rejects on a dropped connection or a non-JSON body (a proxy 502,
      // an expired-cookie redirect to HTML). Without this the promise died silently with
      // `loading` still true, and the tab sat on "Loading…" forever with no way back.
      if (cancelled) return
      setSaveErr(errText(e))
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
    setBuffer(path, null, text)
    setReloadKey((k) => k + 1)
  }, [path])

  // ── Reload from disk ────────────────────────────────────────────────────────────
  // The load effect above is keyed on `path` alone, so a file that changes underneath you
  // — a Claude edit, a git checkout, another device, an external editor — stays on screen
  // as it was when the tab opened. Until now the only way back was to close the tab and
  // reopen it. This is that, without the round trip.
  //
  // It re-reads and replaces the WHOLE preview rather than routing through applyText,
  // which only patches `.text` on an existing text preview. That distinction matters: a
  // file can come back with different metadata — `truncated` flipping once it grows past
  // the 2 MB cap is the obvious one — and patching only the text would leave the header
  // claiming the old state while showing new content.
  //
  // The unsaved buffer is dropped explicitly. Refreshing IS the discard, so leaving the
  // buffer would let peekBuffer restore the edits on the next mount and quietly undo what
  // the user just asked for.
  const doRefresh = useCallback(async () => {
    setConfirmRefresh(false)
    setRefreshing(true); setSaveErr(null)
    setStaleOnDisk(false); setGoneFromDisk(false)
    try {
      const p = await api.fs.read(path)
      const disk = p.kind === 'text' ? p.text : ''
      setPreview(p)
      textRef.current = disk
      loadedRef.current = disk
      dirtyRef.current = false; setDirty(false)
      // Third arg is the new baseline. It is unused when the text is null (the entry is
      // deleted), but `base` is REQUIRED rather than defaulted — deliberately, since a
      // defaulted '' could never match a non-empty file and would silently discard a real
      // buffer. Passing `disk` matches applyText and keeps the call honest.
      setBuffer(path, null, disk)
      setReloadKey((k) => k + 1)
    } catch (e) {
      // Same failure surface as the initial load: a dropped connection or a non-JSON body
      // (a proxy 502, an expired-cookie redirect to HTML) rejects here. Show it rather
      // than leaving the button spinning with no explanation.
      setSaveErr(errText(e))
    } finally {
      setRefreshing(false)
    }
  }, [path])

  // --- live sync: follow the file on disk, the way a notebook already does -----------
  //
  // Subscribe while this path is open; the server refcounts, so two tabs on one file are
  // independent. `fs:changed` is broadcast to EVERY socket (the hub does no per-socket
  // filtering, by design), so the path comparison here is load-bearing, not defensive.
  //
  // Three cases, and they are the same three NotebookDocManager.onDiskChange has:
  //   reviewing → do NOTHING. applyDecision writes accepted hunks against `baseText`;
  //     swapping the file underneath decides hunks against a document the user never saw.
  //     The ⟳ button is disabled here for exactly this reason — live sync is the same
  //     hazard arriving through a different door, so it obeys the same rule.
  //   clean     → take disk silently. doRefresh already does the whole job.
  //   dirty     → flag it and let the user choose. Never clobber an unsaved buffer.
  //
  // Reading the REFS rather than `dirty`/`reviewing` state: the subscription is created
  // once per path, so a value captured at subscribe time would be the answer from whenever
  // this file was opened — for the dirty flag specifically, always `false`.
  const reviewingRef = useRef(false)
  const refreshRef = useRef(doRefresh)
  refreshRef.current = doRefresh
  useEffect(() => {
    api.fs.watch(path)
    const offChanged = api.on.fsChanged((p) => {
      if (p !== path) return
      if (reviewingRef.current) return
      // A save of our own comes back byte-identical, so this is a no-op rather than a
      // flicker — no server-side `writing` flag needed. Content comparison also stays
      // correct when someone else's write lands inside the same debounce window, which
      // an mtime check would not.
      if (dirtyRef.current) setStaleOnDisk(true)
      else void refreshRef.current()
    })
    const offRemoved = api.on.fsRemoved((p) => { if (p === path) setGoneFromDisk(true) })
    return () => { offChanged(); offRemoved(); api.fs.unwatch(path) }
  }, [path])

  // Dirty is a real difference from disk, not "was ever edited" — so Milkdown's
  // initial (re-normalized) emit on load, or typing back to the saved text, doesn't
  // leave a false ● (and a Save that would rewrite normalized bytes).
  const onChange = useCallback((text: string) => {
    textRef.current = text
    const nowDirty = text !== loadedRef.current
    if (nowDirty !== dirtyRef.current) { dirtyRef.current = nowDirty; setDirty(nowDirty) }
    // Baseline is the DISK text this edit was made against; peekBuffer refuses to
    // restore onto anything else. survive the unmount a tab/session switch causes
    setBuffer(path, nowDirty ? text : null, loadedRef.current)
  }, [path])

  const save = useCallback(async () => {
    if (savingRef.current || !dirtyRef.current) return
    savingRef.current = true; setSaving(true); setSaveErr(null)
    const snapshot = textRef.current
    // try/finally around the whole thing: a rejected read or write (network drop,
    // non-JSON error body) used to escape with savingRef still true, which both pinned
    // the button on "Saving…" and made every later save() early-return — Ctrl+S silently
    // dead until the tab was remounted, with unsaved edits still in the buffer.
    try {
      // Guard against silently clobbering an external change: if disk no longer matches
      // what we loaded (someone edited it) and isn't already our text, confirm first.
      const cur = await api.fs.read(path)
      if (cur.kind === 'text' && cur.text !== loadedRef.current && cur.text !== snapshot) {
        if (!window.confirm('This file changed on disk since you opened it. Overwrite those changes with your version?')) return
      }
      const r = await api.fs.write(path, snapshot)
      if (r.ok) {
        loadedRef.current = snapshot
        // Only clear dirty if no edits landed during the await — otherwise those
        // keystrokes would be marked saved and lost on close. Same for the buffer:
        // it's dropped only when what's on disk is what the editor holds.
        if (textRef.current === snapshot) { dirtyRef.current = false; setDirty(false); setBuffer(path, null, snapshot) }
      } else setSaveErr(r.error)
    } catch (e) {
      setSaveErr(errText(e))
    } finally {
      savingRef.current = false; setSaving(false)
    }
  }, [path])

  // Find state lives HERE, not in each editor, for two reasons: Ctrl/Cmd-F then works
  // the moment a tab opens (no "click into the grid first" — a container keydown needs
  // no focused editor), and the query survives the file flipping between its editor and
  // the proposal diff below. This view is keyed by path, so each file gets its own.
  const find = useFind()

  // Container-level Cmd/Ctrl-S (covers Milkdown; CodeEditor also wires it, but save
  // is guarded + dirty-checked so a double fire is a harmless no-op) and Cmd/Ctrl-F.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save() }
    else if (isFindKey(e)) { e.preventDefault(); find.openFind() }
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
  // Mirrored into a ref for the live-sync subscription above, which is created once per
  // path and would otherwise read whatever this was when the file was opened.
  reviewingRef.current = reviewing
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

  // Only the active tab of the active session is mounted, so leaving this file (or
  // this session) unmounts the editor. Key its scroll offset so coming back lands where
  // you left off instead of at the top. `reloadKey` is deliberately NOT part of the key:
  // a reload should keep your place too.
  //
  // THE KEY IS PER SESSION, and that is the whole point rather than a detail. Keyed by
  // path alone, two sessions open on the SAME file share one offset: read to line 500 in
  // session A, switch to B and read that file from the top, and B's scrolling overwrites
  // the shared entry — so returning to A drops you at B's position, usually the top. That
  // presents exactly as "switching sessions resets my place", and it gets worse the more
  // sessions you run on one project, which is the normal way this app is used. Two views
  // of one file are two places a human is reading, so they get two offsets.
  // `path` stays in the key so the same file in one session survives tab and file
  // switches; `?? 'none'` keeps a session-less preview (opened outside any session) from
  // colliding with a real one.
  const scrollKey = `file:${sessionId ?? 'none'}:${path}`
  const imgRef = useRef<HTMLDivElement>(null)
  useScrollMemory(preview?.kind === 'image' ? scrollKey : null, () => imgRef.current)

  // A container keydown only fires for events inside its subtree, so the container has
  // to hold focus when the editor it wraps doesn't take any (the CSV grid, and markdown
  // until you click into it). It also has to RECLAIM focus when the body swaps editors
  // — flipping into or out of proposal review unmounts whatever held the keyboard, and
  // without this Ctrl/Cmd-F in the diff would fall through to the browser's own find.
  // Skipped when focus is already inside, or sitting in some other text field — opening
  // a tab shouldn't yank the caret out of the chat box.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (loading) return
    const root = rootRef.current
    if (!root || root.contains(document.activeElement)) return
    const ae = document.activeElement as HTMLElement | null
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return
    root.focus({ preventScroll: true })
  }, [loading, path, reviewing])

  return (
    <div ref={rootRef} tabIndex={-1} className="flex flex-col h-full bg-ctp-base outline-none" onKeyDown={onKeyDown}>
      {/* Header */}
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-ctp-mantle border-b border-ctp-surface0">
        <span className="text-xs font-mono text-ctp-text truncate">{name}</span>
        {dirty && <span className="text-ctp-yellow text-xs" title="Unsaved changes">●</span>}
        {preview?.kind === 'text' && preview.truncated && (
          <span className="text-[10px] text-ctp-yellow shrink-0">read-only · truncated (2 MB cap)</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {saveErr && <span className="text-[10px] text-ctp-red truncate max-w-[220px]" title={saveErr}>{saveErr}</span>}
          {/* Reload from disk. Gated behind a confirm ONLY when there is something to lose —
              a clean file reloads immediately, because a dialog you always dismiss is one you
              stop reading. Disabled mid-review: applyDecision writes the accepted hunks
              against `baseText`, and swapping the file underneath that would decide hunks
              against a document the user never saw. */}
          <button
            onClick={() => (dirty ? setConfirmRefresh(true) : void doRefresh())}
            disabled={refreshing || reviewing}
            title={reviewing ? "Finish reviewing Claude's proposed change first" : 'Reload this file from disk'}
            aria-label="Reload from disk"
            className="text-xs w-7 h-7 flex items-center justify-center rounded-md text-ctp-subtext hover:text-ctp-text hover:bg-ctp-surface0 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            <span className={refreshing ? 'inline-block animate-spin' : undefined} aria-hidden>⟳</span>
          </button>
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

      {/* Live-sync notices. Banners rather than modals, and deliberately not auto-resolved:
          both of these mean "someone else changed the world under you", and the right
          response is always the user's to pick. */}
      {goneFromDisk && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11px] bg-ctp-red/10 border-b border-ctp-red/30 text-ctp-red">
          <span className="flex-1">
            <span className="font-mono">{name}</span> was deleted on disk. Your copy is still here —
            Save to write it back.
          </span>
          <button onClick={() => setGoneFromDisk(false)} className="shrink-0 px-1 hover:brightness-125" aria-label="Dismiss">✕</button>
        </div>
      )}
      {staleOnDisk && !goneFromDisk && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11px] bg-ctp-yellow/10 border-b border-ctp-yellow/30 text-ctp-yellow">
          <span className="flex-1">Changed on disk since you started editing.</span>
          <button
            onClick={() => setConfirmRefresh(true)}
            className="shrink-0 px-2 py-0.5 rounded bg-ctp-yellow/20 hover:bg-ctp-yellow/30 font-medium"
          >Reload…</button>
          <button
            onClick={() => setStaleOnDisk(false)}
            className="shrink-0 px-2 py-0.5 rounded hover:bg-ctp-yellow/15"
            title="Keep editing; your Save will overwrite what is on disk"
          >Keep mine</button>
        </div>
      )}

      {confirmRefresh && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          body={<>Reloading <span className="font-mono text-ctp-text">{name}</span> from disk will discard your unsaved edits to it. This cannot be undone.</>}
          confirmLabel="Discard and reload"
          danger
          onConfirm={() => void doRefresh()}
          onCancel={() => setConfirmRefresh(false)}
        />
      )}

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
            find={find}
            scrollKey={`${scrollKey}#diff`}
            onDoc={(t) => { resultRef.current = t }}
            onAllResolved={(t) => { resultRef.current = t; applyDecision() }}
          />
        ) : loading || !preview ? (
          <div className="h-full flex items-center justify-center text-xs text-ctp-overlay">Loading…</div>
        ) : preview.kind === 'image' ? (
          <div ref={imgRef} className="h-full overflow-auto p-4 flex items-start justify-center">
            <img src={preview.dataUrl} alt={preview.name} className="max-w-full h-auto rounded border border-ctp-surface0" />
          </div>
        ) : preview.kind === 'pdf' ? (
          <iframe src={preview.dataUrl} title={preview.name} className="w-full h-full" />
        ) : preview.kind === 'binary' ? (
          <div className="h-full flex items-center justify-center text-xs text-ctp-overlay">Binary file — no preview.</div>
        ) : preview.kind === 'error' ? (
          <div className="h-full flex items-center justify-center text-xs text-ctp-red px-4 text-center">{preview.message}</div>
        ) : isMarkdown(path) && editable ? (
          <MilkdownEditor key={`${path}#${reloadKey}`} initialDoc={preview.text} readOnly={false} onChange={onChange} scrollKey={scrollKey} find={find} />
        ) : isCsv(path) ? (
          <CsvTableView key={`${path}#${reloadKey}`} initialText={preview.text} filename={name} readOnly={!editable} onChange={onChange} scrollKey={scrollKey} find={find} />
        ) : (
          <CodeEditor
            key={`${path}#${reloadKey}`}
            initialDoc={preview.text}
            filename={name}
            readOnly={!editable}
            onChange={onChange}
            onSave={() => void save()}
            scrollKey={scrollKey}
            find={find}
          />
        )}
      </div>
    </div>
  )
}
