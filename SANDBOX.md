# Session sandboxing (bubblewrap)

Confine each Claude session so that **even with every permission granted**, it can
only affect the directories you mount. Permission prompts are advisory; this is a
kernel-enforced boundary. The goal you can rely on:

> A sandboxed session cannot **modify** anything on the host outside its mounted
> writable paths — no matter the permission mode (including `bypassPermissions`).

This is a **filesystem** firewall. Network egress is intentionally **not** confined
in v1 (see "Deferred: network egress"). The UI must say so honestly.

---

## Why bubblewrap (not Docker)

`ClaudeEngine` is transport-agnostic: it spawns `{command, args, cwd, env}`. Today
that's `claude …`; sandboxing just changes it to `bwrap …flags… claude …` at the
one spawn site (`sessionManager.launch()`). bubblewrap was chosen over Docker
because:

- **~ms startup** — matters since sessions are already heavyweight; no image, no daemon.
- **The loopback MCP channel keeps working untouched.** The app-control server is
  in-process HTTP on `127.0.0.1:<port>` (`appControlServer.ts`). We do **not**
  `--unshare-net`, so the sandbox shares the host network namespace and reaches
  that loopback (and the internet) exactly as an unsandboxed process would.
- **Surgical mounts** map 1:1 to what "define what is mounted" means.

Tradeoffs we accept: Linux-only (fine — the server runs where `claude` runs, and
that's Linux locally and on remotes); same-UID (isolates *visibility*, not
identity); no built-in resource caps.

---

## Host prerequisite (one-time, per machine)

bubblewrap needs permission to create a user namespace. Modern distros restrict
that by default (Ubuntu 23.10+ via `kernel.apparmor_restrict_unprivileged_userns=1`).
Enabling it is a one-time privileged action — the same class of host setup Docker's
daemon/group needs. It is **portable**: the same command on every machine.

```
./scripts/enable-sandbox.sh          # detect + apply the minimal fix (idempotent)
./scripts/enable-sandbox.sh --check  # probe only; exit 0 = sandbox works
```

On Ubuntu it installs a **bwrap-only** AppArmor profile (`/etc/apparmor.d/bwrap`
granting `userns,`) — only bwrap regains the capability; every other program stays
clamped. Falls back to the sysctl knob on older distros, and tells you the
universal `chmod u+s /usr/bin/bwrap` route if userns is hard-disabled by policy.

**Without it, Claudette still runs** — sessions launch unsandboxed and are labeled
"sandbox unavailable". Never silently unsandboxed-as-sandboxed (see "Honest badge").

---

## The mount model

```ts
interface SandboxMount { path: string; mode: 'rw' | 'ro' }
interface SandboxConfig { enabled: boolean; mounts: SandboxMount[] }
```

- **Strict visibility**: nothing outside is visible unless mounted (or part of the
  runtime baseline below). Writes outside a mount either **fail** (ro paths like
  `/etc`) or land in **throwaway tmpfs** that is discarded on exit — they never
  reach the host. (Verified: a write to `$HOME/x` inside the sandbox does not
  appear on the host.)
- **Two flavors**, `rw` (full) and `ro` (read-only), and **overlaps are allowed**:
  emit mounts sorted **shallowest-path-first** so a `rw` pocket nested inside a `ro`
  tree layers correctly regardless of input order (bwrap applies binds in order).
- **cwd is optional.** A new session *seeds* its own `cwd` as a `rw` mount (the
  convenient default; we do NOT use the repo root — sessions may not be a git repo),
  but you can downgrade it to `ro` or remove it entirely. The only *enforced* data
  mounts are the two `.claude` dirs below; everything else, cwd included, is yours to
  set. You add more mounts (rw or ro) as needed.
- **Obligatory data mounts = the two `.claude` dirs** (both `rw`): the global config
  dir (`~/.claude`, where creds + memory live) and the project-local `<cwd>/.claude`.
  These are always present, so Claude keeps its config and memory even when cwd is
  read-only or removed.
- **On by default** per session; toggleable. Subsessions inherit the parent's config.

### Runtime baseline (always present; not "your data" — just what makes claude run)

Validated on Ubuntu 24.04 (bwrap 0.9.0):

```
--unshare-ipc --unshare-pid --die-with-parent
--proc /proc --dev /dev --tmpfs /tmp
--ro-bind /usr /usr
--ro-bind /etc /etc
# usrmerge symlinks (recreate when the top-level is a symlink; ro-bind if a real dir):
--symlink usr/bin /bin  --symlink usr/sbin /sbin
--symlink usr/lib /lib  --symlink usr/lib64 /lib64
# DNS: /etc/resolv.conf is a symlink into /run; bind its real target so network works
--ro-bind /run/systemd/resolve /run/systemd/resolve      # if present
--ro-bind <readlink -f /etc/resolv.conf> <same>          # if present
# claude + node, resolved DYNAMICALLY (never hardcoded), read-only:
--ro-bind <which claude> <same>                          # ~/.local/bin/claude launcher
--ro-bind <dirname (readlink -f claude)> <same>          # …/versions/<v> (the ELF)
--ro-bind <node root> <same>                             # …/node/vX (from readlink -f node)
# OBLIGATORY data mounts — READ-WRITE (claude writes config + memory at runtime):
--bind <CLAUDE_CONFIG_DIR or $HOME/.claude> <same>       # global config/creds/history/memory
--bind <cwd>/.claude <same>                              # project-local .claude (if present)
# user mounts (a new session seeds cwd rw; you may set it ro or drop it), shallowest-first.
# If NOTHING binds cwd's lineage (cwd dropped AND no local .claude), ro-bind an empty
# dir onto cwd so --chdir resolves, the project stays invisible, AND writes to cwd fail
# hard (EROFS) rather than silently vanishing into a writable tmpfs (as a plain --dir):
--ro-bind <hostTmp>/.claudette-sandbox-empty <cwd>     # only when cwd is otherwise unreachable
--chdir <cwd> --setenv HOME <home>
# Relocate .claude.json INTO the mounted config dir (see below):
--setenv CLAUDE_CONFIG_DIR <configDir>
# NB: NO --unshare-net → shared network (loopback MCP + internet work)
```

