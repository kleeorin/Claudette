// Whether a session may AUTO-RESUME — pull in a conversation it was not explicitly told to
// open — extracted from ChatView for the reason lib/sessionLights.ts gives in its own header:
// nothing in this repo imports ChatView, so a rule written inline there is invisible to every
// suite at once. This one had already been wrong in production, which is the argument for
// moving it rather than commenting it.
//
// ★ THE RULE, AND WHY IT IS "ALONE IN THE DIRECTORY".
// The caller identifies a session's conversation by asking for the most recently touched
// conversation in its `cwd`. That is a correct identification only while the directory holds
// exactly ONE session — and `SessionInfo.cwd`'s own comment states that "a subsession shares
// its parent's cwd", so every subsession violates it by construction.
//
// The reported symptom: after a server restart, a subsession displayed its PARENT's
// conversation, because both resolved the same newest file. Two ROOT sessions opened on one
// directory collide in exactly the same way; the parent/child case is merely the one
// guaranteed to occur. Keying the guard on `parentId` would have fixed the guaranteed instance
// and left the other live and much harder to recognise, so the guard asks the question that
// actually matters: can this directory tell me which conversation is mine?
export function cwdIdentifiesSession(
  session: { cwd: string },
  sessions: readonly { cwd: string }[],
): boolean {
  return sessions.filter((s) => s.cwd === session.cwd).length <= 1
}

// The reasons NOT to resume that have nothing to do with IDENTIFYING the conversation.
// Factored out so the two callers below cannot drift: `mayAutoResume` (the cwd guess) and
// `autoResumePlan` (which can also resume by exact id) must apply the identical set, and
// duplicating a four-arm list is how one of them silently loses an arm.
function resumeBlocked(args: {
  session: { cwd: string } | undefined
  alreadyTried: boolean
  isFresh: boolean
  hasItems: boolean
  running: boolean
}): boolean {
  // ⚠ AN ABSENT SESSION IS NOT "no session" — it is "the list has not loaded yet", and the two
  // are indistinguishable here. Refusing is the safe reading: a resume declined too early can
  // still be retried, whereas one performed against a half-loaded list would be guessing from
  // an incomplete population, which is exactly what the cwd check depends on being complete.
  // This is the same empty-collection-treated-as-authoritative hazard that lib/sessionLights.ts
  // documents for pruneMutes.
  if (!args.session) return true
  return args.alreadyTried || args.isFresh || args.hasItems || args.running
}

// The full eligibility decision. Every arm is a reason NOT to resume, and they are kept
// separate rather than collapsed into one boolean so a test can name which one fired.
export function mayAutoResume(args: {
  // undefined while the session list has not arrived yet — see the note below.
  session: { cwd: string } | undefined
  sessions: readonly { cwd: string }[]
  alreadyTried: boolean   // once per session per app load
  isFresh: boolean        // just created here, so there is nothing to resume INTO
  hasItems: boolean       // a transcript is already on screen; never clobber it
  running: boolean        // a turn is in flight; never disturb it
}): boolean {
  // ⚠ AN ABSENT SESSION IS NOT "no session" — it is "the list has not loaded yet", and the two
  // are indistinguishable here. Refusing is the safe reading: a resume declined too early can
  // still be retried, whereas one performed against a half-loaded list would be guessing from
  // an incomplete population, which is exactly what the cwd check below depends on being
  // complete. This is the same empty-collection-treated-as-authoritative hazard that
  // lib/sessionLights.ts documents for pruneMutes.
  if (resumeBlocked(args)) return false
  return cwdIdentifiesSession(args.session!, args.sessions)
}

// ── RESUMING BY EXACT ID ────────────────────────────────────────────────────────────────────
// The repair the cwd guard was a stopgap for. `system/init` names the conversation the engine
// is actually on, so a session that has seen one needs no guess at all — including every
// subsession, which the cwd heuristic can never serve.

// This session's own conversation id, read off the newest `system/init` in a replayed or live
// event list. Returns undefined when no init is present, which is a real state and not an
// error: the transcript ring is capped, so a long-running session can evict its init, and a
// session whose engine has not started has never emitted one.
export function claudeSessionIdFromEvents(events: readonly unknown[]): string | undefined {
  let found: string | undefined
  for (const e of events) {
    const o = e as { type?: unknown; subtype?: unknown; session_id?: unknown }
    if (o.type !== 'system' || o.subtype !== 'init') continue
    // LAST init wins — a session relaunched mid-life (sandbox or role change) emits a fresh
    // one, and the newest names where the engine is now.
    if (typeof o.session_id === 'string' && o.session_id) found = o.session_id
  }
  return found
}

// What auto-resume should actually DO. Three outcomes rather than a boolean, because the two
// resume paths differ in a way a boolean cannot express — see `repoint` below.
export type AutoResumePlan =
  | { kind: 'skip' }
  // We know this session's own conversation. Read it by id; the directory is irrelevant.
  | { kind: 'byId'; conversationId: string }
  // We do not, but the directory holds exactly one session, so the newest file in it is
  // unambiguously ours.
  | { kind: 'byCwd' }

// ★ WHY `byId` MUST NOT CALL resumeInto, AND THIS IS THE POINT OF THE WHOLE CHANGE.
// `resumeInto` MOVES a session onto a different conversation. In the byCwd path that is the
// intent. In the byId path the id came from the engine's OWN init — it is already on that
// conversation — so re-issuing it is at best a no-op against the live process, and it is
// precisely the call that caused the reported damage: it overrode a restore the server had
// already performed correctly (persistence relaunches every restored session with `--resume`
// into its own saved claudeSessionId). Reading a conversation and repointing an engine are
// different acts, and only the first is wanted here.
export function autoResumePlan(args: {
  session: { cwd: string } | undefined
  sessions: readonly { cwd: string }[]
  alreadyTried: boolean
  isFresh: boolean
  hasItems: boolean
  running: boolean
  // This session's own conversation id, when the client has learned it. Undefined is the
  // ordinary early state, not a failure — see the note on the caller retrying.
  claudeSessionId: string | undefined
}): AutoResumePlan {
  if (resumeBlocked(args)) return { kind: 'skip' }
  // Exact beats heuristic, and it needs no cwd guard: knowing the id answers the question the
  // guard was protecting against.
  if (args.claudeSessionId) return { kind: 'byId', conversationId: args.claudeSessionId }
  if (cwdIdentifiesSession(args.session!, args.sessions)) return { kind: 'byCwd' }
  // ★ A SKIP HERE MUST NOT BE RECORDED AS "tried". The id typically arrives moments later, in
  // the connect snapshot, and the caller re-runs this on that change — so a session that
  // cannot be identified yet gets resumed exactly once the init lands. Marking it tried on
  // this branch would convert a temporary ambiguity into a permanently empty transcript, which
  // is the very symptom this change exists to remove.
  return { kind: 'skip' }
}
