import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import { $prose } from '@milkdown/kit/utils'
import { findMatches, type FindOptions, type Match } from './findMatches'

// Find support for the markdown (Milkdown/ProseMirror) editor: the same query engine
// the code, diff, CSV and notebook bars use, over a rich-text tree instead of a flat
// document.
//
// The search runs per TEXTBLOCK (paragraph, heading, list item, code block) rather
// than over the whole document as one string. That keeps a match from silently
// spanning a paragraph break, and — because a textblock's `textBetween` renders each
// inline leaf (an image, a hard break) as exactly one character — every offset inside
// that string maps back to a document position by simple addition.

export interface ProseHit extends Match {
  /** Absolute document positions, ready for a decoration or a replacement. */
  docFrom: number
  docTo: number
}

export const findPluginKey = new PluginKey<DecorationSet>('claudetteFind')

/** Every occurrence of `query` in the document, in reading order. */
export function findInDoc(doc: ProseNode, query: string, opts: FindOptions): ProseHit[] {
  if (!query) return []
  const out: ProseHit[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // ' ' for leaves keeps offsets aligned with the node's own position arithmetic;
    // inside a textblock there are no nested blocks, so the block separator is moot.
    const text = node.textBetween(0, node.content.size, '\n', ' ')
    for (const m of findMatches(text, query, opts)) {
      out.push({ ...m, docFrom: pos + 1 + m.from, docTo: pos + 1 + m.to })
    }
    return false   // inline content is already covered by the string above
  })
  return out
}

interface Paint { hits: ProseHit[]; activeFrom: number | null }

// The plugin only paints. The React side owns the query and the current index, exactly
// as it does for the CodeMirror editors — so the bar behaves identically in both.
export const findHighlightPlugin = $prose(() => new Plugin<DecorationSet>({
  key: findPluginKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, deco) {
      const paint = tr.getMeta(findPluginKey) as Paint | undefined
      if (paint) {
        return DecorationSet.create(tr.doc, paint.hits.map((h) =>
          Decoration.inline(h.docFrom, h.docTo, {
            class: h.docFrom === paint.activeFrom ? 'pm-find-match pm-find-match-active' : 'pm-find-match',
          })))
      }
      // No new paint: carry the existing highlights through the change so they don't
      // flicker off while the user types next to one.
      return tr.docChanged ? deco.map(tr.mapping, tr.doc) : deco
    },
  },
  props: {
    decorations: (state) => findPluginKey.getState(state) ?? DecorationSet.empty,
  },
}))

/** Meta payload for a repaint — dispatch on a transaction to update the highlights. */
export const paintFind = (hits: ProseHit[], activeFrom: number | null): [PluginKey<DecorationSet>, Paint] =>
  [findPluginKey, { hits, activeFrom }]
