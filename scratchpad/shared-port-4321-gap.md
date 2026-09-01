# The full-run lock does not protect the shared :4321 server

**Found by:** QA, 2026-09-01, while verifying the `ratelimit-test` fix (`0eb9bb7`).
**Owner of the fix:** Landing — `run-suite.sh`'s locking is its design. The finding and this
write-up are QA's; the decision about which option to take is not.

---

## The claim in one line

`.suite-run.lock` stops a second **full run** and stops **edits** to the fingerprinted trees.
It does nothing about a **single-file run**, and a single-file run of any `srv4321:` harness
silently connects to whatever server is already on the port — including a full run's.

## How I found it

I ran `ratelimit-test.mjs` about nine times to verify a fix while another session had a full
run in flight. I reported that as *port contention* — my harness binding `:4321` and locking
the suite's server out. **That was wrong, and the truth is worse.** Correcting it is the point
of this document.

## What is actually true

**No harness binds :4321.** All nineteen files that mention the port only *connect* to it:

    attention-test.mjs        history-resume-test.mjs   notebook-session-test.mjs
    notifications-test.mjs    optimistic-busy-test.mjs  ratelimit-test.mjs
    ready-clobber-test.mjs    sound-notif-test.mjs      real-turn-browser-test.mjs
    …plus the *-shot.mjs capture scripts and real-turn-capture.mjs

The only thing that binds it is `run-suite.sh`'s `start_shared_server`. So there is no port
*contention* — there is **server-state contamination**, which is quieter and harder to notice:

> A single-file run does not fail when a full run owns the port. **It succeeds — against the
> other run's server.** It creates sessions, injects websocket frames and mutates state inside
> the very server the full run is measuring. The single-file run prints a plausible result. The
> full run's numbers are corrupted, and nothing in either output says so.

## The protection that exists, and the direction it does not face

`start_shared_server` already guards the full run against a foreign holder — it refuses, tells
you `ALLOW_FOREIGN_4321=1` exists, and marks the eight shared-server tests `SKIP`. That check is
good and this document does not propose weakening it.

But it is **one-directional**. It protects a *starting full run* from a *pre-existing server*.
Nothing protects a *running server* from a *later single-file run*. The window this leaves open
is exactly the one I ran into: the full run starts first and legitimately owns the port, then a
single-file run walks in behind it.

**And a harness could not tell even if it tried.** `/api/health` (`server/src/index.ts:254`)
returns `{ ok, version, ts, sandboxAvailable, … }` — no data dir, no pid, no run id, nothing
identifying. There is no way for a connecting harness to answer "whose server is this?"

## Why the lock is not simply extended to cover this

Landing scoped the lock to full runs deliberately: *a lock that blocks single-file runs would
train everyone to ignore it*. That reasoning is right and it is why single-file runs stayed
free. The gap is not that the scoping was wrong — it is that **binding the port and owning the
server were treated as the same thing, and they are not.** Only run-suite binds; anyone can own
the state.

## Options, honestly stated

**A — identify the server, and have harnesses check.**
Add a run-id (or data-dir path) to `/api/health`; `start_shared_server` sets it; each `srv4321:`
harness refuses a server it does not recognise. Strongest: makes the failure impossible rather
than merely loud. Costs a `server/src` change plus ten harnesses — or one shared helper the way
`trust-gate.mjs` is shared.

**B — a server-owner file next to the run lock.** *(recommended near-term)*
`start_shared_server` writes `.suite-server.lock` (pid + run id + started-at) and removes it on
teardown; `srv4321:` harnesses read it and refuse, or warn loudly, when it is present and not
theirs. No `server/src` change, composes with the lock Landing just built, and lives in the same
place so there is one concept to learn rather than two. Turns a silent corruption into a refusal.

**C — document it and rely on discipline.**
"Check `--lock-status` before a single-file run of an `srv4321:` harness." Zero code. **Named
here for completeness and not recommended:** discipline is precisely what failed three times
this week, twice with people who had already learned the specific lesson.

**D — give single-file runs their own server on their own port.**
Removes sharing for standalone use entirely and kills the class of bug rather than detecting it.
Largest change; worth considering if these harnesses are touched for other reasons.

## Recommendation

**B now, A if `server/src` is being opened anyway.** B is cheap, it is loud, and it puts the
answer where someone already looks. C alone does not survive contact with the evidence.

## What is not claimed

I did **not** observe a corrupted run caused by this. My own nine runs each checked `ss` for a
holder and started their own server, so they aborted rather than borrowing — the hazard is real
by construction, not by a captured instance. Whoever implements a fix should be able to
demonstrate it in both directions: a single-file run refusing while a full run owns the port,
**and** running normally when nothing does. A guard that cannot be shown to fire is the defect
this repo has spent the week learning to distrust.
