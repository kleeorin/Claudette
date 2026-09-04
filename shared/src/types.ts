// 'exited' is a renderer-only terminal state: the process died so quickly after
// launch that it never really started (e.g. `claude: command not found` on a
// remote). We keep the row and show the error instead of silently removing it.
export type SessionState = 'idle' | 'running' | 'waiting' | 'exited'

// --- Sandbox (bubblewrap) — see SANDBOX.md ------------------------------------
// One bind into a session's sandbox. `rw` = writable, `ro` = read-only. Overlaps
// are allowed (a rw pocket inside a ro tree); mounts are emitted shallowest-first
// so the nesting layers correctly regardless of order.
export interface SandboxMount {
  path: string
  mode: 'rw' | 'ro'
}

// A session's sandbox request. Strict visibility: only these mounts (plus the
// runtime baseline that makes claude run) are visible; writes elsewhere fail or
// land in throwaway tmpfs and never reach the host. `mounts` is seeded with the
// session's cwd (rw); the user adds more. This is what's REQUESTED — whether it's
// actually in force is SessionInfo.sandboxed (the host may lack bwrap/userns).
export interface SandboxConfig {
  enabled: boolean
  mounts: SandboxMount[]
  // Do this session's TERMINAL panes run inside the box too? Undefined/false = NO —
  // a terminal is a plain (env-scrubbed) host shell even when Claude is confined,
  // because it's the operator's own shell: only the authenticated browser can open
  // or type into a pane, and the box holds no token, so a confined session can't
  // reach one (SANDBOX.md "Terminal-pane escape"). Set true to confine terminals to
  // the same mounts as Claude. Applies to panes opened AFTER the change.
  sandboxTerminals?: boolean
  // Hand this session's box the host's GPU character devices (/dev/nvidia*, /dev/dri,
  // /dev/kfd — whichever exist) so CUDA/ROCm work inside it. Undefined/false = NO: the
  // box gets bwrap's minimal `--dev` (null/zero/full/random/tty and nothing else), so a
  // GPU job fails with "no CUDA-capable device is detected" even on a host with a card.
  //
  // A separate flag rather than entries in `mounts`, for two reasons that both make the
  // mount list unable to express this. These are DEVICE nodes, not folders, so the
  // folder picker can never surface them; and a plain `--bind` carries MS_NODEV, which
  // leaves the node visible but dead (nvidia-smi: "Insufficient Permissions"). Only
  // bwrap's `--dev-bind` actually grants access. The node set is discovered from /dev,
  // never typed — see gpuDevicePaths().
  //
  // WIDENS the box: a GPU node is a direct kernel attack surface, and GPU memory is not
  // scrubbed between contexts the way host RAM is. So it is trust-gated as the mirror
  // image of `enabled:false` (normalizeSandbox) — only the auth-gated operator route may
  // turn it ON, never an in-box caller reaching the loopback control API.
  gpu?: boolean
}

// A folder the operator keeps in a standing, INSTALL-WIDE list so every session's sandbox
// editor can offer it as a one-click mount instead of a walk through the folder picker.
// The list is deliberately INERT: an entry is a shortcut and nothing more, never mounted
// into any session on its own, so saving one widens no box until the operator ticks it
// somewhere specific.
//
// That inertness is also why the list needs no trust gate of its own, unlike `gpu` or
// `enabled:false` above. Ticking an entry still goes through the auth-gated setSandbox
// route and normalizeSandbox, so the worst an in-box caller could achieve by reaching the
// list is to SUGGEST a path to the operator's own UI. Keep it that way: the moment an
// entry here mounts itself into a session, it becomes a confinement-widening channel and
// needs the same `trusted` gate normalizeSandbox applies.
export interface SandboxDefaultFolder {
  path: string
  // The access a tick GRANTS. A seed, not a binding: once mounted, the per-mount rw/ro
  // toggle edits the SESSION's copy and leaves this alone — so a folder saved as `ro` can
  // still be made writable for one session without rewriting the default for every other.
  mode: 'rw' | 'ro'
}

