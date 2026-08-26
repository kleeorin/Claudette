# Claudette — Architecture & Build Plan

A web-based harness and shell for Claude Code, with a first-class notebook editor
in which **Claude acts as an extension of the notebook**. Successor to the
Electron app *ClaudeMaster*: same feature surface, browser-delivered, with a
rock-solid Claude↔notebook link built on a Jupyter kernel server.

---

## 1. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Deployment** | **Single-user, local-first, optionally reachable.** The server binds `127.0.0.1` by default and requires an access token *even on loopback* (`server/src/auth.ts`; opt out with `CLAUDETTE_NO_AUTH=1`). Binding a non-loopback `HOST` is supported and **fail-closed**: the server refuses to start without an explicit `CLAUDETTE_TOKEN`. The intended remote path is `./rc_launch.sh` — one origin, `tailscale serve` HTTPS, PWA on a phone. Still **single-user**: one operator, one token, no multi-user authn/authz. | Loopback is not a trust boundary here — sandboxed sessions share the host network namespace and can reach the control API (SANDBOX.md, "Control-plane escape"), so the token gates it. Remote access is a first-class supported mode, not a workaround; the phone is a first-class client. |
| **Backend** | **Hybrid**: a Node/TypeScript server that ports ClaudeMaster's main process ~verbatim (swap Electron IPC → WebSocket/HTTP), **plus a Jupyter server as a companion process** used for kernels. | Max customizability of our own app, one language front↔back, reuse of the debugged engine, and Jupyter's stability exactly where it matters (kernels). Not a "guest" inside Jupyter. |
| **Notebook model** | **Server owns one authoritative notebook document**, addressed by a stable `notebookId` + stable cell ids. The UI is a *pure view*. Claude both **edits and executes** the same document through the same server API. **Coordinated editing** (turn-based per cell) with **enforceable per-cell locks**. | Removes the two root-cause bugs from ClaudeMaster (implicit "active pane" targeting; multiple diverging copies / "temp version"). |
| **Notebook UI** | **Custom React notebook** ("a little Jupyter interface"), ported from ClaudeMaster, rewired as a view over the server document. | Full control, tight Claude integration, matches the desired UX. |
| **Execution** | **Server-side.** The Node server holds the kernel client (→ proxied Jupyter), runs cells, and writes outputs into the authoritative doc. Claude can run cells **with no browser tab open**; execution survives refresh/close; every viewer sees the same live outputs. | Claude executes cells (not just edits them), so execution must not depend on a live tab. Also the natural home for the option-2 upgrade. |
| **Concurrency** | Different cells edited by you and Claude at once: **supported** (per-cell, id-addressed ops + per-cell reconcile). Same cell at the same instant: **blocked by a cell lock** (not merged). | True concurrent co-typing (CRDT) deferred to the upgrade path. |
| **Cell locks** | Trigger = **focus + dirty**, plus manual **pins (🔒)** and an **idle auto-release**. Claude hitting a held cell → **hard-deny** with a quiet transcript note (no interruption). | Protects the cell you're in / editing; won't permanently block Claude; Claude's atomic edits mean it never holds a cell for long, so the lock is effectively one-directional. |
| **Upgrade path** | Architected so option 1 → **option 2 (Yjs/CRDT)** is an *upgrade, not a rewrite*: swap the authoritative doc for a shared `Y.Doc` (reuse `@jupyter/ydoc`), add a `y-websocket` sync server + kernel-output wiring. Addressing, MCP tools, and UI-as-view all carry over. | Keeps the door open to simultaneous co-typing without committing to its cost now. |

**Open decisions** (defaulted below, flag to revisit): see §10.

---

## 2. Why this fixes ClaudeMaster's notebook pain

ClaudeMaster's flakiness ("edits the wrong notebook", "writes a temp version")
came from **implicit addressing + multiple sources of truth**: the `.ipynb` file,
the renderer's in-memory copy, and the kernel state were three copies, and the
app-control tools targeted the *active pane* and did "edit live if open, else quiet
disk write" — two write paths to two truths.

Claudette removes both causes:

