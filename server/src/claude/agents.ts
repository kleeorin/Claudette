// Agent roles (charter + tool scope + model) for a session. A role shapes three
// things at launch: an appended system-prompt charter, the model (optional; the
// user's per-session override still wins), and the tool scope — `allowedTools`
// auto-approves those tools and `disallowedTools` hard-blocks the rest (merged with
// the always-on NOTEBOOK_DENY). `general` contributes nothing, so it's an ordinary
// session. The read-only roles block the mutating tools so they physically can't
// edit files. The SessionManager wiring (getAgent + SUBSESSION_REPORT_INSTRUCTION →
// claudeArgs) reads these on every launch/relaunch.

import type { AgentInfo } from '@claudette/shared'

// The client-facing id/name/description come from AgentInfo (the role-picker contract);
// the rest is the server-only charter/tool-scope the client never sees.
export interface Agent extends AgentInfo {
  // NB `systemPrompt` and `description` are now deliberately worded DIFFERENTLY, and that
  // divergence is the point — do not "harmonize" them. The prompt is what we ASK the model
  // to do (a charter it can misread, forget, or be argued out of); the description is what
  // the tool scope ENFORCES, and it is what the operator reads in the role picker and in
  // list_team. When they disagreed, the description inherited the prompt's optimism: it
  // said "Read-only … never edits" while the role held an auto-approved shell. Describe the
  // enforcement, ask for the intent.
  systemPrompt?: string        // persistent charter → --append-system-prompt
  model?: string               // pin a model; undefined = user default
  allowedTools?: string[]      // whitelist → --allowedTools (auto-approve)
  disallowedTools?: string[]   // blacklist → --disallowedTools (MERGED with NOTEBOOK_DENY)
  // READ-ONLY BY NATIVE TOOL SCOPE — shell access is HUMAN-GATED, not absent. Precisely:
  // the role holds no file-editing tool, and any shell it can reach beyond a pre-approved
  // read-only allowlist falls through to a PROMPT rather than a block. So the role DEFERS
  // writes to the operator; it does not deny them. That distinction is load-bearing and was
  // previously overstated: `reviewer` carried bare `Bash` in allowedTools, which
  // `--allowedTools` auto-approves with no prompt, so a role badged read-only ran `sed -i`
  // and `rm -rf` unattended.
  //
  // Declared rather than inferred from disallowedTools, because the two differ, and read by
  // connector scoping (an MCP tool sits in none of the native lists, so nothing else would
  // catch it) and by the `launders` guard in sessionManager.register.
  readOnly?: boolean
}

// The tools that MUTATE the workspace — blocked for read-only roles so they can
// look but never touch. Bash is included: a shell is an edit channel too.
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'Bash']
// Common read/search tools worth auto-approving for the non-editing roles so they
// don't stop to ask on every file read.
const READ_TOOLS = ['Read', 'Grep', 'Glob']
const RESEARCH_TOOLS = [...READ_TOOLS, 'WebSearch', 'WebFetch']

export const AGENTS: Record<string, Agent> = {
  general: {
    id: 'general',
    name: 'General',
    description: "Default agent — no special charter, full tools, the user's default model. Same as an ordinary session.",
  },
  planner: {
    id: 'planner',
    name: 'Planner',
    description: 'Investigates and writes a step-by-step implementation plan. Holds no editing tools and no shell — it cannot change anything itself.',
    systemPrompt:
      'You are a planning agent. Investigate the codebase and the request, then produce a clear, ordered implementation plan a developer or another agent can execute. '
      + 'You are READ-ONLY: do not modify files or run mutating commands — read, search, and reason. End with the concrete steps, the files each touches, and the risks or open questions.',
    allowedTools: RESEARCH_TOOLS,
    disallowedTools: WRITE_TOOLS,
    readOnly: true,
  },
  reviewer: {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews changes for correctness and quality. Holds no file-editing tools; read-only git commands are pre-approved, anything else it runs will ask you first.',
    systemPrompt:
      'You are a code reviewer. Examine the changes/diff and report correctness bugs first, then quality issues (reuse, simplification, clarity), most severe first, each with a concrete failure scenario. '
      + 'Do not edit files. You may run read-only commands (e.g. git diff, tests) to verify, but never anything that mutates the workspace.',
    // Pre-approve only the read-only git commands a review actually needs. Bare `Bash`
    // used to sit here, and `--allowedTools` AUTO-APPROVES: a role whose badge said
    // "Read-only" ran nested bwrap, `sed -i`, `rm -rf` and `npm audit` without one prompt
    // reaching the operator. Note `WRITE_TOOLS` above already calls a shell an edit channel
    // — this line simply handed it straight back.
    //
    // Everything NOT listed here falls through to a PROMPT, not a block, so a reviewer that
    // needs the test suite still runs it — it asks first. That is the intended shape: a
    // shell cannot be safely pattern-matched (`sh -c` defeats any allowlist), so the answer
    // is to make the human the gate rather than to widen the list.
    allowedTools: [...READ_TOOLS, 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git status:*)', 'Bash(git show:*)'],
    disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
    readOnly: true,
  },
  implementer: {
    id: 'implementer',
    name: 'Implementer',
    description: 'Executes an assigned task end-to-end — edits code, runs commands, verifies. Full tools.',
    systemPrompt:
      'You are an implementation agent. Execute the assigned task end-to-end: make the edits, run the commands, and verify the result. '
      + 'Match the existing conventions of the code you touch, keep the change tightly scoped to the task, and confirm it works before reporting done.',
  },
  researcher: {
    id: 'researcher',
    name: 'Researcher',
    description: 'Gathers information from the web and the codebase and synthesizes concise, cited findings. Holds no editing tools and no shell.',
    systemPrompt:
      'You are a research agent. Gather information from the web and the codebase, corroborate across sources, and synthesize a concise, cited answer. '
      + 'You are READ-ONLY: do not modify files or run mutating commands. Distinguish what the sources establish from your inference, and flag uncertainty.',
    allowedTools: RESEARCH_TOOLS,
    disallowedTools: WRITE_TOOLS,
    readOnly: true,
  },
}

