// The background-process panel's DECISIONS, extracted from App.tsx for exactly the reason
// lib/sessionLights.ts states in its own header: NOTHING IN THIS REPO IMPORTS App.tsx. A rule
// written inline at a JSX call site is invisible to the web suite, to the reducer harness and
// to typecheck all at once — which is how the mute wiring shipped broken past three green
// suites. So every rule here that has a failure mode lives where it can be asserted; App.tsx
// keeps only the rendering.
//
// A background process is a `Bash` tool call made with `run_in_background: true`. The server
// keeps the registry (see the BashProcRecord notes in shared) and broadcasts it; the browser
// never derives one from the transcript, unlike subagents.
import type { BashProcRecord, BashProcOutputResponse } from '@claudette/shared'

// The four lifecycle states, named off the record so this file cannot drift from the wire
// contract. Deliberately NOT re-declared as a literal union here: a second copy of a
// population is a second thing to forget to update, and the shared type is the one the
// server writes.
export type BashProcStatus = BashProcRecord['status']

// ★ 'stopped' AND 'unknown' ARE DIFFERENT OUTCOMES AND BOTH ARE REAL.
// 'stopped' means the CLI told us the process was stopped — normally because the user pressed
// the kill button in this very panel. Measured across the transcript corpus it is the SECOND
// most common shell outcome (completed 15, stopped 12, failed 2), so it is an everyday path,
// not an edge. It is deliberately NOT folded into 'unknown': we know exactly what happened,
// and "unknown" would throw that information away and assert something false.
//
// ★ 'unknown' IS A REAL OUTCOME, NOT A LEFTOVER, and every function below has to honour that.
// A background shell is a child of the CLI, which is a child of the server, so a server
// restart kills it — and the settle pass that runs on engine death genuinely cannot know
// whether the command had succeeded first. A subagent that dies with its engine failed; a
// shell killed by a restart has no knowable outcome, and rendering it as a failure asserts
// something false to the user about their own build/test run. It is grey and it says so.

// Is this process still going? The ONLY live state is 'running'; 'unknown' is terminal
// despite sounding open-ended — nothing further will ever arrive for it, because the engine
// that would have reported it is gone.
//
// The switch is exhaustive on purpose. If the status union ever grows a fifth member this
// line stops compiling, which is the entire point: the alternative — `status === 'running'`
// with an implicit false for everything else — would silently classify a new state as dead,
// and a live process missing from the badge is the one failure this panel exists to prevent.
export function isLiveBashProc(status: BashProcStatus): boolean {
  switch (status) {
    case 'running': return true
    case 'done': return false
    case 'failed': return false
    case 'stopped': return false
    case 'unknown': return false
    default: {
      const _exhaustive: never = status
      void _exhaustive
      // A build that somehow shipped past the check above fails in the SAFE direction: an
      // unrecognised state counts as live, so it shows in the badge and can be looked at,
      // rather than vanishing from the panel entirely.
      return true
    }
  }
}

// The status dot, mirroring AgentStatusDot's shape so the two sidebar lists speak one
// language. Returns classes rather than JSX so it is assertable without a DOM.
//
// THE HUE CHOICE, and its one deliberate collision. Green is this panel's colour (mauve is
// taken by subagents, peach by notebook kernels), so running and done are both green and are
// told apart by the PULSE — which is the honest signal, because "is it still going?" is the
// only question a glance at this list is asking. Failed is red, as everywhere else in the
// app. Unknown is overlay grey: it must be visibly not-a-failure, since red would accuse a
// perfectly fine build of having broken when in fact the server was restarted underneath it.
export function bashProcDot(status: BashProcStatus): { cls: string; title: string } {
  switch (status) {
    case 'running': return { cls: 'bg-ctp-green animate-pulse', title: 'running' }
    case 'done': return { cls: 'bg-ctp-green', title: 'done' }
    case 'failed': return { cls: 'bg-ctp-red', title: 'failed' }
    // Overlay grey, and NOT red: being stopped is the outcome of the user asking for it, so
    // colouring it as a failure would report their own deliberate action back to them as
    // something having gone wrong. This is also exactly what AgentStatusDot already renders
    // for a stopped agent, and the two sidebar lists sit one above the other — they should
    // not disagree about what "stopped" looks like.
    case 'stopped': return { cls: 'bg-ctp-overlay', title: 'stopped' }
    case 'unknown': return { cls: 'bg-ctp-overlay', title: 'outcome unknown' }
    default: {
      const _exhaustive: never = status
      void _exhaustive
      return { cls: 'bg-ctp-overlay', title: String(status) }
    }
  }
}

