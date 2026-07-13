# Notebook core (step 1: P1.5–P1.9) — execution plan
_Drafted 2026-07-09. Scope: the server-side notebook engine. UI (P1.15–P1.16) is step 2._

## STATUS: ✅ server core (step 1) + ✅ UI (step 2) DONE + VERIFIED
Step 1 (P1.5–P1.9) and step 2 (P1.15/P1.16/P1.18, the UI) are built, typecheck clean,
and pass headless E2E. Server suites in `scratchpad/`: `notebook-doc-test.mts`
(doc+locks, 21), `kernel-e2e-test.mts` (live kernel + reorder routing),
`jupyter-proxy-test.mts`, `mcp-e2e-test.mts` (MCP JSON-RPC, 12). UI suite:
`notebook-ui-e2e.mjs` (headless Chrome via CDP — open notebook, type `print(6*7)`,
run, read `42`, 0 page errors). **Next: P1.20 combined human+Claude verify, then
P1.10/P1.17 terminal pane.** See `HANDOVER.md` §Next for deferred simplifications.
One race fixed in step 1: Jupyter logs "running at" before tornado accepts →
`JupyterManager` polls `/api/status` before resolving `start()`.

### Step 2 (UI) — how it maps
`web/store/notebooks.tsx` is a thin VIEW over the server doc (opposite of CM, which
OWNED it): state from `notebook:update`/`locks`/`kernel`; every mutation an intent via
`notebook:op`/claim/release/HTTP. `NotebookView` + `notebook/{Cell,Output}` ported from
CM, re-addressed to cellId + adapted to nbformat-native outputs. **Async-doc hazard
handled:** cell edits debounce 500ms→`editCell`; the CodeMirror reconcile is
focus-guarded so a late echo never clobbers active typing (`Cell.tsx`).

## The one architectural fact that shapes everything
In **ClaudeMaster** the notebook document lives in the **renderer** (`renderer/store/notebooks.tsx`,
730 lines), is addressed by **0-based index**, and MCP notebook tools mutate it by a
round-trip to the UI (`main/index.ts notebookEdit → askRenderer('notebookEdit') →
AppControlBridge → applyAppEdit`). There is **no server-owned doc** in CM.

Claudette's `shared/notebook.ts` already commits to the inverse (PLAN §4):
**server owns one authoritative doc**, addressed by **stable `cellId`**, and **MCP tools call
`NotebookDocManager` directly** (no UI round-trip — this is the "key fix" that kills CM's
wrong-notebook / temp-version bugs).

So step 1 is **~40% verbatim port, ~60% inversion**:
- Verbatim/near: `mcpServer.ts` (pure Node, 0 Electron) and `jupyterManager.ts` (local branch).
- Ported-but-re-addressed: the nbformat codec `ipynb.ts` and the ops logic in `applyAppEdit`
  (index→cellId).
- Inverted: `kernelClient.ts` moves browser→server (`WebSocket`→node `ws`, `fetch`→node global
  `fetch`) and **routes outputs into the server doc by cellId** instead of into a React reducer.

## Build order (dependency-first — NOT the P-number order)
```
P1.7 codec + NotebookDocManager   ← foundation, everything hangs off it
 └ P1.8 cell locks                 ← extends DocManager
 └ P1.6 JupyterManager + Proxy     ← independent; local-only (drop SSH like SessionManager did)
     └ P1.9 server-side kernelClient ← needs Jupyter (run) + DocManager (output routing)
         └ P1.5 MCP server + tools   ← needs DocManager (edit) + kernelClient (run_cell)
             └ Verify E2E (P1.20 subset)
```

## P1.7 — `server/src/notebook/` : codec + NotebookDocManager  *(new code, foundation)*
- `ipynb.ts`: port `CM:renderer/lib/ipynb.ts` (parse/serialize nbformat v4, 1-space indent,
  line-array source split). **Change vs CM:** emit and read **`cell.id`** (nbformat 4.5 supports
  it; CM dropped ids as memory-only). Mint a uuid when disk cell has none. This is what makes
  cellId addressing stable across reload. Map to shared `NbCell` (`id/cellType/source/outputs/
  executionCount`), not CM's `Cell` (which had `running`/`metadata`).