### The right global `.claude`, local or remote

Never hardcode a path. Resolve from the **same environment the child runs with**:

```
configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
```

Bind it at the **identical path** in and out. This auto-follows local
(`/home/you/.claude`) vs a remote whose `$HOME` differs (e.g. `/home/.claude`).
Same trick for the `claude` binary and `node` (both live under `$HOME`, versioned).
It must be **rw** — claude writes creds/history/session state there; a ro bind
breaks startup.

**The `.claude.json` gotcha.** Claude's *main* config is a FILE at `$HOME/.claude.json`,
NOT inside the config dir — and `$HOME` is not mounted. It can't be bind-mounted as a
file either: claude saves it via write-tmp + atomic `rename()`, which fails `EBUSY`
onto a bind-mounted file. Fix: set **`CLAUDE_CONFIG_DIR=<the mounted config dir>`**, so
claude keeps `.claude.json` at `<configDir>/.claude.json` — a real file inside the
already-mounted rw dir, where atomic saves work. On first sandboxed launch we **seed**
`<configDir>/.claude.json` from the host's `~/.claude.json` (copy-if-absent) so the
session inherits the user's trust/prefs instead of a blank config + a "config not
found" warning. Consequence: sandboxed sessions share `<configDir>/.claude.json`
(consistent among themselves) which then evolves independently of the host's
`~/.claude.json`. Acceptable — the heavy state (creds, history, projects) is the
shared dir; `.claude.json` is mostly trust/onboarding/prefs.

