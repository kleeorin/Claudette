import { dataDir } from '../util/dataDir'
import { redirectUri } from '../connectors/connectorOAuth'
import type { AppSettings, SettingsEnvironment, SettingsOverride } from '@claudette/shared'

// The two read-only halves of the settings payload: what the ENVIRONMENT is dictating, and
// where this server is running. Split from settingsStore.ts because this file reads process
// state rather than disk — and because this is the file to edit on the day a CLAUDETTE_*
// override variable is first introduced.

// ── OVERRIDES ────────────────────────────────────────────────────────────────────────────
// ★ THE TABLE IS EMPTY TODAY, AND THAT IS THE CORRECT IMPLEMENTATION — NOT A STUB.
// No environment variable overrides any AppSettings key. The complete set of CLAUDETTE_* vars
// in server/src is CLAUDETTE_DATA_DIR, CLAUDETTE_CREDENTIALS_DIR, CLAUDETTE_NO_AUTH,
// CLAUDETTE_TOKEN, CLAUDETTE_DEFAULT_KERNEL, CLAUDETTE_ALLOW_UNSANDBOXED,
// CLAUDETTE_ALLOW_APP_SOURCE_MOUNT and CLAUDETTE_APP_ROOT; not one of them is a setting.
// CLAUDETTE_MAX_TEAM_SIZE and CLAUDETTE_DEFAULT_MODEL exist ONLY as fixture strings in the web
// tests — they have never been real. So `overrides` is `[]`, always, until someone adds a row
// here. Do NOT invent a variable to make the field look populated: the client's lock mechanism
// is driven entirely by this array, so a fabricated row would DISABLE a control that nothing
// is actually overriding, which is the same "the screen lies" failure as the reverse.
//
// The table is built anyway, empty, because it is the seam: adding an override becomes one row
// rather than a new mechanism, and typing `key` as `keyof AppSettings` turns the contract's
// server-side obligation ("every key must exist in AppSettings; HOST and PORT must never
// appear") from a comment into a compile error. HOST and PORT cannot be named here even by
// accident — they are not AppSettings keys, so the type rejects them.
const ENV_OVERRIDES: ReadonlyArray<{ key: keyof AppSettings; env: string }> = []

export function listOverrides(): SettingsOverride[] {
  return ENV_OVERRIDES
    .map(({ key, env }) => ({ key, env, value: process.env[env] }))
    // An override is only in force when the variable is actually SET. An unset var must not
    // produce a row: a row is what locks the control, so reporting one for a variable nobody
    // exported would disable an editable setting for everybody.
    .filter((o): o is { key: keyof AppSettings; env: string; value: string } => o.value !== undefined)
    .map(({ key, env, value }) => ({ key, env, value: String(value) }))
}

// ── ENVIRONMENT ──────────────────────────────────────────────────────────────────────────
// Facts, not settings. HOST and PORT are read into module-scope consts in index.ts at load, so
// a control that edited them would do nothing until a restart — the same silent no-op as an
// enabled control under an env override, which is why they are reported here and are not
// members of AppSettings.
//
// index.ts does not export its HOST/PORT consts, so they are re-read here with IDENTICAL
// defaults ('127.0.0.1' / 4319). That is a second reading of the same variables and worth
// naming as such: it is safe only because nothing mutates process.env.HOST/PORT after boot, so
// both readings are of the same bytes. If that ever stops being true, export the consts from
// index.ts rather than adding a third reader.
export function buildEnvironment(): SettingsEnvironment {
  return {
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 4319),
    // Not a pure getter: dataDir() also attempts a one-time legacy migration. Harmless and
    // idempotent via its own marker file, and by the time this route can be called the server
    // has long since called it anyway.
    dataDir: dataDir(),
    // ★ CALL THE EXISTING redirectUri(); DO NOT REBUILD THIS STRING. `localhost` and
    // `127.0.0.1` are different strings to an exact-matching OAuth provider, which is why that
    // function exists and why its value is surfaced in the UI rather than documented as a
    // constant. A second construction here would drift from the one the OAuth flow actually
    // sends, and the symptom — redirect_uri_mismatch — names neither file.
    oauthRedirectUri: redirectUri(),
  }
}
