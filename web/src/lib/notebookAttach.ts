// WHICH NEWLY-OPENED NOTEBOOKS ATTACH TO THE ACTIVE SESSION — the ordering half of App.tsx's
// notebook-restore effect, extracted so it can be tested without mounting Shell.
//
// This exists because of hazard H6 in store/sessionReducer.ts, which is an instance of a named
// pattern in this codebase: A GUARD THAT CONSUMES ITS INPUT BEFORE TESTING ITS PRECONDITION.
// The effect used to read:
//
//     if (seen.has(id)) continue
//     seen.add(id)                                       // <-- input consumed here
//     if (activeId && wasLocallyOpened(id)) setPane(…)   // <-- precondition tested here
//
// The dep array is `[openIds, activeId]`, so a re-run once `activeId` arrives was DELIBERATELY
// provided — and marking the id seen first defeated that retry permanently. In an async app
// "precondition not yet met" is the NORMAL first pass: the session list loads after the first
// render, so a notebook opened in that window was silently and permanently never attached. No
// error, no retry, and the tab simply never appears.
//
// The rule this encodes, and the reason `seen` is mutated HERE rather than by the caller:
// marking-seen and acting must be the same event. Splitting them across two statements is what
// let them drift apart in the first place, so they are kept adjacent and indivisible below.
//
// An id whose precondition is not met is deliberately left UNMARKED, which means it is
// re-tested on every subsequent run. That is the retry. It also keeps the removal pass in
// App.tsx correct: that pass iterates `seen` to prune tabs, so `seen` must hold exactly the
// ids that HAVE a tab. Every other site that creates a notebook tab (the focusPane handler and
// the layout-restore path) marks the id seen at the point it creates the tab, for the same
// reason — so an unmarked id is precisely one with no tab to prune, and cannot leak.

/** What the decision needs from the app: who is on screen, and who opened the notebook. */
export interface AttachContext {
  activeId: string | null
  /** False for a notebook a Claude tool pushed from the server — those attach to the CALLING
   *  session via the focusPane handler, and must never leak into whatever session the user
   *  happens to be looking at. */
  wasLocallyOpened: (id: string) => boolean
}

/**
 * Pick the ids to attach, marking each as seen ONLY as it is picked.
 *
 * MUTATES `seen` — deliberately, and only for ids it returns. The caller attaches exactly the
 * returned ids; the two must not be able to disagree.
 */
export function attachNewNotebooks(
  ids: readonly string[],
  seen: Set<string>,
  ctx: AttachContext,
): string[] {
  const attach: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    // PRECONDITION FIRST. Not yet actionable is not the same as handled: leave the id unmarked
    // so the next run — the one the dep array exists to provide — tries it again.
    if (!ctx.activeId || !ctx.wasLocallyOpened(id)) continue
    seen.add(id)
    attach.push(id)
  }
  return attach
}
