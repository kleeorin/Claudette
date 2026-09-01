// SANDBOX-CHIP FOLDER PICKER — does clicking inside the picker kill the popover that opened it?
//
//   CLAUDETTE_JSDOM=/tmp/qa-deps/node_modules/jsdom/lib/api.js \
//     npx tsx scratchpad/sandbox-chip-picker-guard.mts
//
// GROUP C: no browser, no server, no ports. Renders the REAL SandboxControl into jsdom via
// react-dom and drives real `mousedown` events at it.
//
// ── THE BUG ──────────────────────────────────────────────────────────────────────────
// SandboxControl (the sandbox chip + popover in the chat meta-bar) closes its popover on a
// document-level `mousedown` whose target is not inside its own `ref` div. The popover
// renders <SandboxEditor compact />, whose "+ Add a folder…" opens <FileBrowser>, and
// FileBrowser renders through `createPortal` to <body>. A portal is NOT a DOM descendant of
// `ref`, so the first mousedown anywhere in the picker — backdrop or dialog — counted as
// "outside": the popover closed, SandboxEditor unmounted, and the picker's own `picking`
// state died with it. The picker vanished on the first click and adding a mount from the
// chat chip was impossible. SandboxPanel (right dock) renders the same editor with no
// click-away handler at all, which is why the same flow worked there.
//
// THE FIX: FileBrowser's outermost portal node carries a bare `data-overlay-layer`, and
// SandboxControl's handler returns early — leaving the popover OPEN — when the target sits
// inside one.
//
// ── WHAT A RED MEANS ─────────────────────────────────────────────────────────────────
// [1x] red  → a click inside the picker is closing the popover again: either the marker is
//             gone from FileBrowser's OUTERMOST portal node, or SandboxControl stopped
//             consulting it. The user-visible symptom is that the picker cannot be used.
// [2x] red  → the click-away handler itself is broken. ★ THESE MATTER MORE THAN [1x]. A
//             handler DELETED OUTRIGHT passes every [1] assertion perfectly — the picker
//             certainly survives if nothing ever closes anything. Without [2] this file
//             would be green against the worst possible "fix", and would be worth nothing.
//             They run FIRST for that reason: if the handler is dead, you learn it before
//             reading a single reassuring [1].
//
// ── WHAT IS MEASURED, AND WHAT IS NOT ────────────────────────────────────────────────
// MEASURED, end to end, against the real components: the popover opens from the chip, the
// picker opens from the editor, the portal really is outside `ref` (asserted at [0f], not
// assumed), and real `mousedown` events dispatched at the backdrop / the dialog card / a
// folder row inside it leave both the picker and the popover standing.
// NOT MEASURED: anything visual. jsdom has no layout, so "the picker is on screen and
// clickable" is out of reach — this file only knows the elements are in the document. Also
// untouched: the OTHER openers of FileBrowser (SandboxPanel, the file manager), and whether
// any other click-away handler in the app needs the same exemption. `data-overlay-layer` is
// a convention this proves for exactly one opener.
//
// ── LOCATING THE PICKER WITHOUT USING THE FIX'S OWN MARKER ───────────────────────────
// ★ Load-bearing: the picker is found by its heading text ("Choose a folder") and walked up
// to the portal root, NEVER by `[data-overlay-layer]`. Querying the marker would mean that
// deleting the marker — the exact revert this file exists to catch — breaks the PRECONDITION
// instead of the assertion, and the file would skip or die rather than go red. A test must
// not be expressed in terms of the thing it is testing.
// ── MUTATIONS — every core assertion proven able to FIRE, measured 2026-08-27 ────────
// Each is a one-line edit to web/src, reverted immediately after; both files were restored
// and md5-checked identical. Green as shipped: 13 passed / 0 failed.
//   A  `data-overlay-layer` removed from FileBrowser's portal   → 7/6: all six [1] red
//   B  SandboxControl's pre-fix handler restored                → 7/6: all six [1] red
//   C  the click-away handler never registered at all           → 12/1: **[2b] ALONE**
//   D  the marker moved to the INNER dialog card instead of
//      the portal's outermost node                              → 11/2: **[1a]/[1a'] alone**
//
// ★ C AND D ARE WHY THIS FILE IS WORTH KEEPING, and neither is obvious:
//   · C is the worst possible "fix" — delete the handler and the picker survives beautifully.
//     Every [1] assertion passes. Only [2b] catches it. A version of this file without the
//     negative control would have been green against a popover that never closes at all.
//   · D pins the marker to the OUTERMOST portal node. On the inner card the dialog and its
//     rows are still exempt, so [1b]/[1c] stay green and only the BACKDROP case reds —
//     which is exactly the half a user hits when they click the dimmed area to dismiss.
//   A and B are indistinguishable from each other by design: both remove the exemption, and
//   this file deliberately does not try to say WHICH side of the contract broke. It says the
//   contract is broken; the two-line diff says which.
import { setupDom, NO_DOM_NOTE } from './dom-env.mts'

