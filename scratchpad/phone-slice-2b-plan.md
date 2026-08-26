# Phone-native layout — SLICE 2B PLAN

_Authored by PM (planner) 2026-08-25. Persisted by the coordinator because PM is read-only and
was near a context clear; the plan otherwise existed only inside one session._

**Scope: 2B only** = pane hooks + the phone breakpoint single source of truth + one-pane-at-a-time.

## Coordinator rulings (both requested by PM, both APPROVED)

1. **2B takes the three divider `hidden md:block` edits**, reassigned from slice 5. Slice 5 keeps
   `env(safe-area-inset-bottom)`. Reason: the two counts are coupled and cannot be separated —
   see "Divider collision" below. Verified in the tree.
2. **Add the Edit `control_request` to the layout-check shim.** PM listed it recommended-not-
   required; it is required. Reason: without it, section [4]'s phone assertion PASSES under the
   broken design. An assertion that stays green while its subject is broken is the alarm-that-
   lies class this codebase has already been burned by once (the `AskUserQuestionCard` bounding
   that shrank the card 506→279px without moving Submit one pixel). If the cost turns out
   materially larger than PM's estimate, report back rather than absorbing it silently.

## Premises verified against the tree (PM's corrections to the coordinator's brief)

- **The visual-viewport/keyboard question is SETTLED, not live.** `web/src/index.css` carries a
  `STATUS: SETTLED` comment closing the geometry: `position: fixed; inset: 0` is NOT a remedy in
  either form and **must not be applied** — keeping the height is byte-for-byte identical to today
  (`position: fixed` resolves against the LAYOUT viewport, the very box the visual viewport pans
  inside, so a fixed element cannot escape a pan by construction), and the literal form re-sizes
  the shell back to the full 844px layout viewport, putting the composer under the keyboard again
  — a regression. `#root { height: var(--vvh, 100%) }` already sizes the shell to the visible
  viewport. The pan **is** observable headlessly via `Emulation.setPageScaleFactor` (offsetTop
  0→336 while `window.scrollY` stays 0).

  **WHAT IS ACTUALLY STILL OPEN — corrected by Devil, and narrower than this file first said.**
  An earlier draft here (and the coordinator's brief, and `index.css`'s own summary line) stated
  the open question as *"the TRIGGER — does the browser auto-pan"*. **That is answered, and the
  answer is yes.** Probe check 6 is tagged `[trigger]` and PASSES: the browser pans the visual
  viewport by itself to reveal a focused input, headlessly, `scrollY` never moving. It had to be
  reproduced against the PRE-FIX shell only because the `--vvh` layout never puts the input
  outside the visible window to begin with. The real residual gap is one step earlier: **whether
  iOS's software keyboard produces the visual-viewport SHRINK at all.** Headless Chrome has no
  keyboard, so the probe substitutes pinch-zoom — same geometry, different cause, and it scales
  the width where a keyboard does not. Geometry settled, pan response settled, **shrink cause**
  unverified off-device. `web/src/index.css` has been corrected to say this.

  **PROVENANCE, AND A CIRCULARITY WARNING — read before treating any of the above as confirmed.**
  Devil authored BOTH `web/src/index.css`'s `STATUS: SETTLED` block AND
  `scratchpad/visual-viewport-pan-probe.mjs`, earlier in the same session. Every number quoted
  here — offsetTop 0→336, the 336px canvas, the composer returning to y=844 — came out of that
  probe. So PM reading `index.css` and finding the question settled was **not independent
  corroboration**: the source is the same author as the claim. If the probe is wrong, the comment
  and the probe are wrong together and nothing in the tree catches it. Devil flagged this itself
  rather than letting a self-citation read as a second opinion. Nobody is asking for a re-run;
  this records what the confirmation does and does not cover.
