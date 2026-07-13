# Claudette — Phase 0 / Phase 1 build checklist

Ordered, actionable tasks. Source references point at the ClaudeMaster module to
port from (`CM:` = `/home/kleeorin/Work/Projects/ClaudeMaster/src/...`). See
`PLAN.md` for the why.

---

## Phase 0 — skeleton  ✅ (scaffolded)

- [x] **P0.1** Monorepo: npm workspaces `shared/` + `server/` + `web/`, shared
      `tsconfig.base.json`, root `dev`/`typecheck` scripts.
- [x] **P0.2** `shared/` types package: ported `CM:shared/types.ts` +
      `remotePath.ts`, plus Claudette additions (`notebook.ts` doc model + ops +
      locks, `ws.ts` message envelope).
- [x] **P0.3** Server: Fastify HTTP + `ws` WebSocket (noServer, path-routed),
      `GET /api/health`, `/ws` ping/pong, loopback bind (`127.0.0.1`).
- [x] **P0.4** Web: Vite + React shell, `api/client.ts` (`getHealth` + `connectWs`),
      health + ws-ping status on screen.
- [x] **P0.5** Dev proxy: Vite proxies `/api` + `/ws` → server (same origin).
- [x] **P0.6** Typed WS envelope end-to-end (extend `WsClientMessage`/
      `WsServerMessage` unions as topics land in Phase 1).

## Phase 1 — MVP core loop

Goal: web chat + one terminal + rock-solid notebook (server-side execution,
Claude edits *and* runs cells, cell locks). File browser / git / permissions are
**Phase 2**.

### Server

- [x] **P1.1** Port `ClaudeEngine` (`CM:main/claudeEngine.ts`) — spawn `claude -p`
      stream-json, framing, permission control protocol, interrupt, notebook-funnel
      guard. Transport-agnostic; reuse ~verbatim.
- [x] **P1.2** Port `SessionManager` (`CM:main/sessionManager.ts`) —
      create/launch/relaunch/destroy, resume, roles/model/permission-mode, fast-fail.
- [x] **P1.3** Session API: HTTP `session:create/list/destroy`; WS topics
      `session:event / permission / state / ready / exit`. Replaces Electron IPC hub
      (`CM:main/index.ts` + `preload/index.ts`).
- [x] **P1.4** Permission flow over WS: `can_use_tool` → permission card → response;
      allow-once / allow-always (suggestions) / deny; AskUserQuestion.
- [x] **P1.5** Port AppControl MCP server (`CM:main/mcpServer.ts`) — per-session URL
      token; register tools; **notebook tools call `NotebookDocManager` directly**
      (not a UI round-trip — this is the key fix).
- [x] **P1.6** Port `JupyterManager` (`CM:main/jupyterManager.ts`) spawn + venv
      discovery; add **`JupyterProxy`**: reverse-proxy `/jupyter/*` (HTTP + WS
      upgrade) → local Jupyter, hiding its token.
- [x] **P1.7** **`NotebookDocManager`** (NEW): authoritative doc model (nbformat
      4.5, stable cell ids), ops (`edit/add/insert/delete/move/setType/create/read`),
      atomic write-through persist (temp+rename), file-watch + conflict
      (reload / keep-mine), broadcast `notebook:update` deltas.
- [x] **P1.8** Cell locks: `claimCell`/`releaseCell` (focus+dirty), manual pins,
      idle auto-release; **hard-deny** Claude edits to held cells + transcript note.
- [x] **P1.9** **Server-side kernel client** (port `CM:renderer/lib/kernelClient.ts`
      to Node `ws` → proxied Jupyter): `runCell`/`runAll`, map kernel msgs
      (stream / result / display / error / reply, `execution_count`, `clear_output`,
      `update_display_data`) into doc outputs, **route outputs by cell id**,
      heartbeat/reconnect.
- [x] **P1.10** Port `PtyManager` (`CM:main/paneManager.ts` + node-pty) — one shell
      pane; WS `pane:output` / `pane:input`. (Native build on the server; no
      Electron rebuild.)

### Web (SPA)

- [x] **P1.11** Port chat store + `ChatView` (`CM:renderer/store/chat.tsx`,
      `components/ChatView.tsx`) — stream-json → transcript reducer, token streaming,
      thinking blocks, tool cards (`lib/toolFormat.tsx`), markdown. Wire to WS.
- [x] **P1.12** Port MetaBar — model, context-window meter, cost, rate-limit chips.
- [x] **P1.13** Permission cards + AskUserQuestion card + interrupt (Esc).
- [x] **P1.14** Slash-command menu + `/clear` (`/resume` if cheap; else Phase 2).
- [x] **P1.15** **Notebook UI as a VIEW** over the server doc (port
      `CM:renderer/components/NotebookView.tsx` + `notebook/Cell.tsx` +
      `notebook/Output.tsx`, refactor `store/notebooks.tsx`): render cells, CodeMirror
      editors, outputs; subscribe `notebook:update`; send ops; **per-cell reconcile**
      (never clobber the cell you're typing in); run / run-all / restart.
- [x] **P1.16** Cell-lock UI: claim on focus/dirty, pin toggle (🔒), "Claude ✎"
      target highlight, locked badge.
- [x] **P1.17** One terminal pane (xterm, port `CM:renderer/hooks/useTerminal.ts`)
      wired to the pty WS.
- [x] **P1.18** Minimal notebook open via path input (full file browser = Phase 2).

### Cross-cutting

- [x] **P1.19** Session persistence (`CM:main/sessionPersistence.ts`) — save/restore
      to a `sessions.json` under a Claudette data dir (optional for MVP).
- [ ] **P1.20** **Verify end-to-end** (see the `verify` skill): a chat turn with a
      permission prompt; you edit+run a cell; Claude edits+runs a different cell; a
      lock on your active cell is enforced; outputs land on the right cell after a
      reorder.

---

## Deferred (later phases, tracked in PLAN §9)

- **Phase 2** — file browser + previews, git panel, permissions center, docs/wiki,
  notifications (web), production build/bundling + `start` scripts.
- **Phase 3** — agent roles, subsessions + `report_to_parent`, full MCP surface,
  SSH remotes (sessions/fs/git/jupyter + MCP reverse tunnel), optional TUI frontend.
- **Phase 4** — Jupyter Contents API / server terminals / multi-kernel; optional
  **option-2 upgrade** (Yjs co-editing via `@jupyter/ydoc` + `y-websocket`).
