// The app-settings contract: the shapes both halves agree on for `GET /api/settings`,
// `POST /api/settings/save` and `POST /api/settings/reset`.
//
// ★ WHY A NEW FILE RATHER THAN shared/src/types.ts, WHICH THE PLAN ASKED FOR.
// The plan (settings-backend.md §6.1) said to put these beside `PermissionMode` in types.ts.
// They are here instead because types.ts is being edited concurrently for the isElevatedMode
// consolidation, and two writers in one file is how work gets lost. Nothing is given up by
// splitting: `shared/src/bashProcs.ts` already sets the precedent of a topic file that imports
// from './types' and is re-exported through index.ts, so `@claudette/shared` still resolves
// every name from one place and no consumer can tell the difference.
//
// This file is the destination named in `web/src/lib/settingsContract.ts`'s header — that
// local mirror exists only because the UI was built before its server, and its whole body is
// meant to collapse into a re-export from here and then be deleted. The interface bodies and
// their comments below are copied from it VERBATIM and deliberately so: the point of the
// migration is that the two never say different things, and paraphrasing on the way across is
// the one edit that would quietly break that.
import type { PermissionMode } from './types'

// EVERY FIELD IS OPTIONAL, and absent is meaningful rather than merely unset: it means "no
// app-wide preference — use the built-in fallback". For `defaultModel` the fallback is the
// CLI's own choice, which is why the UI must not preselect a model: shipping this with a
// value would change behaviour for every existing install on upgrade, silently.
//
// ★★ TWO VERBS, ONE MEANING EACH — SETTLED 2026-09-08, AND THE REASON IS TYPING. ★★
//   POST /api/settings/save   SETS. An omitted key is unchanged. It NEVER clears.
//   POST /api/settings/reset  CLEARS one key, body `{ key }`.
//
// An earlier draft had `save` take `Partial<AppSettings>` where an explicit `null` meant
// "reset to fallback". That is not `Partial<AppSettings>`: it is
// `{ [K in keyof AppSettings]?: AppSettings[K] | null }`, and every consumer on BOTH sides
// then has to distinguish a null that means something different from absent — three states
// on one verb, in a type that says two. Splitting it keeps `Partial<AppSettings>` honest and
// stops a nullable union crossing the wire at all. The cost is one extra route; the saving is
// that no reader of this type ever has to ask what `null` means here.
export interface AppSettings {
  defaultModel?: string
  defaultAgentId?: string
  defaultPermissionMode?: PermissionMode
  maxTeamSize?: number
}

// The settable keys AS A VALUE, for the same reason BASH_PROC_STATES is a value: the save and
// reset paths must both reason over "all of them", and a reset route that hand-listed the keys
// would accept a fifth key silently — or refuse one — the day AppSettings grows. Deriving the
// type from the array (rather than the array from the type, which TypeScript cannot do) is what
// makes adding a key to one place impossible without the other following.
//
// The `satisfies` clause is the half that actually bites: it makes this array fail to COMPILE
// if it ever names something that is not an AppSettings key. It does NOT catch a key added to
// AppSettings and forgotten here — nothing in the type system can — so that direction is
// covered by an exhaustiveness assertion in scratchpad/settings-store-test.mts instead.
export const APP_SETTINGS_KEYS = [
  'defaultModel', 'defaultAgentId', 'defaultPermissionMode', 'maxTeamSize',
] as const satisfies ReadonlyArray<keyof AppSettings>

export type AppSettingsKey = (typeof APP_SETTINGS_KEYS)[number]

// ── maxTeamSize bounds ───────────────────────────────────────────────────────────────────
// 12 is a HARD MAXIMUM and is not itself settable; 1 is the floor because a team of zero is
// just a session with no teammates, which is what not setting a team up already means.
//
// ★ THESE LIVE IN shared/ BECAUSE THE SERVER MUST ENFORCE THE SAME NUMBERS THE UI SHOWS.
// Client-side validation is not a control — anything that can reach the auth-gated port can
// POST whatever it likes — so the server validates too, and the only way two validators stay
// in agreement is for there to be one pair of numbers. `web/src/lib/settingsLogic.ts` still
// declares its own copies today; until that file re-exports these, the two are pinned equal by
// scratchpad/settings-store-test.mts, which reads both and fails on drift.
//
export const MAX_TEAM_SIZE_LIMIT = 12
export const MIN_TEAM_SIZE = 1

// ★★ UNSET MEANS 6, AND IT MUST NEVER MEAN MAX_TEAM_SIZE_LIMIT. ★★
// This is the value `teamTools.ts` enforced as a hardcoded constant before the setting was
// wired up, so it is what every install behaves like TODAY. Nobody has a stored maxTeamSize,
// which means the unset branch is the branch every existing install takes.
//
// Resolving absent → the ceiling would therefore DOUBLE the team cap of every install on
// upgrade, with no operator action and nothing on screen to say so. That is a
// behaviour-change-on-upgrade, the same class `defaultModel` is specified to avoid when it
// declines to preselect a model. "The default is the maximum" is the obvious-looking
// simplification here and it is wrong; this constant exists so that it cannot be made by
// accident.
export const DEFAULT_MAX_TEAM_SIZE = 6

// The one resolver both the enforcement point and its tests use, so neither can drift from the
// rule above. Clamps rather than refuses: a value outside the bounds can only arrive from a
// hand-edited settings.json (the store validates the save path), and a team ceiling is a
// quantity where the nearest legal value is a sane reading of the intent — unlike a permission
// mode, where there is no "nearest" and the store drops the key instead.
export function resolveMaxTeamSize(stored: number | undefined): number {
  if (stored === undefined || !Number.isFinite(stored)) return DEFAULT_MAX_TEAM_SIZE
  return Math.min(MAX_TEAM_SIZE_LIMIT, Math.max(MIN_TEAM_SIZE, Math.floor(stored)))
}

// A setting the ENVIRONMENT is dictating. Sent by the server rather than inferred here: the
// client cannot see the process env, and a hardcoded list of "things an env var might
// override" goes stale the moment a new one is added server-side — rendering an enabled
// control that silently does nothing, which is undetectable by looking at the screen.
// ★ A SERVER-SIDE OBLIGATION, recorded here because this file is the contract: `key` must be
// a key that EXISTS in AppSettings. `HOST` and `PORT` are not settings — they live in
// `environment` and are read-only there — so they must never appear as overrides.
// The client treats an unrecognised key as inert (it locks nothing, because the lookup is
// keyed), which fails safe. That defence is kept deliberately even though the server is
// obliged not to need it: a behaviour that only matters when the other side is wrong is
// exactly the kind worth keeping, and it costs nothing.
export interface SettingsOverride {
  key: string     // an AppSettings key — see the obligation above
  env: string     // the environment variable doing it, e.g. 'CLAUDETTE_MAX_TEAM_SIZE'
  value: string   // the effective value, already stringified for display
}

// Read-only facts about where this server is running. Not settings: HOST and PORT are read
// once at module load, so a control that edited them would do nothing until a restart — the
// same silent no-op as an enabled control under an env override.
export interface SettingsEnvironment {
  host: string
  port: number
  dataDir: string
  oauthRedirectUri: string
}

export interface AppSettingsResponse {
  settings: AppSettings
  overrides: SettingsOverride[]
  environment: SettingsEnvironment
}

// The body of POST /api/settings/reset. A single key, because reset clears exactly one thing —
// see the two-verbs note on AppSettings.
export interface ResetSettingRequest {
  key: string
}
