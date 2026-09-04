// The repo's ONE way to get a DOM inside a scratchpad test. Import this rather than
// hand-rolling a jsdom bootstrap — a second, subtly different one is how two tests end up
// disagreeing about which globals exist.
//
//   import { setupDom } from './dom-env.mts'
//   const dom = await setupDom()
//   if (!dom) { /* report SKIPPED and exit 0 */ }
//   ...                                   // window/document/Node/... are now global
//   dom.cleanup()
//
// WHY THIS EXISTS: `jsdom` was approved 2026-08-21 for the notebook output sanitizer, which
// is security-critical and had zero tests because DOMPurify cannot run without a `window`.
// It is deliberately NOT a test runner — the suite is still ~50 standalone scripts sequenced
// by run-suite.sh, and each one still owns its own asserts and exit code.
//
// ⚠ CORRECTED 2026-08-27, then CLOSED 2026-09-02. Both stages are kept, because the second is
// only legible against the first and because the arc is the clearest vacuous-pass example in
// this repo.
//
//   [stage 1] The header here originally said jsdom "is a devDependency (approved 2026-08-21)".
//     It was not. It appeared in no package.json and in neither node_modules, so `npm i` had
//     nothing to install and EVERY setupDom caller took the no-DOM path — on every machine,
//     since the day this file was written. That is how output-sanitizer-test.mts came to report
//     `10 passed, 0 failed` and exit 0 with the whole sanitizer-behaviour half UNRUN.
//   [stage 2] The 08-27 correction made that caller exit 77 instead of 0 when no DOM is present.
//     It fixed no bug and changed no behaviour; it only stopped the instrument lying.
//   [stage 3] `4d403d8` (2026-08-28) DECLARED jsdom at the ROOT package.json ("jsdom":
//     "^29.1.1"), and it resolves — require.resolve('jsdom') finds node_modules/jsdom/lib/api.js
//     at 29.1.1. The plain `import('jsdom')` in loadJsdom() below now succeeds, that caller is
//     back to exit 0, and it reports 32 passed / 0 failed / 0 skipped.
//
// ★ THE TRAP THIS LEAVES BEHIND: stage 1 and stage 3 have the SAME EXIT CODE (0) and both look
// green. One certified a security boundary it never touched; the other verifies all of it. The
// assertion COUNT is the only thing that distinguishes them — 10 against 32. If you are ever
// comparing this seam across history, compare counts, because the exit code is blind to the
// difference that matters.
//
// Declared at the ROOT rather than in web/ deliberately: scratchpad/ is not a workspace, these
// harnesses run under `npx tsx` from the repo root and resolve from root node_modules, so a
// declaration in web/ would only be found by a hoisting accident.
//
// IT IS ALSO THE SEAM FOR THE NEXT WEB TEST. The chat store (web/src/store/chat.tsx) is the
// obvious next candidate: its reducer is pure and per-session, and the only reason it was
// untestable was the missing DOM. Anything that needs React DOM rendering will need more
// globals than this installs — add them HERE, to `DOM_GLOBALS`, rather than patching them
// in at the call site.
//
// The `CLAUDETTE_JSDOM` escape hatch, and WHEN IT IS AND IS NOT NEEDED. It is a genuine
// fallback and it stays — but since `4d403d8` it is no longer the default path, and reaching
// for it out of habit is unnecessary work premised on a claim that is no longer true.
//
// The distinction that decides it is RESOLVE versus WRITE, and conflating the two is what made
// the hatch look mandatory for a week. A confined session mounts root `node_modules` READ-ONLY
// — that is the sandbox working as designed — so `npm i` cannot run there. But a plain
// `import('jsdom')` only needs to RESOLVE and READ, which a read-only mount permits perfectly
// well. So on any box that can see root `node_modules` at all, the first branch of loadJsdom()
// below wins and no env var is wanted. Measured 2026-09-02 from a confined session with the
// variable unset: all four setupDom callers ran with a real DOM and none skipped —
// output-sanitizer-test 32/0 (0 skipped), file-live-sync-client-guard 46/0,
// file-multiselect-guard 57/0, sandbox-chip-picker-guard 13/0.
//
// Use CLAUDETTE_JSDOM when root `node_modules` is not reachable from your sandbox at all (not
// merely read-only). Point it at an out-of-tree install; note /tmp is per-sandbox private, so
// each session needs its own copy:
//   mkdir -p /tmp/qa-deps && (cd /tmp/qa-deps && npm i jsdom)
//   CLAUDETTE_JSDOM=/tmp/qa-deps/node_modules/jsdom/lib/api.js npx tsx scratchpad/<test>.mts
//
// ★ AND IT IS NOT AN OFF-SWITCH. To test the no-DOM path, HIDE `node_modules/jsdom`; do not
// invent an env var to simulate its absence. `4d403d8` first tried exactly that (a
// `CLAUDETTE_NO_JSDOM` variable) and it returned exit 0 while proving nothing, because this
// variable is a fallback the loader consults AFTER the plain import, not a lever that disables
// the plain import. Verify an absence with the absence.

