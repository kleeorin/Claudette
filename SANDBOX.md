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
- **Default writable mount = the session's own `cwd`** (rw). Sessions may not be a
  git repo, so we do NOT use the repo root. You add more mounts (rw or ro) as needed.
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
# global claude config/creds/history — READ-WRITE (claude writes here at runtime):
--bind <CLAUDE_CONFIG_DIR or $HOME/.claude> <same>
# user mounts (default: cwd rw), shallowest-first; then:
--chdir <cwd> --setenv HOME <home>
# NB: NO --unshare-net → shared network (loopback MCP + internet work)
```

### The right global `.claude`, local or remote

Never hardcode a path. Resolve from the **same environment the child runs with**:

```
configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
```

Bind it at the **identical path** in and out, and leave `HOME`/`CLAUDE_CONFIG_DIR`
untouched, so claude's resolution inside == outside. This auto-follows local
(`/home/you/.claude`) vs a remote whose `$HOME` differs (e.g. `/home/.claude`).
Same trick for the `claude` binary and `node` (both live under `$HOME`, versioned).
It must be **rw** — claude writes creds/history/session state there; a ro bind
breaks startup.

**Known tradeoff:** `~/.claude` holds *every* project's transcripts plus
`.credentials.json`, so a sandboxed session can still *read* them (write-confinement
holds; read-secrecy does not). Future tightening: a per-session `CLAUDE_CONFIG_DIR`
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
