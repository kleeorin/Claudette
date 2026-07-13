# Claudette — Handover
_Last updated: 2026-07-12_

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

Phase 2 **remaining** (the next steps): **permissions center**, **web notifications**,
**production bundling / `start`-script polish**.

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
- **A running server does NOT hot-reload.** `tsx src/index.ts` (no `--watch`) serves a *prebuilt*
  bundle → rebuild + restart to see edits. The live `:4319` instance predates ALL 07-11/07-12 work.
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
1. **Rebuild to go live** — `./rc_launch.sh` (outward) or `./launch.sh` (dev). No schema change.
2. **Phase 2 remaining** (pick one): **permissions center** (view/edit Claude Code allow/deny/ask
   rules — CM has `../ClaudeMaster/src/main/permissions.ts` + `HANDOVER-permissions.md` to port) ·
   **web notifications** (notify on turn-done / permission prompt when the tab is unfocused — good
   for the phone PWA) · **production bundling / `start` scripts** polish.
3. **P1.20** — combined human+Claude notebook verify (user deferred; each piece verified in isolation).

Follow-ups (nice-to-have, flagged): MCP-opened notebook attaches to the *visible* session (see
Key decisions) · dock layout not yet tuned for phone (narrow dock beside chat is cramped on mobile) ·
divider sizes (`sideW`/`dockW`/`termH`/…) are in-memory, reset on reload — persist if wanted ·
no kernel restart/interrupt button · per-cell "running" is coarse (cleared on kernel busy→idle) ·
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
`README.md` · `../ClaudeMaster/` (port source; `permissions.ts` + `HANDOVER-permissions.md` for the
next task) · memory index `MEMORY.md`.
