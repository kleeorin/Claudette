# Durable fix — sticky "running" agent-tray cards (server-side task registry)

`server/src` + `shared/src` are read-only inside a confined session, so this is written
up as a patch, not auto-applied. Apply yourself, or relaunch with
`CLAUDETTE_ALLOW_APP_SOURCE_MOUNT=1` and I'll apply + verify. Sibling of
`simplify-findings-server.md`.

## The bug (verified)

A background agent's tray card is sticky once launched. In `AgentCard`
(`web/src/components/ChatView.tsx:624`):

```ts
const active = !done && (launched || running)   // done = !!result
```

Once a background launch is acked (`launched = true`), the card shows **running** until a
matching terminal `tool_result` sets `result`. That terminal result is *only ever*
synthesized on the client from a `<task-notification>` user turn
(`web/src/store/chat.tsx:302-306`, `parseTaskNotification` at `:465-472`). There is no
liveness re-check — so if that one signal never reaches the client, the card is stuck as
"running" forever, even though the agent finished.

The stickiness is intentional (it's what lets a background agent keep counting after the
turn goes idle — `countRunningAgents`, `chat.tsx:526-538`). The gap is: **a lost
completion signal has no fallback.**

### Why the signal gets lost

Confirmed by tracing the lifecycle end-to-end:

1. **The server has no task registry.** `SessionManager` tracks only `sessions`,
   `transcripts` (a ring buffer), and `pendingPerms` (`sessionManager.ts:65-76`). It is a
   pure pass-through for CLI stream-json (`claudeEngine.ts:316`) — it never parses
   `Task`/`Agent` tool_uses, the async-launch ack, or `<task-notification>`. All
   agent-state derivation is client-side (`collectAgents`, `chat.tsx:490-519`).

2. **The terminal outcome lives in exactly one volatile place** — the raw
   `<task-notification>` `user` event sitting in the in-memory `transcripts` buffer, kept
   alive only by the buffering guard at `sessionManager.ts:90-93`. That buffer is:
   - **capped at `TRANSCRIPT_CAP = 4000`** (`sessionManager.ts:55`, evicted oldest-first
     at `:96`), and
   - **never persisted** — `saved()`/`SavedSession` carry no transcript
     (`sessionManager.ts:542-552`, `shared/src/types.ts:65-78`), and it is explicitly
     **not** written to the CLI jsonl (`chat.tsx:462-463`), so `/resume` never replays it.

   This session spawned/resumed ~4 coordinators several times plus ~20 grandchildren; the
   nested activity easily pushes 4000 events, so an early agent's `<task-notification>` is
   evicted before a reconnect can replay it. A resumed agent whose completion reached the
   main loop outside the session's user-event stream never had one buffered at all.

   Once that event is gone, `collectAgents` can never set `result` for that Task's
   `toolId`, and the card is stuck.

3. The reconnect snapshot only replays what's still in the buffer — `sendSessionSnapshots`
   sends `events = transcriptOf(id)` (`sessionApi.ts:45-52`), and the client rebuilds tray
   state purely by re-running `collectAgents` over those events (`chat.tsx:615-628`,
   `LOAD`). Evicted ⇒ unrecoverable.

## The fix

Give the server an **explicit, un-capped, persisted per-session task registry** that is
the authoritative record of each subagent's terminal outcome — independent of the
transcript ring — and settles any still-open task when its owning engine dies. Four parts:

1. **Lift the three parse helpers into `shared/`** so server and client parse identically
   (single source of truth). Today they live only in `chat.tsx`:
   - `isSubagentTool` (`chat.tsx:437`) — `name === 'Task' || name === 'Agent'`
   - `ASYNC_LAUNCH_ACK` / `isAsyncLaunchAck` (`chat.tsx:444-447`)
   - `parseTaskNotification` + `userContentText` (`chat.tsx:449-472`)

   Move them to `shared/src/tasks.ts`, re-export from `chat.tsx` (no client behavior
   change), and import them on the server. This is what keeps the two registries from
   drifting.

