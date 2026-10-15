# Claudette — Handover
_Last updated: 2026-10-06._

<!-- Deliberately no "working tree is clean" line here. The previous one was stale the
     moment it was written and stayed wrong for a month, which is the same failure this
     document's rewrite exists to fix: run `git status` — it is authoritative and this
     file cannot be. -->


## ⛔ COORDINATOR HANDOVER — 2026-10-06. READ FIRST.

Coordinator = this session, named **Claudette**. **The team is EMPTY** — all six teammates were
dismissed on 2026-10-06 at the user's order and the work consolidated here. Their exit reports are
the role notes in `.claude/team-handovers/` (Landing's: `implementer-landing-2026-10-06.md`).

**This session can NOT write `server/src`, `shared/src` or `web/dist`** (probe with `test -w`; mounts
flip). The user said: do NOT do anything needing those for now — they will be handled later.

### Status — last commit `a68acf3` (pushed). Everything below is UNCOMMITTED, verified green.
| Item | Evidence |
|---|---|
| Connector concurrency cap — 503 at 6 per (session, connector), 64 global; handshake 15s / ceiling 120s unchanged (`connectorProxy.ts`) | `connector-concurrency-cap-test` 15/15; mutants C1–C5 killed; plan `.claude/plans/connector-concurrency-cap.md` |
| Notebook target identity (user bug: edits landed in the NEW active pane) — pin survives team turns (`TurnNotebookRegistry.onUserTurn`), explicit path honoured when open, optional `expect`, every result echoes name+path, `pathProp` rewritten | `active-pane-test` 35 assertions; plan `.claude/plans/notebook-target-identity.md` |
| Sandbox **A2** — `sandbox.ts` authorizers wired through `sandboxPaths.ts`; `!m.exists` fail-open removed first; `layer-not-wired-guard` retired; `authorizer-box-divergence-guard` green | all sandbox tests green, mutants 5/5; reviewed by QC + coordinator, no logic defect. Plan `.claude/plans/sandbox-migration-a2.md` |
| Phone layout — pending-card band and PermissionCard yield so the composer and Allow/Deny stay on screen (`ChatView.tsx`) | `shell-fixed-cost-probe`, `pending-card-squeeze-probe` 33/33 (now asserts a squeeze was needed) |
| Test fixes — `sound-notif-test` (flake + exact chime count), `real-turn` verdict (`turn-indicator.mjs` `output-arrived-at-turn-end`, 17/17, mutants 4/4), `model-picker-browser-test` (polled notice; opens ITS OWN row's menu, not the first), and the isolate-before-feed fix copied to the 7 other synthetic-feed :4321 harnesses (attention, history-resume, notebook-session, notifications, optimistic-busy, ratelimit, ready-clobber) | :4321 group 5/5 runs green; full suite 2026-10-06: 115 pass, 0 fail, 6 jupyter skips |
| `HANDOVER.md` split; history in `HANDOVER-ARCHIVE.md` | — |

**Live server :4319** runs the 2026-10-04 code (confirmed by Landing): it does NOT have the items above
until a restart — the user's call. **`web/dist`** (`index-BvFpsqG7.js`) has both layout fixes, but a later
comment-only edit to `ChatView.tsx` makes it older than its sources, so the suite calls the 12 bucket-1
browser harnesses uninterpretable until the next rebuild (needs `web/dist` write access).

### Open — deferred by the user (need read-only paths)
1. **Possible residual fail-open, settle BEFORE A3** (QC, [likely], unexecuted): `refuseIfBoxCouldHavePlaced`
   (`sandboxPaths.ts`) never realpaths the candidate. Logical path outside every mount, real path inside an
   rw mount (`/elsewhere/link` → `/srv/app/x`, rw mount `/proj` → `/srv/app`) ⇒ no refusal ⇒ venv probe on
   the HOST. Pre-dates A2. Fix: also compare `real(p)` against `m.real`.
2. Stale comment `sandbox.ts` ~:599 (still says sandbox.ts does not import sandboxPaths.ts).
3. A3–A6 (outline in the A2 plan §7). Open precondition: `viewOf` is unbranded and applies no refusal;
   close it before or with A4 (the only argv change).
4. `web/dist` rebuild (see above).

### Open — other
- Confined background-output read via `/proc/<inner pid>/root` never verified end to end (needs a logged-in sandboxed session).
- Jupyter tests skip from confined sessions: `jupyter_server` is in `~/.local/lib/python3.12/site-packages`, invisible here. From an unconfined session they pass (5/5 + 1 bundle-dependent).

### Key decisions (non-obvious)
- Notebook pin: a HUMAN turn still re-binds to the user's pane; team/mailbox turns do not.
- Connector N+1 is REJECTED (503, JSON-RPC `id:null`), never queued; the global cap has its own wording so a test can tell the two caps apart.
- A2 widened the authorizer to "any surviving mount grants" — matches measured bwrap; user approved.
- Persisted running bashProc rows restore as `'unknown'`, never `'failed'`; `bashProcKillable` is `status === 'running'`, not `isLiveBashProc`.

### Gotchas
- **Mounts flip** per session and over time. `test -w` immediately before writing.
- `list_team`'s `blockedOnPermissionPrompt` can be stale — check for progress before reassigning.
- Check the artefact, never `$?` (`patch`, `vite build`, pipelines all exit 0 while failing).
- Bundle probes: grep the file `index.html` references, for rendered text or a literal className; a runtime-assembled sentence never greps.
- `pkill -f` / `pgrep -f` match their own command line.
- Mutate a COPY; report `ran=N` + an XX control; a surviving mutant is only as good as the mutant.

### Next steps
1. Commit only on the user's order (scope by feature: connector cap · notebook target · A2 · layout · test fixes · docs).
2. When the user enables write access: items 1–4 above, in that order; then restart :4319 (user's call).

### References
Plans: `.claude/plans/` · role notes: `.claude/team-handovers/` · all older history (2026-07-13 .. 2026-10-04): `HANDOVER-ARCHIVE.md` — read on demand.
