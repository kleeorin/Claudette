// STANDING GUARD: nothing in production may be wired to the unfinished path layer.
//
// `server/src/claude/sandboxPaths.ts` exports `viewOf`, `boxCanReach`, `refuseIfBoxCouldHavePlaced`
// and `overlayPathFor`. They are DESIGNED but not finished: the rule is that no caller may be
// wired to them until their preconditions are met, and until now that rule was enforced by a
// sentence in a comment. A rule enforced by a sentence is a rule enforced by nobody — this
// directory's founding lesson, applied to itself.
//
// ★ THIS GUARD IS SUPPOSED TO GO RED ONE DAY, AND THAT DAY IS NOT A BUG ★
// When the preconditions land and the first real caller is wired, this file WILL fail. The
// correct response is to RETIRE IT DELIBERATELY, in the same commit that wires that caller,
// with the reasoning for why the preconditions are now met written into that commit. The
// wrong response — and the only one that loses information — is to quietly delete it, or to
// add the new caller to an exemption list, because either turns "we decided this is ready"
// into "someone made the alarm stop". If you are reading this because it just went red and
// you did not wire anything, that is the real finding: something imported the layer by
// accident, and this file just did its job.
//
//   npx tsx scratchpad/layer-not-wired-guard.mts
// Exit: 0 clean, 1 a production file is wired to the layer (or this guard has gone blind).
import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// The file that DEFINES the layer is not a caller of it, so it is excluded — but see the
// self-check below, which is what stops that exclusion from being a hole.
const DEFINER = 'server/src/claude/sandboxPaths.ts'
const SCOPE = ['server/src', 'shared/src']
const WATCHED = ['viewOf', 'boxCanReach', 'refuseIfBoxCouldHavePlaced', 'overlayPathFor']

let fail = 0
const bad = (msg: string): void => { fail++; console.log(`  ❌ ${msg}`) }

// Quote-aware, LENGTH-PRESERVING comment stripper, so a symbol NAMED IN A COMMENT — which is
// exactly how the standing rule is written down today — is not reported as a wiring. Length
// preservation keeps line numbers honest; quote-awareness matters because a naive `//` strip
// eats the rest of any line containing a URL or a `path//like/this` string.
function stripComments(src: string): string {
  const out = src.split('')
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++ } continue }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++ }
      out[i] = ' '; out[i + 1] = ' '; i += 2
      continue
    }
    i++
  }
  return out.join('')
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

// ── SELF-CHECK, and it is the most important part of this file ───────────────────────
// A guard that watches for a name that no longer exists is PERMANENTLY GREEN, which is
// indistinguishable from a guard that passes — the precise failure that let escape 6 sit
// unnoticed behind an unregistered test while two handovers called it covered. So before
// asserting anything about callers, prove this guard can still see its subject: the definer
// must exist, and every watched symbol must still be exported from it. Rename any of them
// and this fails LOUDLY instead of going quiet.
console.log('── self-check: can this guard still see what it watches? ──')
const definerPath = path.join(ROOT, DEFINER)
if (!existsSync(definerPath)) {
  bad(`the definer ${DEFINER} does not exist — it was moved or renamed. This guard is BLIND until DEFINER is updated.`)
  // STOP HERE. Running the rule anyway is worse than not running it: with the exclusion no
  // longer matching, the definer itself gets reported as a wired production file, four times,
  // and every one of those messages says "the path layer is WIRED" about the file that
  // DEFINES it. That is four confident, wrong sentences on top of the one true one, and it
  // sends the reader hunting a caller that does not exist. Same rule as the parse gate in
  // port-and-reap-lint: a check must not report on a subject it has failed to locate.
  console.log('\n  (rule NOT run — with the definer unlocated every result below would be noise)')
  console.log(`\n${fail} violation(s)`)
  process.exit(1)
} else {
  const definer = stripComments(readFileSync(definerPath, 'utf8'))
  for (const sym of WATCHED) {
    if (!new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let)\\s+${sym}\\b`).test(definer)) {
      bad(`\`${sym}\` is no longer exported from ${DEFINER} — renamed or removed. This guard was watching a name that does not exist, which is a guard that can never fire. Update WATCHED.`)
    }
  }
  if (!fail) console.log(`  ✅ ${DEFINER} exports all ${WATCHED.length} watched symbols`)
}

// ── THE RULE ─────────────────────────────────────────────────────────────────────────
// Deliberately an OCCURRENCE check rather than an import-clause check, and the direction of
// that choice is on purpose. An import-clause parser misses `import * as sp` + `sp.viewOf(…)`,
// a `require` destructure, and a re-export — three ways to be wired that do not look like an
// import of the name. Any MENTION of these symbols in production code is worth a human
// looking at it, so over-approximating here errs toward a red that a person resolves in
// seconds rather than a green that hides a wiring. Comments are stripped first, so the
// standing rule can go on being WRITTEN DOWN in prose without tripping its own guard.
console.log('\n── rule: no production file may reference the unwired path layer ──')
const scanned: string[] = []
for (const rel of SCOPE) {
  const dir = path.join(ROOT, rel)
  if (!existsSync(dir)) { bad(`scope directory ${rel} does not exist — SCOPE is stale and this guard is not looking where it thinks it is.`); continue }
  for (const file of walk(dir)) {
    const relFile = path.relative(ROOT, file)
    if (relFile === DEFINER) continue
    scanned.push(relFile)
    const src = stripComments(readFileSync(file, 'utf8'))
    for (const sym of WATCHED) {
      if (new RegExp(`\\b${sym}\\b`).test(src)) {
        bad(`${relFile} references \`${sym}\` — the path layer is WIRED. If that was deliberate, retire this guard in the same commit; if not, this is the accident it exists to catch.`)
      }
    }
  }
}
if (!fail) console.log(`  ✅ none of ${scanned.length} files under ${SCOPE.join(' / ')} references the layer`)

// Scope note, printed rather than merely true: the two scratchpad files that DO use these
// symbols are tests of the layer itself and are deliberately outside SCOPE. They are what
// keeps the layer honest while it is unwired, so a version of this guard that flagged them
// would be arguing against its own purpose.
console.log('\n  (scratchpad/sandbox-paths-test.mts and scratchpad/mount-shadowing-guard.mts')
console.log('   use these symbols on purpose — they test the layer. Out of scope by design.)')

console.log(`\n${fail === 0 ? 'clean — the layer is still unwired' : `${fail} violation(s)`}`)
process.exit(fail === 0 ? 0 : 1)