- **One source of truth.** The server holds the notebook document. Opening a
  notebook loads the file into that model once; every edit (yours *or* Claude's)
  mutates it through one path; the server persists atomically and broadcasts to
  all viewers. The UI never holds a separate editable copy that can drift.
- **Explicit addressing.** Claude never targets "the active pane." It first
  `read`s the notebook (getting cell ids + content), then edits **by
  `notebookId` + `cellId`**. The server knows exactly which cell.
- **Server-mediated = enforceable locks.** Claude's only route to the notebook is
  the MCP tools, which hit the server. The server can *refuse* an edit to a cell
  you hold — an authoritative lock, not an advisory hint.

---

## 3. System architecture

```
  Browser (SPA, ported ClaudeMaster renderer)
     │
     │  HTTP (request/response)  +  WebSocket (streaming)   ── same origin
     ▼
  Node/TS app server  (127.0.0.1)
     ├── ClaudeEngine          spawn `claude` -p stream-json  (ported ~verbatim)
     ├── SessionManager        session lifecycle, resume, roles, models
     ├── NotebookDocManager    ★ NEW: authoritative notebook docs, locks, persist
     ├── AppControl MCP server hand-rolled HTTP JSON-RPC (ported; notebook tools
     │                          now hit NotebookDocManager directly, not the UI)
     ├── PtyManager            node-pty shell panes + optional TUI  (ported)
     ├── GitManager            git via execFile/ssh                 (ported)
     ├── FsService             local fs ops + dir picker            (ported)
     ├── Permissions           read/merge/write Claude settings     (ported)
     ├── JupyterManager        spawn Jupyter server + venv discovery (ported)
     └── JupyterProxy          ★ NEW: reverse-proxy /jupyter/* (HTTP + WS)
              │
              ▼
        Jupyter server (127.0.0.1, companion process)  ── kernels only (v1)
```

Everything ClaudeMaster ran in the Electron **main** process moves to the Node app
server. Everything in the **renderer** ports to the SPA, with `window.api` (IPC)
replaced by an HTTP+WS client.

---

## 4. The notebook subsystem (the centerpiece)

### 4.1 Server: `NotebookDocManager`

Owns the set of *open* notebooks. Per open notebook:

- `notebookId` (stable, server-assigned on open) → in-memory **document model**
  (nbformat v4.5 JSON; every cell has a stable `cell.id`).
- **Ops API** (the only way to mutate): `editCell`, `addCell`, `insertCell`,
  `deleteCell`, `moveCell`, `setCellType`, `createNotebook`, `readNotebook`, and
  **`runCell` / `runAll`** (execution — see §4.6). Every op names `notebookId`
  (+ `cellId` where relevant). Applied atomically and serialized (single writer
  arbitration).
- **Persistence**: debounced, atomic write-through to the `.ipynb`
  (write-temp-then-rename). The doc is source of truth *while open*.
- **External-change reconciliation**: watch the file; if it changes on disk under
  a clean doc → reload; under a dirty doc → surface a conflict choice
  (Reload / Keep mine) — reuse ClaudeMaster's conflict pattern.
- **Broadcast**: emit `notebook:update` deltas over WebSocket to every subscribed
  viewer.

### 4.2 Cell locks (enforceable)

- UI sends `claimCell(notebookId, cellId)` on focus/dirty; `releaseCell` on
  blur/commit; auto-release after an idle timeout. Optional explicit **pin (🔒)**
  that holds a cell regardless of focus.
- On Claude's `editCell` to a held cell, the server **hard-denies** the MCP call
  with a message ("cell is being edited by the user — edit another cell or wait")
  and drops a quiet note in the transcript. Claude adapts on its own; you are not
  interrupted. *(A per-notebook "ask me instead" permission-card toggle can be
  added later.)*
- **Confirmed trigger:** **focus + dirty**, auto-release on blur/commit or idle
  timeout; manual pins available.
- Claude's edits are **atomic server ops** (one `editCell` carries the full new
  cell source — not a slow stream), so Claude never holds a cell for more than an
  instant. The lock is effectively one-directional: it protects *your* active cell
  from Claude's writes, and you almost never wait on Claude.