- `NotebookDocManager.ts`: holds `Map<notebookId, NotebookDoc>`.
  - `open(path) → NotebookDoc` (read, parse, assign `notebookId`, register file-watch).
  - `applyOp(op: NotebookOp, origin: 'human'|'claude') → NotebookOpResult` — the ops union from
    `shared/notebook.ts`, **cellId-addressed**. Logic ported from `applyAppEdit`. Bumps
    `version`, sets `dirty`. `runCell`/`runAll` are in the union but **delegate to the kernel
    client** (P1.9), not doc mutation.
  - Atomic persist: temp-file + rename (CM writes via `fs.writeFile`; we harden with rename).
  - File-watch + conflict: node `fs.watch`, **baseline echo-filtering** (compare against
    last-written text, as CM's `baseline` field did) → `conflict` state (reload / keep-mine).
  - Broadcast `notebook:update` through the WS hub after every applied op / external reload.
- **Deps:** none new (node `fs`, `crypto.randomUUID`).

## P1.8 — cell locks *(extends DocManager)*
- Add `Map<notebookId, Map<cellId, CellLock>>` (`LockReason = focus|dirty|pin` from shared).
- `claimCell`/`releaseCell`, manual pin, **idle auto-release** timer.
- `applyOp` gate: `origin==='claude'` + target cell held by human → `{ok:false, code:'locked'}`
  (hard-deny) + transcript-note text back through the MCP result. Human ops always win.
- Broadcast lock changes (`notebook:locks`).

## P1.6 — `server/src/jupyter/` : JupyterManager + JupyterProxy
- `jupyterManager.ts`: port `CM:main/jupyterManager.ts` **local branch only** — **drop the
  remote/SSH spawn + `_spawnRemote` + SSH `findNearestPython` round-trip** (Phase 3, mirrors how
  SessionManager was trimmed). Keep: local `_spawnLocal` (`python3 -m jupyter server --port=0
  --ServerApp.token=… --allow_origin=* --root_dir=/`), stderr banner URL parse, `install()`
  pip-install, venv discovery walking up for `.venv/bin/python3`.
- **`JupyterProxy` (new):** reverse-proxy `/jupyter/*` HTTP **and WS upgrade** → local Jupyter,
  **injecting the token server-side** so the browser/phone never sees it, and keeping everything
  single-origin (matters for the PWA/Tailscale setup already built). Use `@fastify/http-proxy`
  for HTTP + a manual `server.on('upgrade')` branch for kernel WS, or hand-roll with node `http`
  + `ws`. **Dep to add:** `@fastify/http-proxy` (or hand-roll to avoid it).

## P1.9 — `server/src/jupyter/kernelClient.ts` *(inversion: browser→server)*
- Port `CM:renderer/lib/kernelClient.ts`, swapping **browser `WebSocket` → node `ws`** and
  **browser `fetch` → node global `fetch`** (Node 20). Keep the Jupyter 5.3 wire envelope,
  heartbeat (control-channel `kernel_info_request`, 25s/8s), exp-backoff reconnect.
- `runCell(cellId)` / `runAll()`: execute code, map kernel msgs (`stream/execute_result/
  display_data/error/execute_reply`, `execution_count`, `clear_output`) → `NbOutput`, and
  **route into the doc by cellId** — call `NotebookDocManager` to append outputs + set
  `executionCount` + broadcast. (CM routed into a reducer via `onOutput/onDone` callbacks; here
  the sink is the doc.) Kernel↔notebook binding via `NotebookDoc.kernelId`.

## P1.5 — `server/src/mcp/` : AppControl MCP server + notebook tools
- `appControlServer.ts`: port `CM:main/mcpServer.ts` **verbatim** (pure Node JSON-RPC-over-HTTP,
  per-session URL token, loopback). Verified against CLI 2.1.198; ours is 2.1.205.
- `tools.ts`: register the notebook tools from `CM:main/index.ts` — `edit_cell/add_cell/
  insert_cell/delete_cell/move_cell/set_cell_type/create_notebook`, and `read_active_pane/
  open_file/open_pane/edit_active_file`. **Handlers call `NotebookDocManager` / `kernelClient`
  directly** (not `askRenderer`).
  - **Decision — addressing Claude sees:** keep CM's **index-based** tool schema (`index`,
    `from`/`to`) — Claude reads the notebook and reasons in positions; the handler resolves
    index→cellId against the current doc. Internal ops/UI stay cellId. (Alternative: expose
    cellId to Claude — rejected: more prompt churn, worse ergonomics for the model.)
  - **Decision — no "active pane" yet (UI is step 2):** CM's `resolveNotebook` steers to the
    user's active pane. For step 1, notebook tools **require an explicit `path`**; DocManager
    `open()`s it on first touch. The active-pane steering + wrong-notebook guard rails come back
    with the UI (P1.15). Flag this as a deliberate simplification, not a port miss.
  - Session-control tools (`spawn_subsession` etc.) are **Phase 3** (agent roles) — skip.
- Wire `configFor(sessionId)` into `SessionManager.launch()` as `--mcp-config` (the stub
  `agents.ts` already keeps `launch()` shape stable). Start the MCP server in `index.ts`.

## Wire-contract additions — `shared/ws.ts`
- server→client: `notebook:update` (doc or delta), `notebook:locks`.
- client→server (consumed by UI in step 2, but land the types now): `notebook:op` (a
  `NotebookOp`), `notebook:claim`, `notebook:release`.

## Verify (P1.20 subset — headless server E2E, `scratchpad/notebook-test.mjs`)
1. `open()` a temp `.ipynb` → `applyOp(editCell)` → `version` bumps + `notebook:update` fires.
2. `JupyterManager.start()` → kernelClient `runCell(print(2+2))` → output lands on the **right
   cellId** in the doc.
3. **Reorder cells, then run** → outputs still route to the correct cell (the CM bug this design
   fixes — proves cellId routing).
4. Human `claimCell(x)` → a `claude`-origin `editCell(x)` is **hard-denied** (`code:'locked'`).
5. (with a session) MCP `tools/call edit_cell` mutates the doc directly, no UI.

## Deps to add
`@fastify/http-proxy` (JupyterProxy — or hand-roll). Everything else uses node builtins + the
already-present `ws`. Node 20 global `fetch` covers the Jupyter REST calls.

## Cross-refs
`PLAN.md` §4 (notebook architecture) · `TASKS.md` P1.5–P1.9 · `HANDOVER.md` · port sources under
`../ClaudeMaster/src/` (`main/mcpServer.ts`, `main/jupyterManager.ts`, `renderer/lib/{ipynb,
kernelClient}.ts`, `renderer/store/notebooks.tsx applyAppEdit`, `main/index.ts` tool defs).
