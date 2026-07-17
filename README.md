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

## Install on a new machine

Claudette is a Node monorepo — no global install, you run it from a clone. Three
prerequisites, then one command.

**1. Node.js 20 LTS or newer** — the only hard requirement (`launch.sh` refuses to
start without it). Check with `node -v`; install from [nodejs.org](https://nodejs.org)
or via `nvm install 20`.

**2. The `claude` CLI** — needed for chat sessions (without it the app still boots,
but sessions won't start):

```bash
npm install -g @anthropic-ai/claude-code
```

**3. Python + Jupyter** — needed to run notebook cells (without it notebooks open
but can't execute):

```bash
pip install jupyter-server ipykernel      # or: python3 -m pip install …
```

**Then clone and launch:**

```bash
git clone <repo-url> claudette && cd claudette
./launch.sh                                # installs npm deps if needed, starts both servers
```

Open the web URL it prints (default http://127.0.0.1:5273). That's it — `launch.sh`
runs `npm install` for you on first run and whenever the lockfile changes.

> Steps 2 and 3 are optional in the sense that the app *runs* without them —
> `launch.sh` only warns. But chat needs `claude` and notebook execution needs
> Jupyter, so install both for the full experience.

### Exposing it beyond localhost (phone / another device)

By default the server binds loopback and needs no token. To reach it from another
device you must set an access token, or the server refuses to start:

```bash
CLAUDETTE_TOKEN=$(openssl rand -hex 24) HOST=0.0.0.0 ./launch.sh --build
# front it with HTTPS, e.g. `tailscale serve --bg 4319`, then open
# https://<your-host>/?token=<that token>  once to authenticate the device.
```

## Run

```bash
./launch.sh        # dev (hot-reload): server :4319, web :5273
./launch.sh --build  # production: build the web bundle, serve it from the server on :4319
# or: npm run dev
```

Server runs on `127.0.0.1:4319`, web on `127.0.0.1:5273` (proxies `/api` + `/ws`
to the server). Open http://127.0.0.1:5273 — the page shows the server health + a
WS ping, confirming the end-to-end wiring. Override ports with
`PORT=… WEB_PORT=… ./launch.sh`.