### 4.3 Different-cell concurrency (per-cell reconcile)

The UI is a view, but must **not clobber the cell you're actively typing in** when
a `notebook:update` arrives for a *different* cell. Rule: apply remote updates to
all cells except the one with local focus/uncommitted text; reconcile that cell on
commit/blur. Cell-granular, far simpler than character-level CRDT.

### 4.4 Claude's targeting flow (rock-solid)

1. `readNotebook(notebookId)` → structure with cell ids + source previews.
2. `editCell(notebookId, "c3d4", newSource)` → server applies to exactly that cell.

The MCP notebook tools call `NotebookDocManager` **directly** on the server — no
renderer round-trip (this is the key improvement over ClaudeMaster's
`askRenderer` path, which is where the "active pane / temp version" bugs lived).

### 4.5 Visibility (you always see Claude's target)

- Highlight / "Claude ✎" badge on the cell Claude is currently editing (server
  announces the active target).
- Stream the edit into that cell live.
- The `editCell(…, "c3d4", …)` tool call is visible in the transcript.

### 4.6 Execution & outputs — **server-side (decided)**

Kernels are Jupyter's; **execution runs on the Node server**. The server holds the
kernel client (Node `ws` → proxied Jupyter — the ClaudeMaster `KernelClient` moves
server-side, essentially unchanged), runs cells (from `runCell`/`runAll`, invoked
by the UI *or by Claude*), maps kernel messages (stream / execute_result /
display_data / error / execute_reply, `execution_count`, `clear_output`,
`update_display_data`) into the authoritative doc's cell outputs, and broadcasts
`notebook:update`.

Consequences (all wanted):
- **Claude can run cells with no browser tab open** — Claude-triggered execution is
  independent of a live viewer.
- Execution **survives refresh/close**; outputs are never orphaned on a closed tab.
- Every connected tab/device sees the **same live outputs**.
- It's the natural home for the **option-2 upgrade** (write outputs into the shared
  `Y.Doc` instead).

Correctness surface: outputs must land on the right cell even if cells are
edited/reordered mid-run — track by **cell id**, not index (see §11).

### 4.7 Upgrade to option 2 (Yjs), when/if wanted

Replace the authoritative doc model with a shared `Y.Doc` using **`@jupyter/ydoc`**
(`YNotebook`, TypeScript — runs in both browser and Node). Add a **`y-websocket`**
sync server in the Node backend; both the browser and the server (where Claude
writes) become Yjs clients. Server-side execution (4.6) writes outputs into the
shared doc. The MCP tools, cell-id addressing, and UI-as-view are unchanged;
locks become advisory presence. Jupyter stays kernels-only. No move to a Python
guest extension.

---

## 5. Transport / API design (replaces Electron IPC)

Two channels over the same origin:

- **HTTP (request/response)** — `fs:*`, `git:*`, `perms:*` (read/write), `remotes:*`
  CRUD + test, `session:create/list/destroy`, `conversations:list`, directory
  picker, `jupyter:install`, `notebook:open/read` + ops (ops may also go over WS).
- **WebSocket (streaming, multiplexed by topic/session)** —
  - `session:event` (stream-json → transcript), `session:permission`,
    `session:state`, `session:ready`, `session:exit`
  - `pane:output` / `pane:input` (pty)
  - `notebook:update` / `notebook:op` / `notebook:lock`
  - `appcontrol:request` (the remaining non-notebook app-control ops)
- **Proxy** — `/jupyter/*` reverse-proxies HTTP **and** WebSocket-upgrade to the
  local Jupyter server (so the browser uses the app origin; avoids CORS and
  hides the Jupyter token). `KernelClient.baseUrl` becomes `<origin>/jupyter`.

Preserve the existing typed contract: `src/shared/types.ts` becomes the shared
API schema for both server and SPA (same package/monorepo).

---

## 6. Component reuse map

