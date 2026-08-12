import type { SessionInfo, TeamMessage } from '@claudette/shared'
import { formatTeamMessage } from '@claudette/shared'

// The team message bus. A session-to-session message is delivered by INJECTING it as a
// user turn into the recipient (SessionManager.sendUserTurn), which is what makes it
// render in the recipient's chat and survive a reconnect — the transcript buffer is
// the single source for user-side turns.
//
// THE RULE THAT SHAPES THIS FILE: never interrupt a turn in flight. A message for a
// BUSY session is queued and delivered when it next goes idle. A coordinator running
// a long turn therefore collects its team's reports and receives them together the
// moment it comes free, instead of having its reasoning cut in half.
//
// The mailbox knows nothing about SessionManager: it takes a small host seam and is
// driven from index.ts, which already has the session event stream. That's deliberate —
// the manager emits 'stateChange', the mailbox listens, and neither imports the other.

// What the mailbox needs from the session layer.
export interface MailboxHost {
  // Undefined once a session is destroyed; `state === 'exited'` once its engine died.
  info(id: string): SessionInfo | undefined
  // Inject a turn. Must route through the path that mirrors + buffers it (sendUserTurn
  // with origin 'team'), NOT straight at the engine, or the message will never appear
  // in the recipient's transcript.
  //
  // Resolves false when the turn was NOT actually written. That is a real case, not a
  // theoretical one: clear_self restarts a session, so between the kill and the relaunch
  // there is a window where the state still reads 'idle' but a turn would be swallowed.
  // It is async because the write itself is — sendUserTurn awaits a git snapshot first,
  // and a relaunch can land inside that await — so the mailbox must wait for the real
  // answer before it can consider the batch gone.
  deliver(id: string, text: string): Promise<boolean>
}

// Deliveries allowed per team between human turns. A star topology makes a true cycle
// hard (members can't reach each other), but a coordinator and one member can still
// volley — each report prompting a follow-up prompting another report. This bounds
// that volley without capping legitimate fan-out: a 6-member team getting two rounds
// of instruction and reply costs 24.
const BUDGET_PER_HUMAN_TURN = 40

// Cap on messages held for one busy recipient. Past this, the sender is told rather
// than the queue growing without limit behind a session that may never come idle.
const QUEUE_CAP = 50

// Coalescing window. Several members reporting into a busy coordinator within the same
// tick should land as ONE turn; without this each would cost the coordinator a full
// turn to read. Short enough to be invisible, long enough to catch a burst.
const DRAIN_DEBOUNCE_MS = 50

// Retry delay after a delivery found no live engine (a session mid-restart). Long
// enough not to spin, short enough that a re-seeded context gets its handover promptly.
const DRAIN_RETRY_MS = 200

// A queued message plus whatever the sender wants run once it has genuinely landed.
interface Queued {
  msg: TeamMessage
  onDelivered?: () => void
}

interface Pending {
  queue: Queued[]
  timer?: ReturnType<typeof setTimeout>
  // A turn we've injected that the session hasn't started yet. State flips to 'running'
  // asynchronously after sendUserTurn, so without this flag a second message arriving in
  // that gap would see 'idle' and inject a SECOND turn on top of the first. Cleared by
  // onIdle — the recipient coming free is what ends the wait.
  awaitingTurn?: boolean
  // A delivery currently suspended inside deliver(). Distinct from awaitingTurn because it
  // is owned SOLELY by drain(): onIdle clears awaitingTurn, and a stateChange→idle can
  // arrive mid-delivery (the engine-exit `replacing` branch re-emits the session's
  // unchanged state on a relaunch), which would otherwise re-open the gate and let a second
  // drain inject concurrently — landing the two turns out of order.
  delivering?: boolean
}

export type SendResult = { ok: true; queued: boolean } | { ok: false; error: string }

export class TeamMailbox {
  private pending = new Map<string, Pending>()
  // teamId (the coordinator's session id) → deliveries left before the next human turn.
  private budget = new Map<string, number>()

  constructor(private readonly host: MailboxHost) {}

  // The team a session belongs to is named by its coordinator: a member's parentId, or
  // a coordinator's own id. Both ends of any edge therefore map to the same budget.
  private teamOf(id: string): string {
    return this.host.info(id)?.parentId ?? id
  }