**Known tradeoff — the sandbox is a WORKSPACE firewall, not a secrets boundary.**
`~/.claude` is always mounted **rw** (claude can't boot otherwise), and it holds *every*
project's transcripts + memory plus `.credentials.json`. So even a maximally-locked
session — cwd removed, only `.claude` left — can still **read your Claude credentials and
every project's history**. Tightening cwd to `ro`/removed shrinks what of the *current
project* is exposed; it does **nothing** to the global mount. Don't read "only .claude"
as "isolated from my secrets." Write-confinement holds (writes outside the mounts fail);
read-secrecy of `~/.claude` does not. Future tightening: a per-session `CLAUDE_CONFIG_DIR`
seeded with only credentials. Documented, deferred.

---

## Availability probe (functional, not "binary exists")

`bwrap` can be installed yet unable to create a namespace. Detection must actually
attempt a throwaway sandbox and check the exit code (whole-root ro bind so the test
binary's dynamic loader is present — a partial bind fails `execvp` with a misleading
`ENOENT`). Cache the result at startup; re-expose via the same `--check` logic.

---

## Honest badge (non-negotiable)

A session that fell back to unsandboxed must never look sandboxed. Effective state,
surfaced per session:

- `sandboxed` → **"filesystem-isolated · network open"**
- enabled but probe failed → **"sandbox unavailable — run scripts/enable-sandbox.sh"**
- disabled → no badge (or "unsandboxed")

"No benefit" is always visibly "no benefit" — the same discipline as the non-Linux
fallback.

---

## Deferred: network egress / external-leak protection

v1 keeps the network open (Level 0). When leak protection is wanted, it bolts onto
the same `wrapSandbox()` seam without touching the mounts. The real target is an
**allowlist** (claude *needs* `api.anthropic.com` + DNS + the loopback MCP; deny the
rest), because "block all network" would kill claude itself.

| Level | Mechanism | Loopback MCP | Blocks exfil | Effort |
|------|-----------|-------------|-------------|--------|
| 0 | open (v1) | ✅ | ❌ | none |
| 1 | `--unshare-net` alone | ❌ | ✅ | breaks claude (no API) |
| 2 | private netns + `pasta`/slirp4netns + allowlist proxy + forwarded MCP port | ✅ | ✅ strong | high |
| 3 | shared netns + per-UID/cgroup `nftables` allowlist | ✅ untouched | ✅ | medium ← first choice |
| 4 | `HTTP(S)_PROXY` env allowlist | ✅ | ⚠️ bypassable | low (guardrail only) |

**Recommended next step when we do it: Level 3** — dedicated UID/cgroup for the
sandboxed claude, `nftables` egress restricted to the allowlist; keeps loopback +
DNS working, no proxy stack. Pair with the per-session `CLAUDE_CONFIG_DIR` to shrink
the credential blast radius. Costs to accept: a strict allowlist breaks `git push` /
`npm install` / web fetch unless those hosts are allowed; DNS is a low-bandwidth
covert channel unless a proxy does resolution. Escalate to Level 2 only for
private-netns purity.

Honest ceiling: even perfect egress control still sends file contents to the model
provider (inherent to using an LLM). We can block **third-party** exfil, not that.

## Control-plane escape (in-box → unsandboxed session)

The filesystem box confines *files*, but the session is Claude Code with a shell, and
the network is shared (no `--unshare-net`). So a sandboxed (or prompt-injected) claude
can reach the server's **control API** on loopback and ask it to create a session with
`sandbox:{enabled:false}` (or `/` mounted rw) — a fully unconfined session. The box is
an accident-guardrail, not a boundary against a motivated in-session agent.

Three things enable it: (1) shared network → `127.0.0.1:<PORT>` is reachable from the
box; (2) `/api/session/create` accepts a **caller-defined** sandbox, including none;
(3) the box could obtain the auth token (it was in the child's env, and `.claudette-token`
sat in the mounted project dir).

**Done — env + token hygiene (closes the token-reachability leg):**
- **A. `--clearenv`** in `wrapSandbox`/`wrapCommand` + a vetted allowlist
  (`CLAUDE_ENV_ALLOW_PREFIXES`): the child no longer inherits the server's env, so
  `CLAUDETTE_TOKEN` (and unrelated host secrets) never enter the box. Claude's own
  auth/proxy/CA vars are passed through; a plain OAuth login needs none (creds live in
  the bound `~/.claude`). Bonus: the confined Jupyter/kernel box no longer inherits
  Claude's credentials either.
- **B. Token off the mounts:** `rc_launch.sh` now persists the token under
  `~/.config/claudette/` (never mounted), not the project dir, and migrates + removes a
  legacy in-project `.claudette-token`.

- **Token required even on loopback (done 2026-07-18).** A+B only bite if a token is
  actually required, and a loopback bind with no `CLAUDETTE_TOKEN` used to run the
  control API unauthenticated. `resolveAuth` now always requires a token: on loopback
  with no env token it loads (or mints, 0600) the persistent one at
  `~/.config/claudette/token` — the same file `rc_launch.sh` manages, outside every
  sandbox mount, stable so devices stay logged in. `launch.sh` mirrors the source and
  prints a ready-to-open `?token=` URL. Explicit opt-out: `CLAUDETTE_NO_AUTH=1`
  (honored on loopback only; a non-loopback bind still refuses to start without an env
  token — a silent file token shouldn't guard a deliberate exposure). Verified:
  `scratchpad/auth-loopback-test.mjs` (17/17 — 401 without token, file minted + mode
  600, cookie + Bearer + WS-upgrade gating, token stable across restart, opt-out open,
  env token beats file).

**C. Confinement can't be lowered by a request — DONE (2026-07-18).** Rather than try to
distinguish an in-box caller from the real UI (unsolved), we made the privileged move
*unavailable to everyone by default*: `normalizeSandbox` (`claude/sessionManager.ts`)
**ignores `sandbox.enabled=false`** and forces confinement on, unless the operator launched
with `CLAUDETTE_ALLOW_UNSANDBOXED=1` — a capability an in-box caller cannot grant itself.
This is the single choke point for create / setSandbox / restore, so no path yields an
unconfined session without the launch flag. (Sandbox mounts a caller supplies are still
honored, but the app-source rw overlay below and the default-on confinement bound how much
they can widen; broadening mounts is far less dangerous than `enabled:false` once the box
holds no token.) Verified in `scratchpad/sandbox-escape-fixes-test.mts`.

Note the layered result: even under `CLAUDETTE_NO_AUTH=1` (loopback open), a box that
reaches `/api/session/create` still can't get an unconfined session (C), can't make the app
source writable (self-mod fix), and any pane it makes is confined (terminal-pane fix) — the
confinement guarantees are enforced in the session/pane logic, independent of auth. What
`NO_AUTH` still exposes is the token-gated fs API (arbitrary host writes); the default
(token required even on loopback, done) closes that because a confined box holds no token.

**D. Cut the loopback reach — DEFERRED, now defense-in-depth (not a live escape).** With C
+ token-on-loopback + `--clearenv` (box has no token) + confined panes + confined kernels +
read-only app source, every primitive reachable over loopback is either credential-gated
(and the box holds no credential) or confined — so the shared network no longer *yields* an
escape. Network isolation is still the durable belt-and-braces: **Level 3 `nftables`** to
deny the box `127.0.0.1:<control-port>` while keeping DNS + Anthropic + the MCP port, or
**Level 2** private-netns forwarding only the MCP port. Not implemented here because it's
easy to break MCP+internet and hard to test without the operator; it closes enabler (1)
but no longer gates a known escape.

## Self-modification escape (rw-mounted server source + hot reload)

The sharpest escape doesn't touch the API at all: **a session can rewrite the code of
the process that sandboxes it.** The server runs *unsandboxed* (it's what spawns the
bwrap boxes), and MCP tools (`mcp/appControlServer.ts`, `mcp/notebookTools.ts`) execute
**in that server process**. In dev, the server is `tsx watch src/index.ts` — it
**hot-reloads on any source change**. So if a session's read-write mounts include the
running server's source tree (the "develop Claudette inside Claudette" case — cwd = the
repo, mounted rw), the box can:

- add a tool to `notebookTools.ts`, or rewrite `index.ts` / `sessionManager.ts` /
  `sandbox.ts` itself, so it runs `child_process.exec(<anything>)`;
- save the file → `tsx watch` reloads it → **arbitrary code in the host process**, with
  the server's full privileges (token, whole host FS, network). No auth, no network
  trick.

Two flavors of "write MCP tools", only one of which escapes:
- **MCP *config*** (`.mcp.json` in cwd, or `mcpServers` in the rw-mounted `~/.claude.json`;
  `--strict-mcp-config` is not set, so claude loads them): the new stdio server is spawned
  *by claude*, so it runs **inside** the box. Persistence/auto-run in-box, not an escape.
- **MCP *tool code* / any server source**: runs **outside** the box via the reload path
  above. Full RCE.

Scope: this bites only when a session's rw mounts contain the running server's source AND
it's in watch mode. A session sandboxed to some *other* project can't see the server
source, so the vector is closed for it. But "dev Claudette in Claudette" is exactly that
case, and is common.

**FIXED (2026-07-18) — the app's own source is read-only inside every box by default.**
`appSourceProtections` (`claude/sandbox.ts`) computes the running server's source dirs
(`<appRoot>/server`, `<appRoot>/shared`; `appRoot` found by walking up from the module to
the dir holding both, overridable with `CLAUDETTE_APP_ROOT`). When a session's mounts
would expose those dirs **writable**, `bwrapBaseArgs` folds in an **`--ro-bind` overlay**
of each — and because they're deeper paths than the rw mount that exposes them, bwrap's
shallow-first layering makes just those subtrees read-only while the rest of a rw project
(web/, docs, scratchpad, …) stays writable. So "dev Claudette in Claudette" still works for
everything except editing the server's own source, and a confined box can't rewrite the
code the host process would reload/restart. The overlay is added ONLY when a rw mount
already exposes the source, so it never reveals source to an unrelated session.
- **Opt out** (full rw source, e.g. actually developing the server in-box):
  `CLAUDETTE_ALLOW_APP_SOURCE_MOUNT=1`. Combined with **not running `tsx watch` when
  exposed** (serve built output; the current `npm run start` is non-watch), the self-mod
  RCE is closed by default.
- Verified in `scratchpad/sandbox-escape-fixes-test.mts` (server/ + shared/ resolve to
  read-only; repo root stays rw; unrelated boxes get no source; flag lifts it) and a live
  nested-bwrap run (writing `server/…` returns EROFS).

**Deferred (harden):**
- **`--strict-mcp-config`** so a session can't introduce MCP servers via project/user
  config (minor — that flavor stays in-box — but tidy).
- Node's own `node_modules` (incl. `tsx`) is still writable inside a repo-rw box; tampering
  there only bites on the NEXT server start (not hot-reload), and overlaps the supply-chain
  item — protect it too if the app root's `node_modules` should be treated as source.

## Terminal-pane escape (unsandboxed pty spawn)

**The terminal panes are not sandboxed at all** — this is the most direct escape of the
set, and unlike the two above it needs no file write, no source tree, and no session
config. `PaneManager.create()` (`pane/paneManager.ts`) does a bare:

```js
pty.spawn(process.env.SHELL || '/bin/bash', [], { cwd, env: process.env as … })
```

There is **no `wrapSandbox`** on this path. Claude *sessions* are spawned through bwrap
(`claude/sandbox.ts`), but a terminal pane is a plain host pty. So the pane is a full,
interactive, **unsandboxed shell running as the server's user**, and it inherits two
things that make it worse than the fs-API primitive:

- **`env: process.env`** — the pty gets the server's *entire* environment, including
  `CLAUDETTE_TOKEN` and any other host secrets. Note this path is **not covered by fix A**
  (`--clearenv` applies to `wrapSandbox`/`wrapCommand`, i.e. claude + kernels — not to
  `pty.spawn`). So even after A ships, a pane still leaks the token.
- **caller-controlled `cwd`** — `create(cwd, …)` takes an arbitrary absolute path,
  unvalidated, so the shell can start anywhere on the host.

**Reachability from inside a box.** The whole vector is driven over loopback with no
extra capability the box doesn't have:
1. `POST /api/pane/create {cwd:"/", cols, rows}` → returns a pane `id`
   (`pane/paneApi.ts` → `PaneManager.create`).
2. Open the app WebSocket `/ws?token=<token>` and send
   `{type:"pane:input", id, data:"<shell> \n"}` → routed by `handlePaneClientMessage`
   → `PaneManager.sendInput` → `proc.write(data)`. That's raw keystrokes into the pty:
   **arbitrary command execution**, not just a file write.
3. Output streams back as `pane:output` broadcasts (fanned to *every* WS client — a pane
   is not scoped to its creator; any authed client can also read/drive a known pane id).

The only gate is the WS auth token — and a sandboxed session inherits it in its env today
(the same reason the control-plane escape works), so the gate is currently open to the box.

**Demonstrated (2026-07-18):** created a pane at `cwd:/`, drove `whoami; ls
~/Downloads; readlink /proc/$$/root` over `pane:input`. It ran as `kleeorin`, listed
`~/Downloads` (a path *outside* this session's bwrap mounts, invisible to the box's own
tools), and — the clincher — `/proc/<pid>/root` resolved to **`/`**, not a bwrap-remapped
rootfs. A confined process would show the sandbox root there; `/` proves there is no mount/
PID/namespace isolation on this pty whatsoever.

**Relation to the other vectors.** Strictly the easiest of the three: the control-plane
escape asks the server to *build* an unsandboxed session; self-modification needs a
writable source tree + hot reload. Here the unsandboxed process already exists and is
one HTTP POST + one WS frame away. It also gives an *interactive shell* (network, `curl`,
`chmod`, cron, ssh-key drop, …), a superset of the fs API's write-a-file primitive.

**FIXED (2026-07-18).** The pane pty now runs inside the owning session's box:
- **`paneSpawnSpec` / `PaneManager.create`** (`pane/paneManager.ts`) resolve the session's
  sandbox (via a resolver wired in `index.ts`, mirroring the kernel one) and, when it's
  confined, spawn the shell through **`wrapCommand(cfg, cwd, shell, [])`** — the exact box
  the session's Claude and Jupyter kernels get. `bwrapBaseArgs` `--clearenv`s it, so the
  shell inherits no `CLAUDETTE_TOKEN`/host secrets. An UNconfined session's pane stays a
  raw host shell (matching that session), but its env is still scrubbed of `CLAUDETTE_*`
  (`sanitizedEnv`) as defense-in-depth.
- **Verified** (`scratchpad/sandbox-escape-fixes-test.mts` argv assertions + a live
  nested-bwrap run): a sandboxed pane's shell can't see `~/Downloads` (out-of-mount),
  reads `$CLAUDETTE_TOKEN` as empty, and gets **read-only** `server/`+`shared/` while the
  rest of the project stays writable (the self-mod overlay below).
- The chdir honors the terminal's own cwd for UX; confinement comes from the session's
  **mounts**, never the chdir (an out-of-mount cwd becomes an empty ro dir), so a
  caller-chosen cwd can't widen visibility.

**Still worth doing (defense-in-depth, not blocking):** owner-scope panes on the WS
(`pane:input`/`pane:output` check the creating session) so one box can't drive/read
another session's terminal — currently any authed client can, but the token is required
even on loopback (done) and a confined box holds no token, so this is hardening, not a
live hole.

## Symlinked-mount escape (bwrap follows a symlinked bind source)

`bwrap --bind SRC DEST` **follows a symlink at SRC and mounts its target** (verified
live). Every data mount is emitted as `--bind <path> <path>` guarded only by `existsSync`
(which follows symlinks) — no `lstat`/`realpath` check. The obligatory `<cwd>/.claude`
mount lives *inside* the session's rw cwd, so a confined box can create it as a symlink:

- box (rw cwd, no local `.claude`) runs `ln -s / <cwd>/.claude`;
- `sandboxKey` folds in whether `<cwd>/.claude` exists, so the key flips and
  `scheduleSandboxApply` **auto-relaunches** the session (resume-preserving) on the next
  idle — no user click, no token;
- the relaunch binds the link's target rw at `<cwd>/.claude` → the box now reads/writes
  the entire target tree (`/` if pointed there), fully outside its mounts.

Complete filesystem escape, self-triggered, needing no source tree, no API call, no
credential.

**FIXED (2026-07-18).** `bwrapBaseArgs` (`claude/sandbox.ts`) now runs each mount through
`isUnsafeSymlinkMount`: a mount source that **is a symlink whose parent dir is box-
writable** (inside some rw mount, by the mounts' *logical* dest paths — never a link's
target, so a malicious link can't launder itself in) is **dropped with a warning**. The
box-writable `<cwd>/.claude -> /` case is refused; a host-created symlink whose parent is
*not* box-writable (e.g. `~/.claude` on a dotfiles symlink farm — `$HOME` isn't mounted)
is kept and bound at its realpath. Verified in `scratchpad/sandbox-fs-escape-fixes-test.mts`
(symlinked `<cwd>/.claude` and its target are never bound; real cwd + host-symlink mounts
survive) and a live nested-bwrap run (the planted `.claude` is absent inside the box, so
the secret is unreachable).

## Notebook-MCP escape (unsandboxed arbitrary-path notebook read/write)

The app-control MCP server and its notebook tool handlers (`mcp/notebookTools.ts`) run
**in the unsandboxed server process**, and every session — sandboxed or not — is launched
with that MCP server configured. So a confined session's Claude can call the notebook
tools directly (the loopback URL token is embedded in its own launch config, not the app
auth token), and the handler's file I/O is **not** confined to the session's mounts:

- `read_notebook {path}` → `readFile(abs)` reads **any `.ipynb` on the host**, outside the
  mounts, and returns every cell's source to the model (confidentiality escape);
- `create_notebook {path}` / `edit_cell`/`add_cell {path}` + `save()` → `atomicWrite(abs)`
  create or **overwrite any existing `.ipynb`** with attacker-controlled content
  (integrity escape). Only the `.ipynb` extension bounds it.

**FIXED (2026-07-18).** `registerNotebookTools` now takes a `NotebookSandboxResolver`
(wired in `index.ts` the same way kernels/panes resolve a session's box). Before any path
is opened/created/read/written, `accessError` calls `sandboxPathAccess(cfg, cwd, path)`
(`claude/sandbox.ts`), which authorizes against the session's **data mounts** (`cfg.mounts`
plus the obligatory global + local `.claude`): a write must land in a `rw` mount, a read in
any mount, the **deepest** containing mount decides (matching bwrap's shallow-first
layering), and both sides are canonicalized (symlinks resolved) so a link inside a mount
can't launder access outward. An unconfined session (sandbox off / unavailable) keeps the
old behavior. Verified in `scratchpad/sandbox-fs-escape-fixes-test.mts` (in-rw read+write,
in-ro read-only, out-of-mount denied, global `.claude` reachable, symlink-out denied).

**Cross-session hook poisoning — the global `~/.claude` write→host-exec angle (FIXED, two layers).**
`~/.claude` is mounted **rw** (Claude writes creds/history/`.claude.json` there via atomic
rename, which EBUSYs onto a file bind — so the dir is bound as a unit), so a box could write
`settings.json` / `settings.local.json` `hooks` + `mcpServers` that a *later* unsandboxed
("host-mode") `claude` would execute host-side. Closed by `configProtection.ts` +
`sandbox.ts`:

- **Layer 1 (write side).** Every `settings.json` (user + project) is pinned **read-only**
  inside the box (`hookSettingsProtections`). `ensureUserSettingsPinnable()` first
  materializes a valid `{}` at `~/.claude/settings.json` when absent, so the ro-bind has a
  real file to pin — closing "create it after launch" for the user scope. Existing hooks
  still *fire* (ro blocks writes, not reads); `settings.local.json` stays **rw** so
  "allow-always" keeps persisting. `sessionDataMounts()` pins the same `settings.json` paths
  ro for the in-process actors (notebook MCP), so the out-of-band path can't write what the
  box can't.
- **Layer 2 (execution side).** `markConfigExposed(cwd)` records every config a confined
  session ran against (persisted ledger; the *shared* user scope taints all later host-mode
  sessions). When a host-mode session launches against an exposed config, `sessionManager`
  points its `CLAUDE_CONFIG_DIR` at `scrubbedHostConfigDir()` — a fresh mirror that symlinks
  creds/state back to the real dir (shared) but replaces `settings.json` +
  `settings.local.json` with scrubbed copies (`hooks`/`mcpServers` stripped). So anything
  that slipped past Layer 1 (a `settings.local.json` hook, or a directive predating this fix)
  never executes unsandboxed.

**Residuals (documented, not silently ignored).** (1) A confined session can still create a
*project* `<cwd>/.claude/settings.json` from scratch when no `.claude/` existed at launch — we
deliberately don't write into the user's repo to seed it, and Layer 2 does not scrub project
scope in host mode (Claude reads it relative to cwd with no redirect). Its neutralization
relies on the same project being reused in host mode. (2) A host-mode session run against an
exposed config uses a scrubbed config *mirror*; top-level files rewritten by atomic rename
(`.claude.json`, refreshed creds) may not flow back to the shared dir for that run
(directory state — projects/todos/history — is symlinked and persists). Both are the price of
keeping the shared-dir rw bind; full closure is per-session config isolation. Verified in an
ad-hoc harness: a bwrap `--ro-bind` over `settings.json` blocks in-box writes (EROFS);
`wrapSandbox` emits `--ro-bind` for the user `settings.json` (rw `--bind` for the config dir,
`settings.local.json` left writable); the scrub strips `hooks`+`mcpServers` while keeping
`permissions`/other prefs and leaves creds/projects as symlinks to the real dir.

## Venv-probe escape (unsandboxed exec of a discovered interpreter) — CRITICAL

The kernel machinery auto-discovers a project's Python: `findNearestPython`
(`jupyter/jupyterManager.ts`) walks up from a notebook's directory checking
`.venv/bin/python3` / `venv/bin/python3` / `env/bin/python3`, and for each candidate runs
`canImportJupyter` → **`execFile(candidate, ['-c', 'import jupyter_server'])`** — on the
**unsandboxed server**, inheriting the server's full env (incl. `CLAUDETTE_TOKEN`).

The notebook dir sits inside a confined session's **writable cwd**, so the box can plant
its own executable there and get it run unsandboxed as the server user:

1. box (rw cwd) writes an executable at `<cwd>/.venv/bin/python3` (any shell script);
2. box calls `create_notebook` under its cwd (allowed) + `run_cell` — both box-reachable
   MCP tools, no app token needed;
3. `run_cell` → `KernelManager.serverFor` → `pythonFor` → `findNearestPython(<cwd>)` finds
   the planted file and **executes it on the host**, with the server's env.

Verified live: the planted binary ran with `HOME=/home/kleeorin` and the server's
`CLAUDETTE_TOKEN` in its environment — full host compromise (read/write anywhere, and the
token unlocks the token-gated fs/git/pane APIs). Strictly the most severe box-reachable
vector found: no symlink, no source tree, no auth — one file write plus one MCP call.

**FIXED (2026-07-18).** Discovery now carries the session's sandbox context
(`findNearestPython(dir, sandbox)`, threaded through `pythonFor`/`serverFor`/
`listKernelSpecs`). `canImportJupyter` probes a candidate whose **logical path lies in a
box-writable mount** (`pathInWritableMount`, `claude/sandbox.ts` — logical, not realpath,
so a symlink the box planted is still caught) **inside that session's box** via
`wrapCommand`: a planted binary then runs confined (no token, no host FS; its escape
attempts fail), while a real project venv still imports and launches. Candidates outside
every rw mount — which the box could not have written — are probed directly, as before,
and out-of-mount venvs are still ro-bound into the box for use. `listKernelSpecs` for a
confined notebook now reads specs from that session's **confined** server rather than an
unconfined `off:` one, so a box-writable interpreter is never launched unsandboxed even
via the (token-gated) kernel picker. Verified in
`scratchpad/sandbox-fs-escape-fixes-test.mts` (planted `.venv/bin/python3` does not
execute on the host under confinement; unconfined behavior preserved).

## Unowned-kernel escape (MCP-created/opened notebook runs its kernel unconfined) — CRITICAL

The venv-probe fix threads a session's box through kernel discovery/launch — but **only
when the notebook has an OWNER**. `KernelManager.sandboxForNotebook(notebookId)` looks up
`owner.get(notebookId)` → `sandboxOf(sessionId)`; a notebook **no session owns** resolves
to `undefined`, and `serverFor` then returns the shared **unconfined `off:` server**
(`new JupyterManager(python)` → a plain `spawn(python, …, { env: {...process.env} })` at
`root_dir=/`, carrying the server's full env **including `CLAUDETTE_TOKEN`**). Every kernel
that server spawns runs **as the server user, outside every mount**.

Ownership was set **only** on the fresh-open-with-focus path (`open_notebook`, or
`targetDoc`'s open branch → `onFocus` → `setOwner`, wired in `index.ts`). Two
**box-reachable** MCP paths skipped it, leaving the notebook unowned:

- **`create_notebook`** never focuses, so it never set an owner; and
- **`targetDoc`'s "already open" branch** returned the doc without claiming it.

So a confined box, over the loopback MCP alone (no app token — the notebook tools use the
box's own MCP URL token), could:

1. `create_notebook {path:"<cwd>/pwn.ipynb"}` — passes the `sandboxPathAccess` gate (in its
   rw cwd), leaves the notebook **unowned**;
2. `add_cell {source:"<arbitrary python>"}` — the already-open branch, still unowned;
3. `run_cell` → `ensureKernel` → `serverFor` → no owner → **unconfined kernel** → the cell
   executes on the host, can **write anywhere** and read `CLAUDETTE_TOKEN` from its env.

It also **silently bypassed the venv-probe fix**: with no owner, discovery ran
`findNearestPython(dir, undefined)`, so a planted `<cwd>/.venv/bin/python3` was probed
(executed) **on the host** again — the exact escape that fix closed, reachable through a
path its test never drove (it called `findNearestPython` directly with an explicit box,
not the `create_notebook`→`run_cell` MCP flow).

**FIXED (2026-07-18).** Ownership is now claimed for the calling session on **every
write/run** through the notebook tools, so the kernel that later executes is confined to
that session's box:
- **`notebookTools.ts`** — `targetDoc` calls `claimOwnership(sessionId, doc, need)` on both
  the fresh-open and already-open branches (guarded to `need==='write'`, so a plain
  `read_notebook` never steals a live kernel), and `create_notebook` calls
  `kernels.setOwner(doc.notebookId, sid)` right after creating. Every mutating/running tool
  (`edit/add/insert/delete/move/set_cell_type`, `run_cell`, `run_all`) resolves through
  `targetDoc(need:'write')`, so all of them claim ownership **before** `ensureKernel` runs.
- **`kernelManager.ts`** — `ensureKernel` now resolves the owner's required server **before**
  reusing a kernel and reuses a live one **only** when it runs on that exact server
  (`KernelClient.serverUrl`). If a notebook's confinement changed since its kernel started
  (a sandboxed session claiming a notebook whose kernel was on the unconfined `off:`
  server), the stale kernel is shut down and restarted on the correct confined server — so
  a pre-existing unconfined kernel can't be reused either.
- **Verified** in `scratchpad/sandbox-unowned-kernel-test.mts` (driving the real MCP
  handlers: `create_notebook`, `edit_cell` on an already-open notebook, and `run_cell` all
  leave the notebook owned by the calling session → its kernel takes the confined server;
  `read_notebook` claims nothing). Existing sandbox tests still pass (server typecheck
  clean).

## The confinement seam (fail-closed, one place) — holistic hardening

Every escape above is the same shape: a server-side actor doing work **on behalf of a
session** while running *outside* that session's box. The defenses split into two kinds —
**executors** (kernel, terminal pty, subprocess spawns) that must *run inside* the box, and
**in-process handlers** (the MCP notebook tools) that can't be boxed and must instead
*authorize their file/exec effects* against the box's mounts. The recurring root cause was
that each actor resolved a session's box on its own, with the same fragile shape:

```ts
(sessionId) => { const s = sessions.get(sessionId); return s?.sandbox ? { cfg, cwd } : undefined }
```

That `undefined` **conflated two cases** — "deliberately unconfined" and "I couldn't resolve
this session" — and both defaulted to *run on the host*. So a missing owner, an unknown id,
or a torn-down session silently became **unconfined**. The notebook-MCP, venv-probe, and
unowned-kernel escapes are all that one fail-**open** default.

**DONE (2026-07-18) — a single fail-closed resolver.** `claude/sessionConfinement.ts`
(`SessionConfinement`) is the one seam all three actors now share (wired once in `index.ts`,
passed to `KernelManager`, `registerNotebookTools`, and `PaneManager`). `resolve(sessionId)`
returns a three-way decision that keeps the two cases distinct:

| mode | when | file op (`authorizePath`) | executor |
|------|------|---------------------------|----------|
| `confined` | known, sandbox-enabled, host can sandbox | inside mounts only (rw for writes) | wrapped in the session's box |
| `host` | operator opted the session out, or host can't sandbox | allowed (already token-gated, single-user) | raw host spawn, env scrubbed |
| **`deny`** | **session unknown / unresolved** | **denied** | **data-mount-less box** (kernel: refused) |

The load-bearing change is the middle case no longer collapsing into `host`: an unresolved
session is `deny`, the most-restrictive branch. Consequences enforced through the seam:
- **Notebook MCP tools** — `accessError` is just `confinement.authorizePath(...)`; an
  unknown session is denied instead of allowed whole-FS.
- **Kernels** — `KernelManager.confinementForNotebook` maps a notebook's owner through the
  seam; **no owner ⇒ `deny` ⇒ the kernel is refused**, never dropped to the shared `off:`
  server. A notebook opened by the operator with no session is tagged `HOST_OWNER`
  (deliberate host kernel), kept distinct from *never-claimed* (refused).
- **Terminal panes** — `paneSpawnSpec` takes the decision directly; `deny` yields a
  data-mount-less bwrap box (or refuses when the host can't sandbox), never a host shell.

Net effect: the *next* server-side actor that forgets to thread a session through degrades
to "broken but safe," not "host RCE." Verified in `scratchpad/session-confinement-test.mts`
(unknown/undefined → `deny`; opted-out/no-sandbox → `host`; enabled → `confined`;
`authorizePath` denies the unknown session and gates the confined one), plus the pane
`deny`-mode assertion in `scratchpad/sandbox-escape-fixes-test.mts` and the reworked
`sandbox-unowned-kernel-test.mts`. Server typecheck clean; all sandbox tests green.

**Not covered by the seam (unchanged, still true):** it's a filesystem-write firewall, not a
network or secrecy boundary — the shared network still allows exfil. The `~/.claude`
hook/`mcpServers` write→host-exec angle it used to leave open is now closed by the two-layer
`configProtection.ts` fix (settings.json pinned ro in-box + host-mode sessions read a scrubbed
config mirror); see "Cross-session hook poisoning" above for the mechanism and its residuals.
Planting non-executable *agents* under `~/.claude` remains a lesser tradeoff (an agent charter
is data a later session would still run under confinement, not host shell).

## G1 — Notebook-write/read TOCTOU (symlink swap between check and I/O)

Found during the "verify no more gaps" audit and **confirmed live**
(`scratchpad/sandbox-toctou-check.mts`). The notebook MCP tools authorize a path by
*canonicalizing* it — `sandboxPathAccess`→`canonicalizeForAccess` realpaths the parent of a
not-yet-existing file — but the actual I/O (`NotebookDocManager.atomicWrite` /`openPath`)
re-resolves symlinks at syscall time. A confined box that owns a rw mount can win a race:

1. box makes a real dir `<rwmount>/d`, calls `create_notebook("<rwmount>/d/x.ipynb")`; the
   gate canonicalizes parent `<rwmount>/d` → in-mount → allowed;
2. between the check and the write, the box's shell swaps it: `rmdir d && ln -s /etc d`;
3. `atomicWrite` writes `<rwmount>/d/x.ipynb.tmp` → follows the symlink → `/etc/…` and
   renames into place — a write **outside the mounts** (bounded to `.ipynb` names; the read
   direction leaks an out-of-mount file only if it parses as a notebook).

**FIXED (2026-07-18).** The containment decision and the write-guard are now bound to **one**
filesystem observation, so nothing can slip between "authorized" and "guarded":
- **`SessionConfinement.authorizeResolved(sid, realDir, base, need)`** authorizes an I/O whose
  parent the caller has *already* realpath'd to `realDir`, deciding containment on
  `join(realDir, base)` — the exact value the caller then pins as the guard. (A plain
  `authorizePath` + a *second* realpath would leave a swap window between the two.)
- **`notebookTools.ts` `gate()`** does that single `realpath(dirname)`, passes the canonical
  dir as `guard`, and **re-gates at every write AT WRITE TIME** (`applyAndSave`, `run_cell`,
  `run_all` gate on `doc.path` right before `save`, not just at open) so a swap between open
  and save is caught too.
- **`NotebookDocManager.atomicWrite`/`openPath`** take the `guard` and refuse if
  `realpath(dirname(abs))` no longer equals it (parent relinked since authorization); the temp
  file is created `wx` (O_EXCL) so a pre-planted final-component symlink can't be followed.
- Verified (`scratchpad/sandbox-toctou-check.mts`, 8/8): legit in-mount write works;
  swap-*after*-authorize is refused (guard mismatch) with nothing escaping; swap-*before*-
  authorize is denied (decision + guard from the same realpath); the read path is likewise
  refused.

**Residual (documented, irreducible in Node):** a sub-syscall window remains *inside*
`atomicWrite`, between its `realpath` re-check and the `writeFile` open — a parent swap landing
in those few instructions could still redirect the write. Closing it fully needs
`openat2(RESOLVE_NO_SYMLINKS)` / a dir-fd relative write, which Node doesn't expose; the guard
shrinks the exploitable window from "unbounded (any time before the write)" to that few-
instruction race, which is extremely hard to win repeatably. The airtight fix is to do the
write from a dir-fd (native addon) or inside the box.

## G2 — Symlinked-mount authorizer divergence (box refuses a mount the authorizer trusts)

Found by an adversarial re-test of the confinement guarantees and **confirmed live**
(`scratchpad/sandbox-symlink-authorizer-probe.mts`, exit 0 after the fix). The
"Symlinked-mount escape" fix was applied in **one** place — the bwrap arg builder
(`bwrapBaseArgs`), which drops a box-writable symlinked mount source via
`isUnsafeSymlinkMount`. But the **out-of-band** path authorizer the notebook MCP tools use —
`sessionDataMounts` → `sandboxPathAccess` → `canonicalizeForAccess` — did **not** apply that
guard, so the two diverged on exactly the mount the box refuses:

1. `sessionDataMounts` adds `<cwd>/.claude` whenever `existsSync` sees it — and `existsSync`
   **follows the symlink**, so a box-planted `<cwd>/.claude -> /outside` is admitted as a
   trusted rw mount root (the `isUnsafeSymlinkMount` guard lived only in the box path);
2. `sandboxPathAccess` then `canonicalizeForAccess`es that root — `realpath` resolves the link
   to its **target** — so the target `/outside` becomes a trusted rw area. (The fix's own
   invariant, "canonicalizing stops a link *inside* a mount laundering outward," **inverts**
   when the link *is* the mount root: canonicalizing it outward *expands* the authorized set.)
3. Because the notebook tools run **unsandboxed** in the server (`NotebookDocManager.atomicWrite`),
   that authorization becomes a real host write: a confined box runs
   `ln -s /out-of-mount <cwd>/.claude`, then `create_notebook`/`add_cell` with
   `path="<cwd>/.claude/x.ipynb"` → the server writes/overwrites the `.ipynb` **outside the
   mounts** (read direction leaks any out-of-mount file that parses as a notebook).

Bounded like the parent notebook-MCP vector (`.ipynb`-named files, attacker-controlled JSON),
but a genuine violation of the write-confinement guarantee. **Worse than the original symlink
escape in one respect:** it needs no relaunch — the authorizer calls `sessionDataMounts` **live
on every MCP call**, so the planted link bites immediately.

**FIXED (2026-07-19).** `sessionDataMounts` now applies the **same** guard the box does, so the
authorizer and the box never diverge on the mount set:

```ts
const full = [...mounts, ...appSourceProtections(mounts), ...settingsRo]
const rwRoots = full.filter((m) => m.mode === 'rw' && existsSync(m.path)).map((m) => path.resolve(m.path))
return full.filter((m) => !isUnsafeSymlinkMount(m.path, rwRoots))
```

`rwRoots` are the **logical** rw dest paths (never a link's target), exactly as `bwrapBaseArgs`
computes them, so a box-writable symlinked `<cwd>/.claude` is dropped from the authorizer's
mount set just as it is dropped from the box's binds. A host-created symlink whose parent is not
box-writable (dotfiles farm) is still kept, matching the box. Verified: the probe now returns
`read=false write=false` and logs the same refusal the box emits; a permanent regression
assertion was added to `scratchpad/sandbox-fs-escape-fixes-test.mts` (13/13) — a planted
`<cwd>/.claude -> secret` must not authorize an out-of-mount `.ipynb`. Full sandbox suite green,
server typecheck clean.

**Note (defense working, observed during the fix):** the patch had to be applied by the operator
because the session doing the audit was itself confined, and the self-modification fix pins
`server/` **read-only** inside every box — the in-box edit failed `EROFS`. Independent live
evidence that "a confined box cannot rewrite the code of the process that sandboxes it" holds.

## Removed: `JupyterManager.install()` latent footgun

The audit also found `JupyterManager.install()` — dead code (zero callers) that built
`sh -c "${py} -m pip install …"` and ran it **unsandboxed** with a possibly box-writable `py`.
Harmless while uncalled, but a wired-up future caller would be a box-reachable unconfined-RCE.
**Removed** rather than left as a trap; if reintroduced, route it through `wrapCommand` like the
other spawns.
