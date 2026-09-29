import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, statSync } from 'fs'
import path from 'path'
import { dataDir } from '../util/dataDir'
import { errMessage } from '../util/errMessage'
import {
  APP_SETTINGS_KEYS, MAX_TEAM_SIZE_LIMIT, MIN_TEAM_SIZE, PERMISSION_MODES, isElevatedMode,
  type AppSettings, type AppSettingsKey, type PermissionMode,
} from '@claudette/shared'

// The operator's app-wide preferences: the defaults a new session starts from, and the team
// ceiling. Persisted in dataDir() as settings.json.
//
// ★★ READ THIS BEFORE BELIEVING THE PANEL DOES ANYTHING. ★★
// Storing a setting and OBEYING it are two different features, and ONE OF THE FOUR KEYS IS NOW
// OBEYED. Keep this list accurate — it is the honest answer to "does the settings panel work?",
// and a stale version of it is worse than none:
//
//   maxTeamSize           — ★ CONSUMED. `mcp/teamTools.ts` resolves it per hire via
//                           resolveMaxTeamSize(). Unset still means 6, deliberately; see the
//                           note on DEFAULT_MAX_TEAM_SIZE in shared/src/settings.ts.
//   defaultModel          — ★ CONSUMED. `/api/session/create` falls back to it when the
//                           request OMITS `model`.
//   defaultAgentId        — ★ CONSUMED. Same route, same rule, for an omitted `agentId`.
//   defaultPermissionMode — ★ CONSUMED. Same route, for an omitted `permissionMode`.
//                           ★ The fallback is `??`, not `||`: only an ABSENT field falls back.
//                           `permissionMode: 'default'` is an explicit "ask me each time" and
//                           must win over a stored `bypassPermissions` — silently turning a
//                           user's request for prompting into allow-all is the worst outcome
//                           that route has.
//                           ★ AND IT IS SCOPED TO THAT ROUTE ON PURPOSE. This key may hold
//                           `bypassPermissions`, and /api/session/create passes `trusted:true`,
//                           so a stored elevated default IS honoured there — defensible, since
//                           it is operator config set through an auth-gated UI. It must NOT be
//                           pushed down into sessions.create(): `employ_teammate` calls that
//                           directly, with no mode and untrusted, so a hired teammate cannot
//                           inherit the operator's allow-all. Moving the lookup would hand it
//                           to every teammate silently.
//
// All four are now wired. Anyone wiring up another key should start by grepping for importers
// of this file, and should update this list in the same change — a stale entry here is the
// "enabled control that silently does nothing" shape the settings contract exists to prevent,
// and it fails in both directions: claiming CONSUMED when it is not sends someone looking for
// a bug that is really a missing feature.
//
// WHY settings.json AND NOT sessions.json: that file is a bare `SavedSession[]` with no object
// envelope, so there is nowhere to put a settings key without changing its top-level shape and
// its restore path. It is also rewritten wholesale on every session change, which would put
// operator preferences on a hot path where a failed session save loses them — and its every
// byte is replayed as TRUSTED at boot, a surface worth keeping small.
//
// WHY dataDir(): ~/.config/claudette is never bind-mounted into a session sandbox, unlike
// ~/.claude which every box binds rw. A confined session therefore cannot write the operator's
// default permission mode — which matters more here than for most files, because
// defaultPermissionMode names the very prompt that stands between a box and an unreviewed tool
// call. CLAUDETTE_DATA_DIR overrides the directory, which is what makes this testable.
//
// Written 0600 via tmp+rename, matching sandboxDefaults.ts / connectorStore.ts: a crash
// mid-write must not leave a truncated file behind.

const file = (): string => path.join(dataDir(), 'settings.json')

let cache: AppSettings | null = null

// ── VALIDATION, IN ONE PLACE, USED BY BOTH DOORS ─────────────────────────────────────────
// The load path and the save path enforce the SAME rules, and that is the whole design of this
// section rather than an incidental tidy-up. sandboxDefaults.ts records the lesson at length:
// a guard that restores a subset of the invariants its callers assume is worse than no guard,
// "because the survivors look validated". A hand-edited `maxTeamSize: -3` or
// `defaultPermissionMode: "banana"` has to be dropped on LOAD, not merely refused on SAVE,
// because the file is editable by hand and that is precisely where bad values enter.
//
// Returning a message rather than a boolean lets the save route hand the operator the reason
// verbatim — client.ts's post() does not throw on 4xx and renders `error` as written.
type Check = (v: unknown) => string | null

// A non-empty string after trimming. `defaultModel` and `defaultAgentId` are free text by
// design (the model field accepts an alias OR a pinned full id), so there is no vocabulary to
// check them against — only that an empty string never becomes a stored "preference", since
// absent already means "no preference" and two spellings of the same state is how a UI ends up
// unable to express one of them.
const nonEmptyString = (label: string): Check => (v) =>
  typeof v === 'string' && v.trim() !== '' ? null : `${label} must be a non-empty string.`

