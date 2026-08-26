// Pins the notebook-output sanitizer (web/src/components/notebook/Output.tsx) — a
// security boundary that had ZERO tests while carrying the whole defence against
// attacker-controlled kernel HTML.
//
//   npx tsx scratchpad/output-sanitizer-test.mts
//
// WHY THIS IS LOAD-BEARING: any library's `_repr_html_`, or a hand-crafted .ipynb opened
// from disk, is attacker-controlled. Rendered raw it executes in the app's AUTHENTICATED
// origin, which holds the full fs / pane / git API — and a sandboxed kernel's HTML would
// escape confinement through the operator's browser. DOMPurify's default profile stops
// script execution but still permits markup that makes the browser issue EXTERNAL
// requests (<img src>, <style>, @import, <link>), which from kernel output is a
// tracking / exfil / tailnet-SSRF channel. The afterSanitizeAttributes hook closes that.
//
// PART 1 needs a DOM (DOMPurify cannot run headless without one) and SKIPS cleanly when
// no shim is installed. PART 2 is a dependency-free static guard on the ROUTING — that a
// renderer added later cannot quietly divert output around the sanitizer.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { setupDom, NO_DOM_NOTE } from './dom-env.mts'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0, skipped = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}
const note = (s: string) => console.log(`   ${s}`)

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — the sanitizer's behavioural invariants (needs a DOM shim)
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== PART 1 — sanitizeHtml invariants ===\n')

const dom = await setupDom()

if (!dom) {
  skipped++
  for (const line of NO_DOM_NOTE) note(line)
} else {
  // Build the sanitizer against a real DOM. Import Output.tsx for the REAL function
  // rather than reconstructing the config here — a copy would drift and pass while the
  // shipped hook rotted, which is the exact failure this test exists to prevent.
  const { sanitizeHtml } = await import('../web/src/components/notebook/Output.tsx')
  const clean = (s: string) => sanitizeHtml(s)
  const has = (out: string, frag: string) => out.toLowerCase().includes(frag.toLowerCase())

  // 1. Script execution.
  const s1 = clean('<div>ok</div><script>fetch("/api/session/list")</script>')
  check('<script> is stripped', !has(s1, '<script'), `→ ${s1}`)
  check('...but benign markup survives (pandas tables must still render)', has(s1, '<div>ok</div>'))

  const s1b = clean('<img src=x onerror="fetch(\'/api/fs/read?p=/etc/passwd\')">')
  check('inline event handlers (onerror) are stripped', !has(s1b, 'onerror'), `→ ${s1b}`)

  // 2. Remote resource loads — the exfil / SSRF channel the hook closes.
  const s2 = clean('<img src="http://evil.example/track.png">')
  check('<img src=http://…> loses its src (no remote fetch)', !has(s2, 'evil.example'), `→ ${s2}`)

  const s2b = clean('<img src="data:image/png;base64,iVBORw0KGgo=">')
  check('...but a data: image SURVIVES (inline plots must still render)', has(s2b, 'data:image/png'), `→ ${s2b}`)

  for (const attr of ['srcset', 'poster', 'background']) {
    const out = clean(`<video ${attr}="http://evil.example/x">`)
    check(`remote ${attr} is dropped`, !has(out, 'evil.example'), `→ ${out}`)
  }

  // 3. Stylesheet channels — FORBID_TAGS plus the inline-style rule.
  for (const tag of ['style', 'link', 'base']) {
    const out = clean(`<${tag}>x</${tag}>`)
    check(`<${tag}> is removed`, !has(out, `<${tag}`), `→ ${out}`)
  }
  const s3 = clean('<div style="background:url(http://evil.example/x)">hi</div>')
  check('inline style with url() is removed', !has(s3, 'evil.example'), `→ ${s3}`)
  const s3b = clean('<div style="@import url(http://evil.example/x)">hi</div>')
  check('inline style with @import is removed', !has(s3b, 'evil.example'), `→ ${s3b}`)
  const s3c = clean('<div style="color:red">hi</div>')
  check('...but a benign inline style survives', has(s3c, 'color'), `→ ${s3c}`)

  // 4. Anchors keep navigation but leak nothing.
  const s4 = clean('<a href="https://example.com/docs">docs</a>')
  check('<a href> gains rel=noopener noreferrer', has(s4, 'noopener') && has(s4, 'noreferrer'), `→ ${s4}`)
  check('<a href> gains target=_blank', has(s4, 'target'), `→ ${s4}`)

  // 5. javascript: URLs.
  const s5 = clean('<a href="javascript:fetch(\'/api/session/list\')">click</a>')
  check('javascript: URL is dropped', !has(s5, 'javascript:'), `→ ${s5}`)
  const s5b = clean('<a href="JaVaScRiPt:alert(1)">click</a>')
  check('javascript: URL is dropped regardless of case', !has(s5b, 'javascript:'), `→ ${s5b}`)

  // 6. SVG resource refs — same rule, different attribute names.
  const s6 = clean('<svg><image href="http://evil.example/x.png"/></svg>')
  check('SVG <image href> remote ref is dropped', !has(s6, 'evil.example'), `→ ${s6}`)
  // The hook keeps in-document fragment refs (#id) — verified on <image>, which survives
  // sanitization. NOT on <use>: DOMPurify removes that element outright (see below), so it
  // is the wrong probe for this branch even though the hook's comment names it.
  const s6b = clean('<svg><image href="#local"/></svg>')
  check('...but an in-document fragment ref (#id) survives on <image>', has(s6b, '#local'), `→ ${s6b}`)

  // <use> is dropped ENTIRELY by DOMPurify's own SVG policy, whatever its href — the
  // classic xlink:href SVG-XSS vector. Stricter than the hook, and worth pinning: a future
  // config change that re-admitted <use> would hand that vector back silently.
  for (const u of ['<svg><use xlink:href="#local"/></svg>', '<svg><use href="http://evil.example/x#a"/></svg>']) {
    const out = clean(u)
    check(`<use> is removed outright (${u.includes('http') ? 'remote' : 'local'} ref)`, !has(out, '<use'), `→ ${out}`)
  }

  dom.cleanup()
}

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — routing: nothing renders kernel HTML around the sanitizer.
// Dependency-free, so it guards the boundary starting today.
//
// Adapted to the JSON-bundle plan: recognised `application/vnd.*+json` bundles get a
// pinned in-app renderer with no kernel-authored script. That renderer must not become a
// second, unsanitized path for ORDINARY output — a bundle without a recognised JSON mime
// must still reach sanitizeHtml.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== PART 2 — routing guard (static) ===\n')