- **2B is INDEPENDENT of that question.** Shell's root is
  `<div className="flex h-full bg-ctp-base overflow-hidden">`; every 2B change lands on children of
  the `flex-1 min-h-0 flex` row below MainTabs. **2B must not touch that root div's className** —
  `index.css` owns shell sizing.
- **The breakpoint is already duplicated in JS once**: the `layout` useState initializer in
  `Shell`, `window.innerWidth < 768` (locate by content, NOT by offset — see the warning below). `web/tailwind.config.js` declares **no `screens` key**, so `md` is
  Tailwind's default 768px and there is nothing importable at runtime.
- **Divider collision.** Section [2] of `layout-check.mjs` is vacuous in BOTH assertions at rest:
  with no tab/dock/terminal open it counts zero dividers having tested nothing. Making the pane
  count honest forces the divider count into that same state, and exactly three of the four
  `title="Drag to resize"` dividers have no `md:` gate. Verified by content: the **sidebar** one
  already has `hidden md:block`; the **companion split**, **terminal dock** and **right dock** ones
  do not. **Locate all four by searching `title="Drag to resize"` — there are exactly four
  occurrences — and skip the one already carrying `hidden md:block`. Do not use line offsets.**


> **⚠ NO `App.tsx` LINE OFFSETS ANYWHERE IN THIS FILE — they were struck 2026-08-25 and must not
> come back.** An earlier draft cited `App.tsx:205` (the breakpoint literal), `:650/:701/:733/:794`
> (the four dividers) and `:74`/`:86` (`LS_KEY`). **Every one went stale within hours**, because 2B's
> own implementation moves the file: the dividers drifted 650→725, 701→781, 733→821, 794→894, and an
> unrelated guard moved 469→541 mid-verification. The divider offsets were the dangerous ones —
> 2B's required edit is to gate exactly three of the four, and `layout-check` section [2] counts
> visible dividers without checking WHICH, so following a stale offset would gate the wrong divider
> and still go green. Anchor on `title="Drag to resize"` and on identifier names instead.

## The breakpoint

New `web/src/lib/breakpoint.ts` exporting `MD_PX = 768` and `usePhone()`, built on
`useSyncExternalStore` over `matchMedia('(min-width: 768px)')`, **negated**. Use `min-width`, not
`max-width: 767.98` — Tailwind's `md:` variant IS `@media (min-width: 768px)`, so negating the
identical query agrees at the boundary **by construction** rather than by approximation. That is
how the JS source relates to the existing `md:` classes: it is the exact complement of the same
query. The drawer's Tailwind classes are untouched and nothing is duplicated.

Replace `App.tsx`'s `window.innerWidth < 768` literal with `MD_PX` so exactly one number exists in
JS. Publish `data-phone="true|false"` on Shell's root div **for the harness only, never for
styling**. The real anti-drift guarantee is the 767-vs-768 harness check below.

**This does not contradict "must not touch that root div's className" above** — the two sit far
apart in this document and a skimming implementer could read them as conflicting. They are
consistent: add an **attribute**, leave the **className** exactly as it is
(`flex h-full bg-ctp-base overflow-hidden`). `index.css` owns shell sizing; 2B owns nothing on
that element except one data attribute the harness reads.

## The panes

**Four panes**, each tagged `data-testid="pane"`: the chat body (`flex-1 min-h-0` wrapping
ChatView/Empty), the content wrapper (`{active && …}` holding `contentNode`), the terminal dock
container (the `allTerms.length > 0` wrapper), and the right dock — **which is a `<div>`, NOT an
`<aside>`** (corrected post-build; the only `<aside>` in `App.tsx` is the Sidebar drawer, so a
`querySelector('aside')` written from an earlier draft of this line would find the wrong element).

**NOT panes**: the session drawer, the `md:hidden` mobile top bar, MainTabs. Extra reason the
drawer must never be tagged — `__qa.visible()` ignores POSITION, so a closed `-translate-x-full`
drawer reads as visible and would make `visiblePanes()` return 2.

