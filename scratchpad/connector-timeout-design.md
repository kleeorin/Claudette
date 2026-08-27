# Connector upstream timeouts — design, measurements, and what was refuted

Status: **DESIGNED, NOT BUILT.** Blocked on write access to `server/src`.
Owner when unblocked: Landing. Design: Architect. Measurements: coordinator.

Written down because six planner exchanges produced this and team messages do not
survive. Twice today a stale or replayed report was mistaken for current state; a
design that lives only in a message queue is the same hazard.

---

## 1. What is MEASURED (not inferred)

| claim | result |
|---|---|
| silent upstream, `tools/list` | `completed 504 (106B) after 120s` — bounded |
| **dripping upstream** (valid SSE head, one chunk every 5s) | **`STILL OPEN after 150s`, 29 drips — NOT bounded** |
| `upstream.setTimeout()` semantics | socket **IDLE** timeout; any byte resets it |
| connector health recovery | `connectorProxy.ts:141` sets `'connected'` on non-error — **it does recover** |
| health keying | per **connector**, not per session — one session's timeout marks it for everyone |
| `MCP_*` env reaching a sandboxed session | **stripped** — `--clearenv` + no `MCP_` in `CLAUDE_ENV_ALLOW_PREFIXES` |
| request tee `reqHead += c` | corrupts a multi-byte char split across chunks; **still parses**, yielding a WRONG id |
| response tee `captured += c` | corrupts identically |
| `toolNameUsable('gh', 'écrire_fichier')` | **false** — `TOOL_NAME_RE` is `/^[a-zA-Z0-9_-]{1,128}$/`, ASCII-only |

**Consequence of the env finding:** for sandboxed sessions the proxy's own bounds are the
*only* bounds. Not academic — load-bearing.

## 2. The design

**Per-method, framed as a fast set under a fixed ceiling.** This framing is what makes it
safe: the session writes the request, so it controls classification — but every request
gets the ceiling, and *recognition* only shortens it. A session can opt out of going
faster; it cannot opt into going slower than the ceiling. Monotonic, cannot regress the
bound.

> **THE CEILING MUST NEVER RISE.** Give `tools/call` 600s "because tool calls run long"
> and a session gains a longer socket pin by classification it controls. The refinement
> becomes a regression the moment any branch exceeds the default.

- **Fast set — 15s.** Widen `TOOLS_LIST_RE` to the handshake methods: `tools/list`,
  `initialize`, `resources/list`, `prompts/list`. Adding methods is always safe by the
  monotonicity argument, so the set can grow without re-litigating.
- **Ceiling — 120s**, unchanged, everything else.
- **Ordering, non-obvious:** the timeout is armed at `:194` but classification is only
  known at `req.on('end')` — *the body is the classifier*. Arm with the ceiling, then
  **re-arm** with the shorter value inside `req.on('end')`. `setTimeout` may be called
  again to replace a pending timer.

**Total-duration guard** (new, separate from the idle one): a plain `setTimeout` armed
when the upstream request is created, cleared on `end`/`close`/`error`. Catches the drip
case, which **no idle value can**. Same fast-set/ceiling split.

> ⚠ **THE TOTAL GUARD IS NOT A RESOURCE BOUND, AND MUST NOT BE RECORDED AS ONE.**
> It bounds one connection's lifetime. With unbounded concurrency an adversary opens more,
> and the cap lands on legitimate long streams rather than on them — the wrong way round.
> The instrument that bounds the resource is a **concurrency cap** (N in-flight upstream
> requests per session and/or per connector). Not evadable by classification, does not kill
> long streams, bounds fd cost directly. Ship the total guard, and open a NEW `[open]`
> naming the concurrency cap as the bound that still does not exist.

## 3. Post-header failure — the gap that has no answer today

`if (!res.headersSent) deny(res, 504) else res.destroy()`. An upstream that sends headers
then stalls takes `destroy()`: the session gets a **truncated body, no status, no message**,
indistinguishable from a network fault. This is the likelier real-world stall (an SSE stream
that opens and dies) and the drip fixture hits it by construction.

Fix — reuse the existing request tee, which already buffers `reqHead` to sniff the method;
the same prefix carries the JSON-RPC `id`.

- Hoist alongside `wantsToolList`: `let reqId: string|number|null = null` and
  `let upstreamContentType = ''`. **Most likely thing to be got wrong:** `contentType` is
  computed *inside* the response handler, but both timeout callbacks live in the outer
  scope. Assign `upstreamContentType = contentType` where `classifiable` is computed.
- **PARSE, DO NOT REGEX** for the id. `"id"` appears legitimately inside tool arguments, and
  a first-match regex returns the wrong one. **A wrong id is worse than no id** — a client
  may settle a *different* pending call with it. Parse the whole tee or return `null`.
  Batch (array) → null. Notification → null. Truncated past `REQ_SNIFF_BYTES` → null, which
  is what `deny()` already emits and no client can mis-route.