// GET /api/sandbox/defaults, and the reply to every mutation below — each write returns
// the WHOLE list so a client never has to reconcile a patch against what it thought it had.
export interface SandboxDefaultsResponse {
  folders: SandboxDefaultFolder[]
}

// A selectable session role (agent): its id, display name, and a one-line summary.
// The full charter/tool-scope lives server-side (claude/agents.ts); the client only
// needs these three to render the role picker + a sidebar badge.
export interface AgentInfo {
  id: string
  name: string
  description: string
}

export interface SessionInfo {
  id: string
  name: string
  cwd: string        // where Claude runs (a subsession shares its parent's cwd)
  rootDir: string    // root for the terminal pane + file browser (a subdir for subsessions)
  parentId?: string  // set on subsessions; points at the owning session
  remoteId?: string  // set when the session runs on a remote host (see RemoteConfig)
  agentId?: string   // the role this session runs as (see main/agents.ts); undefined = 'general'
  model?: string     // per-session model override; undefined = the role's model, else account default
  permissionMode?: PermissionMode  // --permission-mode; undefined/'default' = ordinary prompting
  sandbox?: SandboxConfig  // requested bwrap confinement (see SANDBOX.md)
  sandboxed?: boolean      // EFFECTIVE: true only if the last launch actually wrapped in bwrap.
                           // enabled-but-false ⇒ host can't sandbox (fell back to unconfined) —
                           // the UI must surface this honestly, never as "sandboxed".
  sandboxPending?: boolean // the requested sandbox differs from what the RUNNING engine has
                           // (e.g. a mount was just added). Auto-applied when the session goes
                           // idle; true only while a turn is in flight and the relaunch waits.
  teamEmploy?: boolean // may this session HIRE teammates (employ_teammate/dismiss_teammate)?
                       // Off unless the operator flips it. Messaging tools are always
                       // available; only roster management is gated. Lowering-proof in the
                       // same way the sandbox is: only a trusted (auth-gated) caller may set
                       // it, so a confined session can't reach the loopback API and grant
                       // itself a team — see SANDBOX.md "Control-plane escape".
  connectors?: string[]        // CATALOG connector ids this session may reach (see connectors.ts).
                               // Absent/empty = none: the session's --mcp-config carries no
                               // such entry, so it has none of those tools at all. Trust-gated
                               // exactly like teamEmploy — a confined session must not be able
                               // to grant itself reach it wasn't given.
  accountConnectors?: string[] // claude.ai ACCOUNT connectors this session may use. Stored as
                               // an ALLOW list (not a deny list) so the default — absent/empty —
                               // is "none", and a newly created session is fail-closed rather
                               // than silently inheriting whatever the account has connected.
                               // Enforced by a deny rule for everything not listed, since
                               // Claudette holds no credential and so cannot withhold one.
  agentPending?: boolean   // the ROLE DEFINITION differs from the one the RUNNING engine was
                           // launched with. Third of the configured-vs-effective pair set,
                           // after sandboxPending and connectorsPending, and the one whose
                           // absence bit us: launch() copies the role's tool scope into the
                           // spawn once, so narrowing a role (e.g. `reviewer` losing bare
                           // `Bash`) leaves every RUNNING session on the old, wider scope.
                           // Note what makes this one different — it flips when agents.ts
                           // changes, not when the session's own config does, so a single
                           // edit can set it for many sessions at once. Clears on relaunch.
  connectorsPending?: boolean  // the granted set differs from what the RUNNING engine has. The
                               // engine reads its server list once at spawn (and ignores
                               // tools/list_changed), so a new grant only becomes visible on
                               // relaunch — same shape as sandboxPending. Revoking is immediate
                               // regardless: the proxy refuses the call.
  state: SessionState
  exitError?: string // last output when state === 'exited' (why it failed to start)
}

