import type { FastifyInstance } from 'fastify'
import type { AppSettings, AppSettingsResponse, ResetSettingRequest } from '@claudette/shared'
import { getSettings, saveSettings, resetSetting } from './settingsStore'
import { listOverrides, buildEnvironment } from './settingsEnv'

// HTTP surface for the operator's app-wide settings.
//
// ★★ THREE OF THE FOUR KEYS STILL CHANGE NO BEHAVIOUR. ★★ `maxTeamSize` IS now obeyed
// (teamTools.ts resolves it per hire); defaultModel, defaultAgentId and defaultPermissionMode
// are stored faithfully and read by nothing — see the per-key list at the top of
// settingsStore.ts, which is the one to keep current. Say which is which when reporting this,
// because a panel that saves correctly and affects nothing looks identical to a broken one from
// the outside, and "it saved!" is not evidence that it did anything.
//
// Auth: every route here inherits the app's global gate — index.ts installs
// `app.addHook('preHandler', makeAuthHook(auth))` BEFORE any route is registered, and that
// hook gates everything under /api/ except /api/health and /api/auth. So handlers may treat
// the caller as the operator, exactly as sessionApi.ts and sandboxDefaultsApi.ts do. A
// sandboxed session shares the network namespace and can reach this port, but holds no
// CLAUDETTE_TOKEN and so cannot authenticate (SANDBOX.md "Control-plane escape"). That matters
// more here than it looks: defaultPermissionMode names the very prompt standing between a box
// and an unreviewed tool call, so a box that could write it could widen its own future.
//
// ⚠ A CONSEQUENCE WORTH KNOWING BEFORE ANYONE DEBUGS THIS: the preHandler runs before route
// matching, so a MISSING route and a BAD TOKEN are indistinguishable by status — both 401.
// Never diagnose "is the settings backend deployed?" from a status code. Confirm by CONTENT:
// GET /api/settings returning a body with a `settings` key.
//
// Both writes reply with the WHOLE AppSettingsResponse rather than the key they touched, so a
// client never reconciles a patch against what it thought it had — matching
// sandboxDefaultsApi.ts and what SettingsPanel.apply() already expects.
//
// Errors go back as `{ error: string }` with a 4xx. The client reads `error` off the POST body
// deliberately (web/src/api/client.ts types these as `T & { error?: string }`, and post() does
// NOT throw on non-2xx the way get() does), so these messages are rendered VERBATIM to the
// operator. Keep them human-readable; they are the UI copy.

function snapshot(): AppSettingsResponse {
  return { settings: getSettings(), overrides: listOverrides(), environment: buildEnvironment() }
}

export function registerSettingsRoutes(app: FastifyInstance): void {
  app.get('/api/settings', async (): Promise<AppSettingsResponse> => snapshot())

  // SET-ONLY. An omitted key is untouched; an explicit null is REFUSED rather than treated as
  // a clear — see saveSettings. Clearing is /api/settings/reset.
  app.post<{ Body: Partial<AppSettings> }>('/api/settings/save', async (req, reply) => {
    const r = saveSettings(req.body)
    if (!r.ok) { reply.code(400); return { error: r.error } }
    // Re-read the whole picture rather than returning r.settings alone: overrides and
    // environment belong in the reply too, and snapshot() is the one place that assembles them.
    return snapshot()
  })

  // Clear exactly one key. An unknown key is a 400, not a silent success — it means the client
  // and server disagree about what the key set is, which is worth surfacing.
  app.post<{ Body: ResetSettingRequest }>('/api/settings/reset', async (req, reply) => {
    const r = resetSetting(req.body?.key)
    if (!r.ok) { reply.code(400); return { error: r.error } }
    return snapshot()
  })
}
