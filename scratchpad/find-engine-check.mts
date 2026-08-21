// Unit checks for the shared find engine — the part every editor's bar delegates to.
// Covers the matcher (plain / case / whole-word / regex), replacement expansion, and
// the ProseMirror walk the markdown editor uses to turn a rich-text tree into offsets.
//   npx tsx scratchpad/find-engine-check.mts
import {
  findMatches, compileQuery, isInvalidQuery, expandReplacement, replaceRanges,
  firstMatchFrom, stepIndex, defaultFindOptions, MATCH_LIMIT, type FindOptions,
} from '../web/src/lib/findMatches'
import { findInDoc } from '../web/src/lib/proseSearch'
import { Schema } from '@milkdown/kit/prose/model'

let fails = 0
const eq = (actual: unknown, expected: unknown, label: string) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
  if (!ok) fails++
}
const opts = (o: Partial<FindOptions> = {}): FindOptions => ({ ...defaultFindOptions, ...o })
const spans = (text: string, q: string, o?: Partial<FindOptions>) =>
  findMatches(text, q, opts(o)).map((m) => [m.from, m.to])

console.log('\n[matcher]')
eq(spans('alpha beta alpha', 'alpha'), [[0, 5], [11, 16]], 'plain query finds both occurrences')
eq(spans('Alpha alpha', 'alpha'), [[0, 5], [6, 11]], 'case-insensitive by default')
eq(spans('Alpha alpha', 'alpha', { caseSensitive: true }), [[6, 11]], 'match case narrows to the exact one')
eq(spans('cat concat cat.', 'cat', { wholeWord: true }), [[0, 3], [11, 14]], 'whole word skips the substring in "concat"')
eq(spans('a.b axb', 'a.b'), [[0, 3]], 'plain query treats "." literally')
eq(spans('a.b axb', 'a.b', { regex: true }), [[0, 3], [4, 7]], 'regex query treats "." as a wildcard')
eq(spans('x1 x22 x333', '\\d+', { regex: true }), [[1, 2], [4, 6], [8, 11]], 'regex \\d+ finds all runs')
eq(spans('foo\nbar', '^bar', { regex: true }), [[4, 7]], 'regex ^ is per-line (m flag)')
eq(spans('anything', ''), [], 'empty query matches nothing')
eq(compileQuery('a(', opts({ regex: true })), null, 'a broken regex compiles to null')
eq(isInvalidQuery('a(', opts({ regex: true })), true, 'the bar can tell a broken regex')
eq(isInvalidQuery('a(', opts()), false, '…but "a(" is a fine LITERAL query')

// A pattern that can match the empty string must still terminate.
const zeroLen = findMatches('abc', 'x*', opts({ regex: true }))
eq(zeroLen.length <= MATCH_LIMIT && zeroLen.length > 0, true, 'zero-length matches terminate instead of spinning')

console.log('\n[replacement]')
const m1 = findMatches('hello world', 'world', opts())[0]
eq(expandReplacement('there', m1, opts()), 'there', 'plain replacement is literal')
eq(expandReplacement('$1-$&', m1, opts()), '$1-$&', 'plain mode does NOT expand $ directives')
const m2 = findMatches('key=value', '(\\w+)=(\\w+)', opts({ regex: true }))[0]
eq(expandReplacement('$2=$1', m2, opts({ regex: true })), 'value=key', 'regex mode expands captures')
eq(expandReplacement('[$&]', m2, opts({ regex: true })), '[key=value]', 'regex mode expands $&')
eq(expandReplacement('$$1', m2, opts({ regex: true })), '$1', '$$ is a literal dollar')
eq(
  replaceRanges('a b a b', findMatches('a b a b', 'a', opts()), 'X', opts()),
  'X b X b', 'replaceRanges rewrites every match',
)
eq(
  replaceRanges('one two', findMatches('one two', '(\\w+) (\\w+)', opts({ regex: true })), '$2 $1', opts({ regex: true })),
  'two one', 'replaceRanges expands captures per match',
)

console.log('\n[navigation]')
const nav = findMatches('a a a a', 'a', opts())
eq(firstMatchFrom(nav, 0), 0, 'a search from the top starts at match 1')
eq(firstMatchFrom(nav, 3), 2, 'a search from mid-doc starts at the next match below')
eq(firstMatchFrom(nav, 99), 0, '…and wraps when nothing follows')
eq([stepIndex(0, 4, 1), stepIndex(3, 4, 1), stepIndex(0, 4, -1)], [1, 0, 3], 'stepping wraps both ways')
eq(stepIndex(0, 0, 1), 0, 'stepping an empty ring stays at 0')

console.log('\n[prose walk]')
// A minimal schema shaped like the markdown editor's: blocks of inline text, plus an
// inline leaf (image) to prove leaves keep the offsets aligned.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: { group: 'block', content: 'inline*', toDOM: () => ['h1', 0] },
    text: { group: 'inline' },
    image: { group: 'inline', inline: true, toDOM: () => ['img'] },
  },
  marks: { strong: { toDOM: () => ['strong', 0] } },
})
const { paragraph, heading, image, text } = {
  paragraph: (...c: any[]) => schema.nodes.paragraph.create(null, c),
  heading: (...c: any[]) => schema.nodes.heading.create(null, c),
  image: () => schema.nodes.image.create(),
  text: (s: string, marks?: any[]) => schema.text(s, marks),
}
const strong = schema.marks.strong.create()

const doc = schema.nodes.doc.create(null, [
  heading(text('Notes')),
  paragraph(text('The word target appears here.')),
  paragraph(text('target in a list item')),
  paragraph(text('A paragraph mentioning target once more.')),
])
const hits = findInDoc(doc, 'target', opts())
eq(hits.length, 3, 'finds every occurrence across blocks')
// Positions must actually address the matched text in the document.
eq(hits.map((h) => doc.textBetween(h.docFrom, h.docTo)), ['target', 'target', 'target'],
  'each hit maps back to the exact document range')

// A match must not run across a paragraph boundary.
const twoPara = schema.nodes.doc.create(null, [paragraph(text('foo')), paragraph(text('bar'))])
eq(findInDoc(twoPara, 'foobar', opts()).length, 0, 'a match cannot span a block boundary')

// An inline leaf before the match must not shift the offsets.
const withLeaf = schema.nodes.doc.create(null, [paragraph(image(), text(' after target here'))])
const leafHit = findInDoc(withLeaf, 'target', opts())[0]
eq(withLeaf.textBetween(leafHit.docFrom, leafHit.docTo), 'target', 'an inline leaf keeps offsets aligned')

// Text split across marks: "hello **world**" is two text nodes in one paragraph, and
// the phrase should still be findable as one run.
const marked = schema.nodes.doc.create(null, [paragraph(text('hello '), text('world', [strong]))])
const markedHit = findInDoc(marked, 'hello world', opts())[0]
eq(!!markedHit && marked.textBetween(markedHit.docFrom, markedHit.docTo) === 'hello world',
  true, 'a phrase split across marks still matches as one run')

console.log(fails === 0 ? '\n✅ all engine checks passed' : `\n❌ ${fails} check(s) failed`)
process.exit(fails === 0 ? 0 : 1)