// What a session is currently LOOKING AT: the file open in its active content tab
// (the notebook/editor beside Claude), or null when the Claude tab itself is
// focused. The web client publishes this per session on tab/session switch; the
// server keeps it per session so the app-control notebook tools can target "the
// notebook the user is viewing" when Claude omits an explicit `path`.
export interface ActivePane {
  path: string        // absolute path of the file in the active tab
  isNotebook: boolean // true for a .ipynb (cell tools) vs a text file editor
}

export interface SavedSession {
  name: string
  cwd: string
  rootDir?: string       // defaults to cwd when absent (older saves)
  parentIndex?: number   // index of the parent within the saved array (subsessions only)
  paneCount?: number     // number of stacked terminal panes to restore
  hasPane?: boolean      // legacy: single pane (older saves); read as paneCount 1
  remoteId?: string      // remote host this session runs on (local when absent)
  agentId?: string       // the role this session runs as (re-applied on restore)
  model?: string         // per-session model override (re-applied on restore)
  permissionMode?: PermissionMode  // per-session mode (re-applied on restore)
  sandbox?: SandboxConfig  // bwrap confinement config (re-applied on restore)
  teamEmploy?: boolean     // may hire teammates (re-applied on restore — a persisted
                           // value was already operator-approved, so restore is trusted)
  connectors?: string[]        // granted catalog connectors (re-applied on restore, same
                               // reasoning as teamEmploy: a persisted grant was operator-approved)
  accountConnectors?: string[] // allowed account connectors (ditto)
  claudeSessionId?: string // claude's own --session-id, for --resume on restore
  tasks?: TaskRecord[]     // subagent lifecycle registry, so a restart doesn't strand tray cards
}

// The authoritative record of a subagent's lifecycle, kept server-side per session
// (see SessionManager) so a background agent's terminal outcome survives even when its
// <task-notification> is evicted from the capped transcript ring, was never buffered
// (a resumed/off-stream agent), or is lost to a server restart. Keyed by the Task/Agent
// tool_use id. This is the durable fallback a tray card settles from when no terminal
// tool_result ever reached the client — the fix for sticky "running" cards.
export interface TaskRecord {
  toolId: string            // Task/Agent tool_use id (pairs with <tool-use-id>)
  // The CLI's OWN id for the task, off `system/task_started` — the only handle its
  // `stop_task` control request accepts, and deliberately NOT the same value as toolId.
  // Absent until that event arrives (and forever for a conversation resumed from disk,
  // which never replays it), which is exactly when the tray's stop button stays hidden.
  taskId?: string
  type: string              // subagent_type
  description: string
  prompt?: string
  launched: boolean         // async-launch ack seen (a detached background agent)
  status: 'running' | 'done' | 'failed'
  summary?: string          // terminal summary, for the settled card
}

// --- Native chat backend (stream-json) ---------------------------------------
// See PROTOCOL-stream-json.md for the pinned wire contract (CLI 2.1.198).

// A parsed stream-json event, forwarded to the renderer to build the transcript.
// We keep it loose (the raw object) plus a couple of synthetic kinds; the store
// discriminates on `type`. Notable types: system/init, system/thinking_tokens,
// rate_limit_event, stream_event, assistant, user, result, and 'stderr' (ours).
export type ClaudeEvent = { type: string; [k: string]: unknown }

// A can_use_tool prompt surfaced to the renderer for a native permission UI.
export interface PermissionRequest {
  requestId: string
  toolName: string
  displayName: string
  input: Record<string, unknown>
  toolUseId: string
  description?: string
  suggestions: unknown[]   // permission_suggestions: setMode / addRules options
}

export type PermissionDecision =
  // updatedPermissions echoes the request's permission_suggestions (setMode /
  // addRules) to implement "allow always"; the CLI applies + persists them per
  // each suggestion's `destination` (session vs local/user/project settings).
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message?: string }

// --- Permission Control Center (see HANDOVER-permissions.md) ------------------
// A session's permission mode — Claude's `--permission-mode` launch flag and the
// `defaultMode` key in its settings files.
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