**Exactly-one is owned by ONE pure resolver**, not four scattered class expressions:
`resolvePhonePane(want, { content: active !== null, terminal: dockShown, dock: dock !== null })`,
falling back to `'chat'` when the wanted pane has no entity.
`shownPane = isPhone ? resolvePhonePane(...) : null` (null = desktop, show everything).

**The type, stated literally** because every hide expression compares against it:
`type PhonePane = 'chat' | 'content' | 'terminal' | 'dock'`, with `shownPane: PhonePane | null`
where `null` means desktop.

**`phonePane` is deliberately NOT PERSISTED.** `LS_KEY` stays `'claudette:layout:v1'`
(the `LS_KEY` const, with its `p?.v === 1` gate in the loader) and 2B adds **no migration**. Do not add
`phonePane` to `Persisted` and do not bump the version — that is scope creep with a migration
attached. Stated explicitly because the out-of-scope note below only implies it obliquely, and an
implementer reading this file alone could reasonably get it wrong.

**`usePhone` is unavoidable, not a convenience.** Pure CSS cannot do it: the Claude column and the
right dock carry INLINE styles (`sideW`, `stackH`+dock, `dockW`) and inline styles beat Tailwind
classes, so those must be gated in JS.

**Hiding is Tailwind `hidden` everywhere — never unmount, never opacity/visibility/transform.** The
reason is that ptys and scrollback survive: it is the house pattern already used for terminals
(`className={show ? 'absolute inset-0' : 'hidden'}` plus a `visible` prop). That ground is sound and
sufficient on its own.

> **A SECOND JUSTIFICATION USED TO STAND HERE AND IT WAS FALSE — removed 2026-08-25.** It claimed
> `display:none` reports `scrollHeight === clientHeight === 0` so hidden panes stay out of
> `__qa.scroller()`'s `scrollHeight > clientHeight` filter. **That filter is unreachable.**
> `scroller()` (`layout-check.mjs`) short-circuits on `const hook =
> document.querySelector('[data-testid="transcript-scroller"]'); if (hook) return hook` — the
> `scrollHeight > clientHeight` scan is in the class-scan FALLBACK below that early return. The hook
> is unconditional in the tree (`ChatView.tsx:385`, on the transcript div itself, not behind a
> ternary), so the fallback is dead in every state that has ChatView mounted — which is every state
> sections [1] and [4] measure. Nothing reaches that filter, so `display:none` panes cannot be kept
> out of it. Related: `scroller()` calls neither `visible()` nor `visiblePanes()`; `visible()` is
> used only by `visiblePanes`, `visibleDividers`, `clickSession` and section [4](c). Recorded rather
> than silently deleted because it is the same failure this file exists to design against — a
> supporting reason that reads as verified, is plausible and specific, and that nobody ever
> exercised. Do not reinstate it.

**★ WHAT 2B ACTUALLY DOES TO `scroller()` — the real hazard, and it points at slice 3.** Because 2B
hides with `hidden` and never unmounts, at phone with `shownPane !== 'chat'` the hook STILL RESOLVES
— so `scroller()` begins returning a `display:none`, zero-box element, which it cannot do today
(pre-2B the transcript is always laid out at phone). Every section-[4] operation that WRITES to it
then silently no-ops: `toBottom`'s `s.scrollTop = s.scrollHeight`, and the scroll-up delta, which
the harness already downgrades to "inconclusive" rather than red. **Expect inconclusive section-[4]
results at phone while implementing 2B; that is this effect, not a regression — and do not read an
inconclusive as a pass.** Deciding what `scroller()` should return in that state (null? gate on
`visible()`?) is slice 3's subject and does not exist as a question until 2B lands. This is the real
reason slice 3 must follow 2B.

## ★ POST-BUILD CORRECTIONS — found by Devil while implementing, 2026-08-25

2B is built and green (`layout-check` **30/0** from a 12/1 baseline, `refresh-survival-check` 17/0,
`tsc --noEmit` clean). Four things in the plan above were wrong or incomplete. **Anyone using this
file for slice 3+ should read these first.**