**Ports ~verbatim to the Node server** (logic is already transport-agnostic Node):
`claudeEngine.ts`, `sessionManager.ts`, `mcpServer.ts` (notebook tools rewired to
`NotebookDocManager`), `gitManager.ts`, `permissions.ts`, `agents.ts`,
`conversations.ts`, `ssh.ts`, `remotes.ts`, `remoteFs.ts`, `sshConfig.ts`,
`remotePath.ts`, `jupyterManager.ts`, `paneManager.ts`, `ptySessionManager.ts`,
`sessionPersistence.ts`, `appSettings.ts`, `models.ts`, `docsIndex.ts`.

**New on the server:** HTTP+WS API layer (replaces `main/index.ts` IPC hub +
`preload/index.ts`), **`NotebookDocManager`**, **`JupyterProxy`**, loopback bind +
optional local token.

**Ports ~as-is to the SPA:** the React components/stores, transcript rendering,
CodeMirror/xterm, nbformat parsing (`ipynb.ts`), markdown, `toolFormat`,
`KernelClient` (repoint `baseUrl`).

**Changes in the SPA:**
- New `api` client module: `window.api.*` → HTTP calls + WS subscriptions.
- `store/notebooks.tsx`: no longer *owns* the document — subscribes to
  `notebook:update`, sends ops, implements per-cell reconcile + lock UI. (Biggest
  renderer change.)
- `AppControlBridge.tsx`: shrinks — notebook edits no longer round-trip to the UI.
  Keep active-pane reporting for non-notebook app-control tools.
- Native shims → web equivalents: native dir dialog → server-driven directory
  browser (reuse the `RemoteDirPicker` pattern for local too); `shell.trashItem`
  → server fs trash; `badgeCount`/`flashFrame` → tab title flash + favicon badge +
  `Notification` API; `openExternal` → `window.open`; drag-in OS paths → path
  input / upload.

---

## 7. Jupyter integration

- **v1:** kernels only. `JupyterManager` spawns `python3 -m jupyter server` locally;
  `JupyterProxy` exposes it
  at `<origin>/jupyter`. Kernelspec dropdown, `python-autovenv` preference, custom
  kernel cwd, install-jupyter button — all ported.
- **Later, opt-in (Jupyter-gained features):** adopt the **Contents API** as an
  alternative file layer; **server terminals** (terminado) as an alternative to
  node-pty; multi-kernel; (and, only with the option-2 upgrade) real-time
  collaboration via `jupyter-collaboration`.

---

## 8. Feature parity checklist (from ClaudeMaster inventory)

- [x] Multi-session sidebar (tree, status dots, attention lights, badges), New Session (name / role / model / sandbox)
- [x] Native chat (stream-json transcript, token streaming, thinking blocks, tool cards, markdown), MetaBar (model, context meter, cost, rate-limit chips, plan-quota meter)
- [x] Slash-command menu, `/resume` picker, `/clear`, `/rewind` (chat + git-shadow code restore)
- [x] Permission cards (allow-once / allow-always / deny), AskUserQuestion card, interrupt, retry/relaunch, exited banner
- [x] Desktop notifications + chime + attention badge (web equivalents)
- [x] Session persistence/restore (incl. `--resume` by claude session id)
- [x] Terminal/pty shell panes (stacked, resizable), confined to the owning session's box
- [x] **Notebook editor** (server-owned doc, cell locks, per-cell reconcile, undo/redo, kernel picker, heading collapse, cross-cell find — §4)
- [x] File browser (list/sort/filter, new/rename/copy/paste/trash, upload, previews: text/image/pdf/csv/binary, edit+save, virtual tabs)
- [x] Inline diff review of Claude's edits, per-hunk accept/reject, inside the file's own editor
- [x] Git panel (changes/stage/commit, diff, log, branches)
- [x] Permissions Control Center (effective rules, rules CRUD, settings-file visibility)
- [x] Agent roles (5 built-ins → launch flags), subsessions + `report_to_parent` — shipped as **teams**: star topology, idle-gated mailbox, operator-gated `employ_teammate`/`dismiss_teammate`, dismissal as an exit interview whose report becomes a role handover note, sandbox inheritance
- [x] MCP app-control tools (`mcp__app__*`): notebook read/edit/insert/delete/move/type/create/run/run_all/status/interrupt, active-pane steering, `open_file`, plus the team tools
- [x] **Connectors** — external MCP servers as operator-granted, per-session reach (CONNECTORS.md); not in the ClaudeMaster inventory, new to Claudette
- [x] **Session sandboxing** — bubblewrap confinement per session, incl. kernels and terminal panes, with GPU passthrough (SANDBOX.md); new to Claudette
- ~~Docs/wiki (rich DocView, `[[wikilinks]]`, create-on-click)~~ — **CUT** 2026-08-21. The wikilink parser in `Markdown.tsx` was dead code: `onWikiLink` had no call site anywhere, so the plugin never loaded and the feature never ran in production. Its own comment described the integration as "DocView passes `onWikiLink`" — and no DocView was ever built, in any file. Parser and prop deleted with the cut. Milkdown editing stays; it is the markdown file editor, not a wiki.
- [ ] Phone-native layout — the PWA shell, transport, auth and reconnect are all shipped; the UI is still desktop-only. **Committed work.**
- ~~Remotes/SSH~~ — **CUT** (superseded by Tailscale-to-one-box).

