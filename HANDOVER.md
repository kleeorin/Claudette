# Claudette — Handover
_Last updated: 2026-07-22_

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
- **Fix B — token off the mounts** (`rc_launch.sh`, `scratchpad/ui-screenshots.mjs`): token now
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
**`layout-shots.mjs` / `ui-screenshots.mjs` are STALE** (predate the redesign).

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
    `server/src/claude/sandbox.ts`, `rc_launch.sh`, `scratchpad/ui-screenshots.mjs`, `SANDBOX.md`,
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
