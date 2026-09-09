// App-settings decisions, kept out of the component so the interesting cases are reachable
// without a DOM — the same reason `sessionLights.ts` and `connectorAuth.ts` exist. The rule
// that most needs pinning is the override one: a control the operator can edit that silently
// does nothing is the exact class this repo has now corrected three times.
import type { AppSettings, SettingsOverride } from './settingsContract'

// ★ THE OVERRIDE LOOKUP — DRIVEN BY THE SERVER'S LIST, NEVER BY A LIST HERE.
// Precedence is env-wins, uniformly. The client cannot see the process env, so the only
// honest source is the `overrides` array the server sends. A hardcoded set of "keys an env
// var might control" would be correct on the day it was written and wrong the first time a
// new variable is added server-side without someone remembering to mirror it — and the
// symptom is an ENABLED control that does nothing, which nobody can spot by looking. Driving
// it off the payload means a new override starts disabling its control the moment the server
// reports it, with no client change at all.
export function overrideFor(
  key: keyof AppSettings,
  overrides: readonly SettingsOverride[],
): SettingsOverride | undefined {
  return overrides.find((o) => o.key === key)
}

// A control is disabled IF AND ONLY IF the environment is dictating its value. Deliberately
// not "disabled when busy or overridden" — busy-ness is a transient the component owns, and
// folding the two together here would make this rule untestable without a render.
export function isLocked(key: keyof AppSettings, overrides: readonly SettingsOverride[]): boolean {
  return overrideFor(key, overrides) !== undefined
}

// ── maxTeamSize ──────────────────────────────────────────────────────────────────────────
// 12 is a HARD MAXIMUM and is not itself settable; 1 is the floor because a team of zero is
// just a session with no teammates, which is what not setting a team up already means.
export const MAX_TEAM_SIZE_LIMIT = 12
export const MIN_TEAM_SIZE = 1

// Returns the value to send, or an error to show. `null` is a real value here — it means
// "reset to the built-in fallback" and is how an operator un-sets a preference — so it is
// distinguished from an empty/invalid entry rather than lumped in with it.
export function parseTeamSize(raw: string): { value: number | null } | { error: string } {
  const t = raw.trim()
  if (t === '') return { value: null }
  if (!/^\d+$/.test(t)) return { error: 'Enter a whole number.' }
  const n = Number(t)
  if (n < MIN_TEAM_SIZE) return { error: `The smallest team is ${MIN_TEAM_SIZE}.` }
  if (n > MAX_TEAM_SIZE_LIMIT) return { error: `${MAX_TEAM_SIZE_LIMIT} is the hard maximum.` }
  return { value: n }
}

// ── defaultModel ─────────────────────────────────────────────────────────────────────────
// ALIASES ARE THE PRIMARY CHOICE, and this is a durability argument rather than a taste one.
// The CLI's own `--model` help offers an alias ("fable", "opus", "sonnet") or a full name
// ("claude-fable-5"). An alias resolves to the latest model in that family and keeps doing so
// after a release; a pinned full id is correct until the day it is not, and then it is silently
// stale — still valid, just no longer what the operator meant by "the good one". Free text
// stays available because pinning is sometimes exactly what you want.
export const MODEL_ALIASES = ['opus', 'sonnet', 'fable'] as const

// ★ ABSENT IS A VALUE, AND THE UI MUST BE ABLE TO EXPRESS IT.
// Absent means "the CLI chooses", which is what every existing install does today. If the
// panel preselected an alias, merely opening it and saving anything would change the model
// for every new session — a behaviour change nobody asked for, delivered by a settings screen
// that looked like it was only displaying state. So the unset option is a real, selectable
// choice rather than a placeholder.
export function isCustomModel(v: string | undefined): boolean {
  return v !== undefined && !(MODEL_ALIASES as readonly string[]).includes(v)
}
