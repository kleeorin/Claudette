// Agent roles (charter + tool scope + model) for a session. Phase-1 stub: only
// the `general` role (no charter, full tools, the user's default model — i.e. an
// ordinary session). Phase 3 replaces this with the full built-in role set
// (planner, reviewer, …) and subsession orchestration; the SessionManager wiring
// (getAgent + SUBSESSION_REPORT_INSTRUCTION → claudeArgs) is already in place so
// that's a drop-in. See ../ClaudeMaster/src/main/agents.ts for the full version.

export interface Agent {
  id: string
  name: string                 // display name / sidebar badge
  description: string          // shown to an orchestrating agent via list_agents
  systemPrompt?: string        // persistent charter → --append-system-prompt
  model?: string               // pin a model; undefined = user default
  allowedTools?: string[]      // whitelist → --allowedTools
  disallowedTools?: string[]   // blacklist → --disallowedTools (MERGED with NOTEBOOK_DENY)
}

export const AGENTS: Record<string, Agent> = {
  general: {
    id: 'general',
    name: 'General',
    description: "Default agent — no special charter, full tools, the user's default model. Same as an ordinary session.",
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
