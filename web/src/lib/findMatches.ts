// The one search engine behind every editor's find bar — CodeMirror (code + diff),
// Milkdown (markdown), the CSV grid and the notebook. They differ in what they search
// (a doc, a ProseMirror tree, a cell matrix) but agree on what a query MEANS, so the
// matching, the options and the replacement semantics live here rather than being
// re-invented four times with four slightly different answers.

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export const defaultFindOptions: FindOptions = { caseSensitive: false, wholeWord: false, regex: false }

export interface Match {
  from: number
  to: number
  /** Capture groups, for `$1`-style replacements. Only populated in regex mode. */
  groups?: (string | undefined)[]
  /** The matched text — needed to expand `$&` without re-slicing the source. */
  text: string
}

// A search never scans forever: a pathological query on a big file (say `.*` over a
// megabyte) would otherwise build a million decorations and lock the tab. Past this
// the match list is truncated — callers surface it as "1000+".
export const MATCH_LIMIT = 10_000

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Compile a query to a global RegExp, or null if it's empty / an invalid pattern.
// Whole-word uses lookarounds rather than `\b` so it also works when the query
// starts or ends with punctuation (`\bfoo(\b` never matches; `(?<!\w)foo\((?!\w)` does).
export function compileQuery(query: string, opts: FindOptions): RegExp | null {
  if (!query) return null
  let body = opts.regex ? query : escapeRegExp(query)
  if (opts.wholeWord) body = `(?<!\\w)(?:${body})(?!\\w)`
  try {
    return new RegExp(body, `gm${opts.caseSensitive ? '' : 'i'}`)
  } catch {
    return null   // half-typed regex — the bar shows it as invalid
  }
}

/** True when the user typed a pattern that can't compile (regex mode only). */
export function isInvalidQuery(query: string, opts: FindOptions): boolean {
  return !!query && opts.regex && compileQuery(query, opts) === null
}

// Every occurrence of `query` in `text`, in document order.
export function findMatches(text: string, query: string, opts: FindOptions): Match[] {
  const re = compileQuery(query, opts)
  if (!re) return []
  const out: Match[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      text: m[0],
      groups: opts.regex && m.length > 1 ? m.slice(1) : undefined,
    })
    // A pattern that can match nothing (`a*`, `^`) leaves lastIndex where it was —
    // step it manually or exec() spins on the same offset forever.
    if (m[0].length === 0) re.lastIndex++
    if (out.length >= MATCH_LIMIT) break
  }
  return out
}

// The text a match should be replaced WITH. In regex mode `$&` and `$1`…`$9` expand
// against that match's captures (so a capture-based rewrite works like it does in an
// editor's replace field); `$$` is a literal `$`. In plain mode the replacement is
// taken literally — a `$` typed into the box is a dollar sign, not a directive.
export function expandReplacement(replacement: string, match: Match, opts: FindOptions): string {
  if (!opts.regex) return replacement
  return replacement.replace(/\$(\$|&|\d)/g, (_, k: string) => {
    if (k === '$') return '$'
    if (k === '&') return match.text
    return match.groups?.[Number(k) - 1] ?? ''
  })
}

// Apply replacements to a flat string, given matches over that same string. Used by
// the editors that own their text outright (CSV cells, ProseMirror text nodes); the
// CodeMirror ones dispatch changes instead so undo history stays intact.
export function replaceRanges(text: string, matches: Match[], replacement: string, opts: FindOptions): string {
  let out = ''
  let at = 0
  for (const m of matches) {
    out += text.slice(at, m.from) + expandReplacement(replacement, m, opts)
    at = m.to
  }
  return out + text.slice(at)
}

// Index of the first match at or after `offset`, wrapping to 0 when everything is
// behind it. Lets a fresh search start from where the user is looking rather than
// yanking them to the top of the file.
export function firstMatchFrom(matches: Match[], offset: number): number {
  const i = matches.findIndex((m) => m.from >= offset)
  return i === -1 ? 0 : i
}

/** Step an index around a ring of `count` matches; returns 0 for an empty ring. */
export function stepIndex(index: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0
  return (((index + dir) % count) + count) % count
}