const CHECKS: Record<AppSettingsKey, Check> = {
  defaultModel: nonEmptyString('The default model'),
  defaultAgentId: nonEmptyString('The default agent'),
  // Derived from the runtime array, never a hand-written list of the four modes: a fifth mode
  // must start being accepted here the moment it is added to PERMISSION_MODES, rather than
  // being silently refused by a validator nobody remembered to update.
  //
  // ★★ AN ELEVATED MODE MAY NOT BE STORED AS A DEFAULT. ★★
  // THE PRINCIPLE: elevation is a LIVE DECISION, NOT A PERSISTED ATTRIBUTE. This is the same
  // rule downgradeRestoredMode enforces for a restored session's own mode — a human must
  // re-grant it after a restart — and this closes the sibling case it does not reach: a stored
  // default that would silently elevate every FUTURE session, with no human in the loop at the
  // moment the privilege is actually taken.
  //
  // Genuinely inert today: nothing in server/src consumes this key, and ~/.config/claudette is
  // never bind-mounted into a sandbox, so no confined session can write the file in the first
  // place. It is landed anyway because it costs one line BEFORE the consumption half ships and
  // an incident AFTER — and the consuming code would have every reason to trust a value this
  // module had already validated.
  //
  // isElevatedMode, never a fifth `m === 'bypassPermissions' || m === 'acceptEdits'` pair: that
  // exact comparison was written out in four independent places and a fifth elevated mode would
  // have defeated all four in silence, since widening a union keeps every `===` valid. The
  // shared predicate is an exhaustive Record that fails to COMPILE when the union grows.
  defaultPermissionMode: (v) => {
    if (typeof v !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(v)) {
      return `The default permission mode must be one of: ${PERMISSION_MODES.join(', ')}.`
    }
    // Rendered verbatim to the operator, so it says WHY rather than just "no".
    if (isElevatedMode(v as PermissionMode)) {
      return `"${v}" grants elevated permissions, so it cannot be stored as a default — `
        + 'elevation is a live decision and must be granted per session by a human. '
        + `Choose one of: ${PERMISSION_MODES.filter((m) => !isElevatedMode(m)).join(', ')}.`
    }
    return null
  },
  // Integer-and-in-range, mirroring parseTeamSize in web/src/lib/settingsLogic.ts.
  //
  // The Number.isInteger test is not redundant with the bounds: 6.5 sits happily between 1 and
  // 12 and would otherwise be stored as a fractional team size. MEASURED, against an earlier
  // version of this comment that claimed it also catches NaN: it does NOT, because it does not
  // need to. The bounds are written as an ACCEPTANCE (`v >= MIN && v <= MAX`) and every
  // comparison with NaN is false, so NaN is already refused here. That safety is a property of
  // the FORMULATION, not of the values — flip this to a rejection (`if (v < MIN || v > MAX)
  // return error`) and NaN passes both tests and sails through, with only isInteger left
  // standing between it and the file. Keep the acceptance form.
  maxTeamSize: (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= MIN_TEAM_SIZE && v <= MAX_TEAM_SIZE_LIMIT
      ? null
      : `The team size must be a whole number between ${MIN_TEAM_SIZE} and ${MAX_TEAM_SIZE_LIMIT}.`,
}

export function isAppSettingsKey(k: unknown): k is AppSettingsKey {
  return typeof k === 'string' && (APP_SETTINGS_KEYS as readonly string[]).includes(k)
}

function load(): AppSettings {
  if (cache) return cache
  try {
    const p = file()
    if (!existsSync(p)) return (cache = {})
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'))
    // A file holding a bare array, a number or null parses fine and is not settings. Treat it
    // as empty rather than letting `Object.entries` of a non-object decide the shape.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[settings] settings.json does not hold an object — starting with no settings.')
      return (cache = {})
    }
    const raw = parsed as Record<string, unknown>
    const out: AppSettings = {}
    const dropped: string[] = []
    for (const [k, v] of Object.entries(raw)) {
      // An UNKNOWN key is dropped silently and without complaint, unlike a known key holding a
      // bad value. Two different situations: a stale key from an older schema (or a newer one,
      // if the operator downgraded) is expected debris, whereas `maxTeamSize: -3` means
      // something wrote a value this module would have refused, and is worth a line in the log.
      if (!isAppSettingsKey(k)) continue
      if (CHECKS[k](v) !== null) { dropped.push(k); continue }
      ;(out as Record<string, unknown>)[k] = v
    }
    // Drop the BAD KEYS, not the whole file — losing one preference beats losing all four to a
    // single mistyped entry, and it self-heals: the next save writes back only what survived.
    // Loud about which ones, because this is where a hand edit lands and a silently missing
    // preference reads as the panel being broken rather than the file needing a look.
    if (dropped.length) {
      console.warn(`[settings] dropped ${dropped.length} invalid setting(s) from settings.json `
        + `(${dropped.join(', ')}) — each held a value this server would have refused to save. `
        + 'The remaining settings are unaffected, and saving anything will rewrite the file without them.')
    }
    cache = out
    return cache
  } catch (e) {
    // Only fires when the file will not PARSE. A file that parses but holds a bad value — much
    // the likelier corruption — never reaches here; the per-key checks above handle it.
    //
    // MOVE IT ASIDE BEFORE STARTING EMPTY, for the reason sandboxDefaults.ts spells out: caching
    // `{}` means the operator's very next save — the reflex of someone whose settings have just
    // vanished — persists that empty object straight over the bytes they would have needed to
    // recover. The log line alone was a remedy that the code then destroyed.
    const p = file()
    let kept = ''
    try {
      if (existsSync(p)) {
        // A UNIQUE name per corruption: a bare `${p}.corrupt` would have the second corruption
        // discard the copy the first one preserved. mtime-based so the suffix describes the FILE
        // rather than the moment it was noticed, with a counter to break a same-second tie.
        let dest = `${p}.${Math.floor(statSync(p).mtimeMs)}.corrupt`
        for (let n = 2; existsSync(dest); n++) dest = `${p}.${Math.floor(statSync(p).mtimeMs)}-${n}.corrupt`
        renameSync(p, dest)
        kept = ` The unreadable file has been kept as ${dest}.`
      }
    } catch (moveErr) {
      kept = ` It could NOT be moved aside (${errMessage(moveErr)}), so the next save will overwrite it — copy it now if you want it.`
    }
    console.error(`[settings] could not read settings.json, starting empty: ${errMessage(e)}.${kept}`)
    return (cache = {})
  }
}

