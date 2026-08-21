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
  systemPrompt?: string        // persistent charter → --append-system-prompt
  model?: string               // pin a model; undefined = user default
  allowedTools?: string[]      // whitelist → --allowedTools (auto-approve)
  disallowedTools?: string[]   // blacklist → --disallowedTools (MERGED with NOTEBOOK_DENY)
  // Is this role READ-ONLY in intent? Declared rather than inferred from disallowedTools,
  // because the two differ: `reviewer` keeps Bash (to run git diff and tests) yet must
  // still not gain a mutating MCP tool. Connector scoping reads this — an MCP tool is not
  // in any of the native lists above, so nothing else would catch it.
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
    description: 'Investigates and writes a step-by-step implementation plan. Read-only — never edits files or runs commands.',
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
    description: 'Reviews changes for correctness and quality. Read-only (may run read commands), never edits.',
    systemPrompt:
      'You are a code reviewer. Examine the changes/diff and report correctness bugs first, then quality issues (reuse, simplification, clarity), most severe first, each with a concrete failure scenario. '
      + 'Do not edit files. You may run read-only commands (e.g. git diff, tests) to verify, but never anything that mutates the workspace.',
    // A reviewer may run read-only shell (git diff, run tests) — allow Bash, block edits.
    allowedTools: [...READ_TOOLS, 'Bash'],
    disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
    // Keeps Bash, so it is NOT read-only by tool list — but it is by charter, and a
    // mutating MCP tool would sit outside every native deny above.
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
    description: 'Gathers information from the web and the codebase and synthesizes concise, cited findings. Read-only.',
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
