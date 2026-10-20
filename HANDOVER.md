# Claudette — Handover
_Last updated: 2026-10-19._

<!-- Deliberately no "working tree is clean" line here. The previous one was stale the
     moment it was written and stayed wrong for a month, which is the same failure this
     document's rewrite exists to fix: run `git status` — it is authoritative and this
     file cannot be. -->


## ⛔ COORDINATOR HANDOVER — 2026-10-19. READ FIRST.

Coordinator = this session, named **Claudette**. Team: one implementer, **Landing**, hired 2026-10-15 for the
paths this session cannot write (`server/src`, `shared/src`, `web/dist` — probe with `test -w`; mounts flip).
The user approves Landing's permission prompts by hand, so it is often paused; that is expected.
Earlier teammates' exit reports are the role notes in `.claude/team-handovers/`.

### Status
**master is ahead of origin, NOT pushed** (the user is holding the push). Local commits since `a68acf3`:
connector concurrency cap · notebook target identity · sandbox A2 · phone layout · test de-flakes ·
handover split (all 2026-10-14) · sidebar order: muted families sink to the bottom, every light change
re-sorts, no pin (`web/src/lib/sessionOrder.ts`, 2026-10-19) · the sandbox fixes below (2026-10-19).
Run `git log origin/master..` for the exact list.

**Live server :4319** has none of the server-side items until a restart — the user's call. `web/dist`
(`index-aVaKRvrT.js`, 2026-10-19) is current and has the sidebar change; reload the browser to see it.

### Open — sandbox (as of 2026-10-19)
Committed 2026-10-19: QC's symlinked-candidate fail-open fix, A3, F1 (state dirs hidden under ro mounts
and at their real spelling), F2 (a `/` mount: containment, overlays, cwd). All verified by Landing and the
coordinator; NOT live until :4319 restarts.
1. **F3 — KNOWN, fails CLOSED, unfixed.** Since A3, `symlinkMountRefusal` builds its roots with `viewOf`,
   so a REFUSED rw symlinked mount still contributes its real target as a root. A box-planted link at a path
   the user lists as an rw mount can then get OTHER symlinked mounts refused at next launch. F2 amplifies it:
   a planted link to `/` refuses every symlinked mount, including the project — the session cannot start.
   Not an escape. Also: `appSourceProtections` / `hiddenStateDests` consume the UNREFUSED mount list (the A4
   precondition). Landing could not write the F3 analysis (a safety classifier stopped it); the user chose to
   ship without F3 and handle it later.
2. A4–A6 (outline in `.claude/plans/sandbox-migration-a2.md` §7). A4 must take only refused-clean mounts.
3. B — `normalizeSandbox` does not trust-gate mount widening for untrusted callers.

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

### Next steps (one item at a time; present each to the user and ask)
1. Push — on the user's order.
2. Restart :4319 — the user's call; it makes the connector cap, notebook fix and sandbox fixes (incl. F1) live.
3. F3, then A4–A6, then B — see "Open — sandbox".

### References
Plans: `.claude/plans/` · role notes: `.claude/team-handovers/` · all older history (2026-07-13 .. 2026-10-04): `HANDOVER-ARCHIVE.md` — read on demand.