1. **The right dock is a `<div>`, not an `<aside>`** — corrected inline above.

2. **"HIDE, NEVER UNMOUNT" IS ONLY HALF-TRUE OF THE CONTENT PANE, and not because of 2B.** The
   wrapper is `{active && …}`, so `selectChat` (which sets `active: null`) genuinely **unmounts**
   it. The `hidden` path applies only when `active !== null` and another pane is shown. **This is a
   live trap for the CodeMirror/Milkdown re-show gap**: hiding the editor by clicking Chat unmounts
   it, so you measure a REMOUNT and get a meaningless pass. Devil hit exactly this on its first
   attempt. **The honest hide path is to open the TERMINAL**, which leaves `active` set.

3. **Harness item (b) is necessary but NOT sufficient.** "Open a content tab + Files dock +
   terminal before measuring" does not make all four divider gates testable — the **pane state at
   measurement time** decides which dividers have a visible parent. Proven by mutation: un-gating
   the **terminal-dock** divider left the suite FULLY GREEN, because that divider lives inside the
   Claude column, which is already hidden when the content pane shows. A **second divider
   measurement taken in the TERMINAL pane** was added; the same mutation then goes red. Lesson for
   slice 3: a gate is only tested in a state where its parent is visible.

4. **`resolvePhonePane`'s fallback does more than this plan claimed** — it is why `hideTerm`,
   `closeTab` and dock-closing need **no** phone-pane wiring at all. Removing the entity IS the
   signal to fall back. **Only OPENING is wired.**

**One deviation from the plan, deliberate:** `toggleDock` was rewritten from `setDock((d) => …)` to
read `dock` directly, because setting phone-pane state inside a setState *updater* makes the updater
impure and React double-invokes updaters under StrictMode — a side effect that misfires only in dev.
This is H3's rule ("updaters must stay pure") applied to new code.

**Item (e) cost:** ~25 lines in the shim (a second `GO_EDIT` marker, an `editReq`, a second
interval) plus ~45 for section [7]. Larger than the one-bullet framing implied, well short of
"materially larger". It is the ONLY assertion in the file that can see the ★ defect below —
mutation-tested: the `active`-driven design turns section [7] red with the diagnostic *"the content
pane took the screen — the permission card approving this very edit is now hidden"*.

**KNOWN GAP — two thirds closed, one third BLOCKED.** CodeMirror and Milkdown were measured across a
*proven* `display:none` transition (element asserted mounted with a 0×0 box before concluding) and
re-showed byte-identical, with screenshots inspected. **NotebookView is NOT covered: `jupyter_server`
is not installed in this sandbox, so it cannot be exercised at all.** That third needs someone with
jupyter. Separately, at 390px Milkdown breaks "Heading One" mid-word — cosmetic, identical before
and after, pre-existing, NOT a 2B regression; slice 3/6 territory.

## ★ THE `scroller()` HAZARD IS REAL, DID NOT FIRE BY LUCK, AND IS NOW SELF-DESCRIBING

The hazard predicted for 2B — hiding without unmounting leaves the `data-testid` hook alive inside a
`display:none` subtree, `scroller()`'s early return hands it back unconditionally, and every write to
a zero-box element no-ops — **is exactly right in mechanism and did not bite, by accident.**

**Why it did not fire:** section [2] returns to the CHAT PANE before [3]–[5] run. That was done for
an unrelated reason (leaving `active` null so [7]'s machine-side open is the only thing that sets
it), and it incidentally keeps the transcript laid out at phone. Measured: the scroller's box at
[4]'s phone step is **416px, not 0**. So the suite was **one reordering away** from silently
degrading, with nothing recording the dependency.

