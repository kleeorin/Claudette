# Claudette

A web-based harness and shell for [Claude Code](https://claude.ai/code), with a
first-class notebook editor in which **Claude acts as an extension of the
notebook**. Successor to the Electron app *ClaudeMaster*, browser-delivered, with
a rock-solid Claude↔notebook link built on a Jupyter kernel server.

- **Architecture & decisions:** [`PLAN.md`](./PLAN.md)
- **Build checklist:** [`TASKS.md`](./TASKS.md)

## Layout

```
shared/   @claudette/shared — shared TS types (the API contract)
server/   @claudette/server — Node app server (Claude engine, notebook doc, MCP, Jupyter proxy)
web/      @claudette/web    — Vite + React SPA (the UI)
```

## Develop

```bash
./launch.sh        # installs if needed, then starts both servers
# or: npm run dev
```

Server runs on `127.0.0.1:4319`, web on `127.0.0.1:5273` (proxies `/api` + `/ws`
to the server). Open http://127.0.0.1:5273 — the page shows the server health + a
WS ping, confirming the end-to-end wiring. Override with
`PORT=… WEB_PORT=… ./launch.sh`.

## Prerequisites (grow as phases land)

- Node.js 20 LTS+
- `@anthropic-ai/claude-code` on `PATH` (Phase 1)
- `python3 -m jupyter server` + `ipykernel` (Phase 1 notebooks)
