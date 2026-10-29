// HAZARD H6 (web/src/store/sessionReducer.ts), tested. Pure, no DOM, no browser — possible
// because the ordering rule was extracted out of App.tsx's effect into a plain function.
//
//   npx tsx scratchpad/notebook-attach-test.mts
//
// THE BUG THIS PINS. App.tsx's notebook-restore effect used to read:
//
//     if (seen.has(id)) continue
//     seen.add(id)                                       // <-- input consumed here
//     if (activeId && wasLocallyOpened(id)) setPane(…)   // <-- precondition tested here
//
// The dep array is `[openIds, activeId]`, so a re-run once `activeId` arrives was DELIBERATELY
// provided — and marking the id seen first defeated that retry permanently. The session list
// loads async, so "activeId is not here yet" is the NORMAL first pass, not an edge case: a
// notebook opened in that window was never attached, silently, with no error and no retry.
//
// TEST 2 IS THE POINT OF THIS FILE. The rest is cheap coverage of the neighbouring behaviour;
// test 2 is the one that fails against the old ordering.
//
// WHAT THIS FILE CANNOT DO, stated so it is not read as more than it is: it tests the ORDERING
// RULE, not App.tsx's effect. It cannot prove the effect re-runs when `activeId` arrives — that
// is the dep array's job and asserting it needs Shell mounted with a live notebooks store.
// What it proves is that IF the effect re-runs, the retry now succeeds; under the old ordering
// it could not, whatever the dep array said. Note also there is a `web/src/store/
// sessions.test.tsx` in the tree that would be the natural home for a React-level version.
// When this was written `vitest` was neither installed nor declared in web/package.json, so
// that file could not be executed at all — hence this, in the style of session-reducer-test.
// THAT IS NO LONGER TRUE: vitest is declared, sessions.test.tsx runs, and the whole web suite
// is now a suite member via scratchpad/web-vitest-shim.mjs. This file stays as it is anyway —
// it is pure, costs ~3ms, and needs no DOM to pin what it pins.
import { attachNewNotebooks } from '../web/src/lib/notebookAttach'

import { check, passed as pass, failed as fail } from './assert.mjs'

// localOpener: the session a notebook was opened FROM by this client, or null (server-pushed).
const local = () => 's1'
const remote = () => null

{
  const seen = new Set<string>()
  const got = attachNewNotebooks(['nb1'], seen, { activeId: 's1', localOpener: local })
  check('1 a locally-opened notebook attaches once a session is active',
    got.join() === 'nb1' && [...seen].join() === 'nb1', `got ${got.join()}, seen ${[...seen].join()}`)
}

{
  // *** THE H6 REGRESSION. ***
  const seen = new Set<string>()
  const first = attachNewNotebooks(['nb1'], seen, { activeId: null, localOpener: local })
  // SNAPSHOT the state between the two calls. Reading `seen` after the second call and
  // describing it as "seen-after-first" printed "CONSUMED — this is the bug" on a PASSING run,
  // because by then the second call had legitimately marked the id. A diagnostic that lies on
  // green is worse than none: it is read on the day it goes red, when it will still be wrong.
  const seenAfterFirst = [...seen]
  const second = attachNewNotebooks(['nb1'], seen, { activeId: 's1', localOpener: local })
  check('2 an id whose precondition was not yet met is RETRIED, not consumed',
    first.length === 0 && seenAfterFirst.length === 0 && second.join() === 'nb1',
    `first ${JSON.stringify(first)}, seen after first ${JSON.stringify(seenAfterFirst)}` +
    (seenAfterFirst.length ? ' (CONSUMED — this is the bug)' : '') + `, second ${JSON.stringify(second)}`)
}

{
  const seen = new Set<string>()
  const ctx = { activeId: 's1', localOpener: local }
  attachNewNotebooks(['nb1'], seen, ctx)
  const again = attachNewNotebooks(['nb1'], seen, ctx)
  check('3 an id is never attached twice', again.length === 0, `second call returned ${JSON.stringify(again)}`)
}

{
  // A Claude-opened notebook attaches to the CALLING session via the focusPane handler, which
  // marks it seen itself at the point it creates the tab. Leaving it unmarked here is correct
  // AND safe for App.tsx's removal pass: that pass prunes by iterating `seen`, so `seen` must
  // hold exactly the ids that HAVE a tab. An unmarked id is one with no tab to prune, so it can
  // neither leak nor be double-pruned.
  const seen = new Set<string>()
  const got = attachNewNotebooks(['nb1'], seen, { activeId: 's1', localOpener: remote })
  check('4 a server-pushed notebook is left unmarked, so focusPane still owns it',
    got.length === 0 && seen.size === 0, `got ${JSON.stringify(got)}, seen ${seen.size}`)
}

{
  const seen = new Set<string>()
  const isLocal = (id: string) => id !== 'nb2' ? 's1' : null
  const got = attachNewNotebooks(['nb1', 'nb2', 'nb3'], seen, { activeId: 's1', localOpener: isLocal })
  check('5 out of a mixed batch, only the attached ids are marked (nb2 stays retryable)',
    got.join() === 'nb1,nb3' && [...seen].sort().join() === 'nb1,nb3', `got ${got.join()}, seen ${[...seen].sort().join()}`)
}

{
  // *** THE CROSS-SESSION LEAK (operator report 2026-10-28: "working on a notebook in session A,
  // switch to session B, the notebook opens there as well"). The ws `notebook:update` raced
  // ahead of the HTTP reply, so the first effect pass saw the id as not-yet-local and left it
  // unmarked; the session switch re-ran the effect with activeId = B and attached A's notebook
  // to B. With the opener recorded, the switch must attach NOTHING.
  const seen = new Set<string>()
  let opener: string | null = null                       // reply not in yet → not local
  const ctx = (activeId: string) => ({ activeId, localOpener: () => opener })
  const racedFirst = attachNewNotebooks(['nbA'], seen, ctx('A'))
  opener = 'A'                                           // HTTP reply lands: opened from A
  const afterSwitch = attachNewNotebooks(['nbA'], seen, ctx('B'))
  check('6 a notebook opened in A never attaches to B on a session switch',
    racedFirst.length === 0 && afterSwitch.length === 0 && !seen.has('nbA'),
    `first ${JSON.stringify(racedFirst)}, after switch to B ${JSON.stringify(afterSwitch)}, seen ${[...seen].join()}`)
  const back = attachNewNotebooks(['nbA'], seen, ctx('A'))
  check('7 …and it still attaches to A, its opener, when A is on screen',
    back.join() === 'nbA' && seen.has('nbA'), `back in A ${JSON.stringify(back)}`)
}

{
  // A local open with no session (opened before any session existed) has opener null: it must
  // not adopt whatever session appears later.
  const seen = new Set<string>()
  const got = attachNewNotebooks(['nb1'], seen, { activeId: 's9', localOpener: () => null })
  check('8 an opener-less notebook attaches to no session', got.length === 0, `got ${JSON.stringify(got)}`)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