const OUTPUT_SOURCES = [
  'web/src/components/notebook/Output.tsx',
  'web/src/components/notebook/RichOutput.tsx',
  'web/src/components/notebook/JsonBundleOutput.tsx',
].map((r) => path.join(repo, r)).filter(fs.existsSync)

for (const abs of OUTPUT_SOURCES) {
  const rel = path.relative(repo, abs)
  const text = fs.readFileSync(abs, 'utf8')

  // Every dangerouslySetInnerHTML must be fed a SANITIZED value. The shipped code binds
  // `cleanHtml` / `cleanSvg` (both `useMemo(() => sanitizeHtml(...))`). A raw mime value
  // here is the regression: `__html: html` instead of `__html: cleanHtml`.
  const sinks = [...text.matchAll(/dangerouslySetInnerHTML\s*=\s*\{\{\s*__html:\s*([A-Za-z0-9_.]+)/g)].map((m) => m[1])
  for (const v of sinks) {
    const sanitized = /^clean/i.test(v) || /sanitiz/i.test(v)
    check(`${rel}: dangerouslySetInnerHTML is fed a sanitized value (__html: ${v})`, sanitized,
      sanitized ? '' : `"${v}" is not a sanitize* / clean* binding — kernel HTML may reach the DOM raw`)
  }
  if (sinks.length) note(`${rel}: ${sinks.length} innerHTML sink(s) checked`)

  // The two attacker-controlled mimes must still be routed through the sanitizer.
  if (text.includes("'text/html'")) {
    check(`${rel}: text/html still flows through sanitizeHtml`,
      /sanitizeHtml\(\s*html/.test(text) || /clean[A-Za-z]*\s*=\s*useMemo\([^)]*sanitizeHtml/.test(text))
  }
  if (text.includes("'image/svg+xml'")) {
    check(`${rel}: image/svg+xml still flows through sanitizeHtml`,
      /sanitizeHtml\(\s*svg/.test(text) || /clean[A-Za-z]*\s*=\s*useMemo\([^)]*sanitizeHtml/.test(text))
  }

  // The sanitizer's hardening must not be quietly relaxed.
  if (text.includes('DOMPurify.sanitize')) {
    for (const tag of ['style', 'link', 'base']) {
      check(`${rel}: FORBID_TAGS still lists '${tag}'`, new RegExp(`FORBID_TAGS[^\\]]*'${tag}'`).test(text))
    }
    check(`${rel}: no ALLOWED_URI_REGEXP widening`, !text.includes('ALLOWED_URI_REGEXP'))
    // Exactly ONE sanitize call site. A second one is how a new renderer acquires its own,
    // weaker config (no FORBID_TAGS, hook not applied) while the original stays intact and
    // this file's other checks keep passing.
    const sites = (text.match(/DOMPurify\.sanitize\(/g) ?? []).length
    check(`${rel}: exactly one DOMPurify.sanitize call site (found ${sites})`, sites === 1)
    // Turning the hook off, or allowing all data URIs through as scripts, would both be
    // invisible on screen.
    check(`${rel}: the afterSanitizeAttributes hook is still installed`, text.includes('afterSanitizeAttributes'))
  }
}
if (!OUTPUT_SOURCES.length) { skipped++; note('no output sources found — nothing to guard') }

console.log(`\n${pass} passed, ${fail} failed, ${skipped} section(s) skipped`)
process.exit(fail === 0 ? 0 : 1)
