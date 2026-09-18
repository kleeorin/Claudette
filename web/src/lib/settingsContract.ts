// The app-settings wire types — now a pure RE-EXPORT of the shared definitions.
//
// ★ THIS FILE USED TO DECLARE ITS OWN COPY of AppSettings, SettingsOverride,
// SettingsEnvironment and AppSettingsResponse, under a banner reading "TEMPORARY LOCAL MIRROR —
// DELETE THIS FILE WHEN THE SERVER HALF LANDS", because the settings UI was built before its
// backend existed and `shared/` was not writable from the session that wrote it. The server
// half has since landed: `shared/src/settings.ts` holds all four, and the server's own
// validation derives from them (`APP_SETTINGS_KEYS`).
//
// ★★ WHY THE DUPLICATE HAD TO GO, even though the two copies AGREED field-for-field when this
// was written. The whole client wired against the mirror — api/client.ts, settingsLogic.ts and
// SettingsPanel.tsx all imported from here, and nothing in web/src imported AppSettings from
// shared — so the two declarations were fully independent and a divergence was invisible to
// typecheck ON BOTH SIDES. Concretely: add a fifth key to shared's AppSettings and the server
// would accept and validate it while the client's `Partial<AppSettings>` could not name it,
// with nothing failing to compile anywhere. The panel would silently be unable to set a key
// the backend supports.
//
// Kept as a re-export rather than deleted outright, exactly as the old banner prescribed: four
// modules import from this path, and the indirection costs nothing now that there is only one
// declaration behind it. Note the SIBLING duplication — MAX_TEAM_SIZE_LIMIT / MIN_TEAM_SIZE,
// also mirrored in lib/settingsLogic.ts — IS pinned by scratchpad/settings-store-test.mts,
// which reads that file as text and fails on drift. The numbers were guarded and the shapes
// were not; this closes that asymmetry at the source instead of adding a second guard.
//
// ── THE CONTRACT ITSELF now lives beside the types in shared/src/settings.ts. Two points that
// callers here rely on, kept because other files' comments point at this one:
//
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
export type {
  AppSettings,
  SettingsOverride,
  SettingsEnvironment,
  AppSettingsResponse,
} from '@claudette/shared'
