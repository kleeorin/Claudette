// DID THE WORKING INDICATOR SURVIVE THE INIT CLOBBER? — the decision, extracted from
// real-turn-browser-test.mjs so it can be tested without a live API turn.
//
// ── THE BUG THIS DECIDES ON ──────────────────────────────────────────────────────────────
// The engine sends an init frame shortly after spawn. The client's handler used to reset the
// `running` flag, so the Stop/working indicator vanished a second or two into a turn that was
// still going. The fix keeps `running` set; the observable consequence of a regression is that
// Stop goes DOWN and the assistant then produces output afterwards.
//
// ── WHY THE OLD TEST WAS SOUND BUT NOT SPECIFIC ──────────────────────────────────────────
// It asserted `stop === true` at some sample more than 2500ms in. That CAN fail for the right
// reason — a clobbered indicator is down before 2.5s — so it was never a cannot-fail
// assertion. But 2500 is a WALL-CLOCK PROXY for "init has certainly fired", and it fails
// identically when the turn simply finishes early. The file's own header records exactly that
// on 2026-08-24: samples read `stop=true` at 2.4s and `stop=false` at 3.0s, the threshold fell
// in the gap, and the check went red with the indicator having been up the entire turn. The
// response then was to lengthen the prompt so the turn outlives the threshold — which buys
// margin against the model's speed rather than removing the dependency on it.
//
// A wall-clock threshold cannot distinguish "the indicator died early" from "the turn was
// short", because both produce the same observation: no sample with stop=true after 2.5s.
//
// ── THE TURN-RELATIVE FORM ───────────────────────────────────────────────────────────────
// Both events being compared are events of the TURN, so the model's speed drops out entirely:
//
//   the indicator survived  ⟺  the last sample showing Stop is at or after
//                              the first sample showing assistant output
//
// Under the bug, Stop dies at init — before any assistant text — so the last Stop sample
// precedes the first assistant sample and this is false. Under correct behaviour Stop is up
// throughout streaming, so it is true. A fast turn changes both timestamps together and the
// comparison is unaffected, which is the whole point.
//
// WHAT IT STILL CANNOT DO, stated so it is not read as more than it is: sampling cannot
// observe an interval shorter than its own period. If a turn ever completed entirely between
// two samples, no sample would show assistant output while Stop was up and this would report
// `no-assistant-sample` — which is why that is a distinct outcome below rather than a silent
// false. An inconclusive run must not be spelled the same way as a failing one.

// ── WAS THE TRANSCRIPT STILL GROWING WHEN WE TOOK OUR REFERENCE POINT? ────────────────────
// The harness establishes "what was already on screen" once, immediately before sending. That
// reference is only meaningful if REPLAY HAS FINISHED, and replay is asynchronous: chat.tsx's
// `fromReplay` path emits items as the stream arrives. An item landing after the reference is
// taken is indistinguishable from output this turn produced — whether the reference is a COUNT
// (it raises the total) or a SET OF MARKED NODES (the late item is unmarked). Marking makes the
// reference precise about WHICH nodes; it does not make it earlier, so both forms share this
// hole and only a stability check closes it.
//
// ★ THE FALSE PASS THIS MUST NOT HAVE: two probes taken in the same tick are always equal and
// prove nothing. The probes MUST straddle a real wait — that is the caller's obligation, and it
// is why this refuses on fewer than two rather than treating one as trivially stable. A single
// snapshot cannot answer a question about change.
/**
 * @param {number[]} counts item counts from successive pre-send probes, in order
 * @returns {{settled: boolean, reason: string, last: number, prev: number}}
 */
export function preSendSettled(counts) {
  if (!Array.isArray(counts) || counts.length < 2) {
    return { settled: false, reason: 'need-two-probes', last: -1, prev: -1 }
  }
  const last = counts[counts.length - 1]
  const prev = counts[counts.length - 2]
  return {
    settled: last === prev,
    reason: last === prev ? 'settled' : 'still-arriving',
    last,
    prev,
  }
}

// ── OUTPUT THAT ARRIVES WITH THE END OF THE TURN ─────────────────────────────────────────
// MEASURED 2026-10-06, four live runs in a row: the model wrote NO text before its tool call,
// so the turn's only assistant text landed in the same 200ms tick as the result frame. Stop
// was up in every sample for 12s, then one sample later read stop=false state=idle
// assistant=true. `lastStop >= firstAssistant` is false by exactly one sample, and the run
// went red as "the indicator died before the turn produced anything" — with the indicator
// having been up the entire turn. Same shape as the 2026-08-24 wall-clock miss: an
// observation that is ALSO produced by a healthy turn, so it cannot be the verdict alone.
//
// The discriminator is the turn's own state, not timing. The clobber signature is Stop DOWN
// while the session is still RUNNING; a turn that has ended reads idle. So Stop's last sample
// being immediately before the first output counts as survival ONLY when that first-output
// sample already shows the turn over (`state` present and not 'running'). A sample with no
// `state` keeps the strict rule, so old callers lose nothing. A clobber still fails: Stop dies
// at init, seconds before any output, so the two samples are never adjacent — and if they
// somehow were while the session still read 'running', this branch refuses.
/**
 * @param {{stop: boolean, assistant: boolean, state?: string|null}[]} samples in observation order
 * @returns {{ok: boolean, reason: string, lastStop: number, firstAssistant: number}}
 *   `ok` is meaningful only when `reason` is 'ok', 'output-arrived-at-turn-end' or
 *   'indicator-died-before-output'.
 */
export function indicatorSurvivedInit(samples) {
  let lastStop = -1
  let firstAssistant = -1
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].stop) lastStop = i
    if (samples[i].assistant && firstAssistant === -1) firstAssistant = i
  }
  // INCONCLUSIVE, NOT FAILING. Each of these means the run did not produce the evidence the
  // comparison needs. Reporting them as `ok: false` would be a red naming a defect that was
  // never observed — the failure mode this file exists to remove, one level up.
  if (lastStop === -1) return { ok: false, reason: 'no-stop-sample', lastStop, firstAssistant }
  if (firstAssistant === -1) return { ok: false, reason: 'no-assistant-sample', lastStop, firstAssistant }
  const atOutput = samples[firstAssistant].state
  if (lastStop === firstAssistant - 1 && typeof atOutput === 'string' && atOutput !== 'running') {
    return { ok: true, reason: 'output-arrived-at-turn-end', lastStop, firstAssistant }
  }
  return {
    ok: lastStop >= firstAssistant,
    reason: lastStop >= firstAssistant ? 'ok' : 'indicator-died-before-output',
    lastStop,
    firstAssistant,
  }
}