// Which of Claude's settings files a rule/mode comes from. Precedence low→high:
// user < project < local. (Enterprise policy is out of scope for v1.)
export type PermissionScope = 'user' | 'project' | 'local'

export type PermissionAction = 'allow' | 'deny' | 'ask'

// One allow/deny/ask entry (e.g. "Bash(npm run test:*)"), tagged with the file it
// came from so the UI can group + attribute it.
export interface PermissionRule {
  action: PermissionAction
  value: string
  scope: PermissionScope
}

// One of Claude's three settings files, as located for a session.
export interface PermissionFile {
  scope: PermissionScope
  path: string        // absolute (remote-encoded for remote sessions)
  exists: boolean
  unreadable?: boolean  // present but not valid JSON
}

// The merged permission picture for a session, read from Claude's OWN settings
// files — read-only visibility (P1). `mode` is the effective defaultMode (the
// highest-precedence file that sets one); the per-session launch override is P2.
export interface EffectivePermissions {
  cwd: string
  mode: PermissionMode          // effective defaultMode across the files ('default' if none set)
  modeScope?: PermissionScope   // which file set it (absent when defaulted)
  rules: PermissionRule[]       // every allow/deny/ask entry, tagged by scope
  files: PermissionFile[]       // the three settings files + whether each exists
  notebookFunnel: string[]      // read-only "system" denies (NOTEBOOK_DENY)
  agent?: {                     // read-only agent tool scoping, surfaced for clarity
    id: string
    name: string
    allowedTools?: string[]
    disallowedTools?: string[]
  }
  error?: string
}

// Outcome of a perms:setMode request. `live` = switched in the running session via
// the control protocol; `relaunched` = the session's engine was restarted (resume-
// preserving) to apply the flag now; `restart` = stored, applies on the next launch
// (TUI, or a busy session we didn't interrupt); `error` = couldn't apply.
export type SetModeResult =
  | { applied: 'live'; mode: PermissionMode }
  | { applied: 'relaunched'; mode: PermissionMode }
  | { applied: 'restart'; mode: PermissionMode; reason?: string }
  | { applied: 'error'; error: string }

// A resumable past conversation, for the native /resume picker (see conversations.ts).
export interface ConversationMeta {
  id: string          // claude session id (= transcript filename)
  mtimeMs: number     // last-modified, for ordering + "N ago" display
  title: string       // ai-generated title, else first user prompt
  lastPrompt: string  // subtitle preview
  turns: number       // user-turn count
}

// A point the conversation can be rewound to — one past user turn. Rewinding forks
// the transcript truncated to JUST BEFORE this turn (so the turn and everything
// after it drop away and you continue from there); see conversations.ts.
export interface RewindPoint {
  uuid: string        // the user message's uuid — the fork boundary
  text: string        // the turn's prompt, for preview
  mtimeMs: number     // when it was sent, for ordering + "N ago" display
  ordinal: number     // 1-based turn number, for display
  hasSnapshot: boolean // a working-tree snapshot exists → code-restore available here
}

// What a /rewind restores. `conversation` forks the chat to before the turn; `code`
// restores the working tree to that turn's snapshot; `both` does both.
export type RewindMode = 'conversation' | 'code' | 'both'

// What restoring a turn's code snapshot would change, for the confirm dialog. Paths
// are relative to the repo root. `reverted` = files whose contents differ from the
// snapshot; `deleted` = untracked files created since (removed only when deleteNewer).
export interface RewindPreview {
  reverted: string[]
  deleted: string[]
}

// --- Remotes -----------------------------------------------------------------

// A saved SSH remote. `host` is anything ssh accepts as a destination
// (user@host, or a Host alias from ~/.ssh/config). `sshOptions` are extra argv
// passed before the destination (e.g. ['-p','2222'], ['-i','~/key'], ['-J','jump']).
export interface RemoteConfig {
  id: string
  label: string
  host: string
  defaultDir: string
  sshOptions?: string[]
  // Absolute path to a Python interpreter to launch Jupyter with (e.g. a shared
  // venv's `.venv/bin/python3` that has jupyter_server installed). When unset, the
  // remote's login-shell `python3` is used — which often lacks jupyter_server.
  pythonPath?: string
}