- On fire, once headers are out the status cannot change, so put the error in the **body**:
  - `text/event-stream`: `res.end("\n\ndata: " + body + "\n\n")` where body is
    `{"jsonrpc":"2.0","id":<id>,"error":{"code":-32000,"message":"…"}}`.
    **Leading blank line first** — the stall can land mid-frame, and a blank line terminates
    whatever was in flight; if nothing was, parsers dispatch an empty event and ignore it.
    Safe in both cases, costs two bytes. `JSON.stringify` never emits a literal newline, so
    the body cannot split the frame.
  - `application/json`: a half-written body cannot be repaired. `res.end()` rather than
    `res.destroy()` — a parse error beats a socket error.
- **Wire it into BOTH timeout paths**, not just the new one. The idle path has the same gap
  today and is the more travelled.

## 4. The tee fixes — both, same commit

Both tees use `+= c` on Buffers, which corrupts a multi-byte codepoint split across a chunk
boundary. Collect `Buffer[]`, cap on **accumulated BYTE length**, `Buffer.concat(...)
.toString('utf8')` ONCE at `end`.

- **Request side is a PRECONDITION of `jsonRpcId`**, not a tidy-up: corruption there yields a
  wrong id. It does **not** degrade to `null` as first assumed — measured, the corrupted
  string still parses, because every structural JSON byte is ASCII and unsplittable, so
  corruption can only land inside a string *value*, where U+FFFD is legal.
- **Both caps are currently wrong the same way:** `reqHead.length < REQ_SNIFF_BYTES` and
  `captured.length < MAX_CLASSIFY_BYTES` are *string-length* tests on byte-named constants.
  For multi-byte content the string is shorter than the byte count, so both admit more bytes
  than intended — `MAX_CLASSIFY_BYTES` is a memory bound, so it under-enforces a guard.
- **Response side is correctness / catalog hygiene ONLY.** Do not describe it as security or
  availability — see §6.

## 5. ★ The falsifier that keeps §6 closed

The response-side argument depends on `TOOL_NAME_RE` staying ASCII-only, **and nothing says
so.** Its comment cites only "the Messages API's tool-name constraint". MCP does not restrict
tool names to ASCII, so a connector exposing `écrire_fichier` is legal and is today denied
wholesale — a plausible future bug report, whose obvious fix is to widen the regex.

- **FALSIFIER:** `TOOL_NAME_RE` widened to accept non-ASCII.
- **ESCAPE:** none needed *if the tee fix has landed* — `Buffer.concat` removes the corruption
  entirely, so widening becomes a non-event. **This is the argument for fixing the response
  tee now even though it currently proves nothing.**
- **CHECK (do this in the same commit):** a comment beside `TOOL_NAME_RE` recording that the
  ASCII restriction is load-bearing for more than the CLI's grammar, pointing at the tee.

## 6. What was REFUTED — do not re-litigate

Four passes, nobody right first. Recorded so the dead branches stay dead.

1. ~~"the request hangs with no timeout"~~ — false. Fixed before the probe claiming it was
   written; `connectorProxy.ts:192` says so in past tense.
2. ~~"the request is bounded"~~ — true only for a **silent** upstream. Generalising one
   measured case into a claim about all of them.
3. ~~"a corrupted tool name leaves a write tool undenied (security)"~~ — false.
   `roleScopedDenies` returns `denyAllRule` for a read-only role **before** any per-tool
   enumeration; the per-tool branch is unreachable for that role.
4. ~~"a corrupted tool name denies the whole connector (availability)"~~ — false. The
   **uncorrupted** non-ASCII name already fails `toolNameUsable`, so corruption changes
   nothing.
5. **The actual reason it is harmless:** corruption can only land in a multi-byte codepoint;
   `TOOL_NAME_RE` accepts only ASCII; **a usable name cannot be corrupted and a corruptible
   name was already unusable.** The corruptible set and the load-bearing set are disjoint —
   until §5's falsifier fires.

## 7. What `rt2-connectors-c.mts` should assert afterwards

- **handshake, silent fixture:** completes **504** AND elapsed < ~20s. *Assert the status,
  not just the elapsed* — a fast failure for an unrelated reason (502, aborted) passes a
  timing-only check. Cost drops ~121s → ~16s.
- **handshake, drip fixture:** same assertion. This is the one proving the total guard
  exists; under today's code it runs forever, so it is the fails-first proof.
- **post-header:** the drip fixture sends headers first, so additionally assert the body
  **ends with a parseable JSON-RPC error whose `id` equals the id the probe sent** — not
  merely that an error arrived. That distinguishes correct addressing from `id: null`.
- **truncation fallback:** needs **actual truncation** (>`REQ_SNIFF_BYTES`), not a corruption
  fixture — corruption parses, so it will not exercise this path. Two different tests that
  look like one.
- **ceiling (non-handshake):** gate behind `SLOW=1`, skipped by default, printing a SKIP line
  naming what was not run so the coverage loss is visible rather than silent.
- The drip `[open]` goes away; a new `[open]` opens for the concurrency cap (§2).
