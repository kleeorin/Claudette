# Claudette — Handover
_Last updated: 2026-08-27._

<!-- Deliberately no "working tree is clean" line here. The previous one was stale the
     moment it was written and stayed wrong for a month, which is the same failure this
     document's rewrite exists to fix: run `git status` — it is authoritative and this
     file cannot be. -->


## ⛔ COORDINATOR HANDOVER — rewritten 2026-08-27. READ FIRST. Supersedes the 08-25 block.

> The block that stood here was two days stale and had gone actively wrong (it described
> `web/dist` as stale since 08-24, `run-suite.sh` as untracked, and a baseline of 64/7/6 —
> none true now). Everything below the CORRECTIONS heading is older still: **treat it as
> history, not as state.** `git status` and `git log` are authoritative; this file is not.

### Status — 2026-08-27, second update (evening). HEAD is still `9af9bdf`; nothing pushed.

**Step (ii) is DONE, not half-applied** — the line above this said otherwise and was wrong by
the evening. `viewof-precondition-guard.mts` is **4/4, exit 0** and `tsc -p server/tsconfig.json`
is clean against the uncommitted `server/src/claude/sandbox.ts`. It still wants Landing's own
read before committing, and when it commits, **remove its `EXPECTED_RED` entry from
`run-suite.sh` in the SAME commit** (the guard's header asks for that). Its closing narration
still prints "refused, but with no reason recorded" — now false; fix it in that commit.

**Uncommitted, and it is no longer one file.** `git status` is authoritative, but as of this
writing: `server/src/claude/sandbox.ts` (above) · three `web/src` changes (sandbox-chip picker
fix, Files multi-select, drawn file icons) · `web/src/components/FileIcon.tsx` (new) ·
`scratchpad/` — two new guards, `safe-mutate.sh`, `live-file-sync-design.md`, and edits to
`dom-env.mts`, `output-sanitizer-test.mts`, `run-suite.sh`.

### ★ BASELINE — 2026-08-28 09:59, `85 passed / 1 failed / 6 skipped`. Quotable.
Clean: no contamination banner, **bucket 1 interpretable for the first time since 08-26**
(`web/dist` 09:30:00 newer than every input), no unexpected failures, no runtime skips. The
sole red is `authorizer-box-divergence-guard`, the documented expected red awaiting A2.

**It took four runs to get one.** Two were contaminated mid-run by another session's writes
(`web/dist` rebuilt during run 1, `scratchpad/` written during run 3) — `FP_TREES` is
`web server/src shared/src scratchpad`, so a write anywhere in those four voids the total.
Run 1 was worse than flagged: it **served two different bundles**, and nothing in its output
says which side of the rebuild each bucket-1 harness fell on. The staleness banner samples
ONCE at the start and cannot notice the bundle being replaced under it — a known hole, not
yet fixed. **Before a full run, get every writing session to confirm it has stopped.**

**⚠ THIS NUMBER IS SESSION-SPECIFIC IN TWO KNOWN WAYS.** Two harnesses answer differently
depending on who runs them, and both were found the hard way:
- **jupyter**: `prereqs: jupyter=no` here, so 6 entries SKIP. In a session where
  `jupyter_server` imports they RUN — reported 5 green plus `notebook-ui-e2e` 13/13. So that
  session would read ~91/1/0 for the same commit.
- **`sandbox-fs-escape-fixes-test`**: 13/0 here, 12/1 where `CLAUDE_CONFIG_DIR` points inside
  `~/.config/claudette` (a host-scrubbed config mirror), because `obligatoryMounts` binds it
  rw while `sandboxPathAccess` refuses anything under `stateDirsToHide()`. Fail-closed, so the
  symptom is a permission error, never an escape. Documented in that file's header.

**Rule this earns: state which session measured a prereq before quoting it as a suite fact.**
An environment-local truth reported as a tree fact cost three separate corrections in one day.

**Older baselines: unchanged and still not re-takeable** — `web/dist` is STILL the 08-26 10:48
bundle and three more `web/src` changes landed on top of it today. Last quotable: `79/2/6`.
**Expect the next real baseline to move for a truthful reason:** `output-sanitizer-test.mts`
now exits **77 (runtime skip)** instead of 0 when no DOM is present. That is a correction, not
a regression — it was reporting `10 passed, 0 failed`, exit 0, with every behavioural invariant
of the notebook output sanitizer UNRUN. See the jsdom item below for why that is every machine.

### ★ jsdom was never declared. The whole DOM-test seam has never run by default.
`dom-env.mts`'s header claimed jsdom "is a devDependency (approved 2026-08-21)". It is **not in
any `package.json`**, and in neither `node_modules` nor `web/node_modules`. The approval was
recorded; the declaration was never made — so `npm i` was never going to fix it, and every
`setupDom()` caller has taken the no-DOM path since the day it was written. Header and
`NO_DOM_NOTE` are corrected. **Two registered harnesses cannot run for anyone on a clean
checkout** until it is declared (needs a lockfile regeneration → Landing). Until then:
`mkdir -p /tmp/deps && (cd /tmp/deps && npm i jsdom)` then
`CLAUDETTE_JSDOM=/tmp/deps/node_modules/jsdom/lib/api.js npx tsx scratchpad/<test>.mts`.
`/tmp` is per-sandbox private, so **every session needs its own copy**.

### The critical path is still ONE permission prompt
**`Landing` (session `2e41c0b7`) is blocked**, and is the only session that can write
`server/src`, `shared/src`, `web/dist` or root `node_modules` — verified by `touch` from the
coordinator, which gets `Read-only file system` on all four. Two messages are QUEUED and
UNDELIVERED to it. Clearing the prompt unblocks, in order:
1. **Rebuild `web/dist`.** Promoted to first: three UI changes today exist only in `web/src`,
   so the built app shows none of them, and one of them (the folder icon) can only be checked
   by eye. Also unblocks bucket 1 and a real baseline.
2. **Confirm + commit step (ii)** (above).
3. **Declare jsdom + regenerate the lockfile** (above).
4. **Live file sync — the server half.** Fully designed in
   [`scratchpad/live-file-sync-design.md`](scratchpad/live-file-sync-design.md); hand it over
   intact, it needs no re-derivation. Makes `.md`/`.ts` editors follow the file on disk the way
   notebooks already do. The client half is INERT without it, so the order is safe, but the
   `WsServerMessage` union lives in `shared/src` — **types first**.
5. **The connector timeout work** —
   [`scratchpad/connector-timeout-design.md`](scratchpad/connector-timeout-design.md).
6. **The vitest question** (below).
`authorizer-box-divergence-guard` stays red until A2 — leave its `EXPECTED_RED` entry alone.

### ★ Two rules about mutation testing, learned the expensive way today
1. **A mutation that produces NO red is not a passing mutation — it is an uncovered branch
   announcing itself.** Found a real hole this way: pruning applied to `copy` as well as `cut`
   left all five clipboard assertions green, because nothing tested that a COPY clipboard
   survives its paste (the ordinary case — copy once, paste three places).
2. **The mirror: a red that cannot say WHICH mechanism held is not proof that either does.**
   `file-multiselect-guard`'s `[1b]` is green with the `sel.dir === dir` guard deleted, because
   `load()` already resets the name set. Two redundant defences, one test, no way to tell them
   apart — so the first one "simplified away" looks free. The caveat is in `run-suite.sh`.

### ★ Mutation-test a COPY, never the live file
A snapshot-mutate-restore cycle destroyed ten review fixes another session applied while it
ran, and the restore reported success. Restore does not reinstate the file you snapshotted —
**it overwrites whatever is on disk now**. The md5 check afterwards *confirms* the loss rather
than catching it: "matches my snapshot" is the exact signature of a destroyed concurrent edit.

**The mechanism is established — do not carry this forward as a mystery.** The wreckage looked
inexplicable (new comments sitting above old code, which no single restore seems able to
produce) only under an unstated assumption: that both of the other session's edits fell on the
same side of the restore. They did not. **The code edit landed BEFORE the last restore and was
wiped; the comment edit landed AFTER it and survived. A whole-file restore produces exactly
that chimera.** That is why `safe-mutate.sh`'s refuse-to-restore-on-drift case is *necessary*
rather than merely prudent: the window between snapshot and restore is where the other author
writes, and both sides of it are live. (Worth keeping with the finding: it took the mutating
session owning the damage, the coordinator over-correcting to defend it and mis-recording the
mechanism as unexplained, and then the mutating session correcting the coordinator back. The
truth was in the third step, not the first two.)
`scratchpad/safe-mutate.sh` turns it into a loud refusal (and also refuses a patch that matches
NOTHING — which otherwise runs against the unmutated file and reads as "this assertion cannot
be made to fail", a false finding about the test). A copy is still the preferred cycle.

### ★ Checking whether a teammate is really blocked — THE OLD RULE HERE WAS WRONG
An automated "X is BLOCKED on a permission prompt" notice is not reliable. The rule that stood
here said: call `list_team`, believe the roster, escalate only when notice and roster agree.
**That rule has now been falsified, and following it cost an hour of held-back work.**

On 2026-08-27 the notice fired twice for `Landing` (`2e41c0b7`) and **the roster agreed both
times** — `state: waiting`, `blockedOnPermissionPrompt: true`, checked deliberately on each
occasion. The coordinator escalated to the operator four times. Landing was **not blocked**: it
had been working continuously, and the tree proved it (`shared/src/ws.ts` written,
`sandbox.ts` finished, the `EXPECTED_RED` tombstone in `run-suite.sh`).

**Rule: the roster and the notice are the SAME signal and can both be stale. The tree is the
only witness that cannot lie.** Before escalating a block, check whether the session's files
have moved — `git status`, mtimes, the artifacts it was last asked for. A session that is
producing work is not blocked, whatever two APIs say about it. Ask the teammate directly too;
a queued message costs nothing and it can answer when it comes free.

Note the asymmetry that makes this cheap: escalating a *false* block wastes the operator's
attention and stalls a queue; NOT escalating a real one costs only the delay until the next
check. Prefer the tree, then ask, then escalate.

### ★ Session identity is scrambled — do not litigate it
The roster's names and the occupants' self-descriptions disagree (the session the roster calls
`Landing` believes it is QA and claims authorship of the harness fleet). A restart lost the role
mapping. **Route by ACCESS, not by name** — what matters is which session can write which paths.
Related: authorship cannot be recovered from a dirty tree. `ChatView.tsx`'s uncommitted work was
attributed to Devil and was not Devil's; the correction came from the teammate, with evidence.
**Never infer provenance from `git status`.**

### Open, measured, unowned
- **`shell-fixed-cost-probe`**: 33px composer clip, phone + keyboard up. Stable over three
  baselines. Prints as `[open]`; passes.
- **`App.tsx` residual**: the dock clip returns above `stackH ≈ 351` at `vvh` 508, and nothing
  clamps a persisted `stackH` against `--vvh` on restore. Named in `eda4a76`.
- **vitest**: `web/package.json` declares `"test": "vitest run"`, `web/src/store/sessions.test.tsx`
  is committed with **7 cases**, and vitest is not installed. PM's finding: all 7 fail at mount
  (mock drift), and **test 6 is vacuous** — it spreads a `ReadonlyMap` into a `string[]`, so its
  central invariant can never fail. `web/tsconfig.json` excludes test files and vitest does not
  typecheck, so **a naive install yields a green 7/7 that verifies nothing.** Sequence must be:
  install → drop the `exclude` → let `tsc` find the vacuity → fix → then run. Root
  `node_modules` is read-only; `web/node_modules` is writable.

### Rules that generated most of today's value
1. **A green you cannot explain is a finding.** Today: a harness that passed while its own log
   said the run was not a verdict; a probe asserting a defect fixed before it was written; a
   check comparing tuples to a string; a selector resolving to the assistant's echo.
2. **Name the case you measured, inside the assertion.** One assertion was confidently wrong in
   two opposite directions before landing on the narrow truth.
3. **A control is what makes a measurement mean something.** A security finding was retracted
   today because the same fixture returned the same result with the bug absent.
4. **Reasoning and measurement are each self-validating only in one direction.** Marked claims
   (`STATUS: reasoning, not executed`) were refuted twice by one cheap run each — and the marking
   is what made them cheap to refute. Keep marking them.
5. **The coordinator is not exempt.** Every one of the above was caught by a teammate or by a
   control, not by self-review.

### What to do first on resume
`list_team`, then ask the operator about Landing's prompt — it is the whole queue. Do not start
a full suite run while anyone is writing the tree; the run's own fingerprint will flag it and the
number is wasted.

## ⚠ CORRECTIONS — 2026-08-24. READ BEFORE THE SECTIONS BELOW.

A team swept this document and the tree against each other. Many claims below were stale **in
both directions**, and the dangerous direction turned out to be *"recorded as broken, actually
fixed"* — it sends someone to rebuild a working defence and teaches the next reader to discount
the record.

### This document's own `STATUS:` count — stated, because it flags the trap for another file
**20 grep hits, 5 of them meta-mentions (the convention notes and the marker's own definition), so
15 actual re-verifiable claims.** The file warns that a `STATUS:` grep over
`sandboxPaths-rationale-header.txt` overcounts by 2 and then omitted its own figure — the same trap,
one level up. **A convention that is grep-counted should publish its own count wherever it is used.**

### The one habit that would have prevented most of this
> **A claim about the tree that nobody re-verified is this codebase's recurring defect.**
> Mark every time-dependent sentence `STATUS:` so the whole set is greppable and re-checkable in
> one pass; leave mechanism prose unmarked, because it cannot rot. **Cite function names, not
> line numbers** — a line number is an assertion whose truth-value changes without the file being
> edited. Both conventions are applied in full in
> `scratchpad/sandboxPaths-rationale-header.txt` (13 `STATUS:` markers) and earned their keep
> within hours of being written.

### ★ THE `STATUS:`/mechanism TAXONOMY HAS A THIRD CATEGORY IT DOES NOT NAME — found 2026-08-24
The convention above splits prose in two: `STATUS:` claims rot, unmarked **mechanism** cannot.
Architect audited `sandboxPaths-rationale-header.txt` against the tree and found **all 11 STATUS
claims TRUE — and two unmarked INVARIANTS FALSE.** The taxonomy has a hole:

> **An INVARIANT is PRESCRIPTIVE, and a later reasoned decision can OVERRULE it.** That is
> neither a status claim nor mechanism. It is the category the split forgets, and being unmarked
> it is the category nobody re-checks.

Both false invariants had the same cause — the shell-injection fix closed the hole by **argv
separation, not by removing the shell**. `which` now runs
`execFileSync('sh', ['-c', 'command -v -- "$1"', 'sh', bin])`, and the shell is retained **on
purpose**: `probe()` depends on `command -v` reporting a builtin as a bare word, which a Node-side
PATH walk cannot reproduce (it would return null for `true` and silently change what the
capability probe tests).
- **A4 said "No path string reaches a shell."** False — and as written it *forbids a deliberate,
  well-argued design decision*. Corrected to: no path string is **interpolated** into a shell
  command. **Interpolation is the defect; a shell is not.**
- **A1 said `… / any shell` appear nowhere in `sandbox.ts`.** False, and *permanently* so: a
  blanket no-shell grep is now a guaranteed false positive, which would train whoever runs the
  A6 grep to **ignore it** — the worst outcome for a guard.
- **A5 (migration) said `wrapCommand … drops which()`.** Half right, and dangerous as written: it
  instructs someone to delete a function `probe()` needs. `wrapCommand` should stop calling
  `which()` on caller-supplied input; `which()` itself must survive.

All three are patched in the header file. **Also corrected: there are 11 re-verifiable STATUS
claims, not 13.** A `STATUS:` grep also hits two *meta-mentions* — the convention note and the
marker's own definition — so the count overstates the set, and a reviewer chasing 13 wastes a
pass hunting two that do not exist. **A convention that is grep-counted should exclude its own
definition from the count.**

Two further notes from that audit, worth keeping:
- **A recipe can rot even when the prose it serves does not.** The header bans line numbers, but
  its own landing instructions carried three (`tail -n +28`, `tail -n +203`, "202 lines"). Editing
  the header invalidated them, and editing the *preamble* then moved the divider and invalidated
  the fix. It is now **divider-relative** (`sed -n '/^====/,$p' … | tail -n +3`) and locates
  itself. Same lesson as `req.routeOptions.url`: **ask the artifact where its parts are rather
  than re-deriving the offset.**
- **Two surviving ordinal references are acceptable, and the reason generalises.** "check #20 in
  `sandbox-paths-test.mts`" and "`mount-shadowing-guard.mts` section 4" can rot if things are
  renumbered — but each **names what it asserts in the same breath**, so a reader who finds the
  ordinal wrong can still locate the claim by its text. That self-description is what makes an
  ordinal tolerable where a bare line number is not.

### ALL TEN PATCHES IN `scratchpad/` ARE DEAD — none applies
Swept 2026-08-24; every one now carries a `# DEAD` banner. **Treat `scratchpad/*.patch` as
archaeology, never as a work queue.** Proven dispositions: `reviewer-role-scope` and
`connector-readonly-deny` are **landed** (`reviewer-scope-test.mts` passes every check);
`sandbox-paths-layer` is **superseded** (its file exists, zero importers, 23/23);
`state-dir-containment` is **genuinely conflicted**. The other six are bannered as *not yet
distinguished* — you cannot tell landed from conflicted by reading a patch, because a superseded
one still describes the tree accurately and a conflicted one does not.

### A teammate handover propagated a FALSE security claim
It asserted `agents.ts` still had `allowedTools: [...READ_TOOLS, 'Bash']` — "every reviewer has
an unscoped auto-approved shell behind a Read-only badge". **False.** The narrowing is landed,
`grep "READ_TOOLS, 'Bash'"` returns nothing, and `reviewer-scope-test.mts` passes. Handovers rot
exactly like documents do.

### Landed since the last entry, verified in the tree
- **Phone slice 1** — permission card out of the scrolling transcript, now a `shrink-0` sibling.
- **★ The keyboard fix, and the finding behind it.** `AskUserQuestionCard` was 1578px in an
  844px viewport with Submit 873px below the fold. Bounding the card **DID NOT WORK** — measured:
  it shrank 506→279px and Submit did not move one pixel, because the card is bottom-anchored in
  an `h-full` column, so shrinking it just lets the transcript grow. A smaller cap would not have
  worked either **and would have looked like a fix** — the alarm-that-lies class applied to a
  *fix* rather than a test. The real repair is one line: `#root { height: var(--vvh, 100%) }`
  (`web/src/index.css`), bounding the shell to the VISIBLE viewport via the new
  `web/src/lib/visualViewport.ts`. Everything bottom-anchored then clears the keyboard.
  **STATUS: xterm has NOT adopted the helper** — deliberate follow-up, named in its module header
  (`FitAddon`'s `ResizeObserver` is gated on `contentRect.width`, so a keyboard never re-fits).
  **Honest limit, kept in the code:** headless Chrome has no software keyboard, so
  `visualViewport.height` there always equals `innerHeight` — the MECHANISM is verified, the
  KEYBOARD TRIGGER cannot be observed in this repo's harnesses.
- **Exited banner bounded** — third instance of the same unbounded-card shape; `stderrTail` is
  capped at 2000 chars ≈ 600–700px sitting ABOVE the transcript.
- **F1** — `attention` is now `ReadonlyMap<string, 'finished'|'blocked'>`. **`blocked` clears when
  the session LEAVES `waiting`, never on view**, because looking at a blocked session does not
  answer its prompt. App.tsx still reads `finished` only, so nothing renders "done" for a blocked
  session; a later slice switches the rendering. `session-reducer-test.mts` 41/41.
- **`terminal-ui-e2e` fixed** — it never created a session, so `toggleTerm`'s `if (!activeId)
  return` made the Terminal button enabled but INERT. Never an attach failure; the pty path is
  verified in BOTH host and confined modes. ~~**STATUS: the product defect remains** — the button has no `disabled`
  attribute, and the test fix now hides that path permanently.~~ **FALSE — corrected 2026-08-25.**
  `App.tsx`'s `MainTabs` carries `disabled={!canTerm}` with `canTerm={activeId !== null}`, the
  title `'Terminal — needs a session; create or select one first'`, and the disabled styling. See
  the struck `Terminal button: DECIDED + ALREADY BUILT` item below, which describes the tree
  correctly. Two live passages disagreed about one button for a day.
- **`notebook-ui-e2e` fixed** — 2 assertions reached → 10 passing. Two rots: the retired
  `+ notebook` flow, and **file rows open on DOUBLE-click**. Its 2 remaining reds are
  kernel-dependent and Jupyter is absent, so it should be reclassified chrome+jupyter to become
  an honest SKIP.
- **The squatter mechanism** — both e2e harnesses reaped Chrome on every exit path but their
  detached server only on the happy path, so every FAILING run minted an orphan. Fixed;
  `port-and-reap-lint.mts` gained an `unreapedChildren` rule. **STATUS: `:4331` and `:4332` are
  now FREE.**
- **`registration-lint.mts`** — inverted and fail-closed: every `.mts`/`.mjs` in `scratchpad/`
  must be registered in `run-suite.sh` or listed in `NON_TESTS` with a reason, so a novel suffix
  fails closed. Plus a gate rejecting any registered file lacking a result-dependent exit —
  **registering a test that cannot fail is the same class as not registering one.**
- **`resyncMirrorCreds`** — the host-mode credential bug was not "a login is late" but a permanent
  **divorce**: all prior call sites moved MIRROR → SHARED and the SHARED → LIVE direction was
  never handled. `rename()` replaces the directory entry, so the replacement cannot be prevented
  — it is undone instead, by re-pointing the entry at the shared file.

### ★ TWO RULES EARNED TWICE EACH ON 2026-08-24

> **1. GO READ THE LIBRARY OR THE PAYLOAD. Reviewer agreement is not evidence about either.**
> When a fix depends on a third party's timing or a payload's shape, open the thing itself.
> - **xterm's `write(data, cb)` parses ASYNCHRONOUSLY** — its own typings say the callback fires
>   "when the data was processed by the parser". So queued-but-unparsed data **survives a
>   `reset()` issued after it**, and `reset()`-before-write is correct only if writes are
>   synchronous. An author and a reviewer both approved that reasoning; it was sound in every
>   respect except that nobody opened xterm. The working fix removes the race (replay at most
>   once per pane per mounted instance) rather than ordering it.
> - **The CLI's auth-failure `result` frame carries `is_error`/`error:'authentication_failed'`
>   NEXT TO `subtype:'success'`.** No amount of reasoning about the classifier would have found
>   it — only reading a real frame did.

> **2. A SINGLE PASSING RUN SETTLES NOTHING — the mirror of "a single red may be a flake".**
> - The failed doubled-scrollback fix was **intermittent: 4 doubled, 2 clean over six runs.** One
>   run would have shown green and it would have been reported fixed. Run 5× before claiming a
>   fix.
> - **The suite returned two different totals over a BYTE-IDENTICAL tree** — 63/8/6 then 64/7/6,
>   nothing written between them, harness md5 unchanged. The whole delta was `clear-race-test`
>   flaking once (3 passes to 1 failure, signature: the full 12s `waitFor` budget consumed with
>   the app never rendering). Reporting the first run would have handed over a regression that
>   does not exist.
>
> Both rules now live in `run-suite.sh`'s header, above the taxonomy — where someone reads a
> result, not in a handover that dies with a context.

### ★ A BUG CLASS THIS CODEBASE PRODUCES REPEATEDLY — three instances found on 2026-08-24

> **A guard that CONSUMES ITS INPUT BEFORE TESTING ITS PRECONDITION, in an async world where
> "precondition not yet met" is the normal first pass.** All three below mark work as handled
> before establishing that it could be handled, and all three then fail **silently and
> permanently** rather than retrying.
>
> **Mark-as-handled only AFTER the handling actually succeeded — otherwise the retry you wired
> up is decoration.**

1. **`App.tsx`'s newly-seen-notebook effect.** `seenNb.current.add(id)` runs BEFORE the
   `if (activeId && …)` guard decides whether to attach. On the pass where `activeId` is still
   null the id is consumed, and the `continue` at the top short-circuits every later pass.
   **The proof it is a bug and not a design choice is the dependency array**: it lists
   `activeId` precisely so the effect re-runs when the session becomes active — a retry the
   mark-first ordering guarantees can never do anything. *Fixed indirectly:* `createPath` now
   returns the notebookId (mirroring `openPath`) and the caller focuses explicitly, so
   "create opens it" is true by construction rather than by side effect. **The mark-before-guard
   defect itself is still there** and will bite the next thing that relies on that effect —
   `seenNb` does double duty for the prune loop, so moving the `add` perturbs pruning too.
2. **`scrollMemory.ts`'s `settled` counter.** It incremented while the container could not
   scroll at all, and "content has not loaded" is a perfectly stable `scrollHeight` — so ~1s of
   an empty box counted as "layout settled", the restore was abandoned, and the rAF loop exited
   for good. *Fixed:* `settled` resets while `scrollHeight - clientHeight <= 0`.
3. **The session-blind scroll key** (`file:${path}`). Two sessions on one file shared one
   offset and overwrote each other. *Fixed:* keys are session-scoped, browser-verified with a
   mutation proof.

**When reviewing an effect, ask: does it record that it has handled something before it knows it
can?** That question would have found all three.

### ★ STATUS: THE OAUTH / "not logged in" ROOT CAUSE — DIAGNOSED 2026-08-24, FIX NOT LIVE

The operator reported "OAuth for Claude is coming up too often". **Two composing bugs.**

**1. The credential fix has NEVER EXECUTED.** `resyncMirrorCreds`/`relinkCredsToShared` landed in
`configProtection.ts` on 2026-08-23 11:23. The server serving the operator on `:4319` started
**2026-08-22 08:42** — ~27 hours earlier. `tsx` loads modules at boot and Node caches them, so a
file edit does not reach a running server. Corroborated: every mirror's `.claude.json` symlink is
dated 08-22 08:42, matching that server's start second-for-second.
> **"In the tree" and "live" are different claims, and only a restart connects them.** This was
> asserted the other way by the coordinator, from a `pgrep` run INSIDE a sandbox whose PID
> namespace shows ~8 processes and no owner for a listening port. **Never diagnose process state
> from a confined session** — delegate it to the unconfined teammate.

**2. THE REFRESH TOKEN IS ROTATED, and that is a second, separate bug.** Structure dump of three
credential stores (no secrets read): `refreshTokenExpiresAt` **differs in all three** — proof the
token is rotated per use, not reused. Three independent stores each rotating means every refresh
invalidates the others.

**How they compose:** the pre-fix server leaves every host-mode mirror divorced (an atomic
`rename()` replaces the symlink with a real file) → N independent stores; rotation then makes
N>1 self-invalidating. Observed: three `.credentials.json` files, all differing, written inside a
**2.33-second window**.

**The fix is NECESSARY BUT NOT SUFFICIENT — say so rather than closing this.** Collapsing the
stores onto one inode removes the N>1 condition, but **sharing an inode does not serialise
refreshes**: two sessions can read the same refresh token and both POST it, the server rotates on
first use, and the second gets `invalid_grant`. Nothing anywhere serialises refresh across
processes. With separate stores divergence is *guaranteed*; with a shared inode it narrows to a
real but much smaller race. **Cross-process refresh serialisation is an open, untracked bug.**

**Operator actions, in order:** (1) restart the `:4319` server — this alone collapses three stores
to one and makes the fix live, but it kills every live session; (2) kill the orphan Claudette
server from 2026-08-16 whose `CLAUDE_CONFIG_DIR` points at a deleted mirror; (3) track refresh
serialisation.

**Related latent bug, unfixed:** a server launched from *inside* a session inherits that session's
`CLAUDE_CONFIG_DIR`, so the mirrors it builds symlink into **another mirror** rather than
`~/.claude` — mirror-of-mirror chaining that dangles the moment the parent is released. Guard
would be: refuse to build a mirror when `claudeConfigDir()` is itself under `mirrorRoot()`.

### ★ STATUS: A FAILED TURN RENDERED AS A SUCCESSFUL ONE — FIXED 2026-08-24
The CLI reports an auth failure in a `result` frame carrying `error:'authentication_failed'`,
`is_api_error_message:true`, `terminal_reason:'api_error'` — **and `subtype:'success'`**. The web
classifier was `is_error === true || /error/i.test(subtype)`, false for that frame, so the turn
rendered as a success with **no error text at all**. The CLI writes nothing to stderr on that
path, so that frame was the only witness. Widened to any of those markers; pinned by
`scratchpad/result-error-classification-test.mts` (4 fail against the old classifier, 7/7 against
the new, **including a control that passes in both states** so "classify everything as an error"
cannot sneak through).

### STATUS: still open, and these need the operator
- ~~**`web/dist` is stale (08-22 08:42) and `--ro-bind`.**~~ **STATUS 2026-08-25: the 08-22 figure
  is FALSE and this item's disposition is three separate things, not one.** It was rebuilt twice
  since — 08-24 20:23:33, then **08-24 21:17**, which is what the files on disk carry. It IS stale
  again (`find web/src -newer web/dist/index.html` returns `App.tsx`, `sessionReducer.ts`,
  `sessions.tsx`, `client.ts`, `GitPanelView.tsx`) — but by ~2 hours of edits, not two days. And it
  **cannot currently be rebuilt by anyone**: `web/dist` is separately `--ro-bind` to every confined
  session, and the only session that can write it is blocked on an operator permission prompt.
  So: **stale again, blocked, and known** — do not chase a rebuild that has already happened twice.
  `run-suite.sh` now prints this mechanically (`bucket 1 (12 harnesses): NO SIGNAL — web/dist built
  <t1>, web/src last written <t2>`), so the judgement call is retired.
- ~~**Terminal button:** `disabled` with an explanatory title, or make it create a session?~~
  **STATUS: DECIDED + ALREADY BUILT 2026-08-24.** Operator chose `disabled` + explanatory title.
  No code change was needed — the tree already does exactly that. In `App.tsx`'s `MainTabs`, the
  Terminal button takes `disabled={!canTerm}` with `canTerm={activeId !== null}`, the title reads
  `'Terminal — needs a session; create or select one first'` when disabled, and the className
  carries `disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`. So the
  item was a decision that had already been implemented, listed as though it were open. Rejected
  alternative, for the record: making it create a session, because a control that reads as *view*
  should not silently *provision*.
- ~~**`FileManager.tsx`** comments `createPath` "opens + activates it"; it does neither.~~
  **STATUS: WITHDRAWN 2026-08-24 — the claim was false, in the dangerous direction.** The string
  `opens + activates` occurs exactly once in the repository: in the line above, asserting it.
  `grep -rn activates web/src server/src shared` returns nothing, so there is no such comment in
  `FileManager.tsx` to be wrong. Nor is the behaviour missing: `App.tsx`'s `onNewNotebook` prop
  awaits `notebooks.createPath` and then calls `focusNotebook(r.id)` — i.e. it *does* activate —
  and carries a comment explaining why activation is done explicitly there rather than left to
  the newly-seen effect (that effect marks an id seen before checking whether it can attach, so a
  create while `activeId` is still null consumes the id and the retry its dep array provides is
  dead). `FileManager.tsx`'s only mention is the `onNewNotebook` prop's `// notebooks.createPath`
  pointer, which is accurate. **This is the exact failure this document's corrections block was
  written about — recorded as broken, actually fine — so it is struck through rather than
  deleted: a reader who remembers the claim needs to find its refutation, not its absence.**

  **★ IT PROPAGATED ANYWAY, AND THAT IS THE MORE USEFUL FINDING. STATUS: re-verified twice more,
  2026-08-25.** After being struck through here, the same claim reappeared in a teammate's working
  context and then in a written handover — HANDOVER.md → teammate → handover — **gaining
  credibility at each hop while the tree never matched it at any point.** Nobody re-checked; each
  reader trusted the previous one. Re-verified again: `grep -rn "activates" web/src` returns
  nothing, and `submitCreate`'s notebook branch reads
  `err = await onNewNotebook(p)   // the handler focuses the new notebook's tab; null = created`,
  which is accurate. (The phrase now appears more than once *in this document* — the assertion and
  its refutations — but still nowhere in the source.)
  > **A struck-through correction only protects the document it lives in.** Once a false claim has
  > been repeated aloud it travels independently of its refutation, and a **handover is the
  > fastest vector this project has**: written under time pressure, trusted on arrival, rarely
  > re-checked. **"Check the tree, not the note" has to include notes you wrote yourself.**

### ★ THE COORDINATOR'S OWN WORDING CAN BLOCK A READ-ONLY TEAMMATE — 2026-08-25
Two sessions sat blocked on permission prompts simultaneously, and **one of them was caused by how
the task was phrased.** `planner` carries `allowedTools: RESEARCH_TOOLS` (Read, Grep, Glob,
WebSearch, WebFetch) and `disallowedTools: WRITE_TOOLS` — and **`WRITE_TOOLS` includes `Bash`**
("a shell is an edit channel too"). So a planner has no shell at all. The brief it was given said
*"do the grep first"*, which reads as an instruction to run `grep`.
> **"Grep" is the name of an allowed TOOL and of a forbidden SHELL COMMAND, and a brief written in
> shell vocabulary steers a read-only role straight into the wall.** Say "use the Grep tool", not
> "grep". The same applies to "run", "check with `find`", "`cat` the file", and "`ls` the
> directory" — all of which name shell commands that `planner` and `reviewer` cannot reach.

**This is the capability asymmetry below already biting**, from a direction it does not describe:
the asymmetry is not only *what a session may touch*, it is *what vocabulary its brief can safely
use*. The coordinator writes every brief and sees none of the roles' tool scopes at write time.
**STATUS: unmitigated.** The cheap fix is wording discipline; the real fix would be surfacing a
role's tool scope where briefs are written.

### STATUS: capability asymmetry inside the team — nothing surfaces this
`server/`, `shared/`, `web/dist`, `scripts/`, `node_modules` and the root manifests are
`--ro-bind` read-only to most sessions, which also cannot see `~/.config/claudette` at all.
**But one teammate is unconfined and CAN write `server/`.** That is operator configuration, and
nothing in the UI shows it. Route out-of-sandbox work there rather than deferring it.

### Test-suite figures
**STATUS 2026-08-24, MEASURED: 64 passed / 7 failed / 6 skipped.** Harness md5 identical before
and after the run. This supersedes 55/6/5, which is now itself stale — the registered set has
GROWN since (`result-error-classification-test`, `refresh-survival-check`, `scroll-memory-check`).
**Never quote 49/8/5, 51/9/5, 53/7/5, 62/8/5, 60/9/5 or 55/6/5.**

**STATUS 2026-08-25: a later run measured 67 passed / 8 failed / 6 skipped — AND IT IS NOT A
BASELINE.** The tree fingerprint caught `web/src` and `scratchpad` changing mid-run (three files
written between 09:15 and 09:24) and the run labelled itself contaminated. `server/src` and
`shared/src` came through byte-identical. **64/7/6 remains the last defensible baseline; 67/8/6 is
recorded so nobody re-derives it as an improvement.** Two of its eight reds are attributable to the
mid-run edits (`scroll-memory-check` — the file was rewritten at 09:23 while the suite ran — and
`attention-test`), and three are the documented expected reds. **Real result from that run:** the
in-suite/standalone split is GONE — `ratelimit-test` and `real-turn-browser-test` both pass
in-suite now, untouched, which upgrades shared-server contamination from suspected to **confirmed**
and retires two phantom reds. Zero `:4321` fallback notices.
> **This figure was reported to the coordinator and never written down here.** An audit was then
> asked to reconcile it against 64/7/6 — a contradiction that did not exist in the document,
> because the number was only ever in the coordinator's head. **A belief about the record is not
> the record**, and the same failure class as the other five in this file, pointed inward.

**This suite is NOT deterministic.** Four runs the same day over a byte-identical tree gave
63/7/6, 63/8/6, 64/7/6, 64/7/6 — the whole spread being `clear-race-test` flaking once (3 passes
to 1 failure, signature `timeout: … 'Chat'` at 17s). **Do not treat a single ±1 movement as
meaningful without a second run.** A full run is ~4m46s, not the long haul it was described as.

**★ THE INTERPRETABILITY SPLIT CHANGED CATEGORY — `web/dist` WAS REBUILT (2026-08-24 20:23:33).**
Bucket 1 is no longer no-signal. Verified by chain rather than by timestamp: `dist/index.html` →
`assets/index-Dqp_1-Mr.js`, and that asset contains `"needs a session; create or select one
first"` — a string that was absent from every dist asset that morning. All 159 assets stamped
newer than the last source write. **For the first time, the ~10 dist-serving harnesses produce
real evidence.** The totals did not move; the MEANING of five of the seven reds did. Keep quoting
the split, but with the new bucket-1 status:
- **Bucket 1 — serves `web/dist` (12):** ten `srv4321` entries (attention, doubling-agents,
  history-resume, notebook-session, notifications, optimistic-busy, ratelimit, ready-clobber,
  sound-notif, real-turn-browser) plus `terminal-ui-e2e` and `notebook-ui-e2e` (own server, but
  `NODE_ENV=production`, same bundle). **Formerly no-signal; NOW INTERPRETABLE — but only while
  the bundle is current. Any `web/src` edit makes them stale again until a rebuild.**
- **Bucket 2 — own vite dev server / `vite build` against source (9), interpretable:**
  layout-check, clear-race, composer-history-repro, find-diff-check, find-ui-check, super-editor,
  ask-card-height-probe, refresh-survival-check, scroll-memory-check.
- **Bucket 3 — browser-free `.mts`, fully interpretable:** everything else; all green except
  `rt2-connectors-c`.

**The seven failures, all now interpretable — there is no no-signal bucket left:**
1. `rt2-connectors-c.mts` — the operator's own `UPSTREAM_TIMEOUT_MS` call. Known, expected.
2. `layout-check.mjs` — 12/1, a later-slice `[phone]` characterization assertion for UI that is
   deliberately unbuilt. Expected by design; its own output says so.
3. `terminal-ui-e2e.mjs` — **GENUINE APP BUG, and the rebuild is what converted it from artifact
   to evidence.** See the `sessionReducer` entry below.
4. & 7. `doubling-agents-test.mjs`, `real-turn-browser-test.mjs` — same cause, from the server log
   not by inference: both die on `TypeError: Illegal invocation` (the
   `HTMLTextAreaElement.prototype.value` setter on `null`) because no composer exists, because no
   session was created. `_shared-4321.log` stops at `GET /api/session/trust?cwd=%2Ftmp` → 200 with
   no `/api/session/create` following. Session creation now passes a **trust gate** these
   harnesses predate. **Stale harnesses, not an app defect** — though "a trust gate silently ends
   the create flow" is a real UX question.
5. `notifications-test.mjs` — 2/8, cascading from `❌ bell toggle found + clicked`. Stale selector.
6. `ratelimit-test.mjs` — 1/3, and partially alive: `✅ "▲ Session 83%"`, then the reset-time and
   weekly-chip assertions miss. Chip redesign vs. real regression is **not yet established**, and
   those need opposite responses.

**`ss` vs `pgrep` — corrected, and it cost a contaminated baseline once.** The blanket claim that
the sandbox is process-blind is too strong. `ss -ltn` DOES show listeners belonging to other
sessions (it is how the operator's `:4319` and a transient `:4332` squatter were found);
`pgrep`/`ps` see only your own PIDs. **The rule: you can see a port is held, but not who holds it.**

## What this is
Web-based harness and shell for Claude Code with a first-class notebook, successor to the Electron app **ClaudeMaster** (`../ClaudeMaster`, the port source). Single operator, local-first, reachable from a phone over Tailscale. Architecture: `PLAN.md`. Security model: `SANDBOX.md`. Per-session external reach: `CONNECTORS.md`.

## Status
**Phase 1 and Phase 2 are complete.** Phase 3 shipped teams; remotes/SSH is **cut**, not pending. Beyond the original plan, three subsystems now exist that it never described: session sandboxing, connectors, and `/rewind`.

The product's organising idea, which post-dates PLAN.md and should be read as the current one: **every kind of reach a session has is an operator-set, per-session property** — which folders (sandbox mounts), which external MCP servers (connector grants), which tools (role + permission rules), which model, which role. Features are judged against that.

**Committed next work:** phone-native layout (the shell is desktop-only; everything behind it is built), then a fleet/attention view, then rich notebook outputs via a pinned in-origin JSON-bundle renderer.

## How to verify state (run these before trusting anything below)
```
git status --porcelain                      # authoritative; this file cannot be
npm run typecheck                           # all three workspaces — NOT scratchpad/, see below
./scratchpad/run-suite.sh                   # whole suite — NEVER run Chrome tests standalone
npx tsx scratchpad/<name>-guard.mts         # any single standing guard
```

**STATUS 2026-08-24: `npm run typecheck` does NOT cover `scratchpad/`.** No tsconfig includes it
(`web/tsconfig.json` is `"include": ["src"]`; server and shared likewise), and `tsx` strips types
without checking them. So the ~30 harnesses are **run but never typechecked** — including
`session-reducer-test.mts`, which imports production types straight from
`web/src/store/sessionReducer.ts`. A harness can therefore drift from the types it asserts against
and still go green, which is the same "passes for the wrong reason" family this document keeps
running into.
*Checked, and currently clean:* the reducer test derives every state from `initialSessionStore`
rather than building `SessionStoreState` literals, so adding the `unacked` field did not silently
break it. That is luck of construction, not coverage. To check one harness:
```
npx tsc --noEmit --strict --skipLibCheck --target ES2022 --module esnext \
  --moduleResolution bundler scratchpad/<name>.mts
```
Verified to work and to exit 0 on a clean file. Wiring `scratchpad/` into a tsconfig wholesale was
NOT attempted — the harnesses mix Node, DOM and CDP surfaces and would need their own lib/types
set, so it is a real task rather than a one-line include.
Nothing here is committed. The working tree carries ~90 changed/untracked files for the
operator to review; last commit is `2a57def`.

### STATUS: the 2026-08-24 restart was ORDERED but had NOT happened at time of writing
The operator chose "restart now" for the credential fix. It had not been executed yet, and all
four delegations completed first, so **nothing was lost** — an earlier draft of this block said
their context was gone and had to be re-issued. That was written in anticipation and was wrong.
Their results are folded into the sections below.

**The restart is now LESS urgent than the OAuth entry implies, and here is the evidence.** QA
measured `interrupt-test.mts` PASSING (7s). Its earlier failure that day was self-diagnosed by
the harness, which printed *"the CLI reported an API error, so this run is NOT a verdict on
interrupt: rate_limit — You've hit your session limit · resets 2:40pm"*. **A session rate limit,
since reset — not OAuth, and not a code regression.** Credentials measured valid to
2026-08-25T07:54Z. So the three-divergent-stores problem is real and the restart still collapses
it, but the symptom that motivated the urgency was a different thing wearing its coat.

**When the restart does happen, one thing comes free and one does not.** Free: the stale-`reviewer`
problem (step 2 below) — a relaunch is exactly what re-reads `agents.ts`, so every session returns
holding the git-scoped `allowedTools` instead of the old unscoped auto-approved `Bash`. Critic was
therefore deliberately NOT dismissed; dismissing would have destroyed its context to buy something
the restart provides anyway. NOT free: **cross-process refresh serialisation.** Collapsing the
stores onto one inode removes the N>1 divergence, but nothing serialises a refresh across
processes — two sessions can read the same refresh token, both POST it, and the second gets
`invalid_grant`. Narrowed from guaranteed to a real race. **Do not close the OAuth item on the
restart alone.**

**Bring the server back with `npm run dev`, not `npm run start`.** `server/package.json` defines
`dev` as `tsx watch src/index.ts` and `start` as bare `tsx src/index.ts`. A watch server would
have picked up the 08-23 credential fix on its own; that it did not is evidence `:4319` was
launched via `start`. Using `dev` retires this entire "in the tree but not live" confusion class.

## Next steps (ordered — a resuming session starts here)
_Rewritten 2026-08-24 after four delegations reported. Items 1, 4 and 5 of the previous list are
DONE or were already done; they are kept as struck-through stubs so a reader who remembers them
finds the disposition rather than an absence._

1. ~~Run the full suite.~~ **DONE — 64/7/6 measured.** See **Test-suite figures** above for the
   split, the seven failures, and the non-determinism caveat. Both predicted greens confirmed:
   `data-dir-containment-guard` PASS, `auth-token-containment-guard` PASS.
2. **A running session does not pick up `agents.ts` edits.** `launch()` copies a role's
   `systemPrompt`/`model`/`allowedTools`/`disallowedTools`/`readOnly` into the spawn **once**, and
   `launchStale()` has a term for *which role is assigned* but none for *the assigned role's
   definition changing*. So any session running as `reviewer` since before 2026-08-22 still holds
   the old unscoped shell — not hypothetical: after `reviewer` was narrowed from bare `Bash` to
   read-only git patterns, a live reviewer session was still holding the unscoped shell.
   **Relaunch it**, or `setAgent` it to another role and back. Do not bolt a fifth term onto
   `launchStale` — see the Architecture strand's `Capability` table, which subsumes it.
   **A relaunch discharges the symptom for free**, which is why Critic was not dismissed to fix it.
   **★ STATUS 2026-08-25: now DETECTABLE rather than restart-dependent.**
   `scratchpad/agent-pending-test.mts` ("F4 — STALE-SCOPE DETECTION") is a **deliberate fails-first
   probe**, 12 passed / 2 failed, and **its two reds are unbuilt work, not regressions**: `★ mutating
   the ROLE DEFINITION flips agentPending on the running session` and `the cleared session is
   running the NEW scope`. The fix it asks for is a proposed `agentPending` field — a **third**
   configured-vs-effective dimension on `SessionInfo`, deliberately built to the same shape as the
   two that already exist (`sandbox`/`sandboxed` + `sandboxPending`, and `connectorsPending`)
   rather than as a new concept. Server-side, so **gated on the unconfined session**.
   Deterministic — `claude` is a stub on PATH, no real CLI, no auth, no network.
3. **The `sandboxPaths.ts` rationale header — LANDED 2026-08-25 08:49, but NEEDS RE-LANDING.**
   The pre-revision version landed cleanly and verified (298 lines total —
   208 header lines, a blank separator at 209, body at 210-298; body byte-identical to
   `scratchpad/sandboxPaths-body-snapshot.ts` at offset 210). It was then **revised** — the third
   enforcement bullet changed from `ResolvedMount.refusal?` to the `active`/`excluded` split (see
   the design decision below) — so **the landed file and its source now disagree about the same
   function**, which is exactly the failure this strand is about. Re-land to close it.
   **The recipe is now IDEMPOTENT** and does not depend on the current state of the file: it
   rebuilds from the header plus the body SNAPSHOT, so running it over an already-landed file is
   correct and cannot double up a header. Step 1 compares the LAST 89 lines rather than the whole
   file, so it works either way. Current numbers: header **223** lines, landed file **312**, body
   offset **224**. Distinguish the versions with `grep -c 'refusal?: RefusalReason'` (must be 0)
   and `grep -c excluded` (must be 3) — **the line counts alone will not tell you which version
   you have.** `server/` is `--ro-bind` read-only to everyone except the unconfined session.
   Do not wire any caller to `boxCanReach` — see item 6.
   **Three recomputes of these numbers in two days.** That is the argument for the divider-relative
   extraction: the EXTRACTION no longer rots, only the three stated numbers do, and the diff
   checks those.
4. ~~`web/dist` is stale.~~ **DONE — rebuilt 2026-08-24 20:23:33**, verified by content (the
   bundle now contains a string that was absent that morning), not by timestamp. **This is not a
   permanent state: any `web/src` edit re-stales it and silently returns 12 harnesses to
   no-signal.** Treat "rebuild dist" as a step in any browser-test run, not a one-off fix.
5. ~~Phone-native layout, slice 1.~~ **BUILT.** And so is **slice 2A** — `refresh-survival-check.mjs`
   is complete, registered as `chrome:refresh-survival-check.mjs`, and **green at 17 passed / 0
   failed**. It is GROUP B (spawns its own vite, so the browser gets the WORKING TREE, fully
   interpretable) — it never serves `web/dist` and never touches `:4321`.
   **It answers the `SWEEP_GRACE_MS` question the honest way: it WAITS.** One shared aged fixture,
   `GRACE_MS + 1500 - age` (~31s) slept once, no fake timers, with the instruction in its header
   not to optimise the sleep away — *"you do not speed the net up, you silently delete it."*
   **★ It corrected its own spec by measurement, which is the part worth reading.** H4 was specced
   as detectable with a dead-pane/live-pane fixture; with H4 broken that fixture ran **15/15
   GREEN**, because the reconcile performs its own unconditional `api.pane.prune(keep)` gated by
   neither flag, so both versions converge on identical end state and **any** end-state assertion
   must pass on both. **A fixture that cannot distinguish broken from fixed is not coverage.**
   Replaced by a **call-order** assertion (`list:start → prune:start → prune:start → list:done`):
   16/1 on the break, 17/0 restored. The old fixture was kept rather than deleted — it reddens the
   H5 break.
   The net also earned its keep on its first green-seeking run, going red against correct-looking
   code and exposing a real `TerminalView` defect: the attach-mode pane id was never re-armed after
   a remount, so replay bailed, live output was dropped and typing no-opped.
   **OPEN, routed:** `GRACE_MS = 30_000` is duplicated in the harness under a comment reading "MUST
   track paneManager.ts SWEEP_GRACE_MS", enforced by nothing. The asymmetry is the hazard — LOWER
   the server constant and the harness merely oversleeps; **RAISE it and the harness under-ages and
   every reload assertion silently goes vacuous**, which is the failure the file exists to prevent,
   one level up. Fix is to read `paneManager.ts` at startup, regex the constant, and hard-fail on
   mismatch.
   **NEXT IS 2B, and it is genuinely unbuilt — verified, not assumed.** `web/src` greps clean for
   `data-testid="pane"`, `usePhone` and `matchMedia`: no matches anywhere. So the pane hooks, the
   phone breakpoint source and one-pane-at-a-time are all still to do, and `layout-check.mjs`'s
   remaining `[phone]` red is red for the right reason.
   > **★ ROUTING LESSON, and it is the coordinator's error, not the planner's.** Two consecutive
   > planning assignments were for work already in the tree, both times because a "next steps"
   > entry here was taken at face value — **the exact defect this document says is the codebase's
   > recurring one, committed while reading this document.** A one-line grep would have caught
   > both. **Grep before scoping.**
6. **The `viewOf` precondition is NOT enforced, and landing the header does not enforce it.**
   Architect established that landing satisfies condition 1 of the standing rule and **nothing
   else**. The header does state the precondition precisely ("A MountView MAY ONLY EXIST WITH THE
   SYMLINK REFUSAL ALREADY APPLIED", plus three enforcement bullets: brand `MountView` so it
   cannot be an object literal, give `ResolvedMount` a `refusal?`, and take the two-input
   signature) — **but `mount-shadowing-guard.mts` §4 does not enforce it.** §4 RECORDS the
   consequence of its absence (that `boxCanReach` over-approximates a shadowed path); §1 enforces
   the production-side refusal. **There is currently no test anywhere that `viewOf` refuses
   anything, because `viewOf` has no refusal step.** The header says so itself: the gate is shut
   because there are zero callers, "not because the precondition holds. That guarantee is vacuous
   and evaporates at the first import."
   **Migration trap:** §4 calls `viewOf(nested.mounts)` with ONE argument; the header prescribes
   two. That call site must change in the same commit or the guard stops compiling — which is the
   good outcome, but only if someone expects it.
7. **`terminal-ui-e2e`'s failure was a real bug; a fix is in the tree, unverified.** See the
   `sessionReducer` entry below. Devil is verifying and pinning it with a fails-first reducer
   test; QA has the three stale harnesses (trust gate, bell selector, ratelimit chip).

### The dangling active session — found via `terminal-ui-e2e`, 2026-08-24, FIX IN TREE, NOT YET VERIFIED
`web/src/store/sessionReducer.ts`'s `list` case read
`if (state.activeId !== null || sessions.length === 0) return withList` — it returned early
whenever ANY selection existed and **never asked whether that selection was still in the incoming
list**. `destroyed` does clear the selection, but it is dispatched **only by the client's own
`destroy()`**. A session destroyed out of band — another tab, another client, the server, or a
direct `POST /api/session/destroy`, which is what the test does — arrives as a plain
`session:list` broadcast instead. The row vanished while `activeId` kept pointing at a dead id.
`canTerm` is literally `activeId !== null`, hence a Terminal button enabled with nothing to attach
to; the same dangling id also reached `activeSession`, `ChatView`'s `key`, and the per-session
pane/terminal maps. **The Terminal button was the visible symptom of a wider dangling reference.**

Fix: `list` now reconciles — keeps a live selection, replaces a dead one, nulls only on an empty
list. **The non-obvious half is the new `unacked` set**, and it is why the fix does not trade one
bug for another: a `list` computed BEFORE a create can be delivered AFTER it (WS and HTTP are
separate channels), and by shape alone that is **indistinguishable from a removal** — both are an
active id absent from the incoming list — yet the two demand opposite handling. `created` marks
the id unacked, `list` clears it on acknowledgement, `forget` drops it (without which a session
destroyed before it was ever listed would stay unacked forever, reinstating the very bug).
**`fresh` was deliberately NOT reused for this**: `fresh` is life-of-session ("created this app
load, so never auto-resume it" — `ChatView`'s auto-resume effect is its only consumer), so
clearing it on first ack would break that meaning. Do not merge the two sets.

**The first version of this fix left a gap, and finding it is the instructive part.** Review
caught that keeping the selection while still taking `sessions` wholesale from the payload left
`activeId` pointing at a row absent from `state.sessions` for the stale window — **the same
dangling shape, transient, reached from the other direction.** Fixed by carrying unacknowledged
rows through: a `list` that predates a create is **not a denial of that create**, so it has no
business deleting the optimistic row. The row and the selection move together.
That change paid for itself twice, because the liveness test can now read the merged array and
the second `unacked.has(...)` term disappears — "is the selection alive" and "is its row present"
become **the same question**, with no second term that can disagree with the array. One stateable
invariant remains, and it is asserted directly (F2.9) rather than inferred from scenarios:
> **`activeId` is non-null only while a row with that id is in `sessions`.**

Pinned in `scratchpad/session-reducer-test.mts` (extended, NOT a new file — a separate artifact
would be free to rot independently of what it pins), **57/57**. Fails-first was MEASURED, not
assumed, and the measurement overturned the prediction: restoring the old one-line guard turns
**four** red, not the three predicted from reading the code. F2.8 began as a characterization test
recording the gap and was INVERTED when the gap closed; it is kept in place with that history
written into it, so nobody later reads the sides as having always been that way.
**STATUS 2026-08-24 21:17: VERIFIED END-TO-END. `terminal-ui-e2e` is GREEN, all six checks.**
The bundle was rebuilt and confirmed newer than *every* file in `web/src`, and there is a clean
fails-first pair — RED against the pre-fix bundle, GREEN against the post-fix one, freshness
verified in both runs — so the assertion is proven able to fail and its green is worth something.

**AND THE FIX WAS NOT SUFFICIENT ON ITS OWN — this was under-stated for most of the session.**
`disabled={!canTerm}` on the Terminal button and the reducer reconcile are **two changes and one
guarantee**, not a fix plus a confound. The button predicate is correct and necessary but only
bites once the reducer stops handing it a dangling `activeId`. Diagnosed from a live DOM dump: after
the destroy the sidebar correctly read "No sessions yet" while the button reported
`disabled: false` and the *enabled* title — so `canTerm` was true with zero sessions.
**`canTerm={activeId !== null}` is the wrong predicate whenever the selection can dangle.** Same
shape as sandbox escapes 5 and 6, where two mechanisms had to hold for one property.

> **★ "READING A FILE AND RUNNING A FILE ARE TWO DIFFERENT EXPERIMENTS."** The first hypothesis
> here — that the reducer left a dangling `activeId` — was probed in isolation, returned
> `activeId=null`, and *looked* refuted. It was not: the reducer source had been fixed on disk
> between the read and the run. **This is the in-the-tree-versus-live defect at a MINUTES-long
> timescale rather than the known 27-hour one, and the short window is the more insidious version
> because nobody thinks to suspect it.** With several sessions editing one tree, a source read is
> not evidence about a running system. What settled it was the live DOM dump.

### ★ A CORRECT BELIEF PLUS A TEST THAT CANNOT FALSIFY IT — 2026-08-24
Reviewing the `unacked` merge, the reasoning offered was "a redundant list still returns the same
object, because `orphans` is empty once acked." **True, and the test that supposedly covered it
could never have caught the failure**: `F2.7a` runs with `unacked` EMPTY, so the merge does no
work at all. The risky case is the opposite one — a repeated STALE list while `unacked` is
non-empty, where the merged array is **freshly allocated on every broadcast** and only
content-comparison saves identity. That case had no coverage.
> **A correct belief plus a test that cannot falsify it is indistinguishable from luck.** When a
> test is cited as covering a property, check that it exercises the branch the property is about
> — not merely that it passes.
Closed by `F2.7e`/`F2.7f`. `sameSessions` compares content, not reference, so no churn.

**Fails-first was measured twice, and both breaks taught something.** Restoring the old one-line
guard: 5 red — and **F2.9 (the bare invariant) caught the original bug as `a:[b]` and `a:[]`
without knowing which scenario produced them**, which is the case for asserting invariants
alongside scenarios. Dropping the orphan merge: 3 red, and critically **`F2.4b` is among them** —
so the merge is now a **correctness dependency, not a cosmetic row fix**. Once the second
`unacked.has(...)` term was removed, the merge became the only thing keeping a just-created
session selected through a stale broadcast. Anyone "simplifying" it away silently reintroduces
the create-race bug; F2.4b/F2.7f/F2.8 are what stop that.

**The leak is bounded, via `reconnected`, and the fix shape was chosen against a rejected one.**
The single path by which `unacked` leaks is a create the server never lists and the client never
destroys — i.e. the connection dropping between a create and its acknowledging broadcast. **A
server restart is exactly that.** Since `list` began carrying unacknowledged rows through, a
leaked id costs a **phantom session row that never disappears and never reconciles**, where it
used to cost a dangling selection whose row self-healed away. So a `reconnected` action clears
`unacked` on the WS up-edge, changing state at most once per reconnect and never during
steady-state broadcasts. **The rejected alternative matters as much as the choice:** counting how
many lists omitted an id and dropping it after N was rejected because it fights hazard H2 — a
per-list counter churns state on exactly the repeated identical broadcast that must return the
same object, so the fix would have required weakening F2.7a/e. **When a candidate fix requires
loosening an existing test, suspect the fix, not the test.**
**STATUS: `reconnected` is PINNED — section F3, 12 checks.** (Suite total at the time: 72/72; **current total is 93/93** — see below.) Fails-first
measured by gutting the case to `return state`: 3 red. Note F3.2 (identity when `unacked` is
empty) stays GREEN under the gutted version, correctly — it pins identity, not the fix, and must
not be counted as coverage of the fix.

Both open questions were answered by reading the source, not by assuming:
- **`api.on.connected` fires on BOTH edges and on EVERY open, including the first**
  (`client.ts` emits `true` unconditionally from `sock.onopen`, `false` from `retry()`). So the
  fix does fire — but the unconditional first emit meant the call site needed a `wasDown` latch,
  which it lacked. Harmless only while nothing creates a session before the socket opens: true
  today (the sole `create(` is user-driven, no auto-create on load), and it would quietly stop
  being true the moment anything restores a last session, follows a deep link, or spawns a
  subsession from a URL. **Latch added**, matching `TerminalView`'s existing handler — the house
  pattern, not a new idea.
- **UP edge KEPT, and the reasoning is the deliverable.** `createSession` is HTTP, so a create
  SUCCEEDS while the WS is down and dispatches `created` during an outage — which makes the two
  edges genuinely different rather than a style choice.

> **★ F3.4's EVENT SEQUENCE IS AMBIGUOUS, AND NO REDUCER-LEVEL TEST CAN RESOLVE IT.**
> `created → reconnected → a list without it` is produced by two different realities the reducer
> cannot tell apart — identical actions, order and payloads: **(i)** the server restarted and lost
> the session, so moving the selection is right and closes the phantom bug; **(ii)** the session
> was created *during* the outage, the server has it, and this list merely predates it — the very
> create-race `unacked` exists to prevent. **The assertion therefore encodes a POLICY PREFERENCE,
> not a proof**, and that is written next to F3.4 so it is never later read as evidence that (ii)
> was considered and ruled out.

Chosen on frequency and asymmetric cost: a restart is deliberate, whereas creating a session
inside a sub-8s reconnect backoff is rare; and (ii) costs a selection that self-heals in the row
on the next list, while (i) left a phantom that never went away at all. The down edge inverts it
exactly — perfect on (ii), but it bounds (i) by the *next* disconnect rather than closing it at
this one, so a create lost to a restart during an outage would strand until some later drop.
**Scope note:** the invariant is a property of **the `list` case**, not of the store —
`withActive` sets `activeId` unconditionally, so `setActive` does not enforce it. No UI path
produces such a call (selection is driven by clicks on rendered rows), so it is recorded rather
than pinned. Do not let it get described as a store-wide guarantee.

### ★ THE FIX FOR A BUG REPRODUCED THE BUG — `created` vs `list` ordering, 2026-08-24
An independent review found that `case 'created'` computed `exists` (correctly declining to
duplicate the row) and then added to `unacked` **unconditionally** — re-marking an
ALREADY-ACKNOWLEDGED session as unacknowledged.

**The server-side half is PROVEN, and it is the interesting part.** `/api/session/create` in
`sessionApi.ts` calls `sessions.create(...)` **synchronously, with no `await`**, and
`SessionManager.create` runs `this.emit('changed')` on the line **before** `return session.id`.
**So the `session:list` broadcast carrying a new session is emitted strictly BEFORE the HTTP
response that announces it.** On loopback the WS frame is routinely parsed first. *(That last
clause is a PROXY — what is proven is the server's emit order, not the client's processing order.
Measure by logging dispatch order of `list` vs `created` for one create.)*

Failure: `list [a,b,c]` lands first so `c` is an ordinary acknowledged row → `created(c)` arrives,
`exists` is true, row not duplicated, **but `c` goes back into `unacked`** → `c` is destroyed out
of band → `list [a,b]` reads its absence as "a list predating a create" → **phantom row carried
through, selection pinned to a dead session.** The original bug, reproduced through the mechanism
added to prevent it.
> **When a mechanism keys off "have we heard from the server about this yet", check every path
> that can set that flag AFTER the server has already answered.** Fixed by gating the add on
> `!exists`: **membership in `state.sessions` IS the acknowledgement signal**, which is what makes
> the guard correct rather than merely cheaper.

**Second finding, same review: `list` never called `forget`.** `forget` was reachable only from
`exit` and `destroyed` — but this change's whole premise is that **`destroyed` fires only for our
own `destroy()`**, so an out-of-band removal arrives as a plain `list`. So `list` reconciled the
selection but never cleaned the side tables: a session that finished a turn unwatched and was then
destroyed from another tab kept its `attention`, `prevState` and `fresh` entries **forever**,
growing unbounded in a long-lived tab. A **half-application of the lesson `forget` was written
for**, on the exact case this change is about. Now fixed. No correctness impact today (nothing
reads those maps for an absent id), which makes it easy to test for the wrong reason — assert on
the maps directly and confirm the assertion reds when the loop is removed.

**Known and NOT fixed — the orphan merge can reorder the sidebar.** `[...action.sessions,
...orphans]` appends, but `state.sessions` holds orphans wherever `created` put them. Two
outstanding creates acked out of order (`state.sessions=[a,c,d]`, incoming `[a,d]`) merge to
`[a,d,c]`, so the sidebar reorders and then reorders back. Presentation only, needs concurrent
creates with out-of-order acks. Left alone deliberately: a positional re-insert must pick an index
against a shifting array and risks fighting the server's canonical order — a worse trade than a
rare transient reorder.

**STATUS: both fixes are PINNED.** (Suite total at the time: 92/92; **current total is 93/93**.) Fix 1 as F4 (7 checks; break = remove the
`!exists` gate → 4 red, including the five-step race end-to-end). Fix 2 as F5 (8 checks; break =
delete the `forget` loop → 3 red). The reorder is pinned as characterization in F6.

**Three pieces of test discipline from that round, each worth more than the checks themselves:**
- **F5 asserts on the maps DIRECTLY.** A check routed through `needsAttention` for an absent id
  would pass either way — for the wrong reason — because the fix has no correctness impact today.
- **F5.2 asserts SURVIVING rows keep their entries**, which nobody asked for. **An over-reaching
  `forget` is exactly as wrong as none, and an assertion that only inspects the removed id cannot
  tell those apart.** Generalise: when pinning a cleanup, pin what must NOT be cleaned.
- **F3.2, F5.3a and F5.3b stay GREEN under their own breaks, and that is correct** — they pin
  identity, not the fix. They are labelled so they are never counted as coverage of it.
The client-ordering claim is written into the test file as an **unobserved proxy**: the tests drive
the action order directly, so they pin the reducer's behaviour *given* that interleaving and are
not evidence the interleaving occurs.

**A decision kept, its stated reason discarded.** The reorder was justified as "a positional
re-insert risks fighting the server's canonical order". Review rejected that: **appending already
does**, so it cannot be the argument for appending. Re-insert is weakly better, not a worse trade.
The decision stands on the smaller true reason — cosmetic, rare, self-correcting, touches neither
the invariant nor the selection nor any side table, not worth index arithmetic in the hottest
action in the store.
> **A decision propped up by a wrong reason is one refactor away from being reversed for the wrong
> reason too.** Check the argument even when the conclusion is right.

**The `connected`-has-no-replay limitation is now CLOSED, at its root.** Both symptoms — the
unguarded first-connect dispatch and the missed reconnect after mounting mid-outage — came from
the same fact: `connected` is a plain channel carrying no initial state, so a subscriber cannot
tell where it came in. A bare `wasDown = false` gets one of them wrong whichever way you pick.
The first attempt seeded it `!api.isConnected()`. **That was WRONG, and review caught what a green
suite could not — it closed NEITHER door it claimed to.** `isConnected()` requires readyState
`OPEN`, and two independent facts each make it false at first mount: a freshly constructed
`WebSocket` is CONNECTING, never OPEN; and `SessionsProvider` is nested inside `AuthGate` while
`ensureWs()` is called *only* from `AuthGate`'s effect — React runs child effects first, so `ws`
is still `null` when the sessions effect body runs. Either alone means the seed reads `true` on
**every healthy startup**, dispatching `reconnected` on first connect: exactly the bug the latch
was added to prevent, through a different door. It was a silent no-op only because `unacked` is
empty then.
> **The dangerous artifact was the COMMENT, not the line.** It asserted "one seeded latch closes
> both" — a property that did not hold. **A wrong line gets fixed; a wrong comment gets believed.**
> In a codebase whose recurring defect is unverified claims, a confident comment is a liability
> with a longer half-life than the code it sits on.

**Fixed properly: the primitive is "have we EVER been open", not "are we open".** `client.ts` now
carries a module-level `everConnected`, set once in `sock.onopen`, exposed as
`api.hasEverConnected()`; the seed is `api.hasEverConnected() && !api.isConnected()`. readyState
genuinely cannot answer the question — it conflates *never connected yet* with *was connected and
dropped*, and that distinction IS the question. Four cases, all correct: healthy first mount →
false; remount or outage after a prior connection → true; app loaded while the server is down and
never connected → false, rightly, since HTTP creates fail too and nothing can strand; StrictMode's
second run → correct either side of `onopen`. `isConnected()` is kept — it is right for
`setConnected`, and correctly returns false for CLOSING/CLOSED (`retry()` nulls `ws` before
emitting, so a completed drop reads down, and the `close()`→`onclose` window reads CLOSING).
**The only harmful conflation was CONNECTING-at-startup.**

STATUS: call-site wiring, **reviewed but NOT pinned by any test — the 92/92 says nothing about
it**, and deliberately so: the only thing that could falsify it is real mount-order-plus-socket
timing, which needs the browser path that does not currently work. Extracting a two-boolean truth
table to unit-test would be ceremony, not coverage.
> **This episode is the argument for keeping call-site wiring under REVIEW rather than trusting
> it.** 92/92 was exactly as silent here as it was before the tests that catch the reducer bugs
> existed. A suite that cannot see a category of change is not evidence about that category.

**Refuted hypotheses from the same review — recorded so nobody re-derives them.** Purity holds
throughout (no in-place mutation of any state-held Map/Set). `wasDown` is correct under StrictMode
(function-scoped per effect run, discarded with the subscription). `patch`/`state`/`ready`/
`markBusy` treat an orphan row identically to a real one. `sessions[0]` does not fight
`destroyed`/`exit`. F2.7d and F3.3a-e all have genuine falsifying power — the reviewer's strongest
candidate for a vacuous test was F3.3a-e, on the theory that `rich.unacked` would be empty and
`reconnected` would take its `size === 0` early return, making all five trivially `x === x`; it
does not, because the fixture ends with a `created`. **One latent limitation logged, not fixed:**
`connected` is a plain channel with **no replay to new subscribers**, so if the socket is already
down when the provider mounts, `wasDown` stays false and the first up-edge is not treated as a
reconnect. Reachable only when the provider mounts during an outage.

### ⚠ STATUS 2026-08-25: THE LANDED HEADER INSTRUCTS A RULE THAT IS WRONG. RE-LAND BEFORE (i).
`server/src/claude/sandboxPaths.ts` currently carries the **pre-revision** header (298 lines,
header 1-208, body offset **210** — NOT the 223/312/224 that describe an intended re-land which
has not happened). Paste fidelity was checked line by line and is CLEAN — every line kept its
`//`, nothing wrapped, the nested indentation and `***` emphasis survived. **The problem is which
VERSION was transferred, not the transfer.**

Two revisions are missing, and **the second is the dangerous one**:
- the `active`/`excluded` split is absent (the `refusal?` bullet is still there) — a design
  improvement not yet reflected;
- **the ownership correction is absent, so the landed file tells an implementer to "discard any
  mount whose boxPath is overmounted by a DEEPER logical mount, then take the DEEPEST survivor".
  That rule is wrong**, and step (i) — the next task for a `server/` writer — is exactly that
  implementation.
> **A stale design document is an ordinary problem. A stale document whose entire purpose is to be
> the instruction, sitting at the top of the file it instructs, with the implementation queued
> behind it, is a different thing.** Re-land rather than handing a writer a brief that contradicts
> the file: a brief that disagrees with the code it describes is the two-documents-disagreeing
> failure with extra steps.

**Corrected source is ready.** `scratchpad/sandboxPaths-rationale-header.txt` now carries the
depth-free ownership rule, the ANY-GRANTS reasoning with its live measurement, the "do not delete
`viewOf`'s sort" note with the argv-order reason, invariant **R1**, and a rewritten migration step
(i) that says to REPLACE `mount-shadowing-guard` §4 with hand-built fixtures rather than merely
flip its expectation. **New numbers: header 259, landed total 348, body offset 260** — dry-run
verified, body byte-identical at 260.
**Distinguish versions by content, not by counts:** `grep -c 'refusal?: RefusalReason'` → 0 and
`grep -c 'DEPTH NEVER ENTERS'` → 1. Four recomputes in two days; the counts alone have been wrong
more often than right.
**Count reconciliation, so nobody "fixes" it:** the landed file has **11 STATUS claims / 12 grep
hits** (the 12th is the marker's own definition) while the scratchpad file greps **13**, because
that file's PREAMBLE also mentions the convention and the preamble is correctly NOT landed. The
difference is expected; do not conclude a claim went missing.

### STATUS 2026-08-25: scroll memory — GitPanelView WIRED; AgentDetail was ALREADY wired
`GitPanelView` now has three keyed containers (`git:${cwd}:changes` / `:log` / `:diff:${patch}`),
`scroll-memory-check.mjs` grew 15 → **36 checks, 36/0**, with five mutations each measured to a
single predicted red. **`[3d]`, `[3e]` and `[3g]` stay green under the wiring mutation — they pin
the KEY, not the wiring**; only `[3a] [3b] [3f]` are coverage that the feature works.

**The consumer contract, confirmed consistent across all six existing consumers** (there was no
disagreement to report): `<namespace>:<sessionId>:<subject>`, with a `#<sub-container>` suffix when
one subject owns two containers. Container views build the key; leaf editors take `scrollKey?` as
a prop. `AgentDetail` omits the `?? 'none'` fallback correctly, because its `sessionId` is required.
`ChatView` is deliberately outside this system — it has its own `pinnedRef` mechanism. Do not unify.

**GitPanelView is keyed by CWD, not by session, and the first stated reason was measured FALSE.**
The draft justification — that session-scoping would invent a scroll jump on a same-cwd switch —
does not hold: an unseen key has target 0 and the hook only forces an offset when `target > 0`, so
it is a no-op. The reason that DOES hold: nothing else in the panel is session-scoped (mode,
selected file, loaded diff, commit-message draft all persist across a same-cwd switch because
nothing remounts), so session-scoping the scroll offset alone would scroll the view while the
selection, the diff under it and the half-typed message stayed put. One panel, one position.
> **A justification is a claim. An unmeasured one belongs in the same suspicion class as a
> `STATUS:` line** — and this one was written into the file before being tested.

**★ "AgentDetail is unwired" WAS FALSE — and the coordinator asserted it without checking.**
`AgentDetail.tsx` already imports `useScrollMemory`, computes `agent:${sessionId}:${agentId}`,
calls the hook, and carries a module-level `pinnedByKey` map preserving the 80px bottom-pin across
remount. Uncommitted working-tree change, author unattributed.
> **Third stale-claim instance of the day, and this one was issued in the same message that
> corrected a teammate for carrying a stale claim.** The note-vs-tree drift runs in both
> directions and the coordinator is not exempt from the rule it is enforcing.
**AgentDetail's wiring has ZERO harness coverage** — it exists but nothing exercises it. Covering
it needs the `claude` stub to emit stream-json (a Task/Agent `tool_use` plus child frames carrying
`parent_tool_use_id`, which is what `collectAgents` turns into `steps`) and then tray navigation.
Patterns to borrow: scripted stubs in `layout-check.mjs` / `ask-card-height-probe.mjs`, tray
navigation in `doubling-agents-test.mjs`.

### AgentDetail scroll memory — HARNESS BUILT, 58/58. And the design question is ANSWERED.
`scroll-memory-check.mjs` is now 15 → 36 → **58 checks, 58/0**, four mutations each measured to a
predicted red (`MA` wiring removed → `[4a][4b]`; `MB` `pinnedByKey` gone → `[4a][4b][4c]`;
`MC` `sessionId` dropped from the key → `[4b]` alone; `MD` hook moved below the follow effect →
`[4d]` alone). `AgentDetail.tsx` was md5-verified byte-identical after every mutation.
**`[4d]` is GREEN under both `MA` and `MB` — it pins the ORDERING, not that either fix works.**

**★ THE DIVERGENCE CASE — a pinned reader whose transcript grew while unmounted — RESOLVES TO
"FOLLOW WINS", AND THAT IS CORRECT.** `remembered=6891, new end=9411, landed=9411`. Mechanism: the
hook gives up the instant it LANDS (`if (landed || …) restoring = false`), and on a remount the
transcript is already at full height, so it lands on its first tick and stops — then the follow
effect runs after it **in the same commit** and has the last word. Pinned means "follow the live
output", so a follower is carried to the latest while `[4c]` proves a non-follower is left exactly
where they were. The two compose correctly; **no change needed.**
> The prediction going in was "restore wins", and it was wrong. **The comment already in
> `AgentDetail.tsx` — "if the reader was pinned, the follow effect below puts them at the bottom
> anyway" — was right.** Written by a coordinator session that then forgot it existed (see the
> authorship entry above), and vindicated by a measurement taken to check a contrary prediction.

**★ `pinnedByKey` IS LOAD-BEARING, AND THE FILE SAID OTHERWISE.** The claim was that the map is
invisible to a check parked mid-document, because `onScroll` overwrites the seed a frame later.
`MB` measured that FALSE: it reds `[4a]` and `[4b]` too. **`onScroll` is a delegated handler that
runs in a LATER TASK, while the follow effect runs in the SAME COMMIT** — so the correction always
arrives after the view has already moved. Without the map, **every remount of a live agent snaps to
the end at any offset.** The wrong claim is kept in the file with its measurement beside it.
> **Third justification in that one file to be plausible and then fail measurement — and both of
> today's failed the same way: reasoning about what the hook does OVER TIME while ignoring what
> ORDER things run in.** In React the ordering within a commit is usually the whole answer, and it
> is invisible to reasoning that models the system as a timeline.

**Two facts worth keeping, both found only by measuring:**
- **`<AgentDetail key={active.id}>` does NOT remount on a session switch when both sessions hold
  the same agent id.** React sees the same element type and key in the same slot, re-uses the DOM
  node, and passes a new `sessionId` as a prop — the browser keeps `scrollTop`. The "remounts on a
  session switch" comment holds only when the two agent ids differ. That is why `[4b]` is not a
  pure key check.
- **A session row in the sidebar is NOT a `<button>`.** Scoping by `querySelectorAll('button')`
  found no anchor and the section reported *"no subagent ever appeared"* — **a probe reporting on a
  subject it had failed to locate**, which is the rule this project keeps re-learning. Now scoped
  by containment and cross-checked against the detail view's own `· in <session>` header.

**A stale contradiction inside the same file was also fixed:** section [3]'s header still stated
the DISPROVED cwd-vs-session rationale as fact, contradicting the measurement note further down
that killed it. **A file that argues with itself is how a dead claim gets resurrected.**

### ⚠ `scratchpad/scroll-memory-check.mjs` IS UNTRACKED BUT REGISTERED — a latent self-inflicted red
`git ls-files --error-unmatch` errors on it; `run-suite.sh` registers it. **A `git clean` deletes
the file and `registration-lint` then fails closed on the dangling entry**, which would present as
a lint bug rather than as a missing file. Nothing is committed in this repo yet, so the whole tree
shares this exposure — but this one is worse than most because the registration makes its absence
an *error* rather than a silent gap. Add it whenever a commit is authorised.

### ★ STEP (i) DESIGN — THE ORDERING FAULT. Two defects, one fix. DESIGNED, NOT YET BUILT.
`viewOf` sorts by depth of the LOGICAL path while `boxCanReach` matches on the REAL one and takes
the LAST match. That single mismatch produces **two distinct wrong answers**, in opposite
directions, and both die to the same fix — resolve in BOX space instead of host space.
- **Defect B — SHADOWING, fails OPEN.** A mount whose exposure is overmounted by a deeper dest
  still counts. Recorded in `mount-shadowing-guard` §4.
- **Defect A — "LAST MATCH WINS" IS THE WRONG AGGREGATION, fails CLOSED.** Two UNRELATED mounts
  can expose the same real bytes without shadowing each other — both live in the box at once — so
  the right rule is "ANY mount that reaches it grants". **PROVEN BY EXECUTION 2026-08-25** against
  real `bwrap 0.9.0`: the box wrote the file (host contents `ORIGINAL` → `MUTATED`) while
  `sandboxPathAccess` returned `write:false`. Pinned by `scratchpad/authorizer-box-divergence-guard.mts`.
  It DENIES a legitimate write — an inexplicable permission error, **not a breach**. Do not let a
  red there be reported as a sandbox escape.

**THE FIX.** Extract `resolveReach(entriesInEmissionOrder, target): readonly ResolvedMount[]`.
`boxCanReach` keeps only `real(p)` (returning false on null — fail closed) and the mode decision,
which becomes `need === 'write' ? reaching.some(m => m.mode === 'rw') : reaching.length > 0`.
> **`resolveReach` takes `entries`, NOT a `MountView`, and that is load-bearing.** Taking a view
> would inherit the closed constructor and shut the test seam. **THE ENFORCEMENT BOUNDARY
> (`viewOf`) AND THE TESTABILITY BOUNDARY (`resolveReach`) MUST STAY DIFFERENT FUNCTIONS.**

**★ THE OWNERSHIP RULE — corrected, and the first version was wrong.** It was specified as "the
DEEPEST logical root containing boxPath, ties broken by emission order". **bwrap's actual rule is
not about depth at all:** a bind applies at its dest and everything beneath it, and a later bind
covers an earlier one *including an earlier deeper one*. Mounting `/a` after `/a/b` covers `/a/b`.
> **The owner of a box path is simply the LAST entry in emission order whose logical root contains
> it. Depth does not enter.**
The failing case the depth rule got backwards: `[{logical:'/a/b'}, {logical:'/a'}]` with the
shallow one emitted last — bwrap says `/a` covers `/a/b`; the depth rule picks `/a/b`. **Every
other test in the set still passes under the wrong rule**, which is why §4d exists.

**And this restates why `viewOf`'s sort must not be deleted, more strongly than "it breaks ties":**
> **The sort is what makes `entries` equal bwrap's ARGV ORDER.** Without it, "last containing
> entry" is last in some arbitrary order rather than last in the order bwrap will apply. That is
> the comment to put beside the sort — it explains why the sort stays even though `resolveReach`
> never mentions depth.

**INV-R1 — a precondition stated honestly rather than closed.** `resolveReach` REQUIRES entries in
bwrap emission order. This one **cannot** be closed by construction, because the order is genuine
semantic input: sorting internally would destroy information and make the function unable to model
the very case it must model. *Falsifier:* a caller assembling entries another way, or someone
"helpfully" sorting inside. *Escape:* none — instead name the parameter `entriesInEmissionOrder`
so the obligation sits at every call site, and keep `viewOf` the only production producer.
*Check:* §4d, which fails if ownership becomes depth-based or the array is pre-sorted.

**Same-dest-different-source is NOT reachable through `viewOf`**, and the reason is structural:
`logical` and `real` are both derived from the SAME input string, so two entries with one logical
path necessarily share a real root. It arises only in hand-built fixtures (deliberately — that is
the test seam) and in an exotic self-healing TOCTOU. Named, not guarded.

**(i) IS ENTIRELY A `server/`-WRITER TASK — do not split it across two actors**, because
regenerating `scratchpad/sandboxPaths-body-snapshot.ts` requires reading the landed file. Commit
order: edit `sandboxPaths.ts` → regenerate the snapshot → verify the diff prints nothing → update
the preamble's counts. **Of the three numbers only the TOTAL moves**; the body offset (224) and
header count (223) change only when the HEADER changes. Encode that asymmetry so a future
recompute knows which numbers it actually has to redo.

### ★ A POST-MORTEM COMMENT COPIED INTO A NEW FILE BECOMES A LIVE FINDING — 2026-08-25
A deleted probe carried a paragraph claiming that two Chrome harnesses booted against the
operator's REAL `~/.config/claudette`, with `restore()` relaunching every persisted session before
`app.listen()`. Alarming, and it reached me as a possible live compromise of the operator's
session store. **It is FALSE today, established by enumeration, not argument: 12 of 12 harnesses
that boot a server set `CLAUDETTE_DATA_DIR`, with no exceptions**, and the nine that do not boot
one use the shared `:4321` server, which `run-suite.sh` starts with a `mktemp -d` data dir.
The claim's origin is the lesson. `terminal-ui-e2e.mjs`'s header carries a **past-tense
post-mortem** — "These *were* the only two … so they *booted* against the operator's REAL …" —
narrating a bug fixed ten lines below it. A new file copied the paragraph verbatim, and detached
from the fix it was narrating, it read as a present-tense discovery.
> **A post-mortem is bound to the fix it sits beside. Copy the prose without the fix and it
> becomes a bug report.** When lifting a comment into a new file, re-read it as someone who
> cannot see the original context — which is exactly who will read it next.

**ONE LIVE EXCEPTION SURVIVES, and it upgraded the port problem from tidiness to safety.** Those
nine harnesses are isolated only if the harness actually STARTS the shared server. Under the
`already listens on :4321 — using it` fallback they run against a stranger's server whose data dir
is whatever that stranger chose — possibly the operator's real one. **That fallback is the last
remaining route by which the suite can touch a live session store**, which is the argument that
settled the decision below.

### STATUS: the `:4321` fallback is being changed to HARD-FAIL — approved 2026-08-25
It will SKIP the `srv4321` entries as a prerequisite failure rather than running them (consistent
with how a missing Chrome is handled), print who to stop and why, and keep `ALLOW_FOREIGN_4321=1`
as an override. The skip must also appear in the FINAL SUMMARY — "55 passed, 0 failed, 15 skipped"
read without scrollback looks like a healthy run.

### ★ A FALSE GREEN FOUND NEXT TO A RED — 2026-08-25
`notifications-test`'s `bell shows enabled (aria-pressed)` asked whether **any** button in the
document had `aria-pressed="true"`. `SoundToggle` is on by default and carries it, so that check
**passed while the click beneath it was failing** — reporting the sound toggle's state under the
bell's name. Found only because the red beside it was being repaired.
> **A green sitting next to a red deserves the same scrutiny as the red.** Nobody audits the
> passing lines of a failing file, which is precisely where a check that asserts nothing survives.
Repaired to 8/8, and — the right standard — verified **under the condition that broke it** (run
behind three other session-creating harnesses), not merely standalone.

### THREE EXPECTED REDS — a category, not three coincidences. STATUS 2026-08-25.
The suite now carries **three deliberate reds that document UNBUILT WORK, none of which is a
regression and none of which is a live escape.** Anyone reading a total without this list will
misreport it:
1. **`viewof-precondition-guard.mts`** — 0/4. The `viewOf` precondition is unenforced. Its own
   finding shrinks the ask: the refusal, its subject and its justification **already exist and are
   already computed** — the server prints `[sandbox] refusing symlinked mount source …` and then
   discards it. The work is "stop throwing away a reason you already have".
2. **`authorizer-box-divergence-guard.mts`** — the ordering fault, **PROVEN against real bwrap**
   (the box wrote the file; `sandboxPathAccess` said `write:false`). **It fails CLOSED** — it denies
   a legitimate write, an inexplicable permission error, **NOT a breach.** A red here must never be
   reported as a sandbox escape.
3. ~~**`agent-pending-test.mts`** — 12/2. Stale-scope detection; the `agentPending` field does not
   exist yet.~~ **STATUS 2026-08-25: GREEN, 14 passed / 0 failed. NO LONGER AN EXPECTED RED —
   remove its entry.** The field is fully built server-side: `agentKey()` in `agents.ts` digesting
   exactly five launch-read fields, `Session.appliedAgentKey` set in `launch()`, `agentPending`
   computed in `toInfo()`, declared in shared types, and `launchStale()` correctly carrying no
   agent term. **The 12/2 figure was stale and nobody re-ran it.** This is the first real subject
   for the healed-red alarm, which exists for exactly this: an expected red that starts passing
   keeps its banner hiding a future regression.
**All three are gated on the same thing: a session that can write `server/`.** That is the whole
remaining critical path, and it is operator-gated.
**STATUS 2026-08-25: this is now IN `run-suite.sh`, and it is two tags, not one bucket.**
`[unbuilt]` = a characterization test for work not yet written. `[closed]` = a guard catching a
real fault and refusing to pass. **Collapsing them into a single "expected" bucket is exactly how a
genuine finding gets waved through**, and `authorizer-box-divergence-guard` is where that would
cost most — it must never be read as an escape. The summary now prints
`no unexpected failures — every red in this run is a documented one`, and isolates
`UNEXPECTED failures (N): …` when there are any, so the category cannot swallow a real red.
Proven in three states: all-expected, MIXED (the one that matters), and healed.

**★ AND IT DETECTS ITS OWN STALENESS — the first thing here that does.**
```
!!! <file> is listed as an EXPECTED RED but PASSED — the work it documents has landed.
!!! Remove its EXPECTED_RED entry before that banner starts hiding a real regression.
```
> **An expected red that starts passing is not good news to be filed away.** It means the work
> landed and the banner is now a stale post-mortem describing a defect that no longer exists —
> and left alone it keeps a real future regression permanently labelled "documented, not a
> regression". Same family as the copied data-dir post-mortem and as `F5.1c` asserting the buggy
> behaviour: **a written-down expectation outliving the thing it described.** That family has cost
> this project more than any single bug; this is the first instance that can notice its own death.

### ★★ THE KEYBOARD/VIEWPORT QUESTION IS SETTLED — and both recorded diagnoses were WRONG
**Two source comments that had stood for weeks were disproved by ~40 lines of CDP.**

**1. `lib/visualViewport.ts` blamed xterm's FitAddon. Wrong twice.** It claimed the addon "re-fits
from a ResizeObserver gated on `contentRect.width`, so a keyboard never triggers a re-fit at all".
A ResizeObserver fires on ANY box change including height-only, and `contentRect.width > 0` is a
**LIVENESS test** (is the pane hidden?), not a width-CHANGED test — so it passes and `fit()` runs.
**`useTerminal` was never broken.** Nor can the addon fight a CSS variable: the observer watches
OUR container while `fit()` only resizes `.xterm-screen` inside it, so no loop is possible.
**The actual bug was one line of `App.tsx`:** the terminal dock is `shrink-0` with an inline
`height: termH` in **absolute pixels restored from localStorage**, so a dock sized on a desktop
arrives on a phone unchanged — nothing for the observer to observe. Measured at 390×844 with a
saved 600px dock and `--vvh` 508: **176px of terminal below an `overflow-hidden` shell — the
clipped part is the prompt** — rows frozen at 30.
Fixed in CSS, not JS: `min(${termH}px, max(120px, calc(var(--vvh,100vh) - 164px)))`. Deliberately
CSS because `--vvh` republishes on every visualViewport `scroll`, so reading it into React state
would re-render App every phone-scroll frame for a value the browser resolves itself. **The bound
makes the box change and the existing observer re-fits for free: 30 rows → 16.** Desktop inert;
at rest the saved 600px is untouched. Fails-first 6 red → 0.

**2. `index.css` said the pan is "not observable in any harness in this repo". FALSE, and that
claim is what kept the question open.** `Emulation.setPageScaleFactor` gives headless Chrome a
visual viewport shorter than the layout viewport, and a wheel event pans it: **offsetTop 0 → 336
while `scrollY` stays 0** — offsetTop moving while scrollY does not IS the pan. Better: **the
browser auto-pans to reveal a focused input, headlessly** (offTop 0→336, scrollY 0), which is the
closest analogue to the iOS keyboard trigger.
> **★ HABIT: "X cannot be tested here" is a claim about the HARNESS, not about X. Probe before
> recording "X is untestable."** Twin of "grep before recording X is missing". This one cost weeks.

**`position: fixed; inset: 0` DOES NOT WORK — NOT APPLIED.** Two distinct rules, both measured:
- *keeping the height*: **byte-identical to today**, 336px exposed either way. `fixed` resolves
  against the LAYOUT viewport — the very box the visual viewport pans inside — so **it cannot
  escape a pan by construction.**
- *literal (no height)*: exposure → 0 only because the shell regrows to the full 844px and the
  composer returns to y=844, **under the keyboard** — the exact defect `--vvh` exists to fix. A
  regression, not a remedy.
And with `--vvh` on, `#root` occupies layout 0..508 while the visible window at rest is 0..508 —
**the same box, so nothing is off-screen and the browser has no reason to auto-pan.** Every pan
measured had to be driven by hand; the one place it panned by itself was the PRE-FIX shell.
Residual device-only gap: iOS's own keyboard trigger. Checks are tagged `[geo]` (settled) vs
`[trigger]` (not) so the two are never conflated.
**The suspected cost is NOT real:** neither form moves the pending-permission card into the scroll
container, the `shrink-0` band arrangement survives both at both widths, and desktop is untouched.
The real cost is 250px added to the composer's offset on a phone by the literal form.

### ★★★ A PROBE THAT WAS CAPABLE OF MEASURING ITSELF — found and closed 2026-08-25
`ask-card-height-probe.mjs` read `--vvh`, printed it, and **never asserted it** — while the very
next line **overrode `--vvh` by hand**, to stand in for a keyboard that headless Chrome does not
have.
> **So if `lib/visualViewport.ts` ever stopped publishing the property, every assertion in the file
> would still pass — on the probe's OWN override — while the real app sized itself off a fallback.
> The probe was measuring its own fixture and reporting it as the app.**

**Demonstrated, not argued.** `trackVisibleHeight()` was commented out in `main.tsx` and the probe
re-run: `--vvh` came back `(absent)`, the new assertion went red, exit code 2 — **while
`✅ Submit is reachable at 390×844` stayed GREEN.** That is the hole, executed: the file's headline
assertion passes against a broken app. `main.tsx` restored and verified.
This is the most complete form of the failure this project keeps meeting. A test that passes for
the wrong reason is bad; **a test whose fixture SUPPLIES the thing under test cannot fail for the
right reason at all.** Any harness that injects a value to simulate an environment must assert that
the real producer of that value is alive BEFORE overriding it.

### The corpus audit — 103 files, and the result is "much cleaner than expected"
Scanned mechanically for both shapes rather than by eye. **Zero already-wrong; three fixed.**
- **Shape B (tag/text/class lookups): 231 lookups across 35 files, almost all fine.** The
  "control that does not exist" shape is **absent** — all 9 files whose literals appear nowhere in
  `web/src` turned out to be harness FIXTURE DATA (prompts, fixture filenames, markdown bodies),
  not controls.
- **The real sub-shape was unguarded DOM dereferences** (`querySelector(...).x` with no `?.`),
  which throw inside `evaluate` so the harness dies with a stack trace and **no assertion name at
  all**: 10 in 5 files. All 10 controls verified to render as assumed today. **Most were already
  gated upstream**, which is what kept the list short.
- **Two genuinely ungated, high-blast-radius ones FIXED**, both chosen because a drift would name
  the wrong subject: `terminal-ui-e2e:173` (an ungated `Terminal` lookup whose failure surfaces as
  `xterm terminal attached` — **a selector bug reading as a PTY bug**, sending the reader
  server-side), and `notebook-ui-e2e:220` (an input that exists only if a prior click landed, so
  **step-one failure gets named after step two**).
- **NOT FIXED, deliberately:** four LOW-ranked derefs, each gated upstream or failing obviously.
  A long tail nobody asked for.

**Verification stated per file rather than in aggregate, which is the right honesty:**
`terminal-ui-e2e` **ran, 7/7** (dist-serving, so it says nothing about the app — but "did my edit
break the harness" is answerable against a stale bundle because the control exists in both);
`ask-card-height-probe` **ran green and its mutation red**; `notebook-ui-e2e` **could NOT be run —
`jupyter_server` is not installed here** — verified by parse and structure only, and flagged rather
than left to read as tested.

> **★ HABIT: a per-file heuristic attributes a hit to the FILE, not to the EXPRESSION.** Three of
> four Shape-B "hits" were files containing both a button scan and an unrelated span lookup, and
> the scanner blamed the span on the buttons — nearly hardening a check that was already correct
> (`find-ui-check`'s `'bad regex'` scans a `<span>` because `FindBar.tsx` renders it in one).
> **Verify at the EXPRESSION before reporting.** "Verify before claiming", one level down in the
> tooling that does the claiming.

### ★ A STATUS STRING THAT IS LOGGED BUT NOT ASSERTED IS NOT COVERAGE — 2026-08-25
Prompted by the over-determined-red finding, an author audited their OWN two new probes and **found
the shape in them**: five lookups located a control **by TAG or by VISIBLE TEXT**, and each returned
a status string that was only `console.log`ged, never asserted —
`<button>` texted `Terminal`, another texted `Files`, a leaf texted `demo.py`, the permission card
by the Tailwind fragment `border-ctp-blue`, and the composer by the `textarea` tag.
> **It reads like a check in the transcript and fails silently in the suite — and when it does
> fail, it renames someone else's assertion after itself.** If any selector drifts, `clicked`
> becomes `'no-button'`, nothing paints, and the first red is *"the terminal actually mounted and
> fitted"* — a name pointing at the terminal when the cause is the selector. In the cost probe it
> was worse: a null band would throw a `TypeError` on `.composer.bottom` **inside a verdict about
> `position: fixed`** — a stack trace about the wrong subject entirely.
All five are now named `PRECONDITION` assertions, so drift names itself. Both probes still green
(**xterm-vvh 14/14 + 1 ⚠️**, **shell-fixed-cost 8/8 + 1 ⚠️**).
**One was already known to render differently than assumed:** the `demo.py` lookup needs
`dblclick`, not `click` — `FileManager` opens on `onDoubleClick` and a single click only selects.
That cost a red reading *"the fix does not apply to the content-tab branch"* when the truth was
*"the harness never opened a file"* — caught only by dumping the DOM instead of believing the
check's name.
**Immune by construction, and worth copying where possible:** `visual-viewport-pan-probe.mjs` is a
standalone `data:` URL page that creates its own elements with known ids, so it has no app selector
to rot.

### A LINT RED IS A SNAPSHOT OF A MOMENT — 2026-08-25
Two probes were reported as unregistered and lint-failing. **They were registered; the observation
landed in the window between creating the files and registering them.**
> **A red observed mid-edit gets attributed to the FILE rather than to the TIMING** — the same
> shape as the attribution trap, one layer down. Fail-closed is correct and should not change; the
> cheap guard is to **re-run before reporting a lint red**, exactly as a claim about the tree is
> re-checked before being recorded.
`registration-lint` is currently clean: **102 executable files, 0 unregistered.** `port-and-reap-lint`
reports the allocation table **injective** — no collision between `4485/5285` and `4497`.
**Pick ports from the lint's printed table, not by grep** — grep is the weaker method and was what
produced the near-collision.

### ⚠ TWO PRE-EXISTING LAYOUT DEFECTS — found, NOT fixed, both are POLICY CALLS
1. **The stacked column clips the terminal AT REST, no keyboard involved.** `App.tsx` sizes it
   `stackH + termH + 1`; `stackH` (280, also from localStorage) is bounded by nothing →
   84 + 280 + 600 + 1 = **965 against an 844px shell = 121px clipped on a full viewport.** The new
   bound cut the keyboard-up clip **457px → 201px** (measured by restoring the unbounded values by
   hand, not computed) but cannot fix the rest. **Which of `stackH` / the dock / the content pane
   gives way is a design decision.**
2. **With a pending AskUserQuestion card and the keyboard up at 390×844, the composer's bottom is
   already 33px below the `overflow-hidden` shell.** `ask-card-height-probe` asserts the CARD's
   Submit is reachable — it is — but **nothing ever asserted anything about the composer
   underneath it.** Phone+keyboard only; desktop clean.

**Both are tagged `[open]`: they print with ⚠️ and their numbers but do NOT fail the run** — so the
suite stays green rather than gaining a second permanently-red harness people learn to skip.
**If an ⚠️ turns ✅, someone fixed it and the check should be deleted.** That is the healed-red
principle applied to a warning channel, and it is the right call.
> **★ BUT `[open]` IS A THIRD CATEGORY, AND THIS DOCUMENT ALREADY ESTABLISHED THAT THE UNNAMED
> THIRD CATEGORY IS THE ONE NOBODY RE-CHECKS.** The risk is not that people ignore warnings — it is
> that `[open]` is **a second record of open work not joined to the first**, which is precisely
> this repo's demonstrated failure mode: a claim recorded in one place, corrected in another, the
> stale copy left to instruct someone.
> **JOIN THEM: every `[open]` gets a `STATUS:` line here.** Then a healed `[open]` is caught by the
> single greppable sweep rather than only by whoever happens to read a run's output.
**STATUS: the stacked column clips the terminal AT REST — 121px at 390x844 with `--vvh` 844, and
201px with the keyboard up. Residual cause is `stackH` (280px, unbounded, from localStorage), not
the dock. UNFIXED — the design call is which of `stackH` / the dock / the content pane gives way.**
**STATUS: with a pending AskUserQuestion card and the keyboard up at 390x844, the composer's bottom
sits 33px below the `overflow-hidden` shell. Phone+keyboard only; desktop clean. UNFIXED.**

### The dock bound's comment was wrong in three ways — corrected 2026-08-25 after review
The code is sound; the prose around it was not, and one part of it was the dangerous kind.
1. **A SECOND, FALSE JUSTIFICATION.** It claimed that reading `--vvh` into React state would
   re-render every pan frame, because `--vvh` republishes on `scroll`. It does republish — but
   `publish()` writes `${visibleHeight()}px`, the HEIGHT, and **a pan changes `offsetTop`, not
   height**, so a scroll frame rewrites an IDENTICAL string and `setState` bails on `Object.is`.
   > **A weak reason stated beside a strong one invites someone to refute the weak one and revert
   > the whole change** — which is exactly how the FitAddon misattribution happened one layer down.
   The ResizeObserver reason is sound and sufficient; the false one is now recorded as refuted.
2. **`164` DOES NOT DECOMPOSE AS DOCUMENTED.** It was derived as "the mobile top bar (h-12) and the
   tab bar (h-9), plus 80". **There is no `h-9` tab bar** — `MainTabs`' root is `h-8`, and the only
   `h-9` in the file is the hamburger button and the logo. A real count gives 82 + 80 = 162.
   **The value is left at 164 deliberately** and relabelled as a MEASURED total: changing a tuned
   constant to match a freshly-constructed derivation is a behaviour change smuggled in as a
   comment fix, and the fails-first evidence (6 red → 0) was measured against 164.
3. **The `48` term is MOBILE-ONLY** (`md:hidden`), inside a width-agnostic expression, so desktop
   over-reserves by 48px. Inert today; noted in place.

**★ AND THE FLOOR IS AN ESCAPE HATCH, NOT A SAFETY NET.** Below `--vvh` = **284px** the `max()`
yields the floor and **the bound stops tracking the viewport**: 120 + 164 = 284 > `--vvh`, so the
column exceeds the shell and the prompt is clipped again — the exact failure the bound exists to
prevent. Reachable: a phone in landscape with the keyboard up (320px layout viewport), and any
short desktop window. The trade is defensible (~91px of body, about 5 rows, beats a sliver) but
**the threshold is now written down, because otherwise the failure returns silently at 284px.**

**No masking, but the inertness is CONDITIONAL.** At rest `--vvh`=844 gives
`min(600, max(120, 680)) = 600` — byte-identical to the raw `termH`, so the 965-vs-844 at-rest
measurement is untouched and the `[open]` evidence survives. **That is a consequence of 600 < 680,
not of anything deliberate**: a restored `termH` exceeding `--vvh − 164` at rest would start moving
the at-rest number and would genuinely mask the stacked-column defect.

### `doubling-agents-test` REWRITTEN — 4/7 → 16/16, 226s → 7s, and OUT of bucket 1
Own server (4485), own vite (5285), own Chrome (CDP 9361), driven by a stub `claude` on PATH that
writes frames to **stdout** — so the server reads them and broadcasts through the real pipeline and
only the MODEL is replaced. Registration moved `srv4321:` → `chrome:`. **Bucket 1 is now 11
harnesses, not 12.** Ten mutations, every one of the 16 checks proven able to fire, each red
carrying its predicted diagnostic string.

**★ THE OLD RED WAS OVER-DETERMINED, AND ITS NAME POINTED AT NONE OF THE CAUSES.** The declining
model was real — the `result` frames proved the turn itself was fine — but **two of the three tray
assertions could not have passed even if it HAD delegated**, because they were written against a UI
that no longer exists:
- *"Agents tray appeared"* looked for a button whose text contains "Agents". **No such control
  exists anywhere in `web/src`** — the subagent surface is a ◈N badge on the sidebar row that
  expands into `AgentLines`.
- *"agent card shows a status label"* looked for a `<span>` whose TEXT is done/running/failed.
  `AgentStatusDot` puts that word in a **`title` on an empty 1.5px dot** — never text.
> **A red can be true for reasons unrelated to its name, and fixing the named cause would have left
> it red.** Same family as the sidebar-row-is-not-a-`<button>` trap: an assertion that locates its
> subject by tag or by visible text must be checked against what actually renders, or its failure
> is uninformative in both directions.

**Coverage kept and strengthened**, not traded away: turn-1's doubling intent is now four checks
reaching four different failures (block pairing, the open-map registration the file is named for,
the `message_start` reset, registration after a reset) plus the original repeated-long-line net.
The agent half now also covers the `Task`-vs-`Agent` discrimination — the stub emits a `Bash` call
alongside two launchers, so the badge reads ◈2 only if the collector discriminates on tool name.
**`mkdtemp` cwd kept** (the literal `/tmp` made previous runs count each other's transcripts).

**STATED LIMITATION, in the file header:** nothing here exercises the real CLI's delegation path —
not argv, not `--include-partial-messages`, not the CLI's own frame shapes, and not "does a model
asked to delegate actually delegate". The frame shapes come from what `store/chat.tsx` and
`shared/tasks.ts` are written to ACCEPT — the contract, not a capture. **If the contract drifts,
this stays green and the app is broken.**

**One prediction corrected by measurement:** MU2 was predicted to red three checks; it reds **[1c]
alone**, because each check is read immediately after its own batch lands and before the next is
requested. That temporal isolation is why MU1 and MU2 give disjoint signatures.

**Arithmetic, NOT a measurement:** this file moving from a bucket-1 red to a Group B green *should*
put a fresh baseline at 65/6/6. **Do not quote that as measured** — the last defensible figure is
still **64/7/6**, and a full run remains pointless until `web/dist` is rebuildable.

### ⚠ `run-suite.sh` IS UNTRACKED — the harness that enforces registration has no history itself
`git` shows it `??`. So the file carrying the four diagnosis traps, the taxonomy, the `:4321`
hard-fail, the tree fingerprint, the bucket-1 staleness line and the expected-red split **cannot be
diffed, blamed, or recovered**, and a `git clean` takes all of it. Same exposure as
`scratchpad/scroll-memory-check.mjs`, and worse in consequence. Nothing in this repo is committed,
so this is one instance of a general state — but these two are the ones where loss is not merely
inconvenient. **Add both whenever a commit is authorised.**

### ★★ `setAgent` KILLS A LIVE TURN — MEASURED 2026-08-25. `setSandbox` does not.
Two config changes of the same kind, **opposite policies, and only one documents its choice.**
`setSandbox` routes through `scheduleApply`, which waits for idle with a comment saying why
("killing a live turn would be worse than waiting"). **`setAgent` calls `relaunchApply` directly,
and `relaunchApply` sets `replacing = true` and calls `engine.kill()` IMMEDIATELY with no state
check.** `setAgent`'s own comment says "resume-preserving relaunch — the new engine picks up the
new role while keeping the conversation", which is true of the CONVERSATION and **silent about the
in-flight TURN**.

**MEASURED, with a control:**
```
CONTROL (no setAgent)      : running@11ms → idle@5019ms | result frames: 1
SUBJECT (setAgent mid-turn): running@7ms → idle@1208ms → idle@1210ms | result frames: 0
```
Switching a busy session's role **discards its in-flight work silently** — no error, the state just
goes idle ~4s early and the completion frame never arrives.
**This may well be deliberate** (a role change is more urgent than a mount edit, and the operator
asked for it explicitly). **But if it is, `setAgent` must say so in the same breath `setSandbox`
does** — otherwise the next reader "harmonises" the two and silently makes role changes wait.

> **★ THE PROBE THAT PRODUCED THIS WAS INVALID ON ITS FIRST TWO RUNS, AND IT REPORTED A CONFIDENT
> WRONG ANSWER.** `FAKE_TURN_MS=5000` never reached the stub: the sandbox uses `--clearenv` with an
> allowlist, so the stub fell back to its 250ms default and the turn had already FINISHED before
> the "mid-turn" interrupt landed at 700ms. The probe printed **"THE TURN SURVIVED"** — correct
> about its own data and false about the world. Fixed by disabling the sandbox for the fixture so
> the env var survives, **and by adding a precondition check that asserts the session is actually
> `running` at the moment of interruption**, which turns the failure mode from a wrong answer into
> `PROBE INVALID`. Same family as every other finding today: **a measurement that cannot detect
> its own irrelevance is not evidence.** Any harness that interrupts a turn must first assert the
> turn is in flight.

### ★★★ NO PER-SESSION KEY CAN DETECT "THE PROCESS IS OLDER THAN THE CODE ON DISK" — 2026-08-25
The unifying statement, and the most useful architectural finding of the day:
> **Every `*Key` function compares IN-MEMORY state to IN-MEMORY state. So no per-session key can
> ever detect that the running process is older than the source on disk. `agentPending` and the
> sandbox drift are THE SAME BUG, and it is not a missing key — it is a missing DIMENSION.**

**Why `agentPending` cannot detect the incident it was built for. STATUS: established by
REASONING, not executed — the executing half needs a `server/` write, which is operator-gated.**
`agents.ts` is an ES module and `AGENTS` is a module-level constant captured at first import; Node
caches the instance for the process lifetime, and nothing re-reads the file. So:
- **server not restarted after an on-disk edit** → in-memory `AGENTS` is the OLD definition →
  `agentKey()` returns the OLD digest → it equals `appliedAgentKey` → **`agentPending` is FALSE.
  Stale compared against stale.**
- **server restarted** → `restore()` re-`launch()`es every session against the NEW definition →
  nothing is stale and the flag is moot.
There is no third regime, so the reported incident (a live `reviewer` still holding the unscoped
shell) is necessarily the first — **and `agentPending` would not have caught it.**
**What it DOES detect is runtime mutation of `AGENTS`** — real, correctly built, and exactly what
an operator-configurable-roles feature would need. Measured: `agent-pending-test` is 14/14 green,
and its two starred checks confirm in-memory mutation flips the flag and relaunch clears it.
**The falsifier that remains:** edit `agents.ts` on disk while the server runs, do not restart,
read `agentPending`. Prediction: FALSE.

**Same shape, already live once:** `sandboxKey` digests only session data (`enabled`, local
`.claude` existence, `gpu`, `cfg.mounts`), while the emitted box also depends on code-derived
inputs in no key — `appSourceDirs()`, `stateDirsToHide()`, `obligatoryMounts()`, the DNS/runtime
baseline, the env allowlist. **When the state-dir hiding landed, every already-running session kept
an unhidden state dir, `sandboxKey` was unchanged, `sandboxPending` stayed false, and nothing
reported it.** Adding those inputs to `sandboxKey` does NOT fix it — they are stale in memory too.
**RECOMMENDED SHAPE: one PROCESS-level check, not three per-session keys.** Stat the launch-recipe
sources (`agents.ts`, `sandbox.ts`, `connectorLaunch.ts`) at boot, expose "server is older than its
sources" on `/api/health`, and say it once rather than per session. Server-side; gated.

**★ DECISION 2026-08-25: DO NOT SHIP THE UI ADVISORY — SHIP THE TWO ONE-LINERS.**
After the fix below, **`agentPending` is UNREACHABLE in production**: trigger 1 (in-memory `AGENTS`
mutation) is done only by a test; trigger 2 (the `setAgent` window) is suppressed by the fix;
trigger 3 (on-disk edit) established as unable to fire. **A yellow banner nobody can ever see is
worse than no banner — it is dead code that reads as a working feature**, and the next person
auditing "do we detect stale role scope?" would find a rendered advisory and conclude yes.
**But the distinction that matters: the danger is an unreachable ADVISORY, not an unreachable
FIELD.** `agentPending` is on `SessionInfo` and goes over the wire to every client; today it
reports a transient `true` on an ordinary role switch, which is **simply wrong regardless of who
renders it**. Fix the semantics so no future consumer — an MCP tool, another client, the next UI
attempt — inherits a field that lies, and **document it as currently unreachable beside its
declaration** so its existence is not read as coverage.
**THE FIX IS TWO ONE-LINERS, AND NEITHER WORKS ALONE:**
1. In `setAgent`, move `this.emit('changed')` to AFTER `this.relaunchApply(id)` — because at the
   moment `setAgent` emits, `replacing` is still FALSE (`relaunchApply` sets it after the emit
   returns), so a suppress-on-`replacing` test would have nothing to test.
2. In `toInfo`, add `&& !s.replacing` — because `relaunchApply` only KILLS; the relaunch happens
   later in the exit handler, so emitting after it still emits before `launch()` recomputes
   `appliedAgentKey`, and `s.engine` is still non-null (nulled only on the exit event).
(2) also protects **every other emit that could land inside a replace window** — the class, not the
instance. **REJECTED:** deleting `setAgent`'s emit entirely. Verified why — the `failedFast` branch
emits `'exit'`, NOT `'changed'`, so on a fast-fail start the agentId change might never persist.
A regression for a tidier diff.
**SEQUENCE:** two one-liners now → the process-level disk-vs-memory check next (the thing that
actually detects the incident) → a per-session chip only if operator-configurable roles ever make
trigger 1 real. All server-side; gated.

~~**THE UI IS THE ENTIRE REMAINING `agentPending` DELIVERABLE**~~ — zero hits in `web/src`, while both
siblings are surfaced (`SandboxEditor` reads `sandboxPending`, `ConnectorGrants` renders a yellow
advisory for `connectorsPending`).
> **DO NOT COPY `SandboxEditor`'s WORDING — IT WOULD LIE.** Its "the server auto-applies this the
> moment the session is idle" is true for sandbox, because `launchStale` has a sandbox term and
> `scheduleApply` relaunches on idle. **`agentPending` has no such term BY DESIGN, so it never
> auto-applies and can persist indefinitely.** Copying that sentence tells the operator to wait for
> something that will never happen.
It is **advisory** and the copy must say so — the session keeps its launched scope and the flag
enforces nothing. This is the same over-reading that happened to `readOnly`, so the wording should
foreclose it explicitly ("this notice does not change what it can do"). Placement: inline beside
the role, matching `ConnectorGrants`' advisory shape rather than `SandboxEditor`'s chip.

**INV-A1** — `agentKey` digests exactly the fields `launch()` reads. *Falsifier:* `launch()` starts
consuming a sixth field and nobody adds it, so the flag goes **silently blind** — worse than not
having it. *Escape:* none; a deliberate exclusion must say why beside it, as `name`/`description`
already do. *Check:* extend `agent-pending-test` to assert **one flip per field**, so a
newly-consumed field fails a test rather than passing quietly.

### ★★ THE FIX FOR THE FIX: A LIST OMISSION MUST CLEAR NOTHING — 2026-08-25
**Suite 94/94, `super-editor-test` still 19/19.** The `list` case now clears no side-table state at
all; `forgetPresenceState` is deleted.

**The seam was in the wrong place, and independent review dismantled it using my own argument.**
The first fix cleared `attention`, `prevState` and `fresh` on a list omission. The second spared
`fresh`, on the grounds that **an omission is not a departure** — a session can be absent from one
broadcast and present in the next.
> **That argument does not single out `fresh`.** It is an argument about what an omission MEANS,
> and it applies identically to `attention` and `prevState`. Sparing one of three while clearing
> the other two holds two contradictory premises simultaneously — and the version that did so
> looked like the careful fix.

**The claim that justified clearing them was FALSE, exhaustively.** I wrote that `attention` and
`prevState` "are re-established by the events that would re-add the row". They are not:
`prevState` is written in **exactly one place** (`case 'state'`), `attention` only by
`flagAttention` (from `state` and `exit`) — and **the event that re-adds a dropped row IS a
`session:list`, which writes neither.** Nor does the server re-supply them: `stateChange` is a
**transition** event, so a session merely SITTING in `waiting` emits nothing.

**Two reachable regressions it caused**, and the evidence that transient omissions really occur is
the `super-editor` bisection that produced the previous fix — so the same proof underwrites both:
- **A `blocked` light goes out while the prompt is still pending, and never returns.** No
  `stateChange` fires for a session that has not moved. **This is the exact "alarm that lies" the
  `blocked` reason was introduced to prevent** — reached by a new trigger.
- **A finished turn is never flagged**: `prevState` is gone, so `finishedUnwatched` (which requires
  prev `running`|`waiting`) is false.

**ACCEPTED IN EXCHANGE, deliberately:** the three maps are not pruned when a session leaves
permanently via a list omission. `destroyed` and `exit` still clear them. That is a slow leak
bounded by sessions-per-page-load, and it is **the lesser evil — an unbounded map costs memory,
clearing early costs the operator a missed permission prompt.** Bound growth at a point that is
EVIDENCE of departure, never at a list omission. Note this reverses an earlier review
recommendation (that `list` should call `forget`); the reviewer corrected its own prior advice.

**★ AND THE TESTS PINNED THE DEFECT AS A REQUIREMENT — twice.** `F5.1a`/`F5.1b` asserted the
clearing as correct. They were written to the same spec `F5.1c` was inverted for, **and were not
re-examined when it flipped.**
> **A spec found wrong for one sibling is wrong for the siblings written from it.** Same shape as a
> retraction that misses a copy, one level down. Worse here than for `F6`, which is labelled
> *characterization*: these read as REQUIREMENTS, so a future reader would have defended them.
Both inverted, plus a new **`F5.1e`** asserting `destroyed` clears `attention` and `prevState` too
— without it, "clear nothing, ever" satisfies F5.1a-c and the maps would grow at every exit.

### ★★★ THE DUAL FAILURE: A CONTEXT BOUNDARY ERASES AUTHORSHIP — 2026-08-25
The uncommitted `AgentDetail.tsx` scroll-memory wiring, which the coordinator listed as MISSING
and "confirmed as still true", **was written by the coordinator itself** — in its predecessor
session, 53 minutes before that session ended.

**Established from the transcript store, not from timestamps** — and the method is the point.
Session `d4773aec-12d6-4dae-914f-821cf7d6f320` edited `AgentDetail.tsx` at 19:06:20 local, matching
the file's mtime **to the millisecond**. That session made 136 `send_to_session` calls and zero
`report_to_parent` — a coordinator — and `memory/sandbox-pid-namespace-blind.md` carries
`originSessionId: d4773aec…`, which independently identifies it as this line of coordinator
sessions. Its own tool output at the time reads `import OK | map OK | ref OK | onScroll OK` plus a
clean `tsc --noEmit`, so the change was **finished and self-verified**; the session then moved to
other work and never mentioned it again. That is exactly how the attribution was lost.

> **A handover freezes a claim so corrections cannot reach it. A CONTEXT BOUNDARY does the
> reverse: it erases the memory of having acted, so you become the confident source of a false
> claim about your own work.** Nobody on the team could have corrected it — they had no reason to
> think the coordinator had done it, and the coordinator had no memory of doing it. It survived
> only because a teammate grepped the transcripts instead of asking around.

**PRACTICAL RULE, adopted:** attribution of uncommitted work comes from **`grep` over the
transcript store**, never from mtime. An mtime gives exactly ONE timestamp — the last write — so
it can weakly INCLUDE a file and can never EXCLUDE one. It was useful here only as a place to
point the grep, and it matched only because the last write happened to be the authoring write.
**Before recording "X is missing / unwired / not done", grep the transcripts for X.** The cheapest
version of this is to distrust any of your own claims about work you cannot remember doing —
across a context boundary that is *all* prior work.

### ★★ A HANDOVER IS A SNAPSHOT, AND A LATER CORRECTION NEVER REACHES IT — 2026-08-25
The single most reliable way a false claim survives here. Four instances today, and the **fourth
was authored by the coordinator**:
1. "the sandboxPaths header does not exist on disk" — it did, complete.
2. "`FileManager.tsx` comments `createPath` opens + activates it" — no such comment; travelled
   HANDOVER.md → teammate → that teammate's written handover, gaining credibility at each hop.
3. "scroll memory is unwired in `AgentDetail`" — already wired; **asserted by the coordinator,
   unchecked, in the very message correcting a teammate for carrying a stale claim.**
4. "`super-editor-test`: reducer RULED OUT by causal test" — **wrong, and the reducer was the
   cause.** Written into this file and into a teammate's handover, then retracted. The handover
   had already been written, so the retraction did not reach it; the fresh context resumed
   holding the pre-correction state and would have acted on it.

> **The mechanism is not carelessness — it is that a handover freezes a claim at the moment of
> writing, and corrections propagate forward only to LIVE contexts.** "Check the tree, not the
> note" is necessary but not sufficient, because a note that was TRUE when written attracts no
> suspicion at all. Nothing in the process re-examines it.

**PROCESS CHANGE, adopted:** issuing a correction now includes asking *"does this claim sit inside
a handover or a document someone will resume from?"* and pushing the retraction there explicitly.
The correction is not complete when the fix lands; it is complete when every frozen copy has been
reached. **The coordinator is the only actor positioned to do this**, because it is the only one
that sees both the correction and the set of handovers — which also makes it the single point of
failure for it.

### ★ RESOLVED 2026-08-25: `super-editor-test` — IT *WAS* THE REDUCER, AND A PARTIAL REVERT SAID OTHERWISE
**FIXED. `super-editor-test` 19/19, `session-reducer-test` 93/93.**

**THE CORRECTION MATTERS MORE THAN THE FIX.** This was recorded here — by me, confidently — as
"reducer RULED OUT by causal test, not by argument", and that propagated into two teammates'
working state. It was WRONG, and the reason is the instructive part:
> **I reverted ONE of four changes and reported the whole change set exonerated.** The revert
> covered only the `list` liveness guard. The `forget` loop, the `created` gate, the orphan merge
> and `reconnected` all stayed live. The test failed identically — which proved only that the
> liveness guard was not the cause, and I reported it as proving the reducer was not the cause.
> **A causal test is only as strong as the completeness of what it removes. Revert the whole
> suspect, then bisect — never revert a part and generalise to the whole.**
Reverting ALL four → **19/19 immediately.** Bisecting → the **`forget` loop alone**.

**THE UNDERLYING BUG WAS REAL AND USER-VISIBLE — not a test artifact.** `list` was calling the
full `forget`, which drops `fresh`. But `destroyed`/`exit` and a `list` omission mean different
things: those two mean the id is **GONE**, so clearing everything is right; a `list` omission does
not — a session can be absent from one broadcast and present in the next. **`fresh` means
"created in this app load", which stays true across such a gap, and `ChatView`'s auto-resume
effect is gated on it.** So dropping it made a briefly-absent session eligible for auto-resume and
it pulled in a conversation it should never have loaded.
**Fix:** a narrowed `forgetPresenceState` used on the `list` path — clears `attention` and
`prevState` (meaningful only WHILE present, and re-established by whatever re-adds the row), never
touches `fresh`. `destroyed`/`exit` keep the full `forget`.

**★ AND THE REDUCER SUITE COULD NOT SEE ANY OF IT.** It sat at a confident **92/92** for hours
while `super-editor` was red, because the damage happens in a **CONSUMER of `fresh`**, not in the
reducer. `F5.1c` even asserted the buggy behaviour — Devil wrote it correctly to a spec I got
wrong, so the test was *pinning the bug*.
> **A test written to a spec can only ever be as right as the spec.** Green unit tests are not
> evidence about behaviour that lives one layer out; when an integration test and a unit suite
> disagree, the unit suite is the one with the narrower view.
`F5.1c` is now inverted (fresh SURVIVES a list omission) with that history written into it, plus a
new **`F5.1d`** asserting an actual `destroyed` still DOES clear it — without which "never clear
`fresh` anywhere" would satisfy the inverted assertion.

**Ruled out along the way, so nobody re-derives them:** not `localStorage`/`autoOpenEdits` (the
harness makes a fresh Chrome profile per run, so the seed is `true`); not the permission→tab path
(at failure the tab EXISTS and a session is ACTIVE — the failure is downstream, the editor does
not mount for a tab that exists); not `proposals.ts` (unchanged since 07-22); not the `:4321`
squatter (this harness binds `:4321` itself, and an occupied port would HANG in `proxy.listen`
rather than produce this).
**The mtime narrowing was also wrong, and here is the trap:** `mtime` records only the LAST write.
`sessionReducer.ts` was edited at 21:05 — inside the window — and again the next morning, so a
scan by current mtime shows only the later timestamp and silently excludes the file. **Never use
mtime to establish that a file did NOT change during a window.**

### ★ STEP (i) DESIGN — THE ORDERING FAULT. Two defects, one fix. DESIGNED, NOT YET BUILT.
`viewOf` sorts by depth of the LOGICAL path while `boxCanReach` matches on the REAL one and takes
the LAST match. That single mismatch produces **two distinct wrong answers**, in opposite
directions, and both die to the same fix — resolve in BOX space instead of host space.
- **Defect B — SHADOWING, fails OPEN.** A mount whose exposure is overmounted by a deeper dest
  still counts. Recorded in `mount-shadowing-guard` §4.
- **Defect A — "LAST MATCH WINS" IS THE WRONG AGGREGATION, fails CLOSED.** Two UNRELATED mounts
  can expose the same real bytes without shadowing each other — both live in the box at once — so
  the right rule is "ANY mount that reaches it grants". **PROVEN BY EXECUTION 2026-08-25** against
  real `bwrap 0.9.0`: the box wrote the file (host contents `ORIGINAL` → `MUTATED`) while
  `sandboxPathAccess` returned `write:false`. Pinned by `scratchpad/authorizer-box-divergence-guard.mts`.
  It DENIES a legitimate write — an inexplicable permission error, **not a breach**. Do not let a
  red there be reported as a sandbox escape.

**THE FIX.** Extract `resolveReach(entriesInEmissionOrder, target): readonly ResolvedMount[]`.
`boxCanReach` keeps only `real(p)` (returning false on null — fail closed) and the mode decision,
which becomes `need === 'write' ? reaching.some(m => m.mode === 'rw') : reaching.length > 0`.
> **`resolveReach` takes `entries`, NOT a `MountView`, and that is load-bearing.** Taking a view
> would inherit the closed constructor and shut the test seam. **THE ENFORCEMENT BOUNDARY
> (`viewOf`) AND THE TESTABILITY BOUNDARY (`resolveReach`) MUST STAY DIFFERENT FUNCTIONS.**

**★ THE OWNERSHIP RULE — corrected, and the first version was wrong.** It was specified as "the
DEEPEST logical root containing boxPath, ties broken by emission order". **bwrap's actual rule is
not about depth at all:** a bind applies at its dest and everything beneath it, and a later bind
covers an earlier one *including an earlier deeper one*. Mounting `/a` after `/a/b` covers `/a/b`.
> **The owner of a box path is simply the LAST entry in emission order whose logical root contains
> it. Depth does not enter.**
The failing case the depth rule got backwards: `[{logical:'/a/b'}, {logical:'/a'}]` with the
shallow one emitted last — bwrap says `/a` covers `/a/b`; the depth rule picks `/a/b`. **Every
other test in the set still passes under the wrong rule**, which is why §4d exists.

**And this restates why `viewOf`'s sort must not be deleted, more strongly than "it breaks ties":**
> **The sort is what makes `entries` equal bwrap's ARGV ORDER.** Without it, "last containing
> entry" is last in some arbitrary order rather than last in the order bwrap will apply. That is
> the comment to put beside the sort — it explains why the sort stays even though `resolveReach`
> never mentions depth.

**INV-R1 — a precondition stated honestly rather than closed.** `resolveReach` REQUIRES entries in
bwrap emission order. This one **cannot** be closed by construction, because the order is genuine
semantic input: sorting internally would destroy information and make the function unable to model
the very case it must model. *Falsifier:* a caller assembling entries another way, or someone
"helpfully" sorting inside. *Escape:* none — instead name the parameter `entriesInEmissionOrder`
so the obligation sits at every call site, and keep `viewOf` the only production producer.
*Check:* §4d, which fails if ownership becomes depth-based or the array is pre-sorted.

**Same-dest-different-source is NOT reachable through `viewOf`**, and the reason is structural:
`logical` and `real` are both derived from the SAME input string, so two entries with one logical
path necessarily share a real root. It arises only in hand-built fixtures (deliberately — that is
the test seam) and in an exotic self-healing TOCTOU. Named, not guarded.

**(i) IS ENTIRELY A `server/`-WRITER TASK — do not split it across two actors**, because
regenerating `scratchpad/sandboxPaths-body-snapshot.ts` requires reading the landed file. Commit
order: edit `sandboxPaths.ts` → regenerate the snapshot → verify the diff prints nothing → update
the preamble's counts. **Of the three numbers only the TOTAL moves**; the body offset (224) and
header count (223) change only when the HEADER changes. Encode that asymmetry so a future
recompute knows which numbers it actually has to redo.

### ★ A POST-MORTEM COMMENT COPIED INTO A NEW FILE BECOMES A LIVE FINDING — 2026-08-25
A deleted probe carried a paragraph claiming that two Chrome harnesses booted against the
operator's REAL `~/.config/claudette`, with `restore()` relaunching every persisted session before
`app.listen()`. Alarming, and it reached me as a possible live compromise of the operator's
session store. **It is FALSE today, established by enumeration, not argument: 12 of 12 harnesses
that boot a server set `CLAUDETTE_DATA_DIR`, with no exceptions**, and the nine that do not boot
one use the shared `:4321` server, which `run-suite.sh` starts with a `mktemp -d` data dir.
The claim's origin is the lesson. `terminal-ui-e2e.mjs`'s header carries a **past-tense
post-mortem** — "These *were* the only two … so they *booted* against the operator's REAL …" —
narrating a bug fixed ten lines below it. A new file copied the paragraph verbatim, and detached
from the fix it was narrating, it read as a present-tense discovery.
> **A post-mortem is bound to the fix it sits beside. Copy the prose without the fix and it
> becomes a bug report.** When lifting a comment into a new file, re-read it as someone who
> cannot see the original context — which is exactly who will read it next.

**ONE LIVE EXCEPTION SURVIVES, and it upgraded the port problem from tidiness to safety.** Those
nine harnesses are isolated only if the harness actually STARTS the shared server. Under the
`already listens on :4321 — using it` fallback they run against a stranger's server whose data dir
is whatever that stranger chose — possibly the operator's real one. **That fallback is the last
remaining route by which the suite can touch a live session store**, which is the argument that
settled the decision below.

### STATUS: the `:4321` fallback is being changed to HARD-FAIL — approved 2026-08-25
It will SKIP the `srv4321` entries as a prerequisite failure rather than running them (consistent
with how a missing Chrome is handled), print who to stop and why, and keep `ALLOW_FOREIGN_4321=1`
as an override. The skip must also appear in the FINAL SUMMARY — "55 passed, 0 failed, 15 skipped"
read without scrollback looks like a healthy run.

### ★ A FALSE GREEN FOUND NEXT TO A RED — 2026-08-25
`notifications-test`'s `bell shows enabled (aria-pressed)` asked whether **any** button in the
document had `aria-pressed="true"`. `SoundToggle` is on by default and carries it, so that check
**passed while the click beneath it was failing** — reporting the sound toggle's state under the
bell's name. Found only because the red beside it was being repaired.
> **A green sitting next to a red deserves the same scrutiny as the red.** Nobody audits the
> passing lines of a failing file, which is precisely where a check that asserts nothing survives.
Repaired to 8/8, and — the right standard — verified **under the condition that broke it** (run
behind three other session-creating harnesses), not merely standalone.

### ~~STATUS: `super-editor-test.mjs` — GENUINE NEW RED, cause NOT the reducer work~~
**RETRACTED 2026-08-25 — THIS ENTIRE BLOCK WAS FALSE AND ITS CLOSING IMPERATIVE WAS THE WORST OF
IT.** It read *"The reducer reconcile is RULED OUT by causal test, not by argument… **Do not
re-suspect the reconcile.**"* The reconcile **was** the cause. See
**`★ RESOLVED 2026-08-25: super-editor-test — IT *WAS* THE REDUCER`** above for the fix
(`forgetPresenceState`) and the measurements (19/19, 93/93).
> **This block is kept, struck, rather than deleted — and it is the sharpest lesson in the file.**
> It did not merely go stale: it issued a **bold instruction steering the next session away from
> the true cause**, under a `STATUS:` heading, which the house convention advertises as the
> greppable re-checkable set. An earlier edit replaced a *different* copy of this text and left
> this one live, so the document simultaneously listed the claim as a known false-propagation
> **and** issued it as an instruction. **A retraction that misses one copy is not a retraction.**
> The convention was applied correctly to the Terminal-button and FileManager items — struck, with
> a `STATUS:` correction beneath. This one had neither until an independent audit found it.

### ★ A SUITE TOTAL IS NOT A MEASUREMENT WHILE THE PORT IS SHARED — 2026-08-24
Two suite runs against the same tree gave 63/8/6 and 60/11/6, neither comparable to the 64/7/6
baseline, and **the cause was not the code under test.** `run-suite.sh` logs
`note: something already listens on :4321 — using it, not starting another` and proceeds, so
`attention-test`, `doubling-agents-test` and `history-resume-test` ran against a **foreign
server**. It moves results in BOTH directions: `real-turn-browser-test` PASSED in one run despite
being a baseline failure.
> **A fallback that turns a port collision into a silent reuse converts a loud failure into
> confident wrong numbers.** That is strictly worse than crashing, because the run still prints a
> total and the total still looks like evidence.
Whether that fallback should hard-fail instead is an open question worth deciding, not a
nice-to-have. Compounding it: two teammates were writing to `scratchpad/` during each other's
runs, and one only discovered the other because `registration-lint.mts` flagged a file that
appeared mid-run. **Re-measure with one runner and everyone else idle, or do not quote the
number.** Related and already known: `ss -ltn` shows a port is held but not by whom, so a
squatter is visible and unattributable at the same time.

## Subsystems the older entries below do not cover

**Session confinement (`server/src/claude/sessionConfinement.ts`).** The single seam every server-side actor uses to confine work done *on behalf of* a session — its kernel, its terminal pty, the files its MCP tools touch. Replaced three copy-pasted resolvers whose shared `undefined`-means-host default was the fail-OPEN root cause behind the notebook-MCP, venv-probe and unowned-kernel escapes. The type distinguishes `confined` / `host` / `deny`, and an unresolved session resolves to `deny` — never host. `DENY_ALL_SANDBOX` is the fail-closed executor: it runs, but every user path is invisible. Wired at `index.ts:72`.

**Sandboxing (`server/src/claude/sandbox.ts`, SANDBOX.md).** bubblewrap per session; a filesystem firewall, with network egress deliberately unconfined. The protections in place: `--clearenv` plus an allowlist so no box inherits `CLAUDETTE_TOKEN` (`sandbox.ts:299-303`); app source (`server/`, `shared/`) pinned read-only inside any box that would otherwise expose it rw (`CLAUDETTE_ALLOW_APP_SOURCE_MOUNT=1` opts out — **you need this to develop Claudette from inside Claudette**); confinement that cannot be lowered by a possibly-in-box caller (`CLAUDETTE_ALLOW_UNSANDBOXED=1` opts out); kernels and terminal panes confined to the same box as their session; per-session opt-in GPU passthrough (`sandbox.gpu` → `--dev-bind` of the `/dev/nvidia*` nodes after `--dev /dev`), with `gpuDevicePaths()` served from `/api/health` only to an authenticated caller (`index.ts:229`).

> **Read this section with calibrated confidence.** On 2026-08-21 an adversarial review found **four live escapes in the mechanisms described above**; a second pass on 2026-08-23 found **two more** (items 5-6 below). **All six are now fixed in the tree.** They are recorded here — with the way to re-check each — because a handover that presents these protections as having always worked teaches the next reader exactly the wrong level of trust in them. The pattern to expect is that each is one careful review away from the next hole, not that the model is settled. **Trust the probes below, not this paragraph:** if you are making a security decision, run them.
>
> 1. **Auth gate bypassed by percent-encoding (`auth.ts:137-179`) — the worst of the four, because it defeated the premise the other three rest on.** The hook prefix-matched `req.url`, the **raw** request target; Fastify's router percent-**decodes** before matching. A single encoded character walked between them: `/%61pi/session/list` failed the `/api/` test, took the early `return` — a *whitelist* branch, so an unmatched prefix meant **open**, not denied — and still reached the real route. Every control-plane handler is trusted on the words "this route is auth-gated" (`sessionApi.ts:72,:81,:91`), and there is deliberately no `--unshare-net` (`sandbox.ts:305`), so a confined session already reaches `127.0.0.1:PORT`; SANDBOX.md's "Control-plane escape" answer was "but it holds no token", and it no longer needed one. `POST /%61pi/session/setSandbox {"enabled":false}` was an unauthenticated un-sandboxing. **Fixed:** the hook now decodes before matching, refuses a malformed escape with 400 rather than throwing (an uncaught throw in a preHandler 500s every request, static included), compares the open set against the decoded spelling, **and** additionally tests `req.routeOptions?.url` — the route the router actually matched. **Confirm it yourself:** `npx tsx scratchpad/auth-route-coverage-test.mts` sweeps Fastify's own route table and asserts 401 for everything outside the open set; 7/7 over 120 routes, zero bypasses. `scratchpad/auth-path-bypass-test.mts` covers the specific encodings.
> 2. **Shell injection (`sandbox.ts:740-768`).** `which()` interpolated `bin` unquoted into `execFileSync('sh', ['-c', …])`. `wrapCommand` calls `which(program)` and `jupyterManager.ts:97,189` pass a venv-discovered python path — one a confined session influences inside its own legitimate rw mount, e.g. `<cwd>/p$(payload)/.venv/bin/python3`. The `sh -c` runs **unsandboxed in the server process** with the server's full env including `CLAUDETTE_TOKEN`, so this was host RCE from inside a box via the notebook kernel path. The other five `which()` call sites pass literals and were never reachable. **Fixed:** `bin` rides as a quoted positional (`command -v -- "$1"`), so nothing in it is parsed as script. The shell is kept on purpose — `probe()` depends on `command -v` reporting a builtin as a bare word, and a Node-side PATH walk would silently change what the capability probe tests. **Confirm:** `scratchpad/sandbox-three-escapes-probe.mts`.
> 3. **Symlink guard failed open (`sandbox.ts:501-509`).** `isUnsafeSymlinkMount` compared a `realpath`'d parent against `rwRoots`, which are deliberately *logical* dest paths — the mismatch its own comment warns about. The two agree only while no ancestor of any mount is a symlink; the moment one is (`~/work` → `/mnt/data/work`, an ordinary two-volume layout), the guard silently permitted the mount and the symlinked-mount escape was back. **Fixed:** the parent is tested both ways and refused if *either* spelling lands in a box-writable root. The same guard is now also applied to the out-of-band authorizer (`:541-548`), which would otherwise have authorized a write the box itself refuses. **Confirm:** `scratchpad/sandbox-symlink-authorizer-probe.mts`, `sandbox-regression-fixes-test.mts`.
> 4. **App-source pinning failed open (`sandbox.ts:144`) — two defects, not one.** First, `appSourceProtections` normalized with `path.resolve()` only, never `realpath`, so a checkout under a symlinked ancestor matched no mount and **no read-only overlay was emitted at all** — the self-modification escape, reopened. Second, and only visible once the first was fixed: the overlay was emitted at the source dir's realpath rather than at **the dest the box writes through**. bwrap creates a mountpoint at the literal dest, so an overlay at a path nothing else binds "just materializes an unrelated empty dir inside the box and protects nothing, while the real subtree stays writable" (`:127-131`). Fixing only the comparison would have left the protection inert. **Fixed:** `overlayDestFor` (`:132-142`) probes both spellings and returns the dest under the rw mount. **Confirm:** `scratchpad/sandbox-regression-fixes-test.mts`.
>
> 5. **State dir readable/writable from any box that mounts `$HOME` — found 2026-08-23.** `util/dataDir.ts` and `auth.ts` each justify their location with the *same sentence*: "~/.config is never bind-mounted into a session sandbox." True of the **obligatory** mounts only. Mount `$HOME`, a parent, or `/` — ordinary, no symlink, no bug — and the box reaches `~/.config/claudette`. `sessions.json` is replayed by `restore()` as **trusted** (`sessionManager.ts:941`), so a box that edits its own entry returns with `teamEmploy:true` or `sandbox:{enabled:false}`; the hook-poisoning ledger and `team-notes/` become writable too. **Confirm:** `npx tsx scratchpad/data-dir-containment-guard.mts`.
> 6. **The loopback auth token — same cause, worse consequence, found 2026-08-23.** `~/.config/claudette/token` sat in that same directory. The box can reach loopback (we deliberately omit `--unshare-net`), `isAuthed` accepts the token, and `POST /api/session/create` is auth-gated and so passes `trusted: true` — **a confined session read one file and created an unsandboxed one, immediately, no restart.** SANDBOX.md's "Control-plane escape" answer was *"but it holds no token"*; that was false. **THE FIX IS NOT A READ-ONLY OVERLAY.** For app source, *writing* is the escape and `ro` suffices; here **reading is the escape** and `--ro-bind` still permits reads — an `ro` fix would look correct and leave the hole open. Both dirs are bound over with an **empty** directory (`stateDirsToHide` / `hiddenStateDests` in `sandbox.ts`), covering `dataDir()` and `dirname(tokenFilePath())` **independently**, since they diverge under `CLAUDETTE_DATA_DIR`. **Confirm:** `npx tsx scratchpad/auth-token-containment-guard.mts`.
>
> **Three shapes to carry forward, because each produced more than one of the above:**
> - **A logical path compared against a real one is a fail-open by default** (escapes 3 and 4). Any guard here that compares paths should say which of the two it compares and why both sides agree — or test both spellings, which is what the fixes do.
> - **A gate that parses a path differently from the router that dispatches it is the same class of bug** (escape 1). Prefer deny-by-default, so a disagreement fails closed; the whitelist branch is what turned a parser mismatch into an open door.
> - **Best of all, remove the possibility of disagreement rather than maintaining it.** The strongest part of the auth fix is not the added `decodeURIComponent` — that keeps two parsers in step and must be kept in step forever. It is reading `req.routeOptions.url`, the route the framework itself resolved, which cannot diverge from the framework's own dispatch. When a check must agree with a subsystem, ask the subsystem rather than re-deriving its answer.

Network isolation (Fix D) remains deliberately deferred — defense-in-depth against third-party exfil, not a live escape.

**Connectors (`server/src/connectors/*`, CONNECTORS.md).** External MCP servers as operator-controlled per-session reach. Two kinds: `catalog` (Claudette holds the credential; granting is real, absent from the config means the tools do not exist for that session) and `account` (the CLI holds it; only a deny rule is possible, and only for declared names). HTTP connectors are **proxied** so the credential never enters a box and revocation bites the next call with no relaunch; stdio connectors are re-emitted verbatim so the *engine* spawns them inside the session's box — which means **a stdio connector's credential IS readable by the granted session**, documented as an accepted risk. Catalog at `dataDir()/connectors.json`, mode 0600, outside the default mount set. Hardened across two adversarial passes; CONNECTORS.md states 94 functional checks and 41 blocked attacks, and lists the accepted risks and known gaps plainly. **Deferred: OAuth** (modelled, nothing dials it) and a standalone connection probe.

**Teams (`server/src/mcp/{teamTools,teamMailbox,teamNotes}.ts`).** Star topology: one coordinator, up to `MAX_TEAM_SIZE` members sharing a cwd and inheriting the coordinator's sandbox. Messaging is asynchronous and idle-gated — a message to a busy session is queued and delivered when it comes free. Hiring is operator-gated (`teamEmploy`), never self-granted. Dismissal is an **exit interview**: the teammate's final report is saved as a role handover note and quoted, line-prefixed, into the next hire's first message — line-prefixing because note text is untrusted and a plain delimiter let a note forge a second assignment.

**Fixed 2026-08-21 — worth understanding, because the shape recurs.** `employ_teammate` (`teamTools.ts:269`) called `create()` with seven positional args, so `model`, `permissionMode`, `sandbox` and `trusted` all arrived `undefined`. The `sandbox` omission is deliberate and documented (`:264-268` — it makes a teammate inherit the coordinator's confinement). The `permissionMode` omission was not considered, and it interacted with a second fact to produce a deadlock: the mailbox delivers only on `idle` (`teamMailbox.ts:128`, `index.ts:188-190`), and `claudeEngine.ts:441` sets state `waiting` — never `idle` — for as long as a permission prompt is unanswered. So a teammate parked on a prompt in a session nobody was watching **never received queued messages**, while `send_to_session` told the coordinator "it will receive this when its current turn ends" (`teamTools.ts:100`). Messages accumulated to `QUEUE_CAP = 50`; the comment at `teamMailbox.ts:42-44` had already anticipated "a session that may never come idle" without connecting it to this path. The fix pushes a blocked-notification to the coordinator on the `waiting` transition, stops `send_to_session` promising delivery to a `waiting` recipient, and labels `waiting` in `list_team` as blocked-on-operator rather than leaving it to read as "busy".

**Still open at time of writing:** whether a teammate should inherit its coordinator's permission mode at all, and if so where. Under design (Architect); the candidates are inheritance rules inside `register()` (single choke point, also covers boot-restore, and avoids giving an MCP-reachable caller the first say over a session's permission mode — `create()` has no trust gate on that parameter) versus a trust-gated operator toggle on the coordinator, structurally identical to `teamEmploy`. **Do not "fix" this by passing `permissionMode` through from `employ_teammate`** — that is the shape that was rejected, because it would let a model be the first chooser of a session's permission mode, and because auto-inheriting `bypassPermissions` is a *widening* move, which is the direction every other gate in this codebase refuses (CONNECTORS.md, trust gating).

> **`reviewer` is read-only by TOOL SCOPE, and prompt-gated beyond it (`agents.ts`; narrowed 2026-08-22).** The unscoped auto-approved `Bash` described below is GONE — `allowedTools` now pre-approves only `Bash(git diff:*|log:*|status:*|show:*)`, and anything else falls through to a **prompt**, not a block. The general lesson survives its own fix, which is why this paragraph stays: The role's description says "Read-only … never edits" and it carries `readOnly: true`, but its `allowedTools` include bare `Bash` — and `allowedTools` means **auto-approved**, so that Bash never prompts. `sh -c 'echo x > file'` mutates the workspace without touching any of `disallowedTools: ['Write','Edit','NotebookEdit']`. The code says as much at `:61-62` ("NOT read-only by tool list — but it is by charter"), and a charter is a prompt-level instruction, which SANDBOX.md's first paragraph already tells you not to rely on: permission prompts are advisory, the sandbox is the boundary. **Do not read `Agent.readOnly` as an enforced property.** It is enforced for the MCP surface — CONNECTORS.md's role-scoped denies, unprobed-server refusal, and no-inherit-into-a-less-restricted-child all work as documented — but it is not enforced for native tools, so a read-only role's real containment is whatever its sandbox mounts allow. **It is still not ENFORCED for native tools — it is DEFERRED to the operator**, which is weaker than a block and stronger than nothing. **Confirm the current state:** read `allowedTools` in the `reviewer` entry of `agents.ts` — bare `Bash` means the pre-narrowing gap is back; the git-scoped list means today's posture. Either way the sandbox mounts, not the role, are the boundary.

**Verified 2026-08-21, hedge discharged.** The fix described above is landed, and it was confirmed by reading the applied code rather than the change report. It lives in **`teamTools.ts` and `index.ts`, not `teamMailbox.ts`** — the mailbox's `canDeliverNow`/`onIdle` (`:128`, `:135`) are deliberately unchanged, because the drain semantics were never wrong; what was wrong was that nobody was told. `index.ts:191-209` pushes a blocked-notification upward on the `waiting` transition, de-duplicated per episode by a `notifiedBlocked` Set and cleared on `idle`, with its reentrancy- and loop-safety argument written out (only members notify, always upward, and a coordinator has no parent to notify in turn). `teamTools.ts:104-109` replaces the false "it will receive this when its current turn ends" with an explicit BLOCKED result. `teamTools.ts:143` adds `blockedOnPermissionPrompt` to `list_team`, because — per its own comment — `waiting` reads to a model as "still thinking", which is the misreading that let a coordinator wait forever. **Confirm:** `scratchpad/teammate-blocked-signal-test.mts`.

**`/rewind` (`server/src/git/shadowSnapshots.ts`).** Per-turn working-tree snapshots backing code restore. A snapshot is a real git commit written **without touching the user's index, HEAD, staging or branch** — the whole tree is staged into a throwaway `GIT_INDEX_FILE`, write-tree'd, commit-tree'd, and protected from gc by a ref under `refs/claudette/rewind/<uuid>`. Because they are ordinary refs they survive server restarts with no separate ledger. Restore re-materialises files through a temp index and can optionally delete untracked files created since, so a rewind undoes Claude's edits without rewriting history. Every git call is best-effort; the expected miss (cwd is not a repo) is silent, machine-level faults warn once. UI: `web/src/components/RewindPicker.tsx`.

**Find (`web/src/lib/{useFind,findMatches,searchHighlight,proseSearch}.ts`, `components/FindBar.tsx`).** One shared find-bar state hook across every editor surface — each editor only declares *where* it searches and how it reveals a hit, so stepping, reset-on-retype and focus behave identically everywhere. Ctrl/Cmd-F on an already-open bar re-selects rather than no-ops.

**Upload (`server/src/fs/fsApi.ts:114-118,162-176`).** `POST /api/fs/upload` streams a raw `application/octet-stream` body straight to disk — a dedicated content-type parser hands the stream through unbuffered, so there is no 1 MB JSON body cap, and the auth preHandler still runs before a single byte is consumed. `basename(name)` strips path components so an upload lands in the chosen folder and cannot traverse out; `wx` refuses to clobber.

**Marked as inference, not confirmed by me:** that `/rewind` is verified end-to-end (I read the module and the picker exists; the "built, verified and committed" claim comes from the memory index, not from my reading). Everything else above I read directly. I have **not** run the app, so no claim here is a runtime observation.

## Architecture strand — status, invariants, and open questions

Three proposals were designed on 2026-08-21. (C) is largely landed, (A)'s module is LANDED BUT UNWIRED (`sandboxPaths.ts` exists; `grep -rn sandboxPaths server/src` returns zero importers), (B) has never been built. The code will survive without this section; the reasoning will not, and (B) is entirely design.

### (A) The sandbox path-resolution layer

**The diagnosis.** `sandbox.ts` asked containment questions in six places, and each independently chose a resolution policy for the TARGET and another for the MOUNT ROOTS. Three disagreed, and those three were escapes 2–4 above. All three are now point-fixed. **The layer exists because point fixes leave the disagreement itself in place**, and there are exactly TWO legitimate questions here which need OPPOSITE policies:

- **Q1 REACH** — "if the box performs an I/O at host path P, does it succeed?" The kernel follows symlinks, so **both sides must be real**.
- **Q2 PROVENANCE** — "could a confined session have placed or redirected the thing at P?" The **target must not be realpath'd**: a link the box planted at `<cwd>/x` is inside the rw cwd lexically even though it points elsewhere, and resolving it both loses that fact and opens a TOCTOU window before the exec.

**Honest pricing, and it was accepted on this basis rather than despite it: after the point fixes, the layer closes ZERO live holes.** Its value is entirely (a) the latent fourth instance below and (b) stopping the three fixed sites drifting apart again. This is a debt-and-drift argument, not an incident argument. Schedule it as refactoring.

**The latent fourth instance — the thing most worth preserving here.** Q2 is currently correct BY COINCIDENCE. `pathInWritableMount` compares logical-to-logical, and its one reachable caller happens to hand it a logical target: `notebookDocManager.openPath` sets `doc.path` with `resolve()` (`:60`, `:90`), and `findNearestPython` walks up with `dirname` (`jupyterManager.ts:32-41`). **Nothing declares that pairing.** Add one `realpathSync` to `openPath` — which reads like a hardening, and is the sort of thing a security pass proposes — and with a symlinked project root (`~/proj` → `/srv/proj`) the logical rwRoot no longer prefixes the real candidate, the guard returns false, and the venv-probe escape reopens. Same shape as escape 2's irony: the mitigation is what creates the exposure.

**Staged, verified, not landed:** `scratchpad/sandbox-paths-layer.patch` (`server/src/claude/sandboxPaths.ts`) and `scratchpad/sandbox-paths-test.mts` — 23/23 in a preview tree. The file changes NO caller, so landing it is inert. Also queued: `resetAppRoot()` beside `appSourceRoot()`'s cache.

**The three predicates.** `boxCanReach` (Q1, real/real, last containing mount wins — reproduces bwrap's shallow-first layering incl. the same-path rw/ro tie); `refuseIfBoxCouldHavePlaced` (Q2, lexical target, union of logical dest AND real source); `overlayPathFor` (Q3 — where a protective overlay must be BOUND, = logicalMount + target-relative-to-realMount).

**Why Q2 is a REFUSAL and not a boolean** — stronger than a naming convention: the function over-approximates, refusing whenever it cannot rule the box out. That makes `refusal !== undefined` safe by construction AND makes `refusal === undefined` a SOUND negative, since anything doubtful would already have been refused. Both branches are safe, where `if (couldHavePlaced) grant()` would have read as a grant condition with nothing in the type objecting. Same move `sessionConfinement.ts` already makes twice, with `Confinement` and `Owner`.

**Q3 exists because escape 4 has a second half.** If the rw mount is `~/proj` → `/srv/app` and the app source is `/srv/app/server`, the box reaches it at `~/proj/server`; an `--ro-bind` at `/srv/app/server` binds a path nothing else binds, materializing an empty directory inside the box while the real subtree stays writable. **CORRECTED 2026-08-23 — this was FALSE.** `overlayDestFor` implements logicalMount + target-relative-to-realMount and `appSourceProtections` calls it per mount. Verified from EMITTED ARGV on the `~/proj` -> `/srv/app` layout: ro-bind dest is the box-visible `/home/proj/server`, and no argument containing `/srv/app` is emitted at all. Protection is PRESENT and CORRECT. The mechanism description above still matters — it is why the both-ways probe must not be simplified away.

**Migration — A2 onward, none started.** The enabling constraint: the 10 sandbox tests assert on EXPORTED NAMES and on ARGV, not internals. So keep every export's name and signature and change only bodies; for a non-symlinked layout the argv is byte-identical and all 10 stay green untouched.

- **A2** `sandboxPathAccess` → `boxCanReach`; `pathInWritableMount` → `!refuse…`; `pathVisibleInSandbox`
- **A3** `isUnsafeSymlinkMount` → `refuse…(dirname(mount))`
- **A4** `appSourceProtections` → `refuse…` + `overlayPathFor` ← **the risky step**: the only one that changes argv for a layout someone might really run (a dotfiles-symlinked project root)
- **A5** `wrapCommand` takes an ABSOLUTE program path; drops `which()`
- **A6** the grep enforcing "no path resolution outside `sandboxPaths.ts`"

**Do NOT start (B) before A2 lands** — (B)'s mount-widening rule needs these containment semantics and has no defensible order without them.

**Invariants.** A1: `path.resolve`/`realpathSync`/`startsWith(sep)`/any shell appear nowhere in `sandbox.ts` outside `sandboxPaths.ts` (grep-checkable). A2: exactly three predicates; a fourth question means the taxonomy is wrong and needs revising, not patching. A3: refusal over-approximates. A4: no path string reaches a shell.

**Open and unresolved:** a mount whose path does NOT exist contributes nothing to provenance (test #20 in `sandbox-paths-test.mts`), which is correct today because bwrap will not bind it — but if a caller ever asks about a path under a mount about to be created, the answer is wrong AND FAILS OPEN. Fail-open judgement calls are the class that produced three of the four escapes. Re-derive before flipping.

### (B) The trust boundary — DESIGNED, NEVER BUILT

**One correction to carry forward:** the permission-mode hole is NOT currently exploitable. `setPermissionMode` appears only at `sessionApi.ts:129` (auth-gated), `sessionManager.ts:858` and `claudeEngine.ts:245` — no MCP path — and `employ_teammate` passes no `permissionMode` (`teamTools.ts:269`). It becomes exploitable the moment either (a) `employ_teammate` gains a `permissionMode` argument, or (b) `permissionMode` joins the inheritance list beside sandbox (`:247`) and connectors (`:256`). Both are natural next steps.

**The design, three shapes.** (1) Provenance as a 4-way union `{operator|restore|inherit|session}`, not a positional boolean — `sessionManager.ts:292` already LAUNDERS inherit into operator via `trusted || !!inherited`, and the `launders` check at `:275` exists precisely because inherit ≠ operator for connectors while being treated as equal for sandbox. (2) A `Capability` record with ONE exhaustive `Record<keyof Capability, {widens, key}>` table — add a field without a clause and it is a TYPE ERROR. Three consumers read it: `widens()` (returns REASONS, not a boolean, because the `console.warn`s at `:277`/`:964`/`:990`/`:1209`/`:1227`/`:1243` are this subsystem's only observability), `sandboxKey` (`sandbox.ts:564`) + `connectorKey` (`connectorLaunch.ts:166`) — so the hand-maintained-projection debt is fixed by the SAME change — and the persistence round-trip. (3) `register()` takes an options object. **(3) IS the positional-params fix, so (B) and that conversion MUST SHIP AS ONE COMMIT** or `sessionApi.ts:69`, `teamTools.ts:269` and `sessionManager.ts:1113` get touched twice.

`RefusalReason` from (A) and `widens(): string[]` are the same shape. **One reason type should serve both** — a deduplication neither design noticed when specced separately.

**Verified so nobody re-raises it:** `restore` provenance is EARNED. `sessionPersistence` writes to `dataDir()`, not `~/.claude` (`sessionPersistence.ts:14`), and `dataDir.ts:17` documents that as security-relevant for exactly this reason. **CORRECTED 2026-08-23 — this residual is CLOSED.** `stateDirsToHide()` owns the invariant for `dataDir()` AND `dirname(tokenFilePath())` independently (they diverge under `CLAUDETTE_DATA_DIR`). Box side: `hiddenStateDests`, bound from an EMPTY dir — ro would still permit the read, and here READING is the escape. Authorizer side: an explicit loop in `sandboxPathAccess`. Verified with `$HOME` mounted rw: token, `sessions.json`, ledger and team-notes all `read=false write=false`, control file still readable. Both guards 6/6. **The real residual is narrower:** `stateDirsToHide()` is a hand-maintained list and nothing asserts the WRITERS agree with it. An operator who mounts it reopens self-granted `enabled:false` on next boot.

**Still open, neither blocking:**
1. Does `mounts` have a defensible widening order? Answering it needs A2's containment semantics. The cheap sound answer is exact-pair subset with rw ⊄ ro; that is over-restrictive and it is unknown whether unusably so.
2. Does `readOnly` belong in `Capability` at all? It is DERIVED from `agentId`, and storing it creates a new hole (`readOnly:true` with `agentId:'general'`). The workaround puts `agentId` in the record and derives, which makes `widens()` impure (it reads `AGENTS`). No clean answer.

**The product question, decided:** "read-only" means "this session's own tool list has no writes", NOT "this session cannot cause writes". A read-only coordinator with hiring rights can hire a `general` teammate; that is the DOMINANT workflow and gating it would have been switched on in the first hour. So: keep the hop, stop promising transitivity in the UI. Badge reads "Read-only tools". The delegation caveat lives on the `teamEmploy` control, not the role, because that is the capability that creates it — including the sentence that a teammate inherits this session's reach as its WRITE surface (`sessionManager.ts:247-249`).

**The strict lattice already exists and is already the default: `teamEmploy: false`.** Do not build a second control. State the guarantee precisely, because it is narrower than it looks — messaging is never gated, only roster management is, so: **"a read-only session with no hiring rights AND NO EXISTING TEAMMATES cannot cause writes."**

**Two lines are owed at `sessionManager.ts:275`** explaining why `launders` blocks connector inheritance while native tools now cross freely — connectors are reach the operator granted to a SPECIFIC session; native tools are the child's own role from a list the operator can see. Without them the next reader sees an asymmetry and resolves it in one direction or the other.

**The two-level star holds SOLELY via `teamTools.ts:244`.** All of the above assumes one hop. It belongs in the session graph — a `canHire(session)` predicate on `SessionManager` plus a `register()` assertion refusing a `parentId` whose own session has a `parentId` — so a future "let members hire" feature must DELETE an explicit invariant rather than merely add a caller. It is NOT a `widens()` clause: a graph-shape constraint, not a capability comparison.

### (C) Testability

**Landed and green:** `auth-route-coverage-test.mts` (7/7; found 450 bypasses over 120 routes before the fix), `sandbox-symlink-argv-characterization.mts` (7/7), `outputKeys` + test (8/8), `sessionReducer` + test (32/32), and the `sessions.tsx` provider rewrite on `useReducer`.

**Staged, unrun:** `web/src/store/sessions.test.tsx` — 7 provider tests, blocked on `vitest` + `@testing-library/react` + `jsdom`, which could not be installed against a read-only `node_modules`. **A test nobody has executed is not evidence; do not let it read as passing.**

**Not applied:** the `run-suite.sh` C-I1 lint and the web-unit-suite block. Perform the fails-first check on the lint (add a one-line `process.exit(0)` file to SUITE, confirm it IS flagged) before trusting it.

**The seam that made route testing possible** was already there: `registerFsRoutes` was being tested in-process by `scratchpad/upload-test.mts`. The only blocker for the session routes is that `registerSessionRoutes` takes the concrete `SessionManager`; structural typing means a stub works TODAY, and the interface extraction (C1) makes it clean rather than possible. **C1b** — extracting a side-effect-free `buildApp()` from `index.ts` — remains the follow-up, because the auth sweep currently MIRRORS `index.ts`'s composition rather than importing it, so a route registered directly in `index.ts` (`/jupyter/*` at `:259`, `/api/health` at `:214`, `/api/auth` at `:235`) is not caught automatically.

**Hazard analysis for the provider rewrite, stated so it can be checked:** it touches NONE of the four documented `App.tsx` ordering hazards. An earlier draft claimed H2 (`~441-443`) was "directly improved" and **that was read down**: identity preservation removes only SPURIOUS churn from redundant events; a real change must still produce a new array, and the effect genuinely wants membership-only, so `sessionIdKey` is still required and H2 STANDS. The reducer buys a lower firing rate, not the removal of the workaround.

### Habits this strand established, worth more than any of the code

- **Label a PROOF and a PROXY differently.** You cannot assert the absence of a future bug. The auth sweep's dep-array check is a proof; "no stale closure" can only be pinned by its observable consequence, and the file says so.
- **A security test must prove it can fail.** `auth-route-coverage-test.mts` rebuilds the known-vulnerable hook and FAILS if the sweep cannot see it. It passed in both the broken and fixed runs — without it, the fixed 7/7 would be indistinguishable from a blind harness.
- **Ask the subsystem rather than re-deriving its answer** — from the auth fix's `req.routeOptions?.url`. Same thesis as the whole path layer.
- **A documented hazard must be checked against the artifact in your hands, not only the hypothetical future one.** A comment describing a cache-ordering hazard was written, and that exact hazard then shipped three sections up in the same file. The comment was evidence of understanding it, not of having avoided it.
- **A second harness nobody invokes is a second harness that rots** — why the vitest suite is wired into `run-suite.sh` rather than left as its own command.
- **"This test is stale" is a hypothesis with a two-minute test.** The repo was wrong about it nine times out of nine.

## 2026-08-23 — Two more sandbox escapes closed; a new class of test; harness hygiene ✅ UNCOMMITTED

**Escapes 5 and 6 are described in the Sandboxing section above — read that, not this.** What
follows is only what that section does not carry.

### STANDING GUARDS — a new category in `scratchpad/`, worth understanding before adding tests
Most checks here verify that something *works*. These four pin an invariant **before** it can
be violated, and three of the four found something on their first run:

| file | pins |
|---|---|
| `venv-probe-chain-guard.mts` | `openPath` must store a **logical** `doc.path`. Adding a `realpathSync` there — which reads like *hardening* — reopens the venv-probe escape. |
| `mount-shadowing-guard.mts` | the symlink refusal is load-bearing for more than the escape it was written for. §4 records an over-approximation in the unwired path layer that **must flip in the same commit as A2**. |
| `data-dir-containment-guard.mts` / `auth-token-containment-guard.mts` | escapes 5 and 6. |
| `port-and-reap-lint.mts` | any test binding a port reaps on every exit path; no two bind the same port. |

All are registered in `run-suite.sh` with comments saying **green is the correct steady state**
— unlike the characterization reds (`layout-check.mjs`), which are red until unbuilt work lands.

**The generator, if you want a fifth:** *find a guarantee whose enforcement reads a fact from
somewhere else, then ask who asserts that fact.* Escapes 5 and 6 were found because **the same
justifying sentence appeared in two files** — a rationale copied between files is a fact nobody
owns. Unmined leads: anything justified by "the box can't reach X" (grep the phrase);
`--strict-mcp-config`, whose value rests on the CLI honouring it and nothing verifies that.

### THE FAILURE MODE THIS CODEBASE KEEPS PRODUCING
Every one of these was an **assertion whose truth-value changed without the assertion being
touched** — and each was believed until measured:
- `auth-loopback-test.mjs` left an unauthenticated server on a fixed port; the next run of the
  *same file* connected to its own orphan and reported 8 false failures.
- `clear-race-test.mjs` reported "3/4" while its **positive control was dead** — the three green
  assertions were passing vacuously, proving nothing.
- Four Chrome harnesses polled `/api/health`, which **any** server on that port satisfies. Their
  own servers were dying with `EADDRINUSE`; they drove a *stranger's* app, got its login screen,
  and reported "missing tab" for months.
- `port-and-reap-lint.mts` printed ✅ for a file that **would not parse** — the reap rule greps
  for handler names and a mangled splice left them all present. It now runs esbuild first.
- `ratelimit-test.mjs` died on a missing `/tmp/claudette-shots` **after** its assertions, hiding
  two real failures.
- A guard's own verdict file was written to a path the box could not see, so it recorded
  nothing — the write-decoy, inside the test written to prove confinement.

**Rule earned:** a race test without a working positive control is not weak, it is *decorative*;
and a harness that cannot tell its own server from a stranger's cannot report a startup failure
at all. Both harnesses now wait for **their own child's** ready line and dump its output on
failure.

### GOTCHAS THAT COST REAL TIME
- **Chrome tests fail standalone.** They need `CHROME_BIN`, exported only by `run-suite.sh`.
  Judge them only through the harness, or you get false reds on files you never touched.
- **`web/dist` vs source.** A harness that spawns its own vite (`layout-check`) or builds
  (`clear-race`) tests your source; the four that serve `web/dist` test the bundle. `web/dist`
  is currently stale and is read-only to confined sessions.
- **Editing `run-suite.sh` mid-run corrupts that run** — bash reads a script incrementally.
- **Scripted edits with index arithmetic broke two files this session.** Prefer independent
  anchored replacements; always `node --check` / `bash -n` after.

### LANDING'S "NOT LOGGED IN" — fixed 2026-08-23, but the product bug remains
An unconfined (host-mode) session against an exposed config gets a scrubbed mirror under
`~/.config/claudette/host-scrubbed-config/<sessionId>/`, where every entry symlinks back to
`~/.claude`. Claude refreshes its OAuth token by **atomic rename**, which **replaces the symlink
with a real file** — from then on that session is divorced from the shared credentials and every
later login goes to a file it is not reading. Repaired by hand (symlink restored; stale copy at
`/tmp/landing-creds-stale.bak`). **Still open:** `reconcileCredsBack` runs only at session exit
and at boot, so a login made *while* a host-mode session is alive never reaches it.
**Diagnose with:** `ls -la ~/.config/claudette/host-scrubbed-config/*/` — a real
`.credentials.json` where every sibling is a symlink is the signature.

### OPEN — operator decisions, none blocking
1. **`UPSTREAM_TIMEOUT_MS = 120_000`** (`connectorProxy.ts`). A hung upstream stalls a tool call
   two minutes. The mechanism works; only the constant is in question. It exists because there
   was *no* timeout at all, so this is a value judgement, not an oversight.
2. **Should `bypassPermissions` survive a restart?** `restore()` re-applies persisted
   `permissionMode` as trusted. Architect argues **no** — degrade to `default` with a notice,
   on asymmetry of error: degrade wrongly and you click once; keep wrongly and an unattended
   session runs unprompted for days. `teamEmploy`/`sandbox.enabled` are *postures*; this is a
   *waiver*, and waivers expire. It is explicitly less sure about `acceptEdits`.
3. **Trusting a workspace is a bigger switch than its dialog implies** — the copy was rewritten
   2026-08-22 to say so. `settings.local.json` is deliberately box-writable, so trust also
   decides whether a confined session's **own** writes become permission grants. Latent while
   this cwd is untrusted.
4. **`permissionMode` inheritance for teammates** — still unbuilt, deliberately. See the Teams
   section's warning; do **not** thread it through `employ_teammate`.

### KNOWN-STALE, DO NOT RE-TRIAGE
- `notebook-ui-e2e.mjs` waits for `+ notebook`, retired per `FileManager.tsx:23`. Fixture rot;
  the assertion needs rewriting.
- `terminal-ui-e2e.mjs` passes its shell assertion on a free port and then fails on
  `xterm terminal attached` — a genuine, unclaimed failure.
- `layout-check.mjs` is a spec test for the **unbuilt** phone layout.
- **A full suite has not been run since the last batch of changes.** The last measured figure was
  53 passed / 7 failed / 5 skipped, taken *before* escapes 5-6 were fixed and before the orphan
  ports were cleared. Re-run before quoting a number.

## 2026-07-22 (later) — FIX: "/clear sometimes does nothing, had to do it twice" ✅ UNCOMMITTED (web-only)
**Bug:** `/clear` empties the transcript — which is EXACTLY the auto-resume trigger. For a RESTORED
session, an auto-resume started on mount could still be **in-flight** (fetching its latest conversation)
when you `/clear`; it then completes its `await` and reloads the old conversation **over** the clear, so
`/clear` looks like it did nothing. The second `/clear` worked because the first attempt's auto-resume
had finished (session now in `autoResumed`), so nothing re-pulled. (Created/"fresh" sessions were never
affected — `isFresh` is permanent, so their auto-resume never runs.)
- **Fix (`web/src/components/ChatView.tsx`):** a module-level `resumeAborted` Set. `/clear`, `/resume`
  (pickResume) and `/rewind` (pickRewind) add the session to it (and to `autoResumed`); the auto-resume
  async now **fetches before mutating** and re-checks `resumeAborted` after each `await`, bailing rather
  than clobbering the user's action. Also blocks the future-effect-refire path.
- **Verified:** `scratchpad/clear-race-test.mjs` (4/4 — REAL headless Chrome; the proxy DELAYS
  readConversation so `/clear` lands mid-fetch; asserts the old conversation does NOT come back).
  Confirmed the test genuinely catches it: neutering the abort check makes the marker reappear (3/4).
  Web bundle rebuilt → live on `:4319` after reload.

## 2026-07-22 (later) — Active-pane awareness for CODE files ("edit this file") — BUILT + VERIFIED ✅ UNCOMMITTED, needs server restart
**Ask:** "Claude doesn't know what the active-pane code file is" — so "edit this file" / "the current
file" had Claude guessing a path. Notebooks already had path-less MCP steering; native Edit/Write need
an absolute path, so code files had nothing. **Fix:** append an ambient `<editor-context>` block naming
the open code file to the user turn **sent to the CLI**, so Claude can resolve "this file" to it.
- **New:** `server/src/claude/editorContext.ts` — `buildEditorContext(path)` (the block) +
  `stripEditorContext(text)` (removes it on read-back).
- **`sessionManager.ts`:** new `SessionManagerOpts.activePane(sid)` resolver; `sendUserTurn` sends the
  engine `text + buildEditorContext(pane.path)` ONLY when the active pane is a **code file**
  (`!isNotebook`). The buffer, the `userTurn` broadcast, and the pre-turn snapshot all keep the **raw**
  text — so the block never shows in the live UI and never perturbs `/rewind` keying.
- **`index.ts`:** wires `activePane: (sid) => activePanes.get(sid) ?? null` (the registry the web client
  already publishes on tab/session switch).
- **`conversations.ts`:** strips the block on every persisted read-back — `contentText` (titles + the
  isNoise check), `readConversation` (resume-replay bubble), `listRewindPoints` (point text, so it
  still equals the pre-turn snapshot's `text`). Live path was already clean (`buffer()` drops the CLI's
  user-prompt echo; live user events aren't re-rendered client-side).
- **Verified:** `scratchpad/editor-context-test.mts` (13/13 — strip round-trip; resume/title/rewind
  read-backs clean; rewind text still matches; **stubbed-engine sendUserTurn**: engine gets text+context
  for a code file, broadcast stays clean, notebook/no-pane → NO injection). Typecheck clean (all 3).
- ⚠ **SERVER change → needs a server RESTART to go live** (the running server is `tsx src/index.ts`,
  no watch). Web is unaffected.

## 2026-07-22 (later) — Cursor-style inline diff review ("super editor") — BUILT + VERIFIED ✅ UNCOMMITTED
Implemented the design below. Claude's pending **Edit/MultiEdit/Write** for a (non-notebook)
file **auto-opens that file's tab** in the calling session and renders the change as an inline
**+/- diff INSIDE the file's own CodeMirror editor** (`@codemirror/merge` `unifiedMergeView`)
with **per-hunk Accept/Reject** controls. A review bar adds **Apply accepted** / **Reject all**.
Only the hunks the user keeps land on disk — the flow rides the mandatory permission checkpoint;
**no server changes** (piggybacks `session:permission`, exactly as the design predicted).
- **New:** `web/src/lib/proposals.ts` (apply tool input → proposed text; reconstruct the permission
  decision from the accepted result), `web/src/components/DiffEditor.tsx` (the unified-merge view).
- **Changed:** `web/src/components/FileEditorView.tsx` (takes `sessionId`; flips to review mode when
  a matching pending permission exists — reads fresh disk as the diff base; **block-while-dirty** →
  save first), `web/src/App.tsx` (auto-open+focus the target file tab on an edit permission; passes
  `sessionId`). Added dep `@codemirror/merge@^6.12.2`.
- **Reconstruction trick (the correctness core):** since the diff base is the *exact current disk
  text*, ANY subset of accepted hunks maps to a single whole-file replacement — Edit → `{old_string:
  disk, new_string: acceptedResult}`, MultiEdit → one such edit, Write → `content: result`. Always a
  valid, unique match; no per-hunk bookkeeping. All-rejected (result===base) → `deny`.
- **Fallbacks:** an un-applyable edit (a match went missing) or a dirty buffer keeps the plain
  chat permission card working — both UIs answer the SAME `pending`, so resolving either clears both.
  Markdown/CSV edits render the raw-source diff (not Milkdown/table) during review. `.ipynb` never
  reaches this (NOTEBOOK_DENY). bypass/acceptEdits modes auto-allow before it engages — correct.
- **Live-apply fix (2026-07-22, after first report):** applying/allowing now (a) resolves the chat
  permission and (b) updates the editor **live** — `FileEditorView` optimistically swaps to the
  accepted text on its own Apply, and a disk-reconcile effect (`reviewedRef`/`handledRef` + brief
  poll) reflects a chat-card Allow/Deny too. Before this, the view stayed on the stale load after the
  edit landed on disk. Editor `key` now carries a `reloadKey` so it remounts with fresh bytes.
- **Auto-commit fix (2026-07-22, after second report):** CodeMirror's own per-hunk ✓/✗ only STAGE a
  hunk in the doc — they don't answer the permission, so the chat card persisted. Now `DiffEditor`
  watches `getChunks(state)`; when every hunk has been decided (count → 0) it fires `onAllResolved`,
  which commits the decision (reconstructed from the resulting doc) — so acting on the last hunk in
  the editor RELEASES the permission everywhere. Rejecting all hunks → doc === base → auto-**deny**.
  (The explicit **Apply accepted** button still commits with undecided hunks treated as accepted.)
  NB: CM binds the control to `onmousedown`, not click — matters for tests.
- **Auto-open toggle (2026-07-22):** a sidebar-header button (pencil icon, by the sound/bell toggles;
  `EditPopupToggle` in `App.tsx`, persisted `localStorage 'claudette.autoOpenEdits'`, default ON) gates
  whether a **closed** file's edit pops its editor open. OFF → a closed file's edit stays in the chat
  permission card (no popup). An **already-open** file ALWAYS shows its inline diff regardless (the
  permission auto-open effect focuses an open tab, but only opens a closed one when the toggle is on —
  read via `autoOpenEditsRef`). FileEditorView renders the diff purely off the pending permission, so
  the toggle only affects tab-popping, never whether an open file shows edits.
- **Verified:** `scratchpad/proposals-test.mts` (21/21 — apply + reconstruct + disk round-trip) and
  `scratchpad/super-editor-test.mjs` (19/19 — REAL headless Chrome: file auto-opens, inline diff +
  merge controls render, **the CM per-hunk ✓ auto-resolves** the chat permission + updates the editor
  live, disk is correct, chat-card **Allow** reloads the editor live, **Reject all** sends DENY).
- ⚠ **Sandbox note (this session):** the running server was restarted with the hardened sandbox, so
  in THIS agent session `web/dist`, `node_modules`, `server/`, `shared/` are **read-only** (only
  `web/src`, `scratchpad`, `.claude` writable). I therefore **could not rebuild `web/dist`** to make
  `:4319` live, and the e2e now builds to a temp dir + serves it via a thin proxy to the backend.
  To go live: rebuild `web/dist` from a NORMAL (non-sandboxed) shell — `npm run build -w
  @claudette/web` — or just use dev `:5273` (Vite hot-reload). All source changes are saved in `web/src`.

## 2026-07-22 — Cursor-style inline diff review ("editor +/-") — DESIGNED, NOT BUILT 🟡 (superseded — now BUILT, see above)
**Goal:** Claude proposes a code change that renders as inline **+/- hunks INSIDE the file's
own CodeMirror editor** (not a separate panel/tab), and the user **accepts/declines per hunk**;
only accepted hunks land on disk. This entry is a *design* checkpoint — **no code written yet**.
The design was worked out this session; the key finding is that Claudette is already wired for it.

**Why it fits (the crucial mechanism — verify line #s with grep, captured 2026-07-22):**
- The embedded CLI runs with `--permission-prompt-tool stdio` (`server/src/claude/claudeEngine.ts`
  ~line 37), so **every** `Edit`/`Write`/`MultiEdit` routes to `handlePermission`
  (`claudeEngine.ts` ~338) **before touching disk**, and the CLI **blocks** until Claudette responds.
- `PermissionDecision` already supports `{ behavior:'allow'; updatedInput?: Record<string,unknown> }`
  (`shared/src/types.ts:121`), and `handlePermission` returns `updatedInput: decision.updatedInput
  ?? req.input` (`claudeEngine.ts` ~388). **So returning a MODIFIED input makes the CLI write YOUR
  version.** Partial-accept = reconstruct `new_string` from the accepted hunks and hand it back as
  `updatedInput`. Reject-all = `{ behavior:'deny' }`.
- The decision channel is **already wired end-to-end and already carries `updatedInput`**:
  server→web WS `session:permission` (`sessionApi.ts:30` broadcast → web `client.ts:93`);
  web→server `api.respondPermission(id, requestId, decision)` sends WS `session:permission`
  (`client.ts:205`) → `sessionApi.ts:222` → `sessionManager.respondPermission` (~532) →
  `engine.respondPermission` (~235). **⇒ partial-apply needs NO new server plumbing** — piggyback
  the existing permission request (it already carries `toolName` + `input`) and just enrich the UI
  + build the decision's `updatedInput` from accepted hunks. (New WS messages are optional polish.)

**Frontend enabler:** `@codemirror/merge`'s `unifiedMergeView` renders inline green `+`/red `−`
hunks **with per-chunk Accept/Reject buttons in the same editor**. NOT yet a dependency (we're
already on CodeMirror 6). Plugs into `web/src/components/CodeEditor.tsx` (its extensions list). To
show a proposal: set the editor doc = **proposed** text and pass `original:` = **base** (disk/buffer) text.

**Per-tool mapping:** MultiEdit = cleanest (each `edits[]` entry is a hunk → keep/drop in the
`updatedInput` array). Edit = one `old_string→new_string` → split into sub-hunks with a line diff
(add the `diff` npm pkg). Write = whole-file diff (disk vs `content`).

**Token cost:** ~zero — rides the mandatory permission checkpoint; no new MCP tools/schemas.

**Caveats / decisions:**
- **Unsaved buffer:** a proposal diffs vs **disk**, not the live CodeMirror buffer (there's no
  server-side live text-doc for code files — same gap flagged for the "live-editor MCP" idea).
  v1: **block-while-dirty** (or diff vs the buffer text).
- **File not open:** auto-open+focus it to show the diff (reuse the notebook `onFocus`/active-pane
  pattern; `App.tsx:257` already publishes `activePane` for code files with `isNotebook:false`).
- **bypassPermissions / acceptEdits modes auto-allow without prompting** (`claudeEngine.ts` bypass
  branch ~371) → the review flow only engages in **default/prompting** mode. Correct/expected.
- **Multi-file change = a SEQUENCE of gated Edit calls**, reviewed one file at a time in v1
  (Cursor batches into one review — a later refinement).
- `.ipynb` native edits are already denied + funnelled to the notebook MCP (`NOTEBOOK_DENY`,
  `claudeEngine.ts:75`), so this is for **non-notebook files only** — fine.

**Scoped v1:** MultiEdit + Edit · single-file · prompting-mode only · block-while-dirty · `@codemirror/merge` UI.

**Next steps (ordered):**
1. Add `@codemirror/merge`; wire `unifiedMergeView` into `CodeEditor` so a passed-in `{base, proposed}`
   renders inline +/- with accept/reject (**UI-first, with mock data** so you see it in-editor).
2. Server: add a line-diff util + hunk→`new_string` reconstruction (add `diff`). In `handlePermission`,
   for `Edit`/`MultiEdit`, surface the tool input to the web as a proposal — reusing `session:permission`
   is enough (web detects `toolName ∈ {Edit,Write,MultiEdit}` and renders the diff UI instead of the plain card).
3. Web: on Apply, build `updatedInput` (Edit → reconstructed `new_string`; MultiEdit → filtered `edits[]`)
   and call `api.respondPermission(id, requestId, {behavior:'allow', updatedInput})`; reject-all → `deny`.
4. Handle file-not-open (auto-focus) + block-while-dirty.
5. Later: `Write`, multi-file batching, diff-vs-buffer.

**Repo state (this session, on `master`, ahead of `origin/master`, UNPUSHED):** committed —
CSV editable table view `c91af3d`, OAuth-creds reconcile fix `e6fa8cc`, workspace-trust gate
`1471258`. Untracked throwaway scratch `_sbx_{fix,probe,probe2,run,test}.mts` left in the tree
(unrelated; safe to delete). Nothing for the editor +/- feature exists yet.

## 2026-07-18 (latest) — ALL KNOWN SANDBOX ESCAPES CLOSED (code) ✅ UNCOMMITTED, needs restart
Implemented fixes for every documented escape vector. All typecheck clean; verified by
`scratchpad/sandbox-escape-fixes-test.mts` (18/18 argv-level) + a live nested-bwrap run.
**Live `:4319` still runs the OLD code — a server restart is required to activate all of
this** (the running server is plain `tsx src/index.ts`, NOT `tsx watch` — corrects the old
gotcha — so my edits did NOT hot-reload and did NOT disturb this session).

- **Terminal-pane escape → FIXED** (`server/src/pane/paneManager.ts`, `server/src/index.ts`).
  New `paneSpawnSpec` + a sandbox resolver wired in `index.ts` (mirrors the kernel one):
  a pane for a confined session spawns its shell via `wrapCommand(cfg, cwd, shell, [])` —
  the same bwrap box as the session's Claude/kernels, `--clearenv`'d. Unconfined session →
  raw shell but env scrubbed of `CLAUDETTE_*` (`sanitizedEnv`). Live proof: sandboxed pane
  can't see `~/Downloads`, `$CLAUDETTE_TOKEN` empty, `server/` EROFS, `scratchpad/` writable.
- **Self-modification escape → FIXED** (`server/src/claude/sandbox.ts`). `appSourceProtections`
  adds an `--ro-bind` overlay of `<appRoot>/server` + `/shared` inside any box that would
  otherwise expose them rw (bwrap shallow-first layering pins just those subtrees ro; rest
  of the project stays writable; never revealed to a box that didn't mount them). Opt out:
  `CLAUDETTE_ALLOW_APP_SOURCE_MOUNT=1`. `appRoot` auto-detected (walk up to the dir with
  server/+shared/), override `CLAUDETTE_APP_ROOT`.
- **Control-plane escape / Fix C → FIXED** (`server/src/claude/sessionManager.ts`).
  `normalizeSandbox` (now exported) ignores `sandbox.enabled=false` and forces confinement
  ON unless `CLAUDETTE_ALLOW_UNSANDBOXED=1` — single choke point for create/setSandbox/
  restore. Confinement can't be lowered by a (possibly in-box) request.
- **Token even on loopback + clearenv (earlier this session)** → the box holds NO credential,
  so it can't call the authenticated API at all. Kernels already confined per-session.
- **Fix D (network isolation) — DEFERRED BY USER DECISION (2026-07-18), now defense-in-depth**,
  not a live escape (every loopback-reachable primitive is credential-gated-and-box-has-no-cred,
  or confined). Its remaining value is *third-party exfil* protection (a prompt-injected Claude
  phoning home), NOT escape. Recommended when revisited: Level 3 (nftables allowlist on a
  dedicated UID/cgroup) — a host-config change to design WITH the operator. See SANDBOX.md.
- **New operator flags** (all default-OFF/secure): `CLAUDETTE_ALLOW_UNSANDBOXED`,
  `CLAUDETTE_ALLOW_APP_SOURCE_MOUNT`, `CLAUDETTE_APP_ROOT`, `CLAUDETTE_NO_AUTH`.
  ⚠ **Dev-in-Claudette impact:** after restart, a session whose cwd is this repo gets
  `server/`+`shared/` READ-ONLY. To edit the server's own source from inside a session, the
  operator must set `CLAUDETTE_ALLOW_APP_SOURCE_MOUNT=1` (and to make an unsandboxed session,
  `CLAUDETTE_ALLOW_UNSANDBOXED=1`).
- Still open (hardening, not live holes): owner-scope panes on the WS; `--strict-mcp-config`;
  node_modules writable in a repo-rw box (next-start-only, supply-chain-adjacent); Fix D.

## 2026-07-18 (later) — Security (i) DONE: token required even on loopback ✅ UNCOMMITTED
Implements the recommended first security step from the 07-18 review (closes the local
leg of the control-plane escape: an in-box process — post-fix-A envless, no config mount —
can no longer call the loopback API unauthenticated).
- **`server/src/auth.ts`**: `resolveAuth` loopback branch now always requires a token —
  env `CLAUDETTE_TOKEN` if set, else loads-or-mints (0600, dir 0700) the persistent one at
  `${XDG_CONFIG_HOME:-~/.config}/claudette/token` (same file `rc_launch.sh` manages; never
  mounted into boxes; stable so devices stay logged in). Explicit opt-out `CLAUDETTE_NO_AUTH=1`
  (loopback only). Non-loopback: unchanged fail-closed (env token mandatory — a silent file
  token shouldn't guard a deliberate exposure). New export `tokenFilePath()`.
- **`launch.sh`**: mirrors the token source (env → file → generate via openssl) and prints a
  ready-to-open `?token=` URL for both dev and `--build`; `CLAUDETTE_NO_AUTH=1` respected.
  **`index.ts`**: startup log points at the token file (still masked). **README.md** +
  **SANDBOX.md** updated (SANDBOX "Done" list now includes this).
- Verified: `scratchpad/auth-loopback-test.mjs` **17/17** (401 without token; file minted
  mode 600; Bearer + cookie + WS-upgrade gating; token stable across restart; NO_AUTH opt-out
  open; env token beats file). Typecheck clean. **Server restart needed to take effect.**
- ⚠ **Ripple:** throwaway test servers now need `CLAUDETTE_NO_AUTH=1` (or a token) — older
  scratchpad UI tests that boot :4321 unauthenticated will 401 until run that way. After the
  live server restarts, the browser needs one `?token=` visit (launch.sh prints it).
- Remaining security queue: ~~self-modification → Fix C → terminal-pane~~ ALL DONE — see the
  "ALL KNOWN SANDBOX ESCAPES CLOSED" entry at the top. Only Fix D (network) + minor hardening left.
- **NEW vector documented (2026-07-18):** SANDBOX.md § "Terminal-pane escape (unsandboxed
  pty spawn)". (Now FIXED — see top entry.) `PaneManager.create()` does a bare `pty.spawn(shell,{cwd,env:process.env})`
  with **no `wrapSandbox`** — every terminal pane is an unsandboxed host shell as the
  server's user, inheriting `CLAUDETTE_TOKEN` (NOT covered by fix A) and an arbitrary
  caller-controlled `cwd`. Driven purely over loopback: `POST /api/pane/create` → WS
  `pane:input` = arbitrary RCE (a superset of the fs-API write). DEMONSTRATED this session
  (`/proc/self/root` = `/`, listed `~/Downloads` from outside the box). Real fix: route the
  pane pty through the same bwrap wrapper as sessions; also extend `--clearenv` to it, scope
  `cwd`, and owner-scope panes on the WS. This is arguably the highest-value fix now — a
  terminal that escapes makes the box around the chat moot.

## 2026-07-18 (later) — 0a DONE: doubling fix + Agents tray browser-verified ✅
`scratchpad/doubling-agents-test.mjs` (7/7) against a REAL Claude session on the :4321
throwaway server: turn 1 (bash + marker-word prose) → marker renders exactly once, no
long line repeats (doubling fix holds); turn 2 (forced subagent) → Agents tray + AgentCard
with type chip + status label render live (Agent-vs-Task fix holds). `web/dist` rebuilt 07-18.
- **In-box testing gotchas (durable):** host Chrome lives in `/opt` → INVISIBLE inside a
  sandboxed session. Use the project-local Chrome for Testing at
  `.chrome-headless/chrome/linux-*/chrome-linux64/chrome` (gitignored; re-download via
  `npx @puppeteer/browsers install chrome@stable --path .chrome-headless`), passed to tests
  via `CHROME_BIN`. Also: this session still INHERITS `CLAUDETTE_TOKEN` (fix A isn't live
  until the server restarts) — a throwaway server picks it up from env and then requires
  token auth even on loopback; launch it with `env -u CLAUDETTE_TOKEN`. And `pkill -f` can
  match its OWN shell's command line (exit 144 killed the compound) — use a bracket in the
  pattern, e.g. `pkill -f 'remote-debugging-port=936[0-9]'`.

## 2026-07-18 — Agent rendering fixes + sandbox security review (A/B done) ⚠ ALL UNCOMMITTED, not yet live
Three workstreams this session. **Everything is in the working tree, uncommitted.** A/B need
a **server restart/reload** to take effect; the two web fixes need a **web reload** (`web/dist`
already rebuilt; dev `:5273` hot-reloads). I did NOT restart the running server — it would kill
this very session (I'm running *inside* a Claudette sandboxed session, cwd = this repo).

**1. Chat "doubling" fix** (`web/src/store/chat.tsx`). The phone-join `ASSISTANT` reducer
(uncommitted from a prior turn) duplicated assistant prose: with `--include-partial-messages`,
a message can arrive as >1 `assistant` event; the reducer wiped the whole `open` index map after
each, so the 2nd (cumulative) event couldn't find the already-streamed item and re-materialized
it. Fix: `ASSISTANT` no longer clears `open` wholesale; reset per message on the stream's
`message_start` (new `MSG_START` action + a branch in `handleStreamEvent`); the materialize-fresh
path registers the new item's id back into `open` so cumulative snapshots finalize in place.
Typecheck clean. **Not yet browser-verified against a live doubling repro.**

**2. Agents tray was always empty** (`web/src/store/chat.tsx` + `components/ChatView.tsx`). The
subagent tool in CLI **2.1.207 is named `Agent`, not `Task`**; `collectAgents`,
`countRunningAgents`, and the ChatView render-filter all matched only `Task`, so `agents` was
always `[]` and the whole `AgentsTray` was gated out. Fix: `export const isSubagentTool = (n) =>
n==='Task' || n==='Agent'` applied at all four sites. Rebuilt `web/dist`. Confirmed live: the
session's subagent `tool_use` has `name:"Agent"` with children carrying `parent_tool_use_id`.

**3. Sandbox security review — A+B implemented, C/D + self-modification documented.**
Full threat-model + fixes now live in **`SANDBOX.md`** (new sections: "Control-plane escape" and
"Self-modification escape"). Summary:
- **Core hole:** sandbox is filesystem-only (deliberately no `--unshare-net`), so a sandboxed
  session can reach the loopback control API and `POST /api/session/create` with
  `sandbox:{enabled:false}` → a fully **unsandboxed** session. Demonstrated by hand this session.
- **Fix A — env isolation** (`server/src/claude/sandbox.ts`): added `--clearenv` + an allowlist
  (`CLAUDE_ENV_ALLOW_PREFIXES`, `passthroughEnvArgs`, `BASE_PATH`, `nodeBinDir`) so the child no
  longer inherits `CLAUDETTE_TOKEN`/unrelated host secrets; claude's own auth/proxy/CA vars pass
  through. Kernels (`wrapCommand`) get no creds (bonus). **Tested** via `/tmp/sbtest.mts`: token
  gone, `MY_DB_PASSWORD` gone, `ANTHROPIC_API_KEY` passed, `claude --version` exit 0 in-box.
- **Fix B — token off the mounts** (`rc_launch.sh`, `scratchpad/ui-screenshot.mjs`): token now
  persists to `~/.config/claudette/token` (never mounted) with a migrate+delete of the legacy
  in-project `.claudette-token`. Live exposed copy already migrated/removed.
- **Deferred (documented, NOT coded):** **C** = API must not let a confined caller lower its own
  confinement (hard: server can't tell in-box loopback caller from the real UI); **D** = network
  isolation (nftables/pasta) to cut the loopback reach; **Self-modification escape** = the sharpest
  one and **unaddressed by A–D**: session cwd = repo mounted rw + server under `tsx watch` → edit
  any `server/src/**` (e.g. an MCP tool in `mcp/notebookTools.ts`) → hot-reload runs arbitrary code
  **unsandboxed**. Needs *no token/network*. Only mitigations: don't rw-mount the app's own source
  into a session; don't run `tsx watch` when exposed. Also recommended: **require a token even on
  loopback** (else the local API is unauthenticated and A/B don't bite locally).

## 2026-07-14 — FIX: Claude-opened notebook leaked into the VIEWED session ✅
A notebook a Claude tool opened (in background session X) attached to whatever session
the user was VIEWING (Y), not the calling one. Root cause: `docs.openPath` broadcasts
`notebook:update` globally, and App's `seenNb` effect auto-attached ANY new doc to
`activeId` (the viewed session). (This was the flagged "MCP-opened notebook attaches to
the visible session" follow-up.)
- **Client** — the shell now only auto-attaches notebooks the USER opened locally.
  `notebooks.wasLocallyOpened(id)` (new; `localIds` ref set in `openPath`/`createPath`).
  `App.tsx` `seenNb` gates its `activeId` attach on it; server-pushed docs attach ONLY
  via `focusPane` (which carries the calling sid) — no more race, no leak.
- **Server** (`notebookTools.ts`) — `targetDoc(sid, args, focus=true)` now emits
  `onFocus(sid, doc)` when it FRESHLY opens a notebook, so Claude's edits/opens land in
  the CALLING session (preserves the "changes stay visible" intent, in the right place).
  A notebook already open in the calling pane isn't re-focused; `read_notebook` passes
  `focus=false` (inspecting shouldn't pop a tab). `create_notebook` still doesn't focus
  (its doc says open_notebook to view) → now correctly stays out of every session.
- Verified: `scratchpad/notebook-session-test.mjs` (5/5 — `notebook:update` alone does
  NOT leak into the viewed session; `focusPane(X)` attaches it to X only; switching to X
  shows it; Y stays clean). Typecheck clean (all 3 workspaces).
- **Needs a SERVER restart** to take effect (server-side tool change), not just a reload.

## 2026-07-14 — Completion sound + focus-independent notifications ✅
Addressed "no sound, and I shouldn't need the tab unfocused / the bell pressed."
Reworked signals so a session finishing while you're **not actively watching it**
(different session OR tab hidden) nudges you — the tab need NOT be unfocused, and
sound needs no opt-in.
- **`web/src/lib/chime.ts`** (new): `playChime()` — a soft two-note ding via Web Audio.
  No file/network/permission; works on sticky activation (user has clicked Send).
- **`notifications.ts` reworked** — `useNotifications(sessions, activeId, setActive)`.
  New gate `watching(id) = id===active && !document.hidden`; a finish/permission fires
  signals unless you're watching. Two independent signals: **sound** (`soundOn`, default
  ON, `localStorage 'claudette.sound'`, no bell) + **desktop notification** (bell opt-in,
  now fires even when the tab is FOCUSED — dropped the old `document.hidden`-only gate).
- **`App.tsx`**: new **`SoundToggle`** (speaker icon, mutes the chime) beside the bell;
  bell tooltip clarified ("also send a desktop notification…"). `useNotifications` now
  gets `activeId`.
- Verified: `scratchpad/sound-notif-test.mjs` (7/7 — stubs AudioContext + Notification,
  pins `document.hidden=false`: background finish chimes with tab focused + no bell;
  notifies with tab focused; actively-watched finish is silent; mute stops chime but
  keeps notification). Typecheck clean.
- **Gotcha (cost time):** headless-CDP tests that `throw` before `chrome.kill` leave a
  ZOMBIE chrome on the debug port; the next run reuses that port and inherits its
  `localStorage` (a prior mute wrote `claudette.sound=0`), corrupting results. Always
  `pkill -f 'remote-debugging-port=936'` between iterations, or the harness lies.

## 2026-07-14 — Sidebar "needs attention" light for finished background sessions ✅
A session that finished (or errored) while you weren't viewing it now shows a **red
pulsing light** + bold name + "done" in the sidebar, cleared when you switch to it.
(The desktop notification was already wired but only fires tab-hidden + bell-opted-in;
this is the always-on in-app signal.)
- `sessions.attention: Set<string>` (new). Flagged on a `running/waiting → idle` edge
  (via `prevStateRef`) OR a failed exit, only when `id !== activeId`. Cleared by an
  effect on `activeId` change (covers click / create / default / Claude-focus). Exposed
  on the context.
- `App.tsx` `SessionRow` takes `attention` (from `useSessions().attention`): red
  `shadow`-glow pulsing dot replacing the state dot, bold name, red "done" label.
- Verified: `scratchpad/attention-test.mjs` (5/5 — background finish flags; ACTIVE
  session finishing does NOT self-flag; viewing clears; errored background session
  flags). Typecheck clean.

## 2026-07-14 — FIX: session stuck 'idle' mid-turn (ready clobbered running) ✅
**The real bug** behind "no working indicator, no interrupt, footer says idle while
Claude streams/runs tools." Captured a live turn (`scratchpad/real-turn-capture.mjs`):
the SERVER is correct — `running` on send, held for the whole turn, `idle` only at the
terminal `result`. But the CLI inits **lazily**, so its `system/init` (→ `session:ready`)
lands a beat AFTER the first turn set `running`, and the client's ready handler did
`patch(id, {state:'idle'})` **unconditionally** — slamming state back to idle for the
rest of the turn (and overriding the optimistic `markBusy`). Auto-resume relaunches the
engine, so this hit the first turn after every load.
- Fix (`store/sessions.tsx`): `ready` now only settles to idle when a turn ISN'T in
  flight — `s.state !== 'running' && s.state !== 'waiting'`. (Still marks a relaunched-
  from-exited engine idle.)
- Verified: `ready-clobber-test.mjs` (5/5 — Stop survives an injected ready/init) AND
  `real-turn-browser-test.mjs` (5/5 — a REAL multi-step Claude turn keeps Stop+running
  visible the full ~11s, then returns to idle). `real-turn-capture.mjs` documents the
  server sequence. Typecheck clean.
- **NOTE for future me:** the earlier indicator "fixes" (thinking ticker, optimistic
  markBusy) were necessary but INSUFFICIENT because they were verified only with
  INJECTED events — none exercised a real turn, so the ready-clobber went undetected.
  Prefer `real-turn-browser-test.mjs` for any state/indicator change.

## 2026-07-14 — Optimistic "working" on send (short-turn indicator) ✅
Short/no-tool turns often showed **no** working-indicator and **no** interrupt button:
`running` (which gates the composer strip + Stop) only lit on the server's
`session:state→running` WS broadcast, and for a fast turn the send→running gap plus the
brief running window meant the client barely painted it (and it was inconsistent turn to
turn). Fix: **optimistically flip idle→running on send**.
- `sessions.markBusy(id)` (new) — `idle`→`running` only (never overrides `waiting`/
  `exited`). Called from `ChatView.submit` right after `sendTurn`. The server's real
  running/idle events reconcile (running dedups; result → idle clears it).
- Now Working…/💭 + Stop appear the instant you hit Enter, for every turn. (Short no-
  thinking turns still only show "Working…" — there's no extended-thinking text to show.)
- Verified: `scratchpad/optimistic-busy-test.mjs` (5/5 — fake session with NO server
  backend, so only the optimistic flip can light it; Stop + Working appear on send,
  cleared by an injected idle). Typecheck clean.

## 2026-07-14 — Rate-limit chip: show % used (not just reset) ✅
The session/weekly usage chips showed *when* the window resets but never *how much*
was used. Root cause: the CLI's `rate_limit_event.rate_limit_info` reports usage as
**`utilization`** (a 0–1 fraction, from the `anthropic-ratelimit-unified-*-utilization`
header) — but the client read a nonexistent `percentUsed`, so the number was always
dropped. (Verified against the installed CLI binary 2.1.207: a healthy event is
`{status:"allowed"}` with nothing else; a **warning** event is `{status:"allowed_warning",
resetsAt, rateLimitType, utilization, …}` — which is what populates the chip, so the
usage data was present but under the wrong key.)
- Fix (`store/chat.tsx`): normalize at ingestion — `percentUsed = utilization*100` when
  `utilization` is a number (falls back to any real `percentUsed`). Added `utilization?`
  to `RateLimitInfo`. Display path (`ChatView.tsx` `RateChip`) unchanged; it already
  renders `percentUsed`.
- Verified: `scratchpad/ratelimit-test.mjs` (3/3 — injects warning-shaped five_hour +
  weekly events; chip reads "▲ Session 83% · 12:36 PM" and "Weekly 41%"). Typecheck clean.

## 2026-07-14 — Composer history + auto-resume on load ✅
Two chat quality-of-life features (frontend only).
- **Up/Down message history** (`ChatView.tsx`): shell-like recall of the turns you've
  sent this session. `sentHistory` = the transcript's `user` items; `histPtr` counts
  steps back (0 = live draft), `stashRef` holds the in-progress draft. **Up** at the
  caret-start (or already browsing) recalls the previous message; **Down** walks back
  toward the stashed draft. Any manual edit or submit resets to live. Skipped while the
  slash menu is open. Caret jumps to end on each recall (`taRef`).
- **Auto-resume on load** (`ChatView.tsx` + `sessions.tsx`): a **restored** session
  (from persistence, not one created via the UI this load) with an empty transcript
  auto-pulls its **latest** conversation — the equivalent of `/resume` picking the top
  entry — so a page reload lands you back in context. `sessions.isFresh(id)` (new;
  `freshRef` set in `create()`) excludes just-created sessions; a module-level
  `autoResumed` Set makes it once-per-session-per-load (so `/clear`+switch won't re-pull
  the old convo). Guards on `running` so it never disturbs an in-flight turn. Uses the
  existing `listConversations`→`readConversation`→`resumeInto` chain (newest-first).
- **Replay bug fixed** (`store/chat.tsx` `itemsFromEvent`): resumed conversations now
  render your past **user prompts** as bubbles (string- or text-block content, replay
  only). Previously only tool_results surfaced from `user` events, so a resumed convo
  showed no user turns — and history would be empty after a reload. Live path untouched
  (still the optimistic echo; no dup).
- Verified e2e in headless Chrome: `scratchpad/history-resume-test.mjs` (10/10 — Up/Down
  cycles + stash restore; auto-resume loads the fixture convo incl. user prompts;
  per-session transcripts stay separate). Typecheck clean.

## 2026-07-13 — Markdown cells render + heading-level collapse ✅
Notebook markdown cells now behave like Jupyter: **rendered by default**, and
**foldable by heading rank**. Pure frontend (reuses the existing `Markdown` comp).
- **Rendered markdown** (`Cell.tsx`): a markdown cell shows its rendered output
  (`<Markdown>`) unless being edited. `showEditor = !isMarkdown || !rendered`; the
  CM editor mounts only in edit mode (effect gated on `showEditor`). **Enter / double-
  click** edits; **Shift/Ctrl+Enter, Esc, or blur** renders. Markdown's single "exit
  edit" path is the editor **blur** (commits buffer → NotebookView drops it from
  `mdEditing` → re-renders); run keys `leave()`-blur first for markdown, then advance.
  Empty md cell shows a "double-click to edit" affordance. Code/raw cells unchanged.
- **Heading collapse** (`NotebookView.tsx`): `headingLevelOf()` = the `#` count of a
  md cell's first non-empty line (1=h1 most senior … 6; 0=not a heading). Collapsing a
  heading folds every following cell until the next heading of **same-or-higher** rank
  (`jl <= lvl`). `useMemo` → `{hidden, foldCount, headingLevel}`. Hidden cells are
  skipped in render (original index preserved for ops/drag). Gutter shows a ▾/▸ caret
  on heading cells; collapsed heading shows a "N cells hidden" badge. **Space** toggles
  fold on a selected heading; arrow-nav skips folded cells; a search match inside a
  fold auto-expands (clears `collapsed`). State (`mdEditing`, `collapsed`) is ephemeral
  view state in NotebookView, reset per notebook.
- Verified e2e in headless Chrome: `scratchpad/md-collapse-shot.mjs` (9/9 — renders as
  real `<h1>`/bold/bullets not raw `#`; caret per heading; collapse folds exactly the
  3 cells under H1 incl. the nested H2, next H1 stays; expand restores). Shots
  `/tmp/claudette-shots/md-{1,2,3}`. Typecheck clean.

## 2026-07-13 — Live activity signals (thinking ticker + sidebar state) ✅
Two visibility fixes so it's obvious when/what a session is doing.
- **Composer thinking ticker** (`ChatView.tsx`): while `running`, a strip inside the
  input box (above the textarea) shows a live signal. "Actively thinking" is a *client-
  derived* sub-phase of `running` (the server only knows idle/running/waiting) — read
  off the transcript: newest item is a still-`streaming` thinking block. Shows 💭 + the
  thought's **tail** (`slice(-180)`, `line-clamp-2`) so you see it without scrolling;
  falls back to a green-pulse "Working…" / "Waiting for you…" when not thinking. The
  inline transcript thinking block is unchanged (this is an always-visible mirror).
- **Sidebar state made unmistakable** (`App.tsx`): `StateDot` bigger + glow, and now
  `waiting` pulses too; new `StateLabel` shows a word per row — running→"working"
  (green), waiting→"needs you" (yellow, pulsing), exited→"exited" (red). Hidden on
  hover so it doesn't fight the ✕.
- **State wiring was already complete** (verified, not the cause of "no signal"):
  `claudeEngine.setState` → `sessionManager` `stateChange` → `sessionApi` broadcasts
  `session:state` → client store → dot. If a running instance shows nothing, it's the
  **stale `:4319` bundle** — rebuild.
- Verified: `scratchpad/thinking-shot.mjs` (injects a session + streaming thinking over
  the captured WS; shots in `/tmp/claudette-shots/think-{1,2}`). Typecheck clean.

## 2026-07-13 — Web notifications ✅
Background-session desktop/PWA notifications. When the browser tab is **hidden**, a
Claude **turn completing** (session `running/waiting → idle` edge) or a **permission
prompt** raises a system notification; clicking it `window.focus()`es and switches to
that session. Opt-in, persisted in `localStorage` (`claudette.notifications`).
**Pure frontend — no server/shared changes** (all signals already existed on the WS).
- **`web/src/lib/notifications.ts`** — `useNotifications(sessions, setActive)` hook.
  Owns `wanted` (localStorage) + browser `permission`; `enabled = wanted && granted`.
  Subscribes ONCE to `api.on.stateChange` (diffs a per-session `prevState` ref for the
  running/waiting→idle edge) + `api.on.permission`, both gated on `document.hidden` and
  `Notification.permission==='granted'`. `tag: sessionId` so a newer note replaces the
  session's prior one. Live refs (`enabledRef/sessionsRef/setActiveRef`) so the once-
  mounted subscribers see current values without re-subscribing.
- **Toggle**: `NotifyBell` in `App.tsx`'s `MainTabs` (bell icon by the Files/Git/Terminal
  toggles). Accent when firing, slashed when off/blocked; `requestPermission()` fires
  from the click (user gesture). Denied/unsupported → disabled + explanatory tooltip.
- Icon: `/icon-192.png`. Verified e2e in real headless Chrome:
  `scratchpad/notifications-test.mjs` (8/8 — silent-before-opt-in, toggle+grant, turn-
  complete-while-hidden, permission-prompt, silent-while-visible, no-fire-on-non-edge,
  tag). Stubs `Notification` + wraps `WebSocket` to feed real server frames. Typecheck clean.

## 2026-07-13 — Notebook interface upgrades ✅
Undo/redo, kernel controls + accurate status, kernel picker, clear-outputs,
copy/cut/paste/duplicate, cross-cell search, shortcut help. All typecheck clean;
server logic e2e-verified (`scratchpad/undo-redo-test.mts`, real-kernel + kernelspecs
checks). Web UI typechecked, not browser-driven.
- **Undo/redo (server-owned):** `NotebookDocManager` keeps per-notebook snapshot
  stacks (`undo`/`redo`, cap `MAX_HISTORY=50`). `applyOp` banks a pre-op snapshot on
  success; `undo()/redo()` swap snapshots, bump version+dirty, and emit `opFocus` on the
  first changed cell. `doc.canUndo/canRedo` drive the toolbar. History resets on
  disk-reload. `clearAllOutputs` is undoable. In-cell text undo (CodeMirror) is separate.
- **Kernel status fix:** added `'none'` to `KernelStatus`; store defaults to `'none'`
  (was a bogus green `'idle'` before any kernel started). `shutdown`→`'none'`,
  `restart`→optimistic `'starting'`.
- **Kernel picker + controls:** `GET /api/notebook/kernelspecs` (lazy-starts Jupyter),
  per-notebook `setKernelSpec` — **starts the chosen kernel immediately** (Jupyter-style)
  and becomes the in-memory default for later-opened notebooks; restart/interrupt. Header
  dropdown shows name·status; `doc.kernelName` is the selected spec. Permanent default via
  **`CLAUDETTE_DEFAULT_KERNEL`** env (e.g. `python-autovenv`); falls back to `python3`.
  Kernels start LAZILY otherwise (on first run or on pick) — so an untouched notebook
  correctly shows "no kernel" until then.
- **Cells:** clear-outputs, copy/cut/paste (`c/x/v`, module-level clipboard), duplicate
  (⧉ button), all via existing ops (`addCell` now carries `source`).
- **Search:** `NotebookView` find bar (Ctrl+F) — cross-cell, match count, Enter/Shift+Enter
  step. **Match-level highlighting**: `web/src/lib/cellSearch.ts` is a CM decoration
  field (`setCellMatches` effect) added to every cell; NotebookView keeps a cellId→
  EditorView registry (`registerView` prop on Cell) and pushes each cell's match ranges +
  the active one, then scrolls the `.cm-nb-match-active` span to center. Offsets clamped to
  each editor's live doc len (typing-while-searching). The file CodeEditor already had CM
  Ctrl+F search (unchanged).
- **Shortcut help:** `?` overlay (also a toolbar button).
- New routes: `/api/notebook/{undo,redo,clearOutputs,kernelspecs,kernel/{restart,interrupt,setSpec}}`.
  `registerNotebookRoutes(app, notebooks, kernels)` now takes `kernels`.


## What this is
Web-based harness/shell for Claude Code with a first-class notebook. Successor to the
Electron app **ClaudeMaster** (`../ClaudeMaster`, the port source). Single-user, local-first;
optional secure phone/PWA access over Tailscale. Architecture + decisions: `PLAN.md`.

## Status
**Phase 1 COMPLETE** (chat, notebook, terminal, phone/PWA — see §Phase 1). **Phase 2 in
progress.** Everything below typechecks clean (`npm run typecheck`, all 3 workspaces) and is
screenshot/e2e-verified headless. **The live `:4319` server serves a STALE bundle** — none of
the 07-11/07-12 work is visible until rebuilt + restarted (`./rc_launch.sh` or `./launch.sh`).

Phase 2 done + verified this session:
- **Git panel** ✅ — `server/src/git/{gitManager,gitApi}.ts` (local-only port of CM's git;
  status/diff/log/branches/stage/commit/branch ops) → `api.git.*` → `web/src/components/GitPanelView.tsx`.
  Renders in the right dock. Verified live against a real repo.
- **File browser + editable previews** ✅ — see §Shell redesign. fs write endpoints added.
- **Per-session panes** ✅ — open notebooks/files + the active tab are tracked per session.

Phase 2 **remaining** (the next steps): **permissions center**,
**production bundling / `start`-script polish**. (**web notifications** ✅ done 07-13.)

## 2026-07-12 (later) — Reveal the mutated cell ✅
When an op touches a cell, the notebook view now **selects + reveals** it — so Claude's
cell edits scroll into view, and structural actions land focus on the right cell.
- `applyOp` (`notebookDocManager.ts`) computes the affected `cellId` and emits
  **`opFocus`(notebookId, cellId, reveal)**; bridged to a new WS **`notebook:focus`**.
  `reveal` = Claude-origin OR a structural op (add/insert/delete/move/setCellType).
- `NotebookView.tsx` subscribes (`api.on.notebookFocus`): always `setSelectedId(cellId)`;
  when `reveal`, `revealCell` scrolls it into view (`block:'nearest'`, one rAF retry for
  a freshly-added cell). **Does NOT steal keyboard focus.** A plain human text edit
  (typing/undo) only re-selects → never yanks the scroll while you're in the cell.
- Locked-cell (refused Claude) edits emit no focus. Verified: `scratchpad/opfocus-test.mts`
  (cellId + reveal per op type, incl. delete-neighbor + locked-no-emit; all pass).

## 2026-07-12 (later) — Active-pane steering for notebook MCP tools ✅
Restores CM's active-pane behavior (was deferred out of P1): Claude's app-control
notebook tools now target **the notebook the user is looking at**, fixing "Claude
edited/guessed the wrong open notebook."
- **`path` is now OPTIONAL** on read/edit/run notebook tools — omitted, they resolve to
  the CALLING session's active notebook. New `server/src/mcp/activePaneRegistry.ts`
  (`Map<sid, ActivePane|null>`) holds it; the web client publishes it over WS
  (`session:activePane`) on every tab/session switch (`App.tsx` publish effect, diffed).
- **Stale-path guard** — an explicit `path` naming a *different* visible notebook is
  REFUSED (steers Claude to omit path). Escape hatch: new **`open_notebook`** tool
  focuses a notebook in the calling session (server → client `session:focusPane`).
- New **`read_active_pane`** tool (Claude asks what you're viewing). `pathProp` +
  all tool descriptions rewritten to steer omitting path.
- Also: `mcp.release(id)` is now actually called (on session `exit`) — was a latent
  token-map leak.
- Verified: `scratchpad/active-pane-test.mts` (path-less resolution, guard,
  open_notebook focus, degenerate states — all pass). `mcp-e2e-test.mts` updated for
  the new `registerNotebookTools(mcp, docs, kernels, panes, onFocus)` signature.
- **Web side is typechecked but not browser-verified** (needs a live Claude session for
  the full WS round-trip); server resolution is e2e-proven.
- **Closed active pane (intentional):** closing a notebook is client-view-only (the server
  never closes the doc). While Claude works: path-less calls error cleanly in the gap
  (active→null); an explicit-path edit **resurfaces + refocuses** the notebook (the
  `notebook:update`→re-add-to-`order`→`seenNb` chain). User chose to KEEP this resurface
  (2026-07-12) — Claude's changes stay visible rather than editing an unseen file. Don't
  "fix" the re-add: it's the same mechanism that makes Claude-opened notebooks appear.

## 2026-07-12 session — Shell redesign + editors + per-session panes
Approved plan: `~/.claude/plans/hashed-sleeping-moler.md`. Big rewrite of `web/src/App.tsx`.

- **New shell IA** — Claude is the **permanent anchor**, never hidden. Content (notebooks +
  file editors) opens as **tabs beside Claude** (companion split, `layout` side/stack, resizable).
  **Files & Git = narrow toggleable RIGHT DOCK** (`dock: 'files'|'git'|null`, resizable `dockW`).
  **Terminal = toggleable BOTTOM DOCK** spanning the main column (`termOpen`, `termH`). One
  generic pointer-drag divider helper (`dividerProps`) drives all resizers (sidebar/companion/
  dock/terminal). Tab strip = Chat · content tabs · Files/Git/Terminal toggles + side/stack control.
- **Per-session panes** — `bySession: Record<sid, {tabs, active}>`. Files tracked per session
  in App state; **notebooks attach to the CURRENTLY-ACTIVE session** when opened (store is global)
  via a `seenNb` effect, pruned from all sessions on close. Switching sessions swaps the whole
  tab set + focus. Verified: `scratchpad/persession-shot.mjs`.
- **File manager dock** (`web/src/components/FileManager.tsx`, replaced/deleted `FilesView.tsx`) —
  narrow tree + **New notebook / New file / New folder** actions (the old tab-strip `+ notebook`
  modal is retired). Dir → navigate; `.ipynb` → notebook tab; other → editor tab.
- **File editors, editable + save to disk** (`web/src/components/FileEditorView.tsx`):
  markdown → **Milkdown WYSIWYG** (`MilkdownEditor.tsx`); other text → **CodeMirror w/ per-file
  syntax colouring** (`CodeEditor.tsx` + `lib/codeLanguages.ts`, both ported from CM); images/PDF
  → inline viewer. Ctrl/Cmd+S saves; dirty ●; truncated (>2 MB) files open read-only.
- **fs write surface** (`server/src/fs/fsApi.ts`): `POST /api/fs/{write,createFile,mkdir}` →
  `WriteResult`; `createFile` uses `wx` (won't clobber). `api.fs.{read,write,createFile,mkdir}`.

### 2026-07-11 fixes (same running-tree)
- **Empty "Thinking" blocks suppressed** (`ChatView.tsx`) — Fable emits signature-only thinking
  (`"thinking":""`); an empty toggle was noise. Now filtered out (no toggle, no spacing gap).
- **Kernel cwd = the notebook's OWN dir** (`server/src/jupyter/kernelManager.ts`) — pass the
  notebook path (relative to Jupyter `root_dir=/`) on kernel start. Was `/`. Verified:
  `scratchpad/kernel-cwd-test.mts`. **(Supersedes the old "kernel cwd = /" deferred item.)**
- **Prominent interrupt** (`ChatView.tsx`) — while generating, the primary button becomes a red
  **⏹ Stop** (Send stays if a draft is typed); the "Working…" line got a clickable Stop; Esc
  still works. Interrupt = stream-json `control_request{subtype:'interrupt'}`. Verified stops a
  live turn: `scratchpad/interrupt-test.mts`.

## Key decisions (why)
- **Claude is the anchor; panes dock around it** (never hidden). Notebooks kept their companion
  split (Claude-left / content-right, side/stack). — user directive, this session.
- **Panes are per session** — a session's editors/notebooks travel with it. Notebooks (global in
  the store) attach to the *visible* session on open. **Edge case:** a notebook Claude opens via
  MCP while you're viewing a *different* session attaches to the visible one (the store doesn't
  say which session triggered it) — correct for normal use (you open in the session you're in).
- **Markdown → Milkdown, code → CodeMirror** (user choice); editors **save to disk**.
- Earlier durable decisions (backend hybrid, server-owned notebook doc, cell locks, CM modules
  dropped remote/SSH) — `PLAN.md` §1, unchanged.

## Layout (non-obvious map)
```
shared/  @claudette/shared — types.ts (Git*, FilePreview, WriteResult, DirEntry, FsListResponse),
                             notebook.ts (doc/ops/locks), ws.ts (typed WS unions)
server/  @claudette/server — Fastify + `ws` (loopback). claude/{claudeEngine,sessionManager,…},
                             notebook/{notebookDocManager,ipynb,notebookApi},
                             jupyter/{jupyterManager,kernelManager(cwd fix),kernelClient,jupyterProxy},
                             fs/fsApi.ts (list/read + write/createFile/mkdir), git/{gitManager,gitApi}.ts,
                             mcp/{appControlServer,notebookTools,activePaneRegistry(active-pane steering)},
                             pane/{paneManager,paneApi}, auth.ts, index.ts
web/     @claudette/web    — Vite+React (Tailwind `ctp-*` = Claudette palette, NOT Catppuccin).
                             api/client.ts (api.on/session/http/notebook/pane/fs/git.*),
                             store/{chat,sessions,notebooks}, App.tsx (the shell — docks + per-session panes),
                             components/{ChatView,NotebookView,TerminalView,GitPanelView,FileManager,
                               FileEditorView,CodeEditor,MilkdownEditor,FileBrowser(folder-pick only now),Markdown},
                             lib/{codeLanguages,editorTheme,toolFormat}, index.css (has `.milkdown-host` styles)
```
- Managers `extend EventEmitter`, bridged to the WS hub in each `*Api.ts` (`bridge*Events`) —
  mirror for any new topic. MCP notebook tools call the managers **directly**.
- New web deps (07-12): `@milkdown/{kit,react,theme-nord}` + `@prosemirror-adapter/react`;
  `@codemirror/lang-{json,yaml,sql,rust,cpp,go,java,php,xml,javascript}` + `@codemirror/search`.

## Run / verify
```bash
./launch.sh        # dev: server :4319 + Vite web :5273 → http://127.0.0.1:5273
./rc_launch.sh     # outward: build + token-guarded server + Tailscale HTTPS + phone QR
npm run typecheck  # all 3 workspaces
npm run build --workspace @claudette/web   # prod bundle (now ~2.0 MB w/ Milkdown)
```
Tests in `scratchpad/` (`npx tsx <f>.mts` / `node <f>.mjs`; each boots real deps). Backend:
`notebook-doc-test`, `kernel-e2e-test`, `kernel-cwd-test.mts` (07-11), `mcp-e2e-test`,
`loose-ends-test`, `interrupt-test.mts` (07-11). Headless-CDP UI (need web built + a throwaway
server on **:4321**): `redesign-shot.mjs` (full new shell), `persession-shot.mjs` (per-session
panes, **asserts**), `git-shot.mjs`, `files-shot.mjs`. Shots land in `/tmp/claudette-shots`.
**`layout-shot.mjs` / `ui-screenshot.mjs`** (renamed 2026-08-22 to the `*-shot.mjs` convention, which marks a screenshot producer with no assertions). They predate the redesign and neither can fail — both end in an unconditional `process.exit(0)`. **They were NOT deleted, and the reason is worth keeping:** the same "it's stale" claim was made about nine other browser tests, and when QA finally handed them a server five passed in 2-4 seconds — they had never been run, not rotted. "This test is stale" is a hypothesis with a two-minute test, and this repo has been wrong about it nine times out of nine. Run them before deleting them. Note separately that `ui-screenshot.mjs` reads the operator's REAL persisted token and drives their LIVE `:4319` server — that hazard is independent of staleness and must be fixed or the file removed before it is ever swept into an automated suite.

## Gotchas (durable)
- **The running `:4319` server is plain `tsx src/index.ts` — NO watch** (verified 2026-07-18
  via the process tree: `sh -c tsx src/index.ts` → `tsx` → `node … src/index.ts`, no `watch`
  anywhere). So server *source* edits do NOT hot-reload and do NOT disturb running sessions;
  changes go live only on a **manual restart** (which drops WS clients + relaunches sessions,
  killing any session running inside this repo). This CORRECTS the earlier "hot-reloads under
  `tsx watch`" note. (The `dev` script IS `tsx watch`, but this instance wasn't started that
  way.) Because it doesn't watch, the self-modification escape isn't *live* here — but it's
  still fixed in code (app source is ro in boxes; see SANDBOX.md). The **web** bundle is served
  from `web/dist` (static) — web changes need `npm run build -w @claudette/web` for `:4319`;
  dev `:5273` hot-reloads web via Vite.
- **Web dev port is 5273** (not 5173). **`NODE_ENV=development` is exported in this shell** — web's
  `build` re-pins `NODE_ENV=production` (else a bloated dev bundle / dead SW). Don't remove.
- **`@fastify/static` wildcard handler** serves rebuilt hashed assets without a restart — keep it.
- **Testing beside the user's server:** throwaway on **:4321** (`PORT=4321 HOST=127.0.0.1 npx tsx
  src/index.ts`), kill by **listening PID** (`ss -ltnp | grep 4321`) — NEVER `pkill -f "tsx src/index.ts"`.
  For clean session tests pass an **isolated `CLAUDETTE_DATA_DIR`** (else persisted sessions restore
  and confuse UI-driving that matches by session name).
- **The throwaway server also has no `--watch`** — restart it after server-side edits (a stale one
  404s new routes, e.g. `/api/fs/read` returned `{"error":"not found"}` until restarted).
- **Terminal remounts on session switch** — `TerminalView key={termCwd}` re-roots the pty to the
  new session's cwd (fixes the stuck-cwd bug) at the cost of scrollback. Intentional.
- **Modals opened from the sidebar/dialog subtree MUST `createPortal` to `document.body`** — the
  aside's `transform` becomes the containing block and clips `fixed` overlays (`FileBrowser`,
  `NewSessionDialog` do this).
- **Jupyter logs "running at" before tornado accepts** → `JupyterManager.start()` polls first; keep.
- Bundle is ~2.0 MB (CodeMirror + xterm + Milkdown) — fine for localhost; code-split later.

## Next steps
**Immediate (2026-07-18 session — all uncommitted):**
0a. ~~Browser-verify the doubling fix + Agents tray~~ ✅ DONE (see 07-18 later entry;
    `scratchpad/doubling-agents-test.mjs` 7/7). Live `:4319` still needs a restart to pick it up.
0b. **Security — DONE.** token-on-loopback + terminal-pane + self-modification + Fix C all
    implemented + tested (see the top "ALL KNOWN SANDBOX ESCAPES CLOSED" entry). Remaining is
    only Fix D (network isolation, now defense-in-depth) + minor hardening (owner-scope panes,
    --strict-mcp-config, node_modules). **Activate with a server restart** (not yet done —
    would drop this session; the running server is the OLD code).
0c. **Commit** the working-tree changes once the user says so (memory: never commit without an
    order). Touched: `web/src/store/chat.tsx`, `web/src/components/ChatView.tsx`,
    `server/src/claude/sandbox.ts`, `rc_launch.sh`, `scratchpad/ui-screenshot.mjs`, `SANDBOX.md`,
    plus the earlier uncommitted Phase-2 files already in `git status`.

1. **Rebuild to go live** — `./rc_launch.sh` (outward) or `./launch.sh` (dev). No schema change.
2. **Phase 2 remaining** (pick one): **permissions center** (view/edit Claude Code allow/deny/ask
   rules — CM has `../ClaudeMaster/src/main/permissions.ts` + `HANDOVER-permissions.md` to port) ·
   **production bundling / `start` scripts** polish. (**web notifications** ✅ done 07-13.)
3. **P1.20** — combined human+Claude notebook verify (user deferred; each piece verified in isolation).

Follow-ups (nice-to-have, flagged): MCP-opened notebook attaches to the *visible* session (see
Key decisions) · dock layout not yet tuned for phone (narrow dock beside chat is cramped on mobile) ·
divider sizes (`sideW`/`dockW`/`termH`/…) are in-memory, reset on reload — persist if wanted ·
per-cell "running" is coarse (cleared on kernel busy→idle) ·
`open_notebook`/newly-MCP-opened notebook also appears as an inactive tab in the *viewed*
session when the calling session differs (pre-existing seenNb attach behavior; harmless).

## Phone / remote access — WORKING via Tailscale (verified on-device)
`./rc_launch.sh` = one-command outward launcher (build → token-guarded loopback server →
`tailscale serve` HTTPS 443 → prints phone URL + QR → foreground). Token persisted in
`.claudette-token` (gitignored, stable so the PWA stays logged in). Auth (`server/src/auth.ts`):
loopback+no-token = open; any non-loopback HOST **requires `CLAUDETTE_TOKEN` or refuses to start**
(fail-closed) → httpOnly cookie via `/api/auth?token=…`, gates `/api/*` + `/jupyter/*` + WS.
Gotchas (cost time): direct tailnet IP to app ports doesn't work here → `tailscale serve` only;
phone needs MagicDNS (Android Private DNS Off/Automatic); `sudo tailscale set --operator=$USER` +
HTTPS certs done; first HTTPS hit provisions the cert (~10 s). Boot-persistence (systemd) NOT set.

## References
`PLAN.md` (architecture + decisions) · `TASKS.md` (P0/P1 checklist — pre-dates Phase 2) ·
`~/.claude/plans/hashed-sleeping-moler.md` (approved shell-redesign plan) · `NOTEBOOK-PLAN.md` ·
`README.md` · **`SANDBOX.md`** (bwrap model + the full escape-vector threat model / fixes A–D +
self-modification — read before touching sandbox or session-create) · `../ClaudeMaster/` (port
source; `permissions.ts` + `HANDOVER-permissions.md` for the next task) · memory index `MEMORY.md`.
