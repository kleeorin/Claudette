// FILES DOCK MULTI-SELECT — can a selection act on something you cannot see?
//
//   CLAUDETTE_JSDOM=/tmp/qa-deps/node_modules/jsdom/lib/api.js \
//     npx tsx scratchpad/file-multiselect-guard.mts
//
// GROUP C: no browser, no server, no ports. Renders the REAL FileManager into jsdom via
// react-dom and drives real clicks at it. Second file to use that seam (after
// sandbox-chip-picker-guard); see dom-env.mts.
//
// ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────────────
// The action on the end of this feature is DELETE and it is irreversible. Multi-select
// stores NAMES, and a bare name is ambiguous the moment the listing changes underneath it:
// the same name exists in the next folder, and a name hidden by the Hidden filter is still
// a name. FileManager closes both by construction — `selected` is derived as
// `sel.dir === dir ? visible.filter(...) : []`, so it can only ever contain rows that are
// on screen right now. [1a] and [1b] are that property, tested from the outside.
//
// ── WHAT A RED MEANS ─────────────────────────────────────────────────────────────────
// [1a] red → a row the Hidden filter has taken off screen is still in the acted-on set. The
//            user sees "1 selected", presses Delete, and loses two files.
// [1b] red → a selection made in one folder re-bound to same-named rows in another. This is
//            the one that deletes the wrong file with the right name, and the fixture puts
//            `beta.txt` in BOTH folders precisely so that a name-only implementation cannot
//            pass by accident.
// [2]  red → a batch stopped at the first failure, or swallowed it. With N items "one of
//            them failed" is the normal outcome; a loop that aborts leaves the rest undone
//            with nothing on screen saying so.
// [4]  red → ordinary single-file use broke while multi-select was added. ★ These matter
//            as much as the rest: a selection model that never selects anything passes
//            every [1] assertion perfectly.
//
// ── WHAT IS MEASURED, AND WHAT IS NOT ────────────────────────────────────────────────
// MEASURED end to end against the real component: selection state, the derived count as
// rendered, which paths reach `api.fs.delete` (recorded off the stubbed fetch, so "did not
// touch it" is a fact about the request, not an inference from the UI), partial-failure
// reporting, and the open/navigate callbacks.
// NOT MEASURED — stated rather than quietly skipped:
//   · Anything visual. jsdom has no layout, so the SVG FileIcon change (solid folder vs
//     outlined page) is entirely outside this file's reach: it can see the elements exist,
//     never that they look different. That change needs eyes or a screenshot diff.
//   · Multi-download. It is N anchor clicks on a 120ms timer; driving it here would測 test
//     jsdom's anchor handling, not the app.
//   · Right-click menus, Copy/Cut/Paste, and the phone `selMode` beyond [4c].
//
// ── ★ [4d] IS RED AS SHIPPED, AND IT IS A REAL FINDING, NOT A BROKEN TEST ────────────
// FileManager's own comment above `onDoubleClick` states the contract: it is "gated on
// `selMode` and the modifier keys", because "a Ctrl- or Shift-double-click would otherwise
// toggle the selection twice AND open the file, which no file manager does". The code is
// `onDoubleClick={() => { if (!selMode) openEntry(e) }}` — there is no modifier check, and
// measured, a Ctrl-double-click DOES open the file. Comment and code disagree; [4d] asserts
// the comment. Same shape as dom-env.mts claiming jsdom was a declared devDependency when
// it was not: a stated fact nobody had executed.
// ── MUTATIONS — every core assertion proven able to FIRE, re-measured 2026-08-27 ─────
// Run against a PATCHED COPY of FileManager.tsx at a repo-root dotfile, never against
// web/src — see the concurrent-editor note below for why that stopped being optional.
// As shipped: 57 passed / 0 failed.
//   M1   `selected` drops the `sel.dir === dir` guard        → NO RED. See ★ below.
//   M1c  that guard AND load()'s folder-change clear removed → [1b]
//   M2   `selected` derives from `entries`, not `visible`    → [1a] [1a']
//   M3   runBatch aborts on the first failure                → [2a] [2c]
//   M4   runBatch swallows the errors                        → [2b]
//   M5   Shift-range extends over `entries`, not `visible`   → [3d]
//   M6   plain click always toggles (never navigates)        → 15 red, incl. [4a] [3e]
//   M7   onDoubleClick ungated                               → [4c] [4d]
//   M8   load() does not prune dead names                    → [5a]
//   M9   toggleOne only ever adds                            → [3b]
//   M10  onDoubleClick opens nothing                         → [4b]
//   M11  doDelete joins against the LIVE `dir`               → [6a] [6b]  ★★
//   M12  runBatch refreshes without the dirRef check         → [8b]
//   MC1  cut clipboard KEPT WHOLE after a partial paste      → [9d] [9e]
//   MC2  cut clipboard CLEARED wholesale                     → [9c] [9d] [9e]
//   MC3  the prune applied to COPY as well as cut            → [9g]
//
// ★ MC3 IS THERE BECAUSE RUNNING IT FOUND A HOLE I HAD ALREADY WRITTEN. [9a]-[9e] cover the
//   cut prune, and every one of them stayed green with the `mode === 'cut'` guard removed —
//   so nothing tested that a COPY clipboard SURVIVES its paste, which is the ordinary case
//   (copy once, paste into three folders). [9g] closes it. A mutation that produces no red
//   is not a passing mutation; it is an uncovered branch announcing itself.
//
// ★★ M11 IS THE ONE WORTH READING. It restores exactly the pre-fix `doDelete`, and [6a]
//    reports `delete calls: ["/root/beta.txt"]` where `/root/sub/beta.txt` was confirmed —
//    a different, real file destroyed because a name resolved against the wrong folder.
//    That defect was found by READING and argued to be unreachable in practice (the confirm
//    is a `fixed inset-0` portal, so its backdrop covers the breadcrumb). This is that
//    argument tested: the guarantee rested on another component's styling, and the moment
//    something reaches the breadcrumb — a keyboard path, a future non-modal confirm, a
//    scripted client — it is gone. Reasoning and measurement each only validate one way.
//
// ★ M1 PRODUCES NO RED, AND THAT IS A FACT ABOUT THIS TEST, NOT A PASS.
// The `sel.dir === dir` guard cannot be isolated, because load() ALREADY resets the name set
// on every folder change — the guard is a second line of defence behind it, and with load()
// intact the app stays correct without it. [1b] pins "at least one of the two redundant
// mechanisms holds", which is the user-facing property; it cannot say which. M1c is what
// gives it teeth. Do not read [1b] green as "the dir guard works".
//
// ★ AND [1b] COULD NOT FAIL AT ALL UNTIL IT WAS REWRITTEN. The first version selected in
// /root and then PLAIN-CLICKED the `sub` row to navigate — but a plain click calls
// clearSel() by design before navigating, so the selection was already empty before the
// folder changed. It stayed green with the guard deleted outright. It now navigates by
// BREADCRUMB, which calls load() directly and clears nothing: the only ordinary route that
// carries a selection across a folder change. An assertion that cannot fail is not evidence.
//
// ── ★ CONCURRENT-EDITOR HAZARD, learned the hard way on this file ────────────────────
// Mutation testing writes to a source file and restores it from a snapshot. If someone else
// is editing that same file, the restore silently reverts their work. FileManager.tsx moved
// under this harness twice in one session. Every mutation above is therefore taken against a
// COPY at a repo-root dotfile with its five relative imports rewritten — and the copy is
// first proven to reproduce the real file's result exactly before a single mutation is
// applied. That costs one rewrite and removes the whole class of problem.
// When a copy is impractical, use `scratchpad/safe-mutate.sh`, which turns the silent
// clobber into a loud refusal: it re-checks the file immediately before restoring and
// declines to write if it moved. It cannot make in-place mutation safe — only make its
// failure visible.
import { setupDom, NO_DOM_NOTE } from './dom-env.mts'