function persist(s: AppSettings): void {
  const p = file()
  const tmp = `${p}.tmp`
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)   // explicit: a pre-existing tmp would keep its old mode
  renameSync(tmp, p)
  cache = s
}

export function getSettings(): AppSettings {
  return { ...load() }
}

export type SaveSettingsResult =
  | { ok: true; settings: AppSettings }
  | { ok: false; error: string }

// SET-ONLY. An omitted key is left exactly as it was; this verb NEVER clears one — that is
// what resetSetting is for, and the split is the settled contract (see AppSettings in
// shared/src/settings.ts for why a nullable save is three states in a type that says two).
//
// ★ AN EXPLICIT null/undefined IS REFUSED RATHER THAN TREATED AS A CLEAR. Accepting it would
// rebuild the merged verb through the back door: every consumer on both sides would once again
// have to distinguish "present and null" from "absent", which is the precise cost the two-verb
// split was chosen to avoid. Refusing is also the safer direction — a client that sends null
// meaning "clear" learns immediately, whereas silently clearing would look like it worked.
export function saveSettings(patch: unknown): SaveSettingsResult {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'Expected an object of settings to save.' }
  }
  const entries = Object.entries(patch as Record<string, unknown>)
  if (entries.length === 0) return { ok: false, error: 'No settings were supplied.' }

  // Validate EVERYTHING before writing ANYTHING. A partial application would leave the operator
  // with some of their edit applied and an error message, and no way to tell which half landed.
  for (const [k, v] of entries) {
    if (!isAppSettingsKey(k)) return { ok: false, error: `"${k}" is not a setting.` }
    if (v === null || v === undefined) {
      return { ok: false, error: `To clear "${k}", use reset — save only ever sets a value.` }
    }
    const err = CHECKS[k](v)
    if (err) return { ok: false, error: err }
  }

  const next: AppSettings = { ...load() }
  for (const [k, v] of entries) (next as Record<string, unknown>)[k] = v
  persist(next)
  return { ok: true, settings: { ...next } }
}

export type ResetSettingResult =
  | { ok: true; settings: AppSettings }
  | { ok: false; error: string }

// Clear exactly one key.
//
// An UNKNOWN key is an ERROR here, deliberately unlike removeDefaultFolder's no-op. The cases
// differ in what the caller's intent implies: removing a folder that is not listed already
// satisfies "this must not be in the list", so failing the second of two tabs would be noise.
// An unknown SETTINGS key means the client and server disagree about what the key set IS, and
// a client resetting a control the server has never heard of is worth surfacing rather than
// answering with a cheerful unchanged payload.
//
// Resetting a key that is simply not SET is still a success — that is the folder case, and the
// intent ("no app-wide preference for this") is already true.
export function resetSetting(key: unknown): ResetSettingResult {
  if (!isAppSettingsKey(key)) return { ok: false, error: `"${String(key)}" is not a setting.` }
  const cur = load()
  if (!(key in cur)) return { ok: true, settings: { ...cur } }
  const next: AppSettings = { ...cur }
  delete next[key]
  persist(next)
  return { ok: true, settings: { ...next } }
}

// Test seam: drop the in-memory cache so a test (or a hand edit of the file) is seen.
export function resetSettingsCache(): void {
  cache = null
}