// A top-level `Host` alias discovered in ~/.ssh/config, offered as a one-click
// quick-add in the remote picker. hostName/user are shown for context only — ssh
// resolves the real connection details from the config itself.
export interface SshConfigHost {
  alias: string
  hostName?: string
  user?: string
  port?: string   // shown only when non-default (not 22)
}

// The connection identity ssh resolves for a destination (`ssh -G`), for display
// so the manager shows who/where you'll actually connect as.
export interface ResolvedHost {
  hostName?: string
  user?: string
  port?: string
}

// cwd/rootDir strings for remote sessions are encoded as `remote://<id>/<abs>`
// (see main/remotePath.ts); this keeps the whole fs/git IPC surface path-only.
export type RemoteTest = { ok: true } | { ok: false; error: string }

export interface DirEntry {
  name: string
  isDir: boolean
  size: number     // bytes; 0 for directories / unreadable entries
  mtimeMs: number  // last-modified epoch ms; 0 if unreadable
}

// One directory's listing, for the file/folder browser (GET /api/fs/list?path=).
// `path` is the resolved absolute dir actually read (may differ from the request
// after normalization); `parent` is null at the filesystem root.
export type FsListResponse =
  | { path: string; parent: string | null; entries: DirEntry[]; error?: undefined }
  | { error: string }

// In-app file preview, returned by fs:readFile. Travels over IPC (and therefore
// over VNC for remote launches), so no external viewer / window manager needed.
export type FilePreview =
  | { kind: 'image'; name: string; dataUrl: string }
  | { kind: 'pdf'; name: string; dataUrl: string }
  | { kind: 'text'; name: string; text: string; truncated: boolean }
  | { kind: 'binary'; name: string }
  | { kind: 'error'; name: string; message: string }

export type WriteResult = { ok: true } | { ok: false; error: string }

// --- Git ---------------------------------------------------------------------

export interface GitFileStatus {
  path: string        // repo-relative path
  orig?: string       // original path for renames/copies
  index: string       // staged status char (X of the porcelain XY pair; ' ' = none)
  worktree: string    // unstaged status char (Y of the pair; ' ' = none)
  staged: boolean     // has staged changes (index is meaningful)
  unstaged: boolean   // has unstaged changes (worktree is meaningful)
  untracked: boolean  // not yet tracked by git
}

export type GitStatus =
  | { repo: true; branch: string; upstream: string | null; ahead: number; behind: number; files: GitFileStatus[] }
  | { repo: false }                    // dir isn't inside a git work tree
  | { repo: 'error'; error: string }

export type GitDiff = { ok: true; diff: string } | { ok: false; error: string }
export type GitResult = { ok: true } | { ok: false; error: string }

export interface GitCommit {
  hash: string     // full SHA
  short: string    // abbreviated SHA
  subject: string  // first line of the message
  author: string
  date: string     // relative, e.g. "2 hours ago"
}

export type GitLog = { ok: true; commits: GitCommit[] } | { ok: false; error: string }

export type GitBranches =
  | { ok: true; current: string; branches: string[] }  // `current` is '' when detached
  | { ok: false; error: string }

// Plan-quota usage (the account's rate-limit windows), read from the same
// `/api/oauth/usage` endpoint the CLI's own `/usage` command uses — the stream no
// longer carries a usage fraction, so this is polled over HTTP. Account-global (not
// per-session). `resetsAt` is epoch SECONDS (matches the rate-limit chip's rendering).
export interface UsageWindow {
  kind: string          // e.g. 'session', 'weekly_all'
  group: string         // 'session' | 'weekly'
  label: string         // display label ('Session' | 'Weekly')
  percent: number       // 0–100 utilization
  resetsAt?: number     // epoch seconds
  severity?: string     // 'normal' | 'warning' | …
}
export interface UsageResponse { windows: UsageWindow[]; fetchedAt: number }
