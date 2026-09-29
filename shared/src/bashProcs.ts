// Parsing the CLI's background-bash wire format. Pure string work, no I/O, so it can be
// exercised against verbatim transcript strings without a server, a browser or an API call.
//
// ★ EVERY SHAPE BELOW WAS MEASURED FROM REAL TRANSCRIPTS, NOT FROM THE SPEC — and that
// distinction earned itself twice. The plan's §1 recorded the status vocabulary as
// "completed and failed only" and documented a single-`<task-id>` envelope. Both were wrong:
// `stopped` is the second most common shell outcome (measured per-envelope over the whole
// corpus, shell-shaped ids only: completed 15 / stopped 12 / failed 2), and some
// notifications carry SEVERAL task-ids plus a synthetic sentinel. A parser written to the
// paraphrase would have read the first id and stranded the rest as running forever — which is
// precisely the failure the panel exists to make visible.
import { BASH_PROC_STATES, type BashProcStatus } from './types'

// A synthetic id the CLI adds to its orphan round-up. NOT a shell — rendering it produces a
// phantom row that never settles. Matched by PREFIX: the observed value is
// `__orphan_summary__:shell`, and the `:shell` suffix implies sibling kinds we have not seen.
export const ORPHAN_SENTINEL_PREFIX = '__orphan_summary__'

export function isOrphanSentinel(id: string): boolean {
  return id.startsWith(ORPHAN_SENTINEL_PREFIX)
}

export interface BackgroundAck {
  shellId: string
  outputFile?: string
}

// The tool_result that acknowledges a backgrounded Bash, verbatim:
//   Command running in background with ID: btxytcvrw. Output is being written to:
//   /tmp/claude-1000/<mangled-cwd>/<session-uuid>/tasks/btxytcvrw.output. You will be
//   notified when it completes. To check interim output, use Read on that file path.
//
// ⚠ THE ID IS FOLLOWED BY A FULL STOP, AND `\S+` EATS IT. That is not hypothetical: a probe
// of mine captured `bajjb5k0n.` and sent the trailing period to the CLI, which then looked
// like "the CLI rejects shell ids". Bound the character class instead of trusting whitespace.
export function parseBackgroundAck(text: string): BackgroundAck | null {
  const id = text.match(/running in background with ID:\s*([A-Za-z0-9_-]+)/i)
  if (!id) return null
  // Same discipline for the path: stop at whitespace or a quote, and require the .output
  // suffix, so the sentence's trailing period is never absorbed into the filename.
  const file = text.match(/(\/[^\s'"]*?\.output)\b/)
  return { shellId: id[1], ...(file ? { outputFile: file[1] } : {}) }
}

export interface BashNotification {
  // ALL of them, in document order. Never "the" task id — see the multi-id note above.
  taskIds: string[]
  toolUseId?: string     // absent on the orphan round-up
  outputFile?: string    // absent on the orphan round-up
  status: string         // the CLI's own word, unmapped — map with bashStatusFrom()
  summary?: string
  exitCode?: number
}

// Parse one <task-notification> envelope. Returns null when the text holds none, so a caller
// can hand it any turn text without pre-filtering.
export function parseBashNotification(text: string): BashNotification | null {
  const blk = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/)
  if (!blk) return null
  const body = blk[1]
  const status = body.match(/<status>([^<]*)<\/status>/)
  if (!status) return null
  const taskIds = [...body.matchAll(/<task-id>([^<]*)<\/task-id>/g)].map((m) => m[1])
  const tool = body.match(/<tool-use-id>([^<]*)<\/tool-use-id>/)
  const file = body.match(/<output-file>([^<]*)<\/output-file>/)
  const summary = body.match(/<summary>([\s\S]*?)<\/summary>/)
  const out: BashNotification = { taskIds, status: status[1] }
  if (tool) out.toolUseId = tool[1]
  if (file) out.outputFile = file[1]
  if (summary) {
    out.summary = summary[1]
    // TOLERANT ON PURPOSE — two prose forms exist and neither is structured data:
    //   completed (exit code 0)      failed with exit code 1
    // Absence is normal (the orphan round-up carries none), so this stays undefined rather
    // than defaulting to 0, which would claim a clean exit nobody observed.
    const code = exitCodeFrom(summary[1])
    if (code !== undefined) out.exitCode = code
  }
  return out
}

// THE EXIT CODE, extracted from summary PROSE — the only place the CLI reports it.
//
// ★ EXPORTED so BOTH ingestion paths can share it. It used to live inline inside
// parseBashNotification, which meant the STRUCTURED `system/task_notification` path in
// sessionManager had nothing to reuse and simply never set `exitCode`: the same command
// reported its code through one CLI notification shape and omitted it through the other.
// BashProcDetail renders `· exit N` only when defined, so the user saw an exit code appear or
// vanish depending on which shape arrived — indistinguishable from a real absence.
// Re-inlining the regex at the second site would reintroduce exactly the duplicated-population
// shape the isElevatedMode consolidation was written to remove.
//
// TOLERANT ON PURPOSE — two prose forms exist and neither is structured data:
//   completed (exit code 0)      failed with exit code 1
// Absence is normal (the orphan round-up carries none), so this returns undefined rather than
// defaulting to 0, which would claim a clean exit nobody observed.
export function exitCodeFrom(summary: string): number | undefined {
  const m = summary.match(/exit code (\d+)/)
  return m ? Number(m[1]) : undefined
}

// The shell ids in an envelope, with the sentinel removed.
export function shellIdsOf(n: BashNotification): string[] {
  return n.taskIds.filter((id) => !isOrphanSentinel(id))
}

// Map the CLI's word onto our record status. Anything unrecognised becomes `unknown` rather
// than being dropped or guessed: a status we have never seen is exactly "we do not know what
// happened", and inventing `failed` for it would assert something unobserved. That also means
// a NEW CLI status degrades safely instead of throwing.
export function bashStatusFrom(cliStatus: string): BashProcStatus {
  switch (cliStatus) {
    case 'completed': return 'done'
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
    default: return 'unknown'
  }
}

// Is this a state the process is still in? Derived by QUERYING the exported set rather than
// listing live states, so a sixth state cannot quietly join the "finished" side by omission.
export function isLiveBashStatus(s: BashProcStatus): boolean {
  return s === 'running'
}

export function bashProcStates(): readonly BashProcStatus[] {
  return BASH_PROC_STATES
}


// The response shape of GET /api/session/:id/bashProc/:toolId/output.
//
// ★ `retrievable: false` CARRIES A REASON RATHER THAN AN EMPTY `output`, and that is the whole
// point of the discriminant. "Nothing has been written yet" and "we can no longer reach it"
// both render as a blank pane, and only the words separate them — a user staring at an empty
// box cannot tell whether to wait or to give up. The client renders `reason` VERBATIM, so it
// is written for a person, not for a log.
//
// `ok: false` is reserved for a request that should not have been made — an unknown session or
// toolId. The UI only asks about a row it is already showing, so that means the client and the
// server's registry disagree about what exists, which is a bug to surface rather than an
// ordinary empty state to absorb.
export type BashProcOutputResponse =
  | { ok: true; retrievable: true; output: string; truncated: boolean }
  | { ok: true; retrievable: false; reason: string }
  | { ok: false; error: string }