**What was done about it — the silent failure is now a named one.** `scroller()` itself was NOT
fixed; that remains slice 3's, deliberately.
1. A `[today]` **precondition inside [4] at both widths** asserts the scroller has a non-zero box.
   Green today (desktop 285px, phone 416px). On failure it prints *"scroller() returned a
   display:none element — writes to it no-op, so the result below is INCONCLUSIVE, not a pass"*.
2. The **ordering dependency is written at the end of [2]**, enumerating all three things that
   depend on returning to the chat pane, ending "if you reorder these sections, re-read [4]'s
   scroller precondition before believing its result."

**Fails-first proof.** Mutating [2] to NOT return to the chat pane — the exact reorder that triggers
the hazard — produces TWO reds: the new precondition, **and** `[phone] the card has a reachable
answer button`. Without the precondition the only visible symptom is that second red, sending the
reader hunting a permission-card regression that does not exist. This is the over-determined-red
shape; the new check disambiguates it by naming the cause of the second failure.

### ★★ HABIT #19 — the general lesson, and it is the sharpest one from this slice
The false justification this file used to carry (that `display:none` keeps panes out of
`scroller()`'s `scrollHeight > clientHeight` filter) survived review because **the citation was
accurate AND unreachable**. Grepping for `scrollHeight > clientHeight` FINDS it, which CONFIRMS the
claim — while the early return three lines above means it never executes.

> **A citation can be simultaneously accurate and unreachable. Verifying that a cited line EXISTS is
> not verifying that it RUNS.** Reachability is not checkable by grep — only by reading the control
> flow above the line, or by running it. This is nastier than citing something fictional, because
> the grep comes back green.

## ★ The finding that matters most — a defect 2B could introduce

**Do NOT reuse `active` as the phone chat/content selector**, even though it is the smaller diff and
looks natural (`selectChat` already sets `active: null`). Three effects in Shell open a content tab
MACHINE-side: notebook-opened, file-opened, proposed-edit auto-open. If a machine-opened tab could
displace the chat pane at phone, then **when Claude proposes an edit the file editor would hide the
permission card approving THAT VERY EDIT** — the card slice 1 just made a sibling of the transcript
INSIDE the chat pane.

So `phonePane` is explicit state wired ONLY into user-initiated handlers (`selectChat`, `selectTab`,
`openFile`, `focusNotebook`, `openAgent`, `toggleDock`, `toggleTerm`). A machine-opened tab appears
in the strip unhighlighted — a notification, not a yank. Consequence: `active` and `shownPane` can
disagree, so **MainTabs must highlight from `shownPane` at phone, not from `active`**.

**The passes-for-the-wrong-reason catch:** `layout-check` would NOT catch this defect. Its stand-in
CLI raises a BASH permission, so `active` stays null, chat stays shown, and section [4]'s phone
assertion keeps passing under the broken design. This is why ruling #2 makes the Edit
`control_request` required.

## Second defect 2B introduces — fix in the same slice

`ChatView` needs an optional `visible` prop plus
`useEffect(() => { if (visible && pinnedRef.current) bottomRef.current?.scrollIntoView({ block: 'end' }) }, [visible])`.

While `display:none` the transcript has no box, so the existing `[items, pending]` effect's
`scrollIntoView` is a no-op, and Chrome drops `scrollTop` to 0 when the box is removed — a phone
user who reads chat, taps a file, and taps back lands at the TOP of the transcript with new messages
below. `onScroll` itself is safe (0-0-0 < 80 re-pins rather than unpins), so the bug is purely the
lost scroll position. Mirrors TerminalView's existing `visible` contract — the house pattern, not an
invention.

## File-by-file (components and functions, per house convention — line numbers rot)

- **NEW `web/src/lib/breakpoint.ts`** — `MD_PX`, `usePhone`.
- **`App.tsx` / `Shell`** — call `usePhone`; add `phonePane` state + `resolvePhonePane`; add
  `data-phone` to the root div and change nothing else about it; `hidden md:block` on the three
  ungated dividers; main-column wrapper hidden when `shownPane === 'dock'`; content wrapper gets the
  pane hook + hidden unless `'content'`; Claude column hidden when `'content'`/`'dock'`, inline
  style gated to `undefined` at phone and class forced to `flex-1 min-h-0 min-w-0` regardless of
  `active`; chat body gets the pane hook + hidden unless `'chat'` + `visible` prop to ChatView;
  terminal dock container gets the pane hook, shown when `dockShown && (!isPhone || shownPane ===
  'terminal')`, and at phone drops the inline `boundedDockH` height for `flex-1 min-h-0`; the
  per-terminal `show` expression gains the same clause so TerminalView's `visible` prop stays
  truthful; right dock gets the pane hook + hidden unless `'dock'`, inline width gated off at phone,
  `flex-1 min-w-0 border-l-0` at phone; pass `phonePane={shownPane}` to MainTabs.
- **`App.tsx` / `MainTabs`** — Chat tab on-state becomes
  `shownPane ? shownPane === 'chat' : active === null`; `isOn(t)` additionally requires
  `!shownPane || shownPane === 'content'`. Optional: hide the side/stack layout toggle at phone, it
  controls a split that does not exist there — if taken, the class is `hidden md:flex`, **not**
  `md:block`, because the button is a flex container.
- **`ChatView.tsx`** — the `visible` prop + re-pin effect above.

## Harness — `scratchpad/layout-check.mjs`

REQUIRED:
- (a) `visiblePanes()` gains `inViewport` — **targeted on purpose**, because a global `visible()`
  strengthening would break section [3]'s phone `clickSession`, which today clicks an OFF-SCREEN
  drawer row. That global fix stays unclaimed; slice 4 (drawer/tab-bar nav) should own it.
- (b) Section [2] opens a content tab + the Files dock + the terminal before measuring anything.
- (c) Two new `[today]` boundary checks: at 768×900 assert `data-phone === 'false'` AND the
  `md:`-gated sidebar divider is visible; at 767×900 assert both flip. This is what makes `MD_PX` a
  real single source — same shape as `refresh-survival-check`'s GRACE_MS cross-source check.
- (d) A new `[today]` desktop guard: with tab+dock+terminal open at 1440×900, `visiblePanes() >= 3`.
  Without it, "hide everything, always" passes section [2].
- (e) The Edit `control_request` behind a second marker file (**required per ruling #2**).

## Verification / bucket

**GROUP B, nothing serves `web/dist`.** `layout-check.mjs` already spawns its own `npx vite` in
`web/` over the working tree and is registered in `scratchpad/run-suite.sh` as
`chrome:layout-check.mjs`. So Landing's dist rebuild is irrelevant to 2B either way.

2A is untouched: 2B never unmounts a pane, so no WebSocket detaches and `paneManager`'s GRACE_MS
path is never entered. Re-run `refresh-survival-check` (17/0) anyway, because it also asserts
terminal restore.

## Known gap — stated so it does not look covered

**CodeMirror 6 and Milkdown inside a `display:none` subtree can render blank or mis-measured on
re-show.** `layout-check` asserts STRUCTURE, never pixels, so it **cannot** catch this. Needs one
manual look at phone width with a notebook and a file editor open; if it bites, the fix is the same
`visible` prop pattern. xterm IS covered (ResizeObserver + FitAddon, and the plan keeps `visible`
truthful).

Also noted: `boundedDockH`'s known 284px floor still applies on desktop; dropping it at phone is
safe ONLY because `#root` is `var(--vvh)`. Section [3]'s phone `clickSession` vacuity survives 2B by
design.

## Out of scope

Bottom tab bar (slice 4), safe-area inset (5), card max-height + `scroller()` tightening (3,
indivisible), notebook (6), terminal/file-manager (7), the global `__qa.visible()` `inViewport`
strengthening, the FileManager `createPath` return-type fix. Undecided: whether `phonePane` should
be per-session (global in 2B; per-session needs an LS_KEY migration).
