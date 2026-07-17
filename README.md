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

### Exposing it beyond localhost (phone / another device / VPN)

By default the server binds loopback (`127.0.0.1`) and needs no token — from the
**same machine**, the firewall is irrelevant and any port works. To reach it from
**another device** you bind a non-loopback address, and the server then **requires
an access token** (it refuses to start without one — fail-closed by design, because
Claudette runs shell commands and drives Claude, unlike a plain file server).

**Always use `--build` for remote access** — it serves the UI and the API from a
*single* origin, so there's only **one** port to reach. (Plain `./launch.sh` is dev
mode with *two* ports; see [Dev vs build](#dev-vs-build-mode) below.)

#### The access token

You **make the token up** — it's a shared secret you invent, used in two places that
must match: the `CLAUDETTE_TOKEN=` you launch with, and the `?token=` in the URL you
open. Generate a strong one:

```bash
openssl rand -hex 24        # copy the output; use it as your token
```

You put it in the URL **once per device** — the first `?token=…` visit sets an
httpOnly cookie, and that device stays logged in afterward. **Reuse the same token**
across restarts so you don't have to re-authenticate; only change it if it leaks.

#### Reachable over a VPN / a known-open port (the common case)

If your VPN reaches the machine's IP and a port (say `8916`) is open there, this is
all you need — the direct analogue of `python -m http.server 8916`, plus auth:

```bash
CLAUDETTE_TOKEN=<your-secret> HOST=0.0.0.0 PORT=8916 ./launch.sh --build
# then open, once:  http://<machine-ip>:8916/?token=<your-secret>
```

- `HOST=0.0.0.0` — listen on all interfaces (incl. the VPN one), not just loopback.
- `PORT=8916` — any open port **≥ 1024** (ports below 1024 need root to bind).
- No firewall changes needed if the port is already reachable over the VPN.

#### Locked-down firewall (no inbound ports) → Tailscale

If you **can't open any inbound port**, use `./rc_launch.sh` — it fronts the app with
`tailscale serve` over HTTPS (real cert) on your private tailnet. Tailscale traverses
NAT/firewalls with no inbound port open, and persists a token to `.claudette-token`
so your phone PWA stays logged in. Needs Tailscale installed + `tailscale up`.

## Run

```bash
./launch.sh          # dev (hot-reload): server :4319, web :5273
./launch.sh --build  # production: build the web bundle, serve it from the server on :4319
# or: npm run dev
```

Override ports with `PORT=… WEB_PORT=… ./launch.sh`.

### Dev vs build mode

The two modes differ in how the UI is served — which is also why dev has *two* ports
and build has *one*:

| Mode | Command | Ports | You open | Use it for |
|---|---|---|---|---|
| **Dev** | `./launch.sh` | server `:4319` + Vite `:5273` | **5273** | editing Claudette's code (hot-reload) |
| **Build** | `./launch.sh --build` | server `:4319` only | **4319** | just *using* Claudette; remote access |

- **Dev mode** runs a separate **Vite** dev server (`:5273`) that serves the React UI
  with hot-module-reload and **proxies** `/api` + `/ws` to the Node server (`:4319`).
  The extra port exists purely for live-reloading while developing. Open **5273**.
- **Build mode** compiles the UI to static files (`web/dist/`) and the Node server
  serves **both the UI and the API from one origin** (`:4319`). No Vite, no proxy,
  one port. This is the way to run it for real, and what remote access should use.
