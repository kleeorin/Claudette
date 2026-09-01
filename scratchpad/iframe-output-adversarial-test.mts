// ADVERSARIAL tests for sandboxed-iframe rich outputs (proposal #3 — the ship gate).
//
// Every check here is an ATTACK. `✅ blocked` means the attack failed, which is the
// outcome we want; `🚨 SUCCEEDED` is a finding. Modelled on
// connectors-gpu-adversarial-test.mts — nothing here asserts that a feature works,
// only that it cannot be abused.
//
//   npx tsx scratchpad/iframe-output-adversarial-test.mts
//
// Threat model: kernel output is ATTACKER-CONTROLLED. Any library's `_repr_html_`, or a
// hand-crafted .ipynb opened from disk, can carry arbitrary HTML/JS. Proposal #3 lets that
// JS EXECUTE, inside `<iframe sandbox>` with a null origin. So the sandbox attribute is
// the entire security boundary, and the failure mode that matters is that someone later
// adds `allow-same-origin` to fix a rendering bug and the boundary silently evaporates
// with everything still looking correct on screen.
//
// PART A (pure logic, no deps, runs anywhere) — the token auditor + its own self-test.
// PART B (source scan, no deps)              — the shipped attribute must satisfy PART A.
// PART C (needs Chrome)                      — null-origin containment, proved live.
//
// PART A and B are the mechanical ship gate. PART C is the proof the gate is meaningful.
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
import { withMarks, passed as pass, failed as fail } from './assert.mjs'
// The mark IS the finding here — see withMarks in assert.mjs. `✅ blocked` and not a bare ✅,
// so a reader skimming a run cannot mistake "the escape was refused" for "a test passed".
const check = withMarks({ pass: '✅ blocked', fail: '🚨 SUCCEEDED', gap: '  ' })
let skipped = 0
const note = (s: string) => console.log(`   ${s}`)

// ════════════════════════════════════════════════════════════════════════════
// THE SPEC — owned by Critic. This is the ONLY block that should need editing
// when the required attribute set changes. Everything below derives from it.
// ════════════════════════════════════════════════════════════════════════════

// Tokens the iframe is permitted to carry. FAIL-CLOSED: anything not listed here is a
// finding, including a token invented after this test was written. That is deliberate —
// an explicit denylist can only catch attacks we already thought of.
const ALLOWED_SANDBOX_TOKENS = new Set<string>([
  'allow-scripts',
])

// Named purely so the report is legible about WHY each one is dangerous. Not the
// mechanism of the check — the allowlist above is.
const WHY_DANGEROUS: Record<string, string> = {
  'allow-same-origin': 'with allow-scripts the frame can reach parent DOM/cookies AND remove its own sandbox attribute',
  'allow-top-navigation': 'frame can navigate the operator away from the app (phishing)',
  'allow-top-navigation-by-user-activation': 'same as above behind a click',
  'allow-popups': 'frame can open windows that escape the sandbox',
  'allow-popups-to-escape-sandbox': 'explicitly un-sandboxes spawned windows',
  'allow-forms': 'frame can POST attacker data to a chosen endpoint',
  'allow-modals': 'frame can block the UI with dialogs',
  'allow-downloads': 'frame can push files at the operator',
  'allow-pointer-lock': 'frame can capture input',
  'allow-presentation': 'frame reaches presentation APIs',
  'allow-storage-access-by-user-activation': 'frame can request first-party storage',
}

// Where the feature is expected to live. Kept as a list so the test still finds it if
// the iframe is factored into its own component.
const CANDIDATE_SOURCES = [
  'web/src/components/notebook/Output.tsx',
  'web/src/components/notebook/RichOutput.tsx',
  'web/src/components/notebook/IframeOutput.tsx',
]

// ════════════════════════════════════════════════════════════════════════════
// PART A — the auditor, and proof that the auditor itself works.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== PART A — sandbox-attribute auditor (pure, no deps) ===\n')

