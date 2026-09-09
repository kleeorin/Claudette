// ★★ TEMPORARY LOCAL MIRROR — DELETE THIS FILE WHEN THE SERVER HALF LANDS. ★★
//
// These types belong in `shared/src/types.ts`, beside every other type both halves of the app
// agree on. They are here only because the settings UI is being built before its server, and
// `shared/` is not writable from this session. When Landing builds `GET /api/settings`, the
// whole of this file is replaced by a re-export:
//
//     export type { AppSettings, SettingsOverride, AppSettingsResponse } from '@claudette/shared'
//
// …and then deleted once nothing imports it.
//
// ★ ONE FILE, ONE SEAM, ONE DELETION — and that is the entire point of the constraint.
// Declaring these shapes inline in the components that use them would scatter a contract
// across a tree, and then the day the real types land there is no single place to remove:
// some copies get updated, some do not, and two sources that ought to agree now disagree
// silently. That is the failure this team has spent the week removing from other files, and
// it is far cheaper to not create it. Nothing in web/src should redeclare these shapes —
// import them from here, so that when this file becomes a re-export every consumer follows
// automatically and the migration is one edit rather than a search.
import type { PermissionMode } from '@claudette/shared'

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