import { withMarks, passed, failed } from './assert.mjs'
const ok = withMarks({ indent: '  ' })
const done = (): never => {
  console.log(`\n${passed} passed / ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

const dom = await setupDom()
if (!dom) {
  // EXIT 77, NOT 0 — run-suite.sh's runtime-skip code. The brief for this file said "SKIP
  // (exit 0)", but exit 0 is how the runner spells PASS: without jsdom this would report as
  // a passing test that executed no assertion at all. 77 lands it in the SKIP column with
  // this reason attached and listed under "runtime skips", where a coverage hole belongs.
  // ★ scratchpad/output-sanitizer-test.mts still exits 0 on this path, and jsdom is in
  //   neither package.json nor node_modules — so on this machine it currently reports PASS
  //   having tested nothing, and its subject is the notebook output SANITIZER. Not fixed
  //   here because it is not this task, but it should be.
  console.log('[skip] no DOM: jsdom could not be imported, so nothing here was verified.')
  for (const line of NO_DOM_NOTE) console.log('  ' + line)
  process.exit(77)
}

const g = globalThis as any
g.IS_REACT_ACT_ENVIRONMENT = true

// ── the app's two network globals, stubbed ───────────────────────────────────────────
// Shapes matter more than values: the session store dispatches whatever `listSessions()`
// resolves to straight into its reducer, and `sameSessions` reads `.length` on it — so a
// bare `{}` here does not fail politely, it throws inside a reducer during render and the
// whole tree unmounts. Each route returns the shape its caller destructures.
const routeBody = (url: string): unknown => {
  if (url.includes('/api/health')) return { sandboxAvailable: true, gpuDevices: [], homeDir: '/home/probe' }
  if (url.includes('/api/session/list')) return { sessions: [] }
  if (url.includes('/api/agents')) return { agents: [] }
  if (url.includes('/api/connectors')) return { connectors: [], accountConnectors: [], oauthClients: [], strict: false }
  if (url.includes('/api/fs/list')) {
    return { path: '/tmp', parent: null, entries: [{ name: 'alpha', isDir: true }, { name: 'beta', isDir: true }] }
  }
  return {}
}
g.fetch = async (u: unknown): Promise<unknown> => {
  const url = String((u as { url?: string })?.url ?? u)
  return { ok: true, status: 200, json: async () => routeBody(url), text: async () => JSON.stringify(routeBody(url)) }
}
// Never opened, never messaged. The store's socket effects all swallow their own failures,
// so an inert stub is enough to keep the provider from throwing at mount.
class InertSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1
  static readonly CLOSING = 2; static readonly CLOSED = 3
  readyState = 0
  addEventListener(): void {} removeEventListener(): void {}
  send(): void {} close(): void {}
}
g.WebSocket = InertSocket

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const act = (React as unknown as { act: (cb: () => Promise<void>) => Promise<void> }).act

// The components ship compiled with `jsx: "react-jsx"` (web/tsconfig.json), but there is no
// tsconfig at the repo root, so `npx tsx` — which is how run-suite.sh invokes every .mts —
// falls back to the CLASSIC transform and emits bare `React.createElement`. Publishing React
// as a global satisfies that. It is a COMPILE shim, not a behaviour change: both transforms
// produce identical elements, and doing it here keeps this file runnable by the plain
// `npx tsx <path>` the runner uses, with no special invocation to remember.
g.React = React

const { SessionsProvider } = await import('../web/src/store/sessions.tsx')
const { SandboxControl } = await import('../web/src/components/SandboxControl.tsx')

const SESSION = {
  id: 'probe-1', name: 'Probe', cwd: '/tmp/probe', rootDir: '/tmp/probe',
  state: 'idle', sandbox: { enabled: true, mounts: [] }, sandboxed: true,
}

const container = document.createElement('div')
document.body.appendChild(container)
const root = createRoot(container)
await act(async () => {
  root.render(React.createElement(SessionsProvider, null,
    React.createElement(SandboxControl as never, { session: SESSION } as never)))
})

// ── helpers ──────────────────────────────────────────────────────────────────────────
const buttons = (): HTMLElement[] => [...document.querySelectorAll('button')] as HTMLElement[]
const byText = (re: RegExp): HTMLElement | null => buttons().find((b) => re.test(b.textContent ?? '')) ?? null
const click = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })   // let effects/fetches settle
}
const mousedown = async (el: Element): Promise<void> => {
  await act(async () => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
}
// The popover is open iff the editor it wraps is rendered. Keyed on the editor's own
// control rather than on a class name, so a restyle cannot silently make this always-false
// (which would turn every [1] green for the wrong reason).
const popoverOpen = (): boolean => !!byText(/Add a folder/i)
// The picker, found by its heading — deliberately NOT by the marker under test. Walk up to
// the node whose parent is <body>: that is the portal root, i.e. the backdrop.
const pickerHeading = (): HTMLElement | null =>
  ([...document.querySelectorAll('span')] as HTMLElement[]).find((s) => s.textContent === 'Choose a folder') ?? null
const pickerRoot = (): HTMLElement | null => {
  let n = pickerHeading()
  while (n?.parentElement && n.parentElement !== document.body) n = n.parentElement
  return n && n.parentElement === document.body ? n : null
}
const pickerOpen = (): boolean => !!pickerHeading()

// ═══ [0] PRECONDITIONS ═══════════════════════════════════════════════════════════════
console.log('\n[0] preconditions — can this harness reach the thing it claims to test?')
ok('[0a] SandboxControl rendered its chip', !!byText(/sandbox/i), '', 'setup')
await click(byText(/sandbox/i)!)
ok('[0b] clicking the chip opens the popover', popoverOpen(), '', 'setup')

if (!popoverOpen()) {
  console.log('  ⚠ the popover never opened — nothing below could be measured, so it did not run.')
  done()
}

// ═══ [2] THE CLICK-AWAY HANDLER IS ALIVE — run FIRST, see the header ═════════════════
// If these are red, every [1] below is meaningless: a deleted handler passes them all.
console.log('\n[2] negative controls — the handler still closes on a genuine outside click')
const outside = document.createElement('div')
outside.textContent = 'an ordinary element, in no overlay'
document.body.appendChild(outside)

await mousedown(byText(/Add a folder/i)!)
ok('[2a] a mousedown INSIDE the popover does NOT close it', popoverOpen(), '', 'core')

await mousedown(outside)
ok('[2b] a mousedown on an ordinary element outside DOES close it', !popoverOpen(), popoverOpen() ? '← the click-away handler is not closing at all; every [1] below would pass vacuously' : '', 'core')

// ═══ [1] THE REGRESSION TEST ═════════════════════════════════════════════════════════
// ★ EACH CASE RE-ESTABLISHES THE STATE FIRST. The first version dispatched all three
// mousedowns against one long-lived popover, and that made the cases dependent: a mutation
// that only broke the BACKDROP case closed the popover on [1a] and then took [1c]-[1f] down
// with it as collateral, reporting six failures for one cause and hiding which target
// actually regressed. Measured — moving the marker from the portal's outermost node to the
// inner dialog card reds all six that way, and only [1a]/[1b] once the cases are isolated,
// which is the signal that says "the marker is on the wrong node".
console.log('\n[1] a click inside the portal picker must not close the popover that opened it')

// Bring the UI back to: popover open, picker open. Idempotent — it checks before clicking,
// because clicking the chip when the popover is ALREADY open toggles it shut. (That is not
// hypothetical: it is how an earlier draft of this file crashed instead of reporting under a
// mutation that left the popover open.)
const openPicker = async (): Promise<boolean> => {
  if (!popoverOpen()) { const chip = byText(/sandbox/i); if (chip) await click(chip) }
  if (!popoverOpen()) return false
  if (!pickerOpen()) { const add = byText(/Add a folder/i); if (add) await click(add) }
  return popoverOpen() && pickerOpen()
}

ok('[0c] the popover and picker can be (re-)opened after the controls above closed them', await openPicker(), '', 'setup')

const backdrop0 = pickerRoot()
ok('[0d] the picker was located by its heading, without using the marker under test', !!backdrop0, '', 'setup')

// The premise of the entire bug: the portal is NOT a DOM descendant of the popover. Asserted
// rather than assumed — if a refactor stopped portalling, these clicks would be "inside" by
// ordinary containment and every [1] would pass while testing nothing at all.
const popoverRoot = byText(/Add a folder/i)?.closest('div.relative') ?? container
ok('[0e] PREMISE: the picker really is outside the popover subtree (it is a portal)', !!backdrop0 && !popoverRoot.contains(backdrop0), backdrop0?.parentElement === document.body ? 'portal root is a direct child of <body>' : '', 'setup')

if (!backdrop0) {
  console.log('  ⚠ the picker was not measurable — section [1] did not run.')
  await act(async () => { root.unmount() })
  dom.cleanup()
  done()
}

// One target, measured from a freshly re-established state so it cannot be poisoned by an
// earlier case. `pick` runs AFTER the re-open, because the portal nodes are new each time.
const dispatchCase = async (tag: string, what: string, pick: (root: HTMLElement) => Element | null | undefined): Promise<void> => {
  if (!await openPicker()) {
    console.log(`  ⚠ could not re-establish popover+picker — [${tag}] did not run.`)
    return
  }
  const root0 = pickerRoot()
  const target = root0 ? pick(root0) : null
  if (!target) {
    console.log(`  ⚠ no ${what} to click — [${tag}] did not run.`)
    return
  }
  await mousedown(target)
  const stillOpen = popoverOpen()
  ok(`[${tag}] mousedown on ${what} leaves the popover open`, stillOpen, stillOpen ? '' : '← the popover closed, so SandboxEditor unmounted and took the picker with it', 'core')
  ok(`[${tag}'] …and the picker is still in the document`, pickerOpen(), '', 'core')
}

await dispatchCase('1a', 'the picker BACKDROP (the portal root)', (r) => r)
await dispatchCase('1b', 'the dialog CARD', (r) => r.firstElementChild)
// The click a user actually makes lands on a folder row several levels deep — not on the
// backdrop or the card. Deepest target, so `closest()` has the furthest to walk.
await dispatchCase('1c', 'a folder ROW deep inside the dialog',
  (r) => ([...r.querySelectorAll('button')] as HTMLElement[]).find((b) => /alpha/.test(b.textContent ?? '')))

await act(async () => { root.unmount() })
dom.cleanup()
done()
