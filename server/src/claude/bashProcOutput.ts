// Reading a background shell's output file — the filesystem half of
// GET /api/session/:id/bashProc/:toolId/output.
//
// Split out of sessionManager deliberately: the interesting logic here is all about paths and
// process lifetimes, none of it needs a SessionManager, and keeping it separate is what lets it
// be tested against REAL files and a REAL absent file rather than a mock that returns whatever
// it was told to.
//
// ★★ TWO FACTS THAT EACH COST A WRONG CONCLUSION BEFORE. Read both before editing.
//
// 1. A CONFINED SESSION'S OUTPUT FILE IS NOT ON THIS FILESYSTEM. `sandbox.ts` gives every
//    confined session `--tmpfs /tmp`, a private empty tmpfs, and the CLI writes its background
//    output under /tmp. The server cannot see that path from its own view at all. It IS
//    reachable through the live process's `/proc/<pid>/root` — measured, including that the
//    file tracks appends live — but only through the INNER pid. The engine's own pid is the
//    OUTER `bwrap` process (launch() wraps the command), and `/proc/<outer>/root` does not
//    resolve to the box. Implementing from the engine pid yields ENOENT and the wrong lesson.
//
// 2. ONCE THE ENGINE IS GONE, OUTPUT IS UNRETRIEVABLE FOR BOTH TIERS — DELIBERATELY.
//    A confined session's file dies with its namespace, so it is genuinely impossible. An
//    UNCONFINED session's file does survive on the real /tmp, and we refuse to read it anyway.
//    That is a levelling DOWN, not a limitation we hit: a panel that remembers for some
//    sessions and forgets for others is the two-tier behaviour this design rejected, and the
//    inconsistency would be discovered by a user rather than by us. Levelling down costs one
//    condition; levelling up is impossible for confined sessions at any price.
import { readFileSync, statSync, openSync, readSync, closeSync, readdirSync } from 'fs'

// How much of the file to return. The TAIL, not the head: someone opening this pane wants to
// know what the command is doing NOW, and the head of a build log is its least interesting
// part. 256 KiB is far more than a pane can show and far less than a JSON body should carry.
export const MAX_OUTPUT_BYTES = 256 * 1024

export type BashOutputRead =
  | { retrievable: true; output: string; truncated: boolean }
  | { retrievable: false; reason: string }

// Walk from the outer (bwrap) pid to the process whose /proc/<pid>/root IS the box.
//
// `/proc/<pid>/task/<tid>/children` is used rather than shelling out to `pgrep -P`: it needs no
// subprocess, and `pgrep -f` in particular has a documented habit in this repo of matching its
// OWN command line. Returns the outer pid unchanged when it has no children, which is the right
// answer for an UNSANDBOXED session — there `spawn` is `claude` itself and no walk is wanted.
export function innerPidOf(outerPid: number): number {
  try {
    for (const tid of readdirSync(`/proc/${outerPid}/task`)) {
      const raw = readFileSync(`/proc/${outerPid}/task/${tid}/children`, 'utf8').trim()
      if (!raw) continue
      const first = Number(raw.split(/\s+/)[0])
      if (Number.isInteger(first) && first > 0) return first
    }
  } catch { /* process gone, or /proc not available — fall through */ }
  return outerPid
}

// Where this server can find the file, given who is asking.
// An unsandboxed session's path is simply itself; a sandboxed one is reachable only under the
// live inner process's root.
export function resolveOutputPath(outputFile: string, sandboxed: boolean, enginePid: number | undefined): string | null {
  if (!sandboxed) return outputFile
  if (enginePid === undefined) return null
  return `/proc/${innerPidOf(enginePid)}/root${outputFile}`
}

// The whole decision. Every `retrievable: false` carries a reason written FOR A USER — the UI
// renders it verbatim — because "nothing written yet" and "we can no longer reach it" both look
// like a blank pane and only the words separate them.
export function readBashProcOutput(args: {
  outputFile: string | undefined
  engineAlive: boolean
  enginePid: number | undefined
  sandboxed: boolean
  maxBytes?: number
}): BashOutputRead {
  const { outputFile, engineAlive, enginePid, sandboxed } = args
  const maxBytes = args.maxBytes ?? MAX_OUTPUT_BYTES

  // Checked BEFORE the path, and before the file exists, because it is true regardless of
  // either — see fact 2 above. Doing it in this order is what makes the two tiers behave the
  // same, rather than the unconfined one accidentally succeeding.
  if (!engineAlive) {
    return { retrievable: false, reason: "This session's engine has stopped, so the command's output is no longer retrievable." }
  }
  // `outputFile` on the record is PROVENANCE ONLY. Its absence means the CLI never told us
  // where it was writing — usually because the launch acknowledgement has not arrived yet.
  if (!outputFile) {
    return { retrievable: false, reason: 'No output file has been reported for this command yet.' }
  }

  const path = resolveOutputPath(outputFile, sandboxed, enginePid)
  if (path === null) {
    return { retrievable: false, reason: "This session's process is not running, so its output cannot be reached." }
  }

  let size: number
  try {
    size = statSync(path).size
  } catch {
    // Distinguished from "engine gone" on purpose: the command may simply not have written
    // anything yet, which is an ordinary state a user should not read as an error.
    return { retrievable: false, reason: 'Nothing has been written to the output file yet.' }
  }

  if (size === 0) return { retrievable: true, output: '', truncated: false }

  // Read only the tail, by offset — not readFileSync().slice(), which would pull a whole
  // multi-megabyte build log into memory just to discard the front of it.
  const start = size > maxBytes ? size - maxBytes : 0
  const length = size - start
  const buf = Buffer.allocUnsafe(length)
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const got = readSync(fd, buf, 0, length, start)
    return { retrievable: true, output: buf.subarray(0, got).toString('utf8'), truncated: start > 0 }
  } catch {
    return { retrievable: false, reason: "The output file could not be read from this session's process." }
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* already gone */ } }
  }
}