2. **Build the registry in `SessionManager`,** fed from the *same* `engine.on('event')`
   tap that already calls `buffer()` (`sessionManager.ts:221-232`). A `Map` keyed by the
   Task's Anthropic tool id, held beside `transcripts`, never evicted:

   ```ts
   // shared/src/types.ts — new
   export interface TaskRecord {
     toolId: string            // Task/Agent tool_use id (pairs with <tool-use-id>)
     type: string              // subagent_type
     description: string
     prompt?: string
     launched: boolean         // async-launch ack seen (background agent)
     status: 'running' | 'done' | 'failed'
     summary?: string          // terminal summary, for the settled card
   }
   ```

   ```ts
   // sessionManager.ts — new field + record()
   private tasks = new Map<string, Map<string, TaskRecord>>()   // sessionId → toolId → record
   tasksOf(id: string): TaskRecord[] { return [...(this.tasks.get(id)?.values() ?? [])] }

   // called from engine.on('event'), right where buffer() is today
   private recordTask(id: string, e: ClaudeEvent): void {
     const m = this.tasks.get(id) ?? new Map<string, TaskRecord>()
     if (e.type === 'assistant') {
       for (const b of assistantToolUses(e)) {              // type==='tool_use'
         if (!isSubagentTool(b.name)) continue
         const input = (b.input ?? {}) as { subagent_type?: string; description?: string; prompt?: string }
         if (!m.has(b.id)) m.set(b.id, {
           toolId: b.id, type: input.subagent_type || 'agent',
           description: input.description || 'Subagent task', prompt: input.prompt,
           launched: false, status: 'running',
         })
       }
     } else if (e.type === 'user') {
       // async-launch ack → launched; <task-notification> → terminal
       for (const tr of userToolResults(e)) {               // {tool_use_id, content}
         const rec = m.get(tr.tool_use_id)
         if (rec && isAsyncLaunchAck(tr.content)) rec.launched = true
       }
       const notif = parseTaskNotification(userContentText(userContent(e)))
       if (notif) {
         const rec = m.get(notif.toolUseId)
         if (rec) { rec.status = notif.isError ? 'failed' : 'done'; rec.summary = notif.summary }
       }
     }
     if (m.size) { this.tasks.set(id, m); this.emit('task', id, this.tasksOf(id)) }
   }
   ```

   Because the registry captures `type`/`description`/`prompt` when the tool_use is first
   seen, a card can be **fully reconstructed even if both the tool_use and the
   notification have since been evicted** from the event buffer — strictly better than
   replaying raw events.

3. **Liveness fallback — settle open tasks when the engine dies.** This is the re-check
   the client lacks. In `engine.on('exit')` (and the `replacing`/resume-fallback
   relaunch paths) mark every still-`running` task for that session as terminal:

   ```ts
   private settleOpenTasks(id: string, reason = 'Agent ended (session stopped)'): void {
     const m = this.tasks.get(id); if (!m) return
     let changed = false
     for (const rec of m.values()) if (rec.status === 'running') {
       rec.status = 'failed'; rec.summary ??= reason; changed = true
     }
     if (changed) this.emit('task', id, this.tasksOf(id))
   }
   ```

   Call it from the `failedFast` / `cleanup` branches of the exit handler
   (`sessionManager.ts:285-294`) and from `resumeInto`/`restartFresh` (which drop the
   transcript today, `:342`/`:361`). A card for a dead agent can then never stay
   "running". Clear the map in `cleanup()` alongside the transcript (`:584`).