// The word beside the dot in the detail header, and the text colour that goes with it.
// Split from bashProcDot because the header wants a phrase ("outcome unknown — the session
// restarted") where the list wants a tooltip, and letting one function serve both had it
// returning a string too long for a 1.5px dot's title.
export function bashProcStatusText(status: BashProcStatus): { label: string; text: string } {
  switch (status) {
    case 'running': return { label: 'running', text: 'text-ctp-green' }
    case 'done': return { label: 'done', text: 'text-ctp-green' }
    case 'failed': return { label: 'failed', text: 'text-ctp-red' }
    case 'stopped': return { label: 'stopped', text: 'text-ctp-overlay' }
    // Phrased as a fact about what we know rather than about the process, because the
    // process may well have finished perfectly — we simply stopped being able to see it.
    // ★ The LABEL is what separates this from 'stopped' above: both render the same grey dot
    // (neither is a success and neither is a failure), so the word is the only channel
    // carrying the difference between "you stopped it" and "we lost track of it".
    case 'unknown': return { label: 'outcome unknown', text: 'text-ctp-overlay' }
    default: {
      const _exhaustive: never = status
      void _exhaustive
      return { label: String(status), text: 'text-ctp-overlay' }
    }
  }
}

// What the sidebar badge shows: how many processes this session has, and how many are still
// going (the pulse). `null` means draw nothing at all — same grammar as the kernels badge,
// which is absent rather than showing a zero.
//
// TOTAL, NOT JUST LIVE, and that is a call worth stating. A finished background process is
// still the thing the user wants to look at — its exit code and summary are the whole reason
// they backgrounded it — so the count that vanishes the moment a build finishes would hide
// the answer at exactly the moment it arrived. The pulse carries "still going"; the number
// carries "there is something here".
export function bashProcBadge(procs: readonly BashProcRecord[]): { total: number; live: number } | null {
  if (procs.length === 0) return null
  return { total: procs.length, live: procs.filter((p) => isLiveBashProc(p.status)).length }
}

// How long this process has been going, in ms. A finished one is frozen at its own span; a
// running one grows with `now`.
//
// ★ `now` IS AN ARGUMENT, NOT A Date.now() CALL, for two reasons that both bit something else
// in this repo. It makes the function testable without faking a clock, and it lets the caller
// own the tick rate — a component that read the clock itself would either need its own timer
// or would silently freeze the elapsed reading until some unrelated re-render happened to
// come along.
//
// Clamped at zero. `startedAt` is the SERVER's clock and `now` is the BROWSER's, so a client
// whose clock lags the server's by a few seconds would otherwise render a brand-new process
// as having started in the future and count backwards.
//
// ★ RETURNS null WHEN THE START TIME IS NOT USABLE, and the caller must render that case
// rather than a number. This is not defensive padding — it was MEASURED. A record settled in
// BULK (the corpus contains notifications carrying several <task-id>s and no <tool-use-id>,
// which settle processes the server may never have watched start) can plausibly reach the
// client with no real `startedAt`. Fed to the arithmetic below, `startedAt: 0` renders
// "496961h 21m" and an absent one renders "NaNh NaNm" — both measured, both in the detail
// header, and both are the kind of thing a user reports as "the panel is broken" rather than
// as the missing timestamp it actually is. `null` forces the caller to say "unknown", which
// is the true statement.
export function bashProcElapsed(proc: Pick<BashProcRecord, 'startedAt' | 'endedAt'>, now: number): number | null {
  if (!Number.isFinite(proc.startedAt) || proc.startedAt <= 0) return null
  return Math.max(0, (proc.endedAt ?? now) - proc.startedAt)
}