---

## 9. Phased roadmap

**Phase 0 — skeleton.** Monorepo (shared `types`), Node app server (HTTP + WS,
loopback bind), Vite SPA shell, `api` client module. One end-to-end ping.

**Phase 1 — MVP core loop.** ✅ **Confirmed scope.** Port
`ClaudeEngine`/`SessionManager` → chat over WS (transcript, streaming, permissions,
interrupt); one pty pane; `NotebookDocManager` + notebook UI with **one Jupyter
kernel, server-side execution**, server-owned doc, explicit id addressing, cell
locks, and Claude able to **edit *and* run** cells. *This is the first genuinely
usable Claudette and proves the rock-solid Claude↔notebook link.* **File browser,
git, and permissions stay in Phase 2** (open notebooks/files via terminal or a
minimal path input in the MVP).

**Phase 2 — workspace parity.** File browser + previews, git panel, permissions
center, docs/wiki, session persistence/restore, notifications (web), slash/resume.

**Phase 3 — orchestration.** Agent roles + teams **done** (see the checklist above;
`mcp/teamTools.ts`, `mcp/teamMailbox.ts`, `mcp/teamNotes.ts`, and the team section of
SANDBOX.md). Remotes/SSH is **cut**, not pending. Still open: optional TUI frontend.

**Phase 4 — Jupyter-gained extras (opt-in).** Contents API / server terminals /
multi-kernel; and, if wanted, the **option-2 upgrade** (Yjs co-editing).

---

## 10. Remaining decisions

- **A. Kernel execution home** — ✅ **RESOLVED: server-side** (§4.6). Claude
  executes cells, so execution must be tab-independent.
- **B. Local token** — *default: bind `127.0.0.1` only, no token.* Add a
  loopback-only token if you ever expose via a tunnel to shared machines.
- **C. Server framework** — *default: Fastify (or Express) + `ws`.* TS throughout.
- **D. Monorepo tooling** — *default: single repo, `server/` + `web/` + `shared/`,
  npm workspaces, Vite for web.*
- **E. TUI frontend** — *default: defer to Phase 3* (the native stream-json chat is
  primary; the pty-based TUI is a nice-to-have).
- **F. ipywidgets** — not supported by any custom-UI path without building the
  comm + widget-manager machinery; out of scope unless you later embed JupyterLab.

---

## 11. Key risks

- **stream-json wire contract drift** — pinned against CLI 2.1.198
  (see ClaudeMaster `PROTOCOL-stream-json.md`); re-verify on CLI upgrades, guard on
  `claude_code_version`.
- **Notebook execution ↔ document consistency** — outputs must land on the right
  cell across edits/reorders (cell-id bookkeeping); the main correctness surface.
- **Jupyter proxy WS upgrade** — must forward the `channels` WebSocket + token
  correctly; kernelClient heartbeat/reconnect already handles half-open sockets.
- **Web replacements for native affordances** — dir picker, trash, drag-in,
  badges/notifications — each needs a deliberate web design (§6).
```