4. **Ship it to clients — snapshot, live event, and persistence.**
   - Snapshot: add `tasks` to the wire type and the builder.
     ```ts
     // shared/src/ws.ts:53
     | { type: 'session:snapshot'; id: string; events: ClaudeEvent[]; pending?: PermissionRequest[]; tasks?: TaskRecord[] }
     | { type: 'session:tasks'; id: string; tasks: TaskRecord[] }   // live registry updates
     ```
     ```ts
     // sessionApi.ts:50 — sendSessionSnapshots
     hub.send(ws, { type: 'session:snapshot', id: s.id, events, pending, tasks: sessions.tasksOf(s.id) })
     // bridgeSessionEvents — new
     sessions.on('task', (id, tasks) => hub.broadcast({ type: 'session:tasks', id, tasks }))
     ```
     Guard the `events.length === 0 && pending.length === 0` early-continue at
     `sessionApi.ts:49` so a session with only tasks still sends a snapshot.
   - Persistence: add `tasks?: TaskRecord[]` to `SavedSession` (`shared/src/types.ts`),
     emit it from `saved()` (`sessionManager.ts:542`), and rehydrate the map in `restore()`
     (`:556`). A `changed` emit after `recordTask`/`settleOpenTasks` (throttled — reuse the
     400ms `saveTimer` at `index.ts:104`) makes a server restart no longer strand cards.

### Client consumption (minimal, additive)

`collectAgents` gains the snapshot/live `tasks` as a fallback — the transcript path still
wins when a real terminal `tool_result` is present:

```ts
// chat.tsx — collectAgents(items, tasks?: TaskRecord[])
result: it.toolId
  ? resultByTool.get(it.toolId)
    ?? terminalFromRegistry(tasks, it.toolId)   // synthesize {kind:'tool_result', isError, content:summary}
  : undefined,
launched: it.toolId ? (launchedTools.has(it.toolId) || registryLaunched(tasks, it.toolId)) : false,
```

Store the per-session `tasks` from `session:snapshot` / `session:tasks` next to the
transcript and thread it into the `collectAgents` / `countRunningAgents` call sites. A card
now settles from the registry even when its `<task-notification>` was evicted, was never
buffered, or was lost to a restart.

## Why this closes every observed failure mode

| Failure mode (from the incident) | Covered by |
| --- | --- |
| `<task-notification>` evicted past the 4000 cap | Registry is un-capped, separate from the ring (part 2) |
| Completion reached the main loop off the user-event stream / resumed agent, never buffered | Liveness settle on engine exit/relaunch (part 3) |
| Server restart drops the in-memory buffer | Registry persisted in `sessions.json` (part 4) |
| Reconnect can't rebuild an evicted card | Snapshot carries `tasks` with full card metadata (parts 2+4) |

## Blast radius / notes

- Purely additive: no existing event, wire field, or client derivation changes meaning;
  `tasks` is optional everywhere, so an old client ignores it and a new client falls back
  to the transcript when it's absent.
- Memory: one small record per real subagent, not per event — bounded by task count, and
  freed with the session in `cleanup()`.
- The one judgment call is part 3's `reason`/`status`: settling an open task to `failed`
  on engine exit is correct for a dead agent but *would* mislabel a genuinely-live
  background agent if we settled too eagerly — so only settle on **engine exit / relaunch /
  clear**, never on turn-idle. (This is the same distinction the client already draws by
  gating foreground agents on `turnActive`.)

## Anchors touched

- `shared/src/tasks.ts` (new — lifted parse helpers), `shared/src/types.ts` (`TaskRecord`,
  `SavedSession.tasks`), `shared/src/ws.ts:53` (snapshot `tasks` + `session:tasks`)
- `server/src/claude/sessionManager.ts`: field + `recordTask`/`settleOpenTasks`/`tasksOf`,
  call sites in `engine.on('event')` (`:221-232`), `engine.on('exit')` (`:255-295`),
  `resumeInto` (`:342`), `restartFresh` (`:361`), `cleanup` (`:584`), `saved`/`restore`
  (`:542`/`:556`)
- `server/src/session/sessionApi.ts:45-52` (snapshot builder + `task` bridge)
- `web/src/store/chat.tsx`: re-export helpers from shared; thread `tasks` into
  `collectAgents` (`:490`) + `countRunningAgents` (`:526`); store per-session `tasks` from
  the two WS messages
