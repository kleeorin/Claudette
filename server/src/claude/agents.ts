// Agent roles (charter + tool scope + model) for a session. A role shapes three
// things at launch: an appended system-prompt charter, the model (optional; the
// user's per-session override still wins), and the tool scope — `allowedTools`
// auto-approves those tools and `disallowedTools` hard-blocks the rest (merged with
// the always-on NOTEBOOK_DENY). `general` contributes nothing, so it's an ordinary
// session. The read-only roles block the mutating tools so they physically can't
// edit files. The SessionManager wiring (getAgent + SUBSESSION_REPORT_INSTRUCTION →
// claudeArgs) reads these on every launch/relaunch.

export interface Agent {
  id: string
  name: string                 // display name / sidebar badge
  description: string          // shown to an orchestrating agent via list_agents + the role picker
  systemPrompt?: string        // persistent charter → --append-system-prompt
  model?: string               // pin a model; undefined = user default
  allowedTools?: string[]      // whitelist → --allowedTools (auto-approve)
  disallowedTools?: string[]   // blacklist → --disallowedTools (MERGED with NOTEBOOK_DENY)
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
  },
}

// Appended to every subsession's system prompt so it reports back to its parent
// when done (Phase 3 orchestration). Kept here so SessionManager's launch() is
// unchanged when subsessions land.
export const SUBSESSION_REPORT_INSTRUCTION =
  'When you finish your task, call the report_to_parent tool with a concise summary of what you did and any results the parent needs.'

export function getAgent(id?: string): Agent {
  return (id && AGENTS[id]) || AGENTS.general
}

export function isAgent(id: string): boolean {
  return id in AGENTS
}

export function listAgents(): Array<Pick<Agent, 'id' | 'name' | 'description'>> {
  return Object.values(AGENTS).map(({ id, name, description }) => ({ id, name, description }))
}