interface Audit { ok: boolean; offending: string[]; tokens: string[] }

// Parse a sandbox attribute value and report every token outside the allowlist.
// Whitespace-separated per the HTML spec; comparison is case-insensitive because the
// HTML parser lowercases attribute keywords, so `Allow-Same-Origin` is live.
export function auditSandboxAttr(value: string): Audit {
  const tokens = value.trim().split(/\s+/).filter(Boolean).map((t) => t.toLowerCase())
  const offending = tokens.filter((t) => !ALLOWED_SANDBOX_TOKENS.has(t))
  return { ok: offending.length === 0, offending, tokens }
}

// The single most dangerous COMBINATION, called out separately because it is the one a
// well-meaning developer actually reaches for: allow-scripts + allow-same-origin lets the
// framed document call parent.document and delete its own sandbox attribute.
export function isSelfDefeatingCombo(value: string): boolean {
  const t = new Set(value.trim().toLowerCase().split(/\s+/))
  return t.has('allow-scripts') && t.has('allow-same-origin')
}

// A test whose own assertion logic is untested proves nothing. This table proves the
// auditor actually fires — if any of these rows stopped being detected, PART B would
// silently start passing on a dangerous attribute.
const AUDITOR_CASES: Array<{ attr: string; shouldBlock: boolean; label: string }> = [
  { attr: 'allow-scripts', shouldBlock: false, label: 'the sanctioned value is accepted' },
  { attr: '', shouldBlock: false, label: 'empty sandbox (maximally restrictive) is accepted' },
  { attr: 'allow-scripts allow-same-origin', shouldBlock: true, label: 'allow-same-origin alongside allow-scripts' },
  { attr: 'allow-same-origin', shouldBlock: true, label: 'allow-same-origin alone' },
  { attr: 'allow-scripts allow-top-navigation', shouldBlock: true, label: 'allow-top-navigation' },
  { attr: 'allow-scripts allow-popups', shouldBlock: true, label: 'allow-popups' },
  { attr: 'allow-scripts allow-forms', shouldBlock: true, label: 'allow-forms' },
  { attr: 'allow-scripts allow-modals', shouldBlock: true, label: 'allow-modals' },
  { attr: 'allow-scripts allow-downloads', shouldBlock: true, label: 'allow-downloads' },
  { attr: 'allow-scripts allow-popups-to-escape-sandbox', shouldBlock: true, label: 'allow-popups-to-escape-sandbox' },
  // Evasion attempts against the PARSER, not the policy.
  { attr: 'allow-scripts   allow-same-origin', shouldBlock: true, label: 'extra whitespace does not hide a token' },
  { attr: 'allow-scripts\tallow-same-origin', shouldBlock: true, label: 'tab separator does not hide a token' },
  { attr: 'allow-scripts\nallow-same-origin', shouldBlock: true, label: 'newline separator does not hide a token' },
  { attr: 'ALLOW-SAME-ORIGIN', shouldBlock: true, label: 'uppercase does not hide a token' },
  { attr: 'Allow-Same-Origin', shouldBlock: true, label: 'mixed case does not hide a token' },
  // The fail-closed property: a token nobody has heard of yet is STILL a finding.
  { attr: 'allow-scripts allow-future-token-invented-in-2027', shouldBlock: true, label: 'FAIL-CLOSED: unknown future token is rejected' },
]

for (const c of AUDITOR_CASES) {
  const a = auditSandboxAttr(c.attr)
  const detected = !a.ok
  const correct = detected === c.shouldBlock
  const why = c.shouldBlock && a.offending.length ? (WHY_DANGEROUS[a.offending[0]] ?? 'outside the allowlist') : ''
  check(`auditor: ${c.label}`, correct, c.shouldBlock ? (why || `offending=${a.offending.join(',')}`) : `sandbox="${c.attr}"`)
}

check('auditor: allow-scripts + allow-same-origin flagged as the self-defeating combo',
  isSelfDefeatingCombo('allow-scripts allow-same-origin'))
