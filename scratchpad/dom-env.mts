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
// WHY THIS EXISTS: `jsdom` is a devDependency (approved 2026-08-21) added for the notebook
// output sanitizer, which is security-critical and had zero tests because DOMPurify cannot
// run without a `window`. It is deliberately NOT a test runner — the suite is still ~50
// standalone scripts sequenced by run-suite.sh, and each one still owns its own asserts and
// exit code.
//
// IT IS ALSO THE SEAM FOR THE NEXT WEB TEST. The chat store (web/src/store/chat.tsx) is the
// obvious next candidate: its reducer is pure and per-session, and the only reason it was
// untestable was the missing DOM. Anything that needs React DOM rendering will need more
// globals than this installs — add them HERE, to `DOM_GLOBALS`, rather than patching them
// in at the call site.
//
// The `CLAUDETTE_JSDOM` escape hatch: a CONFINED session mounts `node_modules` read-only
// (that is the sandbox working as designed), so `npm i` cannot run there and a plain
// `import('jsdom')` fails even though the dependency is declared. Point that env var at an
// out-of-tree install to run these tests from inside a box. Ordinary runs never need it.

// Globals a jsdom window must publish for DOM-consuming library code to work. DOMPurify
// needs the node/element constructors for its `instanceof` checks; the rest are what
// browser code reaches for without thinking.
const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'location',
  'Node', 'Element', 'HTMLElement', 'HTMLTemplateElement', 'HTMLFormElement',
  'DocumentFragment', 'DOMParser', 'XMLSerializer', 'NodeFilter',
  'Text', 'Comment', 'CustomEvent', 'Event', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
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
export const NO_DOM_NOTE = [
  'no DOM available: `jsdom` could not be imported.',
  'Normally that means `npm i` has not been run since jsdom was added as a devDependency.',
  'Inside a CONFINED session node_modules is mounted read-only, so install it out of tree',
  'and point CLAUDETTE_JSDOM at it, e.g.:',
  '  mkdir -p /tmp/qa-deps && (cd /tmp/qa-deps && npm i jsdom)',
  '  CLAUDETTE_JSDOM=/tmp/qa-deps/node_modules/jsdom/lib/api.js npx tsx scratchpad/<test>.mts',
]