// Globals a jsdom window must publish for DOM-consuming library code to work. DOMPurify
// needs the node/element constructors for its `instanceof` checks; the rest are what
// browser code reaches for without thinking.
const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'location',
  'Node', 'Element', 'HTMLElement', 'HTMLTemplateElement', 'HTMLFormElement',
  'DocumentFragment', 'DOMParser', 'XMLSerializer', 'NodeFilter',
  'Text', 'Comment', 'CustomEvent', 'Event', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  // Added 2026-08-27 for the first test that RENDERS React into this DOM
  // (sandbox-chip-picker-guard). React DOM's event plumbing and the scheduler reach for
  // these, and a test dispatching a real click needs the event constructors to exist as
  // globals rather than only on `window` — `new MouseEvent(...)` in a module has no
  // `window` in scope. Added here rather than patched in at the call site, per the note
  // above: a second, subtly different bootstrap is how two tests end up disagreeing about
  // which globals exist.
  'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'InputEvent', 'FocusEvent',
  'MessageChannel', 'MessagePort', 'MessageEvent',
  'HTMLInputElement', 'HTMLButtonElement', 'HTMLDivElement', 'HTMLSpanElement',
  'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLAnchorElement', 'SVGElement',
  // ★ NOT `performance`, and not `queueMicrotask`. Publishing jsdom's `performance` over
  // Node's blows the stack instantly: jsdom's own Performance implementation calls the
  // GLOBAL `performance.now()`, so overwriting that global with jsdom's makes it call
  // itself forever (`RangeError: Maximum call stack size exceeded`, measured 2026-08-27).
  // Node's versions work fine for DOM code. The general trap: a jsdom global that
  // delegates to the platform must not be allowed to shadow the platform.
] as const

export interface DomEnv {
  window: any
  cleanup: () => void
}

// Resolve jsdom, or null when it genuinely is not reachable. Never throws: a caller is
// expected to SKIP loudly rather than fail, so a missing devDependency does not read as a
// broken sanitizer.
async function loadJsdom(): Promise<any | null> {
  try { return await import('jsdom') } catch { /* fall through */ }
  const override = process.env.CLAUDETTE_JSDOM
  if (override) {
    try { return await import(override) } catch { /* fall through */ }
  }
  return null
}

// Install a fresh DOM on globalThis. Returns null if jsdom is unavailable — check for it.
export async function setupDom(html = '<!doctype html><html><body></body></html>'): Promise<DomEnv | null> {
  const mod = await loadJsdom()
  if (!mod) return null
  const { JSDOM } = mod
  const dom = new JSDOM(html)
  const g = globalThis as any

  // Remember what we shadowed so cleanup can put it back — a test that installs a DOM
  // and leaves it installed can change how a LATER import in the same process behaves.
  const saved = new Map<string, unknown>()
  for (const k of DOM_GLOBALS) {
    saved.set(k, g[k])
    const v = (dom.window as any)[k]
    if (v !== undefined) g[k] = v
  }

  return {
    window: dom.window,
    cleanup() {
      for (const [k, v] of saved) { if (v === undefined) delete g[k]; else g[k] = v }
      try { dom.window.close() } catch { /* already gone */ }
    },
  }
}

// The message to print when setupDom() returns null, so every test says the same thing.
//
// REWRITTEN 2026-09-02, and the change is one of expectations, not just of wording. This used
// to open "jsdom is NOT declared in any package.json … there is nothing for npm to install",
// which was true when written and is now false: `4d403d8` declared it at the root. Printing
// that to someone whose DOM failed to load would send them to install a dependency they
// already have and to set an env var they do not need, while the real cause — a sandbox that
// cannot reach root node_modules — went unnamed. So this now states what IS expected and
// treats its own firing as the anomaly, which is what it has become: on a normal checkout,
// reaching this text at all means something is wrong beyond a missing package.
//
// (The previous version also carried a duplicated half-line, "and point CLAUDETTE_JSDOM at
// it, e.g.:", left over from an earlier edit. Removed here rather than preserved — unlike the
// stale claims above it records no decision and teaches nothing.)
export const NO_DOM_NOTE = [
  'no DOM available: `jsdom` could not be imported.',
  'This is NOT the expected state. jsdom IS declared at the ROOT package.json ("jsdom":',
  '"^29.1.1") and normally resolves from root node_modules with no configuration at all —',
  'a read-only mount is fine, since importing only needs to resolve and read, not write.',
  'So reaching this message means your sandbox cannot see root node_modules AT ALL, or the',
  'install is incomplete. Check `node -e "console.log(require.resolve(\'jsdom\'))"` first.',
  'If root node_modules is genuinely unreachable, install out of tree and point',
  'CLAUDETTE_JSDOM at it — note /tmp is per-sandbox private, so each session needs its own:',
  '  mkdir -p /tmp/qa-deps && (cd /tmp/qa-deps && npm i jsdom)',
  '  CLAUDETTE_JSDOM=/tmp/qa-deps/node_modules/jsdom/lib/api.js npx tsx scratchpad/<test>.mts',
]