  // Queue (or immediately deliver) a message. Returns an error the CALLING tool hands
  // straight back to the model — refusals have to be legible to Claude, not silent.
  //
  // `onDelivered` fires when the message has actually been handed to the recipient's
  // engine, which is NOT when send() returns: a busy recipient gets it a turn or more
  // later. Callers that must act on receipt rather than on queueing (dismissal waits for
  // the teammate to have really been asked) hang off this instead of assuming.
  send(targetId: string, msg: TeamMessage, onDelivered?: () => void): SendResult {
    const target = this.host.info(targetId)
    if (!target) return { ok: false, error: `session ${targetId} no longer exists` }
    if (target.state === 'exited') {
      return { ok: false, error: `${target.name} is not running (its engine exited), so it cannot receive messages` }
    }

    // Check the queue cap BEFORE spending budget: a send that gets refused here never
    // happened, so charging for it would let a wedged recipient drain the whole team's
    // allowance and start refusing everyone else's messages too.
    const p = this.pending.get(targetId) ?? { queue: [] }
    if (p.queue.length >= QUEUE_CAP) {
      return { ok: false, error: `${target.name} already has ${QUEUE_CAP} messages waiting and hasn't come free — not queuing more` }
    }

    const team = this.teamOf(targetId)
    const left = this.budget.get(team) ?? BUDGET_PER_HUMAN_TURN
    if (left <= 0) {
      return {
        ok: false,
        error: 'team message budget exhausted for this turn — the team is talking in circles. '
          + 'Stop sending, summarise what you have, and end your turn so the user can weigh in.',
      }
    }
    this.budget.set(team, left - 1)

    p.queue.push({ msg, onDelivered })
    this.pending.set(targetId, p)

    const canDeliverNow = target.state === 'idle' && !p.awaitingTurn
    this.scheduleDrain(targetId)
    return { ok: true, queued: !canDeliverNow }
  }

  // A session went idle: the turn we were waiting on is over, so anything held for it
  // can go now. Driven from the 'stateChange' stream in index.ts.
  onIdle(id: string): void {
    const p = this.pending.get(id)
    if (!p) return
    p.awaitingTurn = false
    this.scheduleDrain(id)
  }

  // A HUMAN turn resets the team's budget — a new instruction from the user is a new
  // task, and the volley protection should not leak across tasks. Only genuine user
  // input may call this: routing injected turns through here as well would have every
  // team message refill the very budget meant to bound it.
  onHumanTurn(id: string): void {
    this.budget.delete(this.teamOf(id))
  }

  // Messages waiting for a session — surfaced by list_team so a coordinator can see it
  // has a report pending rather than wondering why a teammate has gone quiet.
  pendingCount(id: string): number {
    return this.pending.get(id)?.queue.length ?? 0
  }

  // Drop a session's mail with the session itself, and the budget keyed by its own id —
  // which is the team's budget when the session WAS the coordinator.
  //
  // Deliberately NOT `budget.delete(teamOf(id))`. That looks like it also tidies up after a
  // member, but `teamOf` resolves a member to its COORDINATOR, so releasing a member wiped
  // the whole team's allowance. Every dismissal releases a member — which meant a
  // coordinator sitting at the message ceiling could refill it just by dismissing someone,
  // turning the loop guard into a formality.
  release(id: string): void {
    const p = this.pending.get(id)
    if (p?.timer) clearTimeout(p.timer)
    this.pending.delete(id)
    this.budget.delete(id)
  }

  dispose(): void {
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer)
    this.pending.clear()
    this.budget.clear()
  }

  private scheduleDrain(id: string, delayMs = DRAIN_DEBOUNCE_MS): void {
    const p = this.pending.get(id)
    if (!p || p.timer) return
    p.timer = setTimeout(() => {
      const cur = this.pending.get(id)
      if (!cur) return
      cur.timer = undefined
      void this.drain(id)
    }, delayMs)
  }

  // Deliver everything held for a session as ONE turn. Bails unless the session is
  // genuinely free; every path that could make it free again re-schedules.
  //
  // `awaitingTurn` stays set across the await, so a message arriving mid-delivery queues
  // behind this batch instead of racing it into a second turn.
  private async drain(id: string): Promise<void> {
    const p = this.pending.get(id)
    if (!p || !p.queue.length || p.awaitingTurn || p.delivering) return
    const info = this.host.info(id)
    if (!info) { this.release(id); return }        // destroyed while its mail waited
    if (info.state !== 'idle') return              // still busy; onIdle will bring us back

    const batch = p.queue.splice(0, p.queue.length)
    p.awaitingTurn = true
    p.delivering = true
    let delivered = false
    try {
      delivered = await this.host.deliver(id, batch.map((q) => formatTeamMessage(q.msg)).join('\n\n'))
    } catch { delivered = false }
    p.delivering = false

    // The session may have been released or destroyed while we awaited the write. Compare
    // IDENTITY, not just presence: a release followed by a fresh send re-creates the entry,
    // and putting this batch back would resurrect mail the release meant to drop.
    const cur = this.pending.get(id)
    if (!cur || cur !== p) return

    if (delivered) {
      // Only NOW is the message genuinely the recipient's problem. Callbacks run after
      // the write, never at queue time — a dismissal that fired on queueing would kill a
      // teammate that had not yet been asked anything.
      for (const q of batch) { try { q.onDelivered?.() } catch { /* a bad callback must not stall the queue */ } }
      return
    }
    // Nothing took it (the session is between a kill and its relaunch). Put the batch back
    // AT THE FRONT so ordering holds, and try again shortly. Dropping it here would lose
    // exactly the message that matters most — a cleared session's own handover.
    cur.queue.unshift(...batch)
    cur.awaitingTurn = false
    this.scheduleDrain(id, DRAIN_RETRY_MS)
  }
}