// --- team charters (star topology) -------------------------------------------
// A team is one COORDINATOR (a top-level session) plus its MEMBERS (sessions
// carrying its id as parentId). Members talk to the coordinator and never to each
// other, so there is exactly one place the state of the work lives — and message
// loops are structurally almost impossible. SessionManager.launch() composes these
// into --append-system-prompt.
//
// These carry the STANCE only, never the roster. Who's on the team changes as
// members are hired and dismissed, and baking a roster into the system prompt would
// force a relaunch on every change; `list_team` supplies the live facts instead.

// Appended when a session has at least one member. Note what it does NOT say: it
// never promises the coordinator can hire. That depends on the operator's
// "employ team allowed" toggle, which can flip at any time, so list_team reports
// `canEmploy` and the tool handlers enforce it.
export const COORDINATOR_INSTRUCTION =
  'You are the COORDINATOR of a team of Claude sessions sharing this working directory. '
  + 'Each teammate is a separate session with its OWN context and role — it knows only what you tell it and what it can read from the workspace. '
  + 'Call list_team to see the current roster, each teammate\'s role, whether it is idle or busy, and whether you are allowed to hire; the roster changes, so never assume it. '
  + 'Delegate with send_to_session. Teammates cannot talk to each other — every message routes through you — so when two of them need to agree on something, you are the one who carries it across. '
  + 'Delegation is ASYNCHRONOUS: send_to_session returns as soon as the message is queued, NOT when the work is done. Never idle waiting for a reply. '
  + 'Finish what you can, end your turn, and the reply will arrive on a later turn as a <team-message> block. '
  + 'Give a teammate enough context to act alone — it cannot see your conversation.'

// Appended to every member (a session with a parentId). Supersedes the older
// report-only instruction: a member now also needs to know it is on a team at all,
// that it is a leaf, and that it can recycle its own context.
export const MEMBER_INSTRUCTION =
  'You are a MEMBER of a team of Claude sessions sharing this working directory, working under a coordinator session. '
  + 'The coordinator is the ONLY session you can message: sends to any other teammate are refused, so route anything a peer needs through the coordinator. '
  + 'When you finish your assigned task, call report_to_parent with a concise summary of what you did and any results the coordinator needs — it cannot see your conversation, so state conclusions rather than pointing at your own history. '
  + 'Messages from the coordinator arrive as <team-message> blocks on your turns; treat those as the assignment, not as the human speaking. '
  + 'If your context grows long and mostly stale, call clear_self with a handover summary — you will restart fresh with that summary carried across. '
  + 'If you are ever told you are being dismissed, your next report_to_parent is your exit interview: whatever you write there is saved and handed to the next teammate in your role, and nothing else you learned survives. '
  + 'Write it for a successor who was not there — how the code is laid out, the conventions, the traps, the decisions and why — not as a status update.'

export function getAgent(id?: string): Agent {
  // Own-property lookup for the same reason isAgent uses it: `AGENTS['constructor']`
  // resolves up the prototype chain to a truthy non-Agent, which would win over the
  // `general` fallback.
  return (id && Object.hasOwn(AGENTS, id) ? AGENTS[id] : undefined) || AGENTS.general
}

// A stable key of the RESOLVED role definition — the third configured-vs-effective
// dimension, alongside sandboxKey (sandbox.ts) and connectorKey (connectorLaunch.ts).
//
// WHY A KEY OF THE DEFINITION AND NOT JUST `agentId`. A running engine never re-reads
// this file: launch() copies `systemPrompt`/`model`/`allowedTools`/`disallowedTools`/
// `readOnly` into the spawn once and the child holds that scope for its whole life. So a
// session can be running a TOOL SCOPE THAT PREDATES THE CURRENT ROLE DEFINITION with
// nothing able to say so — which is not hypothetical: after the `reviewer` role was
// narrowed from bare `Bash` to read-only git patterns, a live reviewer session was still
// holding the old unscoped shell, and the UI reported it as an ordinary reviewer. Keying
// on `agentId` alone cannot see that: the id never changed, the definition did.
//
// The five fields below are exactly the ones launch() reads off the agent. If a sixth is
// ever consumed there, add it here in the same commit or `agentPending` goes quietly
// blind to it — the failure is silent, which is why this list is spelled out rather than
// JSON.stringify'ing the whole object (that would also fold in `name`/`description`, which
// are display-only and would report a pending relaunch for a copy edit).
export function agentKey(id?: string): string {
  const a = getAgent(id)
  return JSON.stringify([
    a.id,
    a.model ?? '',
    a.systemPrompt ?? '',
    a.allowedTools ?? [],
    a.disallowedTools ?? [],
    !!a.readOnly,
  ])
}

export function isAgent(id: string): boolean {
  // hasOwn, not `in`: `in` walks the prototype chain, so 'constructor', 'toString' and
  // friends all validated. setAgent then stored and PERSISTED a bogus role, and
  // getAgent('constructor') returned Object's constructor — truthy, so no fallback to
  // `general` — and launch() read systemPrompt/allowedTools/readOnly off a Function.
  return Object.hasOwn(AGENTS, id)
}

export function listAgents(): Array<Pick<Agent, 'id' | 'name' | 'description'>> {
  return Object.values(AGENTS).map(({ id, name, description }) => ({ id, name, description }))
}
