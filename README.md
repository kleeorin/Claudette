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

**4. bubblewrap** *(optional — for sandboxing sessions)* — lets a session confine
Claude (and its notebook kernels) to a chosen set of folders. Without it, sessions
run unconfined and the UI labels them "sandbox unavailable". Install + enable it once
per machine — see [Sandboxing sessions](#sandboxing-sessions-bubblewrap) below.

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

By default the server binds loopback (`127.0.0.1`) — from the **same machine**, the
firewall is irrelevant and any port works. An access token is required **even there**:
without `CLAUDETTE_TOKEN` set, the server auto-generates one and persists it at
`~/.config/claudette/token`, and `launch.sh` prints a ready-to-open `?token=` URL.
(Loopback is not a trust boundary here — sandboxed sessions share the host network,
see `SANDBOX.md`. Opt out consciously with `CLAUDETTE_NO_AUTH=1`.) To reach it from
**another device** you bind a non-loopback address, and the server then **requires
`CLAUDETTE_TOKEN` explicitly** (it refuses to start without one — fail-closed by
design, because Claudette runs shell commands and drives Claude, unlike a plain file
server).

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

> **Dev mode over a VPN by hostname — allowlist it (and pass a token).** Vite (dev
> only) rejects requests whose `Host` header isn't the bind address, so opening the
> dev server at `http://box.internal:8080` over a VPN gives *"Blocked request. This
> host is not allowed."* Allowlist the host with `WEB_ALLOWED_HOSTS`, choose the port
> you open with `WEB_PORT`, and — since `HOST=0.0.0.0` is non-loopback — set
> `CLAUDETTE_TOKEN` (the server refuses to start without one):
> ```bash
> CLAUDETTE_TOKEN=<your-secret> \
>   HOST=0.0.0.0 \
>   WEB_ALLOWED_HOSTS=box.internal \
>   WEB_PORT=8080 \
>   ./launch.sh
> # then open, once:  http://box.internal:8080/?token=<your-secret>
> ```
> `WEB_ALLOWED_HOSTS` takes a comma-separated list; `all` (or `*`) disables the check.
> Only `WEB_PORT` needs to be reachable — Vite proxies the API to the backend over
> loopback. **Build mode has no Vite**, so it needs none of this — another reason to
> prefer `--build` for remote access.

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

## Sandboxing sessions (bubblewrap)

A session can **confine Claude — and its notebook kernels — to a chosen set of
folders** using [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`), an
unprivileged Linux sandbox. It's a *filesystem* firewall: Claude can read/write only
the mounts you grant and can't see anything else; the network stays open. Full design
in [`SANDBOX.md`](./SANDBOX.md).

**1. Install bubblewrap:**

```bash
sudo apt install -y bubblewrap     # Debian/Ubuntu
sudo dnf install -y bubblewrap     # Fedora
sudo pacman -S bubblewrap          # Arch
```

**2. Turn it on (one-time, per machine):**

```bash
./scripts/enable-sandbox.sh            # detect + apply the minimal fix (idempotent)
./scripts/enable-sandbox.sh --check    # probe only; exit 0 = sandbox works
```

Bubblewrap runs **fully unprivileged at runtime** — but modern distros (Ubuntu 23.10+)
ship with unprivileged *user namespaces* locked down, and bwrap needs them. Re-enabling
that is a **one-time privileged action** (`enable-sandbox.sh` uses `sudo` for it, then
never again): on Ubuntu it installs a bwrap-only AppArmor profile granting `userns`;
on older distros it flips the `sysctl` knob. Same class of one-time setup as Docker's
daemon/group. After that, every session is confined with no further root.

**Without it, Claudette still runs** — sessions launch unconfined and are labeled
"sandbox unavailable"; it never shows a false green light. Manage a session's
confinement from the **Sandbox** panel (or the chip in its meta bar): toggle it, add
folders, set each read-only or read-write.