check('auditor: allow-scripts alone is NOT flagged as the combo (no false positive)',
  !isSelfDefeatingCombo('allow-scripts'))

// ════════════════════════════════════════════════════════════════════════════
// PART B — the shipped source must satisfy PART A.
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== PART B — shipped attribute scan ===\n')

const found = CANDIDATE_SOURCES.map((r) => path.join(repo, r)).filter(existsSync)
const sources = found.map((f) => ({ file: path.relative(repo, f), text: readFileSync(f, 'utf8') }))

// Every `sandbox=` attribute literal we can see in the rendering sources.
const attrs: Array<{ file: string; value: string }> = []
for (const s of sources) {
  // JSX: sandbox="…" or sandbox={'…'} / {"…"}; also setAttribute('sandbox', '…').
  for (const m of s.text.matchAll(/sandbox\s*=\s*\{?\s*["']([^"']*)["']/g)) attrs.push({ file: s.file, value: m[1] })
  for (const m of s.text.matchAll(/setAttribute\(\s*["']sandbox["']\s*,\s*["']([^"']*)["']/g)) attrs.push({ file: s.file, value: m[1] })
}

if (attrs.length === 0) {
  skipped++
  note(`no <iframe sandbox> found in ${sources.length} source file(s) — proposal #3 has not landed yet.`)
  note('PART B is INERT until it does. It becomes the ship gate the moment the attribute appears.')
  note(`scanned: ${sources.map((s) => s.file).join(', ') || '(none of the candidate paths exist)'}`)
} else {
  for (const a of attrs) {
    const audit = auditSandboxAttr(a.value)
    check(`${a.file}: sandbox="${a.value}" carries no token outside the allowlist`, audit.ok,
      audit.ok ? `tokens=[${audit.tokens.join(', ')}]`
               : audit.offending.map((t) => `${t} (${WHY_DANGEROUS[t] ?? 'outside the allowlist'})`).join('; '))
    check(`${a.file}: not the self-defeating allow-scripts+allow-same-origin combo`, !isSelfDefeatingCombo(a.value))
  }
}

// Independent of where the attribute lives: the dangerous tokens must not appear ANYWHERE
// in the rendering sources. This catches the attribute being assembled dynamically, which
// the literal scan above would miss entirely.
for (const s of sources) {
  const stripped = s.text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')  // ignore comments
  for (const tok of Object.keys(WHY_DANGEROUS)) {
    if (!stripped.includes(tok)) continue
    check(`${s.file}: source does not mention "${tok}"`, false, WHY_DANGEROUS[tok])
  }
}
if (sources.length) note(`scanned ${sources.length} source file(s) for dynamically-assembled tokens`)

// ════════════════════════════════════════════════════════════════════════════
// PART C — live null-origin containment (needs Chrome).
// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== PART C — live containment ===\n')

const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
if (!existsSync(CHROME)) {
  skipped++
  note(`SKIPPED: no Chrome at ${CHROME} (set CHROME_BIN). PART C is the only part needing a browser.`)
  note('It must assert, from INSIDE the frame, that all of these are unreachable:')
  note('  1. document.cookie is empty (the auth cookie does not cross the origin boundary)')
  note('  2. localStorage/sessionStorage access throws (null origin has no storage)')
  note('  3. fetch("/api/session/list") fails or returns 401 — no ambient credentials')
  note('  4. window.parent.document throws (cross-origin)')
  note('  5. window.top.location cannot be assigned (no top-navigation)')
  note('  6. the frame cannot remove its own sandbox attribute')
} else {
  note(`Chrome present at ${CHROME}; wire PART C against find-ui-check.mjs's harness`)
  note('(isolated PORT + CLAUDETTE_DATA_DIR + throwaway CLAUDETTE_TOKEN, /api/auth?token= to authenticate).')
  skipped++
}

console.log(`\n${pass} blocked, ${fail} finding(s), ${skipped} section(s) skipped`)
process.exit(fail === 0 ? 0 : 1)