let passed = 0, failed = 0
const ok = (tag: string, name: string, cond: boolean, extra = ''): void => {
  cond ? passed++ : failed++
  console.log(`  ${cond ? '✅' : '❌'} [${tag}] ${name}${extra ? ` — ${extra}` : ''}`)
}
const done = (): never => {
  console.log(`\n${passed} passed / ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

const dom = await setupDom()
if (!dom) {
  // EXIT 77, run-suite.sh's runtime-skip code — not 0, which is how the runner spells PASS.
  console.log('[skip] no DOM: jsdom could not be imported, so nothing here was verified.')
  for (const line of NO_DOM_NOTE) console.log('  ' + line)
  process.exit(77)
}

const g = globalThis as any
g.IS_REACT_ACT_ENVIRONMENT = true

// ── the fixture ──────────────────────────────────────────────────────────────────────
// ★ `beta.txt` EXISTS IN BOTH FOLDERS. That is the whole point of [1b]: an implementation
// that keyed the selection on names alone would resolve the root's `beta.txt` against the
// subfolder's and delete the wrong file, and a fixture with distinct names could never
// catch it. `.hidden.txt` sits in the MIDDLE of the root listing so a Shift-range across it
// has to step over it ([3a]).
type Entry = { name: string; isDir: boolean; size?: number }
const FIXTURE: Record<string, Entry[]> = {
  '/root': [
    { name: 'alpha.txt', isDir: false },
    { name: '.hidden.txt', isDir: false },
    { name: 'beta.txt', isDir: false },
    { name: 'gamma.txt', isDir: false },
    { name: 'sub', isDir: true },
  ],
  '/root/sub': [
    { name: 'beta.txt', isDir: false },     // SAME NAME as the root's — see above
    { name: 'delta.txt', isDir: false },
  ],
}
const deleted: string[] = []          // every path that actually reached api.fs.delete
// Per-delete latency, so a batch can be caught MID-FLIGHT. A real 20-item delete is 20
// sequential awaits with the listing still interactive; an instant stub cannot reproduce
// the window in which the user navigates away, which is the whole of [8].
let deleteDelayMs = 0
const failDelete = new Set<string>()  // paths the stub refuses, for the partial-failure case
const failRename = new Set<string>()  // SOURCE paths whose move the stub refuses ([9])
const renamed: Array<{ from: string; to: string }> = []
const copied: Array<{ from: string; to: string }> = []

const jsonOf = (url: string, init?: { body?: string }): unknown => {
  if (url.startsWith('/api/fs/list')) {
    const q = url.includes('?path=') ? decodeURIComponent(url.split('?path=')[1]) : '/root'
    const entries = FIXTURE[q]
    if (!entries) return { error: `no such directory: ${q}` }
    const parent = q === '/root' ? null : '/root'
    return { path: q, parent, entries }
  }
  if (url.startsWith('/api/fs/copy')) {
    const { from, to } = JSON.parse(init?.body ?? '{}') as { from: string; to: string }
    copied.push({ from, to })
    const destDir = to.slice(0, to.lastIndexOf('/')) || '/root'
    FIXTURE[destDir] = [...(FIXTURE[destDir] ?? []), { name: to.slice(to.lastIndexOf('/') + 1), isDir: false }]
    return { ok: true }
  }
  if (url.startsWith('/api/fs/rename')) {
    const { from, to } = JSON.parse(init?.body ?? '{}') as { from: string; to: string }
    renamed.push({ from, to })
    if (failRename.has(from)) return { ok: false, error: 'permission denied' }
    // Really move it, so the listing the component refreshes into is the one a real move
    // would produce — a stub that reports success without moving anything would let a
    // broken prune pass by leaving the source in place.
    for (const d of Object.keys(FIXTURE)) {
      const hit = FIXTURE[d].find((e) => `${d}/${e.name}` === from)
      if (!hit) continue
      FIXTURE[d] = FIXTURE[d].filter((e) => e !== hit)
      const destDir = to.slice(0, to.lastIndexOf('/')) || '/root'
      FIXTURE[destDir] = [...(FIXTURE[destDir] ?? []), { name: to.slice(to.lastIndexOf('/') + 1), isDir: false }]
    }
    return { ok: true }
  }
  if (url.startsWith('/api/fs/delete')) {
    const path = String(JSON.parse(init?.body ?? '{}').path)
    deleted.push(path)
    if (failDelete.has(path)) return { ok: false, error: 'permission denied' }
    // Really remove it, so the component's own post-op refresh sees what a real one would.
    // Without this the pruning in `load()` could never be observed ([5]).
    for (const d of Object.keys(FIXTURE)) {
      FIXTURE[d] = FIXTURE[d].filter((e) => `${d === '/root' ? '/root' : d}/${e.name}` !== path)
    }
    return { ok: true }
  }
  return { ok: true }
}
g.fetch = async (u: unknown, init?: { body?: string }): Promise<unknown> => {
  const url = String((u as { url?: string })?.url ?? u)
  if (deleteDelayMs && url.startsWith('/api/fs/delete')) {
    await new Promise((r) => setTimeout(r, deleteDelayMs))
  }
  return { ok: true, status: 200, json: async () => jsonOf(url, init) }
}

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const act = (React as unknown as { act: (cb: () => Promise<void>) => Promise<void> }).act
// See sandbox-chip-picker-guard: the components ship with `jsx: "react-jsx"`, but there is
// no tsconfig at the repo root, so `npx tsx` (how run-suite invokes every .mts) falls back
// to the classic transform and emits bare `React.createElement`. Compile shim, not a
// behaviour change.
g.React = React

const { FileManager } = await import('../web/src/components/FileManager.tsx')

const opened: string[] = []
const openedNb: string[] = []
const container = document.createElement('div')
document.body.appendChild(container)
const root = createRoot(container)
await act(async () => {
  root.render(React.createElement(FileManager as never, {
    initialPath: '/root',
    onOpenFile: (p: string) => opened.push(p),
    onOpenNotebook: (p: string) => openedNb.push(p),
    onNewNotebook: async () => null,
    onClose: () => {},
  } as never))
})
await act(async () => { await new Promise((r) => setTimeout(r, 30)) })

// ── helpers ──────────────────────────────────────────────────────────────────────────
const text = (): string => document.body.textContent ?? ''
const buttons = (): HTMLElement[] => [...document.querySelectorAll('button')] as HTMLElement[]
// A row is the button carrying that exact filename in its font-mono label. Matching the
// LABEL rather than the button's whole textContent keeps `beta.txt` from also matching a
// confirm dialog that lists it.
const row = (name: string): HTMLElement | null => {
  const label = ([...document.querySelectorAll('span.font-mono')] as HTMLElement[])
    .find((s) => s.textContent === name && s.closest('button'))
  return (label?.closest('button') as HTMLElement) ?? null
}
const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 30)) }) }
const fire = async (el: Element, type: string, init: Record<string, unknown> = {}): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init })) })
  await settle()
}
const clickRow = async (name: string, mods: Record<string, boolean> = {}): Promise<boolean> => {
  const r = row(name); if (!r) return false
  await fire(r, 'click', mods); return true
}
const btn = (label: string): HTMLElement | null => buttons().find((b) => b.textContent?.trim() === label) ?? null
// The DERIVED count, read off the rendered actions bar — not off internal state. If the bar
// is absent the count is 0, which is the same thing the user sees.
const selCount = (): number => {
  const m = text().match(/(\d+) selected/)
  return m ? Number(m[1]) : 0
}
const hiddenToggle = (): HTMLInputElement | null =>
  (document.querySelector('input[type=checkbox]') as HTMLInputElement) ?? null
// ★ A PLAIN CLICK, and nothing else. The first version set `cb.checked = on` and THEN
// dispatched a click — but a click on a checkbox toggles it, so it flipped straight back and
// `Hidden` never actually changed. That is not a harmless harness bug: [3d] and [1a] are
// both "reveal the dotfile and see what happens", so a no-op toggle made each of them pass
// while measuring nothing. [0f] is the precondition that caught it, and `hiddenIs()` below
// is the guard that stops it recurring silently.
const setHidden = async (on: boolean): Promise<void> => {
  const cb = hiddenToggle()
  if (!cb || cb.checked === on) return
  await fire(cb, 'click')
}
// Read the filter's effect, not its input: the dotfile is on screen or it is not.
const hiddenIs = (on: boolean): boolean => !!row('.hidden.txt') === on
// Delete the current selection all the way through the confirm dialog.
const deleteSelection = async (): Promise<boolean> => {
  const del = btn('Delete…'); if (!del) return false
  await fire(del, 'click')
  const confirm = btn('Delete'); if (!confirm) return false
  await fire(confirm, 'click')
  await settle()
  return true
}

// ═══ [0] PRECONDITIONS ═══════════════════════════════════════════════════════════════
console.log('\n[0] preconditions — can this harness reach the thing it claims to test?')
ok('setup', '[0a] the listing rendered', !!row('alpha.txt') && !!row('sub'))
ok('setup', '[0b] a dotfile is hidden by default', !row('.hidden.txt'))
ok('setup', '[0c] nothing is selected at rest', selCount() === 0)
if (!row('alpha.txt')) { console.log('  ⚠ no listing — nothing below could run.'); done() }

// ═══ [4] NEGATIVE CONTROLS — ordinary single-file use, run FIRST ═════════════════════
// If these are red, every selection assertion below is suspect: a model that never selects
// anything satisfies "you cannot act on what you cannot see" trivially.
console.log('\n[4] negative controls — the ordinary single-file path still works')
await clickRow('sub')
ok('core', '[4a] with no selection, a plain click still navigates into a folder',
  !!row('delta.txt'), `dir now shows ${row('delta.txt') ? '/root/sub' : 'unchanged'}`)
const crumb = buttons().find((b) => b.textContent === 'root')
if (crumb) { await fire(crumb, 'click') }
ok('setup', '[0d] …and the breadcrumb navigates back', !!row('alpha.txt'))

await fire(row('alpha.txt')!, 'dblclick')
ok('core', '[4b] with no selection, a double-click still opens a file',
  opened.includes('/root/alpha.txt'), `onOpenFile got ${JSON.stringify(opened)}`)

const selModeBtn = btn('☑')
ok('setup', '[0e] the select-mode toggle exists', !!selModeBtn)
if (selModeBtn) {
  await fire(selModeBtn, 'click')
  const before = opened.length
  await fire(row('gamma.txt')!, 'dblclick')
  ok('core', '[4c] in select mode a double-click does NOT open', opened.length === before,
    opened.length === before ? '' : `onOpenFile fired: ${JSON.stringify(opened.slice(before))}`)
  await fire(selModeBtn, 'click')   // leave select mode (also clears)
}

// [4d] A Ctrl- or Shift-double-click. FileManager's own comment at the onDoubleClick site
// says it is "gated on `selMode` and the modifier keys" and that without that "a Ctrl- or
// Shift-double-click would otherwise toggle the selection twice AND open the file, which no
// file manager does". This asserts that stated contract directly.
{
  const before = opened.length
  const r = row('beta.txt')!
  await fire(r, 'click', { ctrlKey: true })     // 1st of the double: toggles on
  await fire(r, 'click', { ctrlKey: true })     // 2nd: toggles back off
  await fire(r, 'dblclick', { ctrlKey: true })
  ok('core', '[4d] a Ctrl-double-click does NOT also open the file',
    opened.length === before,
    opened.length === before ? '' : `onOpenFile fired: ${JSON.stringify(opened.slice(before))}`)
  await clickRow('alpha.txt')   // plain click: back to a clean, unselected state
}

// ═══ [3] RANGE AND TOGGLE MECHANICS ══════════════════════════════════════════════════
console.log('\n[3] range / toggle mechanics')
await clickRow('alpha.txt', { ctrlKey: true })
ok('core', '[3a] Ctrl-click selects a row', selCount() === 1, `count=${selCount()}`)
await clickRow('alpha.txt', { ctrlKey: true })
ok('core', '[3b] …and Ctrl-clicking it again deselects it', selCount() === 0, `count=${selCount()}`)

await clickRow('alpha.txt', { ctrlKey: true })
await clickRow('gamma.txt', { shiftKey: true })
ok('core', '[3c] Shift-click extends the range over the VISIBLE rows',
  selCount() === 3, `count=${selCount()} (alpha→beta→gamma)`)
// ★ The decisive half: reveal the dotfile that sits INSIDE that range in the underlying
// listing. If the range had extended over `entries` instead of `visible`, it was swept in
// and the count jumps to 4 the moment it becomes visible.
await setHidden(true)
ok('setup', '[0f] the Hidden toggle really reveals the dotfile (or [3d] proves nothing)', hiddenIs(true))
ok('core', '[3d] …and did NOT sweep in the hidden dotfile inside the range',
  selCount() === 3, `count=${selCount()} after revealing .hidden.txt`)
await setHidden(false)
// The escape hatch: a stray plain click must always drop the selection, so you can never be
// stuck in a state where clicking a folder refuses to open it. Tested here rather than
// inside [1b], which is where it used to hide and quietly neuter that assertion.
await clickRow('alpha.txt')
ok('core', '[3e] a plain click drops the selection (the escape hatch)', selCount() === 0, `count=${selCount()}`)

// ═══ [1] YOU CAN ONLY ACT ON WHAT YOU CAN SEE ════════════════════════════════════════
console.log('\n[1] the selection can only contain rows that are on screen')

// [1a] the Hidden-filter hazard.
await setHidden(true)
await clickRow('alpha.txt')                      // plain click: drops the range above
await clickRow('alpha.txt', { ctrlKey: true })
await clickRow('.hidden.txt', { ctrlKey: true })
ok('setup', '[0g] with Hidden on, a dotfile can be selected alongside a normal file',
  selCount() === 2, `count=${selCount()}`)
await setHidden(false)
ok('core', '[1a] turning Hidden OFF drops the now-invisible dotfile from the count',
  selCount() === 1, `count=${selCount()} — expected 1 (alpha.txt only)`)

const before1a = deleted.length
await deleteSelection()
const touched1a = deleted.slice(before1a)
ok('core', "[1a'] …and deleting does NOT touch the hidden file",
  !touched1a.includes('/root/.hidden.txt'), `delete calls: ${JSON.stringify(touched1a)}`)
ok('core', "[1a''] …while the visible one IS deleted (so this is not passing by doing nothing)",
  touched1a.includes('/root/alpha.txt'))

// [1b] the cross-folder hazard — the one that deletes the wrong file with the right name.
//
// ★ NAVIGATE BY BREADCRUMB, NOT BY CLICKING THE FOLDER ROW. The first version of this
// selected in /root and then plain-clicked `sub` — and a plain click calls clearSel() BY
// DESIGN before it navigates, so the selection was already empty before the folder changed
// and this assertion could not fail under ANY mutation. Measured: it stayed green with the
// `sel.dir === dir` guard deleted outright. The breadcrumb calls load() directly and clears
// nothing, which is the only ordinary route that actually carries a selection across a
// folder change.
await clickRow('sub')
ok('setup', '[0h] in /root/sub, which has its OWN beta.txt', !!row('beta.txt') && !!row('delta.txt'))
await clickRow('beta.txt', { ctrlKey: true })
ok('setup', '[0i] its beta.txt is selected', selCount() === 1, `count=${selCount()}`)
const upCrumb = buttons().find((b) => b.textContent === 'root')
if (upCrumb) await fire(upCrumb, 'click')
ok('setup', '[0j] the breadcrumb navigated back to /root without clearing anything itself',
  !!row('alpha.txt') || !!row('gamma.txt'))
ok('core', "[1b] a selection made in /root/sub does NOT re-bind to /root's same-named row",
  selCount() === 0, `count=${selCount()} — a name-only selection would report 1 here`)

// ═══ [2] PARTIAL FAILURE IS REPORTED, NOT SWALLOWED ══════════════════════════════════
console.log('\n[2] a batch with one failing item')
// Back into the subfolder — [1b] left us in /root, and this section wants the two rows that
// live in /root/sub. A plain click both navigates and clears, which is the state we want.
await clickRow('sub')
ok('setup', '[0k] in /root/sub for the batch case', !!row('beta.txt') && !!row('delta.txt'))
failDelete.add('/root/sub/beta.txt')
await clickRow('beta.txt', { ctrlKey: true })
await clickRow('delta.txt', { ctrlKey: true })
ok('setup', '[0l] two rows selected in /root/sub', selCount() === 2, `count=${selCount()}`)
const before2 = deleted.length
await deleteSelection()
const touched2 = deleted.slice(before2)
ok('core', '[2a] every item is attempted — the batch does not abort on the first failure',
  touched2.includes('/root/sub/beta.txt') && touched2.includes('/root/sub/delta.txt'),
  `delete calls: ${JSON.stringify(touched2)}`)
ok('core', '[2b] the failing item is named in the on-screen error',
  /beta\.txt/.test(text()) && /permission denied/.test(text()),
  text().includes('permission denied') ? '' : '← nothing on screen says anything failed')
ok('core', '[2c] …and the item that succeeded is really gone from the listing', !row('delta.txt'))

// ═══ [5] runBatch PRUNES THE SELECTION ═══════════════════════════════════════════════
// A stale name surviving a delete is invisible until the name comes BACK — then it returns
// already selected, and the next action operates on a row nobody chose. So: delete a row,
// re-create it behind the component's back, refresh, and require it to come back unselected.
// Checking the count straight after the delete would prove nothing, because `selected`
// derives from `visible` and a deleted row cannot be in it either way.
console.log('\n[5] a deleted name does not linger in the selection')
failDelete.clear()
const back = buttons().find((b) => b.textContent === 'root')
if (back) await fire(back, 'click')
await clickRow('gamma.txt', { ctrlKey: true })
ok('setup', '[0m] gamma.txt selected in /root', selCount() === 1, `count=${selCount()}`)
await deleteSelection()
ok('setup', '[0n] …and it is gone', !row('gamma.txt'))
FIXTURE['/root'].push({ name: 'gamma.txt', isDir: false })   // it comes back, e.g. from git
const refresh = buttons().find((b) => b.textContent === '⟳')
if (refresh) await fire(refresh, 'click')
ok('core', '[5a] a re-created file of the same name comes back UNSELECTED',
  !!row('gamma.txt') && selCount() === 0,
  `row back=${!!row('gamma.txt')} count=${selCount()} — a lingering name would report 1`)

// ═══ [6] THE CONFIRM SNAPSHOT — does the delete hit the folder you confirmed IN? ═════
// `setConfirmDel(selected)` stores the ROWS, but `doDelete` rebuilds each path with
// `joinPath(dir, e.name)` against the LIVE `dir`. So if the folder changes between opening
// the confirm and pressing Delete, the names resolve against the WRONG folder — and the
// fixture's `beta.txt` exists in both, which is what turns a mis-resolution into deleting a
// different real file rather than a harmless miss.
//
// ★ THIS IS THE ONE CASE jsdom IS BETTER AT THAN A BROWSER. ConfirmDelete is a
// `fixed inset-0` portal, so on a real screen its backdrop covers the breadcrumb and a user
// cannot physically click it — the guarantee rests on another component's styling rather
// than on the code. jsdom has no layout and no hit-testing, so the click lands and the
// question gets asked directly. A harness that faithfully reproduced the browser could not
// reach this at all.
console.log('\n[6] the folder changes between confirm and confirm-click')
{
  const backRoot = buttons().find((b) => b.textContent === 'root')
  if (backRoot) await fire(backRoot, 'click')
  const subRow = row('sub')
  if (!subRow || !row('beta.txt')) {
    console.log('  ⚠ /root no longer has both `sub` and `beta.txt` — [6] did not run.')
  } else {
    await clickRow('sub')
    ok('setup', '[0o] in /root/sub, which has its own beta.txt', !!row('beta.txt'))
    await clickRow('beta.txt', { ctrlKey: true })
    ok('setup', '[0p] its beta.txt is selected', selCount() === 1, `count=${selCount()}`)
    const del = btn('Delete…')
    if (!del) {
      console.log('  ⚠ no Delete… button — [6] did not run.')
    } else {
      await fire(del, 'click')
      ok('setup', '[0q] the confirm dialog is open', !!btn('Delete'))
      // Leave the folder WITHOUT dismissing the dialog.
      const crumb2 = buttons().find((b) => b.textContent === 'root')
      if (crumb2) await fire(crumb2, 'click')
      ok('setup', '[0r] navigated to /root while the confirm is still open',
        !!btn('Delete') && !!row('gamma.txt'), `dialog=${!!btn('Delete')}`)
      const before6 = deleted.length
      const confirmBtn = btn('Delete')
      if (confirmBtn) await fire(confirmBtn, 'click')
      const touched6 = deleted.slice(before6)
      ok('core', '[6a] the delete resolves against the folder the confirm was MADE in',
        touched6.length === 1 && touched6[0] === '/root/sub/beta.txt',
        `delete calls: ${JSON.stringify(touched6)} — expected ["/root/sub/beta.txt"]`)
      ok('core', "[6b] …so /root's own same-named file is NOT the one destroyed",
        !touched6.includes('/root/beta.txt'),
        touched6.includes('/root/beta.txt') ? '← it deleted the WRONG beta.txt: a name resolved against the wrong folder' : '')
    }
  }
}

// ═══ [7] FileIcon — does the folder glyph actually draw a folder? ════════════════════
// Nothing else checks this. jsdom cannot say the icons look different, but it CAN say the
// folder is a filled shape and the pages are stroked outlines — which is the distinction
// the component's header says must survive losing colour, and an empty <svg> would fail.
console.log('\n[7] the drawn icons')
{
  const { FileIcon } = await import('../web/src/components/FileIcon.tsx')
  const box = document.createElement('div')
  document.body.appendChild(box)
  const iconRoot = createRoot(box)
  const svgOf = async (kind: string): Promise<SVGElement | null> => {
    await act(async () => { iconRoot.render(React.createElement(FileIcon as never, { kind } as never)) })
    return box.querySelector('svg')
  }
  // ★ Read each render's facts IMMEDIATELY. React reuses the same DOM node when the same
  // component re-renders, so holding an SVG reference across renders leaves all three
  // pointing at the LAST one — which is exactly how [7e] first failed while the component
  // was perfectly correct.
  const folder = await svgOf('folder')
  const folderClass = folder?.getAttribute('class') ?? ''
  const fPaths = folder ? [...folder.querySelectorAll('path')] : []
  ok('core', '[7a] the folder glyph draws a non-empty shape',
    fPaths.length > 0 && (fPaths[0].getAttribute('d') ?? '').length > 20,
    `paths=${fPaths.length}`)
  ok('core', '[7b] …and it is FILLED, which is the weight difference that survives losing colour',
    fPaths.some((n) => n.getAttribute('fill') === 'currentColor'))
  const file = await svgOf('file')
  const fileClass = file?.getAttribute('class') ?? ''
  const filePaths = file ? [...file.querySelectorAll('path')] : []
  const stroked = file?.querySelector('g[stroke="currentColor"]')
  ok('core', '[7c] the file glyph draws an OUTLINE, not a fill',
    !!stroked && filePaths.length > 0 && !filePaths.some((n) => n.getAttribute('fill') === 'currentColor'),
    `paths=${filePaths.length} stroked=${!!stroked}`)
  const nb = await svgOf('notebook')
  const nbClass = nb?.getAttribute('class') ?? ''
  const nbPaths = nb ? [...nb.querySelectorAll('path')] : []
  ok('core', '[7d] a notebook is the file silhouette PLUS a mark, not a different shape',
    nbPaths.length === filePaths.length + 1, `notebook=${nbPaths.length} file=${filePaths.length}`)
  // Colour is set centrally so it cannot drift into four slightly different yellows.
  ok('core', '[7e] each kind carries its own tone class from the one TONE map',
    folderClass.includes('text-ctp-yellow') && fileClass.includes('text-ctp-overlay')
    && nbClass.includes('text-ctp-peach'),
    `folder=${folderClass.trim()} file=${fileClass.trim()} notebook=${nbClass.trim()}`)
  await act(async () => { iconRoot.unmount() })
}

// ═══ [8] NAVIGATING WHILE A BATCH IS STILL RUNNING ═══════════════════════════════════
// runBatch's trailing refresh used to close over the render-time `dir` and call
// setDir(old) when it finished — so leaving the folder mid-batch yanked you back out of
// the one you had just opened. It now compares `dirRef.current` against the batch's home
// and refreshes only if you are still there.
console.log('\n[8] the user navigates while a delete batch is in flight')
{
  FIXTURE['/root/sub'] = [{ name: 'one.txt', isDir: false }, { name: 'two.txt', isDir: false }]
  const backR = buttons().find((b) => b.textContent === 'root')
  if (backR) await fire(backR, 'click')
  await clickRow('sub')
  ok('setup', '[0s] /root/sub re-stocked with two files', !!row('one.txt') && !!row('two.txt'))
  await clickRow('one.txt', { ctrlKey: true })
  await clickRow('two.txt', { ctrlKey: true })
  ok('setup', '[0t] both selected', selCount() === 2, `count=${selCount()}`)
  const del = btn('Delete…')
  if (del) await fire(del, 'click')
  const confirmBtn = btn('Delete')
  if (!confirmBtn) {
    console.log('  ⚠ no confirm dialog — [8] did not run.')
  } else {
    // React warns "an update was not wrapped in act(...)" for every state change below, and
    // here that is CORRECT AND INTENDED: act() waits for pending work to settle, which is
    // precisely the window this case needs to stay open. Eight warning blocks would bury the
    // two assertions, so they are silenced for this section only — a log nobody reads is the
    // same as no log.
    const realErr = console.error
    console.error = (...a: unknown[]) => { if (!/not wrapped in act/.test(String(a[0]))) realErr(...a) }
    deleteDelayMs = 120
    // Start the batch WITHOUT awaiting it: the point is to act while it is still running.
    confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 40))          // first delete in flight
    const crumb = buttons().find((b) => b.textContent === 'root')
    if (crumb) crumb.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 600))          // let the batch and both loads finish
    await settle()
    deleteDelayMs = 0
    ok('core', '[8a] the batch still deleted everything it was asked to',
      deleted.includes('/root/sub/one.txt') && deleted.includes('/root/sub/two.txt'),
      `deleted: ${JSON.stringify(deleted.slice(-2))}`)
    ok('core', '[8b] …and finishing did NOT yank the user back to the batch\'s folder',
      !!row('gamma.txt') && !row('one.txt'),
      `on screen: ${JSON.stringify(([...document.querySelectorAll('span.font-mono')] as HTMLElement[]).filter((n) => n.closest('button')).map((n) => n.textContent))}`)
    console.error = realErr
  }
}

// ═══ [9] A PARTIALLY-FAILED CUT PRUNES THE CLIPBOARD TO THE FAILURES ═════════════════
// The two wrong answers are symmetrical and both look reasonable:
//   · KEEP IT WHOLE  → the retry re-attempts the items that already moved. They now fail
//     source-missing, and those phantom errors bury the one real failure.
//   · CLEAR IT       → the item that did NOT move is stranded, with no way to retry the
//     group; the user is left believing the cut completed.
// Pruning to exactly the failures is the same rule load() applies to the selection, so the
// clipboard and the selection converge on what still needs doing. Read off the Paste
// button, which is the only surface the clipboard has: its label carries the count and its
// title names the single remaining item.
console.log('\n[9] a cut where one item fails to move')
{
  FIXTURE['/root/sub'] = [{ name: 'moves.txt', isDir: false }, { name: 'sticks.txt', isDir: false }]
  const backR = buttons().find((b) => b.textContent === 'root')
  if (backR) await fire(backR, 'click')
  await clickRow('sub')
  ok('setup', '[0u] /root/sub stocked with two files to cut', !!row('moves.txt') && !!row('sticks.txt'))
  await clickRow('moves.txt', { ctrlKey: true })
  await clickRow('sticks.txt', { ctrlKey: true })
  const cut = btn('Cut')
  ok('setup', '[0v] both selected and a Cut button is offered', selCount() === 2 && !!cut, `count=${selCount()}`)
  if (cut) await fire(cut, 'click')
  const pasteBtn = (): HTMLElement | null =>
    buttons().find((b) => (b.textContent ?? '').startsWith('📋 Paste')) ?? null
  ok('setup', '[0w] the clipboard now offers a paste of BOTH items',
    (pasteBtn()?.textContent ?? '').trim() === '📋 Paste 2', `label=${JSON.stringify(pasteBtn()?.textContent)}`)

  // `sticks.txt` refuses to move; `moves.txt` goes through.
  failRename.add('/root/sub/sticks.txt')
  const crumb = buttons().find((b) => b.textContent === 'root')
  if (crumb) await fire(crumb, 'click')
  const p = pasteBtn()
  if (!p) {
    console.log('  ⚠ no Paste button in /root — [9] did not run.')
  } else {
    const beforeRen = renamed.length
    await fire(p, 'click')
    const tried = renamed.slice(beforeRen)
    ok('core', '[9a] both items were attempted (the batch does not abort on the failure)',
      tried.some((r) => r.from === '/root/sub/moves.txt') && tried.some((r) => r.from === '/root/sub/sticks.txt'),
      `renames tried: ${JSON.stringify(tried.map((r) => r.from))}`)
    ok('core', '[9b] the one that succeeded really moved', !!row('moves.txt'))
    const after = pasteBtn()
    ok('core', '[9c] the clipboard is PRUNED, not cleared — a retry is still offered',
      !!after,
      after ? '' : '← the clipboard was cleared wholesale: the failed item is stranded with no way to retry it')
    ok('core', '[9d] …and it holds ONLY the failure, not both',
      (after?.textContent ?? '').trim() === '📋 Paste',
      `label=${JSON.stringify(after?.textContent)} — "📋 Paste 2" means it was kept whole, so a retry would re-attempt the moved item`)
    ok('core', '[9e] …and the item it names is the one that failed',
      (after?.getAttribute('title') ?? '').includes('sticks.txt'),
      `title=${JSON.stringify(after?.getAttribute('title'))}`)
  }

  // ── the other half of the `mode === 'cut'` guard ──────────────────────────────────
  // A COPY clipboard must SURVIVE its paste: copying once and pasting into three folders is
  // the ordinary use, and pruning a copy the way a cut is pruned would empty it after the
  // first successful paste. Only a cut is consumed by pasting, because only a cut moves the
  // source. Without this the prune could be applied to both modes and nothing would notice.
  const pasteBtn2 = (): HTMLElement | null =>
    buttons().find((b) => (b.textContent ?? '').startsWith('📋 Paste')) ?? null
  await clickRow('gamma.txt', { ctrlKey: true })
  const copyBtn = btn('Copy')
  ok('setup', '[0x] a file is selected in /root and Copy is offered', selCount() === 1 && !!copyBtn)
  if (copyBtn) await fire(copyBtn, 'click')
  const beforeCopy = copied.length
  const p2 = pasteBtn2()
  if (p2) await fire(p2, 'click')
  ok('core', '[9f] a copy-paste really copies', copied.length > beforeCopy,
    `copies: ${JSON.stringify(copied.slice(beforeCopy).map((c) => c.to))}`)
  const afterCopy = pasteBtn2()
  ok('core', '[9g] …and a COPY clipboard SURVIVES its paste, so it can be pasted again',
    !!afterCopy && (afterCopy.getAttribute('title') ?? '').includes('gamma.txt'),
    afterCopy ? `title=${JSON.stringify(afterCopy.getAttribute('title'))}`
              : '← the copy clipboard was consumed by pasting; only a CUT should be')
}

await act(async () => { root.unmount() })
dom.cleanup()
done()