// A duration as a compact span: "4s", "2m 14s", "1h 3m". Distinct from lib/ago.ts, which
// answers "how long ago was this instant" — that reads "just now" for anything under a
// minute, which is precisely wrong for a process you are watching run, where the seconds
// ticking over are the feedback that it is alive.
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// The one-line name for a process — the sidebar row, and the label a detail tab keeps.
// Mirrors agentTabLabel, including its fallback chain: the model's own `description` is the
// best name it will ever have, the command is the honest second-best, and a literal is the
// last resort so a tab is never blank.
//
// The command is collapsed to its FIRST LINE and truncated. A backgrounded command is
// routinely a multi-line heredoc — pasted whole into a sidebar row it would blow the layout
// out, and into a tab strip it would push every other tab off screen.
export function bashProcLabel(proc: Pick<BashProcRecord, 'command' | 'description'>, max = 60): string {
  const d = proc.description?.trim()
  if (d) return truncate(d, max)
  // ★ `?? ''` IS LOAD-BEARING AND TYPECHECK CAN NEVER TELL YOU SO. The type says
  // `command: string`, but this record arrived through JSON.parse off a socket — the compiler
  // is asserting a property of a server that, at the time of writing, did not yet exist. A
  // record missing `command` made this throw `Cannot read properties of undefined (reading
  // 'split')`, and because BashProcLine calls this DURING RENDER, React unmounted the whole
  // SessionRow subtree: one malformed record blanked the sidebar's entire session list, not
  // just its own row. `description` directly above was already guarded with `?.trim()`, which
  // is what made the gap look accidental rather than decided. The existing fallback below
  // then covers the empty string with no further branching.
  const first = (proc.command ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return first ? truncate(first, max) : 'background command'
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`
}

// May this process be killed — i.e. should either kill control be OFFERED at all?
//
// ★ DELIBERATELY NOT BUILT ON isLiveBashProc, AND THE REASON IS THE WHOLE POINT OF EXTRACTING
// THIS. That function defaults an UNRECOGNISED status to `true`, argued in its own comment as
// the safe direction — and it is, for the badge, where "unknown state" should still show and
// be inspectable. Routed into a destructive control the identical default becomes the UNSAFE
// direction: it would offer a kill for a state we do not understand. The two consumers want
// OPPOSITE defaults from the same unknown input, so this asks `status === 'running'`
// explicitly. For every state that exists today the two agree exactly; for one that does not
// yet, the badge shows it and this hides the button, which is the right way round for each.
//
// The shellId half: the CLI reports it in an ack a moment after the launch, and a
// conversation resumed from disk never replays it. Without it the kill cannot be routed at
// all — and per the engine's own note the CLI answers an unroutable stop with SUCCESS, so a
// button offered here would silently do nothing and report that it had worked.
//
// EXTRACTED because this rule previously lived inline at BOTH call sites — one in App.tsx,
// which this module's header names as the repeatedly-bitten "nothing imports it" hazard, and
// one in BashProcDetail.tsx, which has no test file at all. It is the single destructive
// control in this feature and it was the only rule with a failure mode still written twice
// where nothing could assert it.
export function bashProcKillable(p: Pick<BashProcRecord, 'status' | 'shellId'>): boolean {
  return p.status === 'running' && !!p.shellId
}

// Can we still show this process's output?
//
// ONLY WHILE THE ENGINE IS ALIVE, AND THAT IS A LEVELLING-DOWN, NOT A LIMITATION WE HIT.
// It was measured both ways: an unconfined session writes its output file to the real /tmp,
// where it survives the engine's death indefinitely; a confined session writes to a private
// tmpfs that is reachable only through the live process's /proc entry, and dies with the
// namespace. So history is genuinely available for one tier and genuinely impossible for the
// other, at any price.
//
// Showing it for the sessions that can would make the panel remember for some sessions and
// forget for others, with nothing on screen explaining why — an inconsistency the user would
// discover rather than us. It also lines up with 'unknown' above: once the engine is gone we
// do not know the outcome, and half-knowing the output is worse than saying so. Both tiers
// lose it, and the pane says why instead of showing an empty box.
export function bashOutputAvailable(engineAlive: boolean): boolean {
  return engineAlive
}

// ── The output pane's decisions ─────────────────────────────────────────────────────────
// Extracted for the same reason as everything above: the component is not where a rule can
// be tested.

// Should the output pane keep re-fetching? Only while the process is still going AND its
// engine is alive. Polling a finished process wastes requests on a file that will not change;
// polling after the engine is gone asks a question the server will always answer "no".
// Deliberately NOT built on isLiveBashProc: an unrecognised status defaults to live there
// (the safe direction for a badge), which here would mean polling forever for a state we do
// not understand. `status === 'running'` is explicit, like bashProcKillable, for that reason.
export function shouldPollOutput(status: BashProcRecord['status'], engineAlive: boolean): boolean {
  return status === 'running' && engineAlive
}

export const OUTPUT_POLL_MS = 2000

// What the pane shows for a response. Three kinds, kept apart ON PURPOSE:
//   output — text to render (possibly empty, which is an ordinary state, not an error)
//   reason — the server could not give output, and SAYS WHY, verbatim; "nothing written yet"
//            and "we can no longer reach it" both look like a blank pane and only the words
//            separate them, so the words are the content
//   error  — the request itself failed. Distinct from `reason` because it means something is
//            wrong (the client asked about a row the server does not have, or the network
//            failed), and rendering it like an ordinary "not yet" would hide a bug
export type OutputDisplay =
  | { kind: 'output'; text: string; truncated: boolean }
  | { kind: 'reason'; text: string }
  | { kind: 'error'; text: string }

export function outputDisplay(r: BashProcOutputResponse | Error): OutputDisplay {
  if (r instanceof Error) return { kind: 'error', text: r.message || 'The output could not be loaded.' }
  if (!r.ok) return { kind: 'error', text: r.error || 'The output could not be loaded.' }
  if (!r.retrievable) return { kind: 'reason', text: r.reason }
  return { kind: 'output', text: r.output, truncated: r.truncated }
}
