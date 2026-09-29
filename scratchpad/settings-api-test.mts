// The settings HTTP surface (server/src/settings/settingsApi.ts) — GET /api/settings and the
// two write verbs, driven through a real Fastify app with app.inject().
//
// Registered WITHOUT the auth preHandler on purpose: the gate is not this file's subject and is
// already covered generically by auth-route-coverage-test.mts, which enumerates Fastify's own
// route table (these routes were added to its registrar list so they are swept there too).
// What is under test here is the payload shape and the two verbs' HTTP behaviour.
//
// ⚠ AND THE THING THIS CANNOT TEST: that any of it DOES anything. These assertions are about
// the ROUTES. Whether a stored key is obeyed is a separate question with a separate test —
// `maxTeamSize` is obeyed (see team-size-setting-test.mts) and defaultModel, defaultAgentId
// and defaultPermissionMode are obeyed at session creation (see session-defaults-setting-test.mts).
// Every assertion below would stay green if all four were inert. Read this as "the routes are
// correct", not as "settings work" — that separation is why the consumption tests are separate
// files, and why this sentence must be updated whenever a key is wired rather than left saying
// the opposite of the truth.

import Fastify from 'fastify'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { check, failed as fail } from './assert.mjs'
import { APP_SETTINGS_KEYS } from '../shared/src/settings.js'
import { redirectUri } from '../server/src/connectors/connectorOAuth.js'

const dir = mkdtempSync(path.join(tmpdir(), 'claudette-settings-api-'))
process.env.CLAUDETTE_DATA_DIR = dir

const { registerSettingsRoutes } = await import('../server/src/settings/settingsApi.js')

const app = Fastify({ logger: false })
registerSettingsRoutes(app)
await app.ready()

const get = async () => {
  const r = await app.inject({ method: 'GET', url: '/api/settings' })
  return { status: r.statusCode, body: r.json() as Record<string, unknown> }
}
const post = async (url: string, payload: unknown) => {
  const r = await app.inject({ method: 'POST', url, payload: payload as object })
  return { status: r.statusCode, body: r.json() as Record<string, unknown> }
}

try {
  // --- the payload shape -----------------------------------------------------------------
  const g = await get()
  check('GET /api/settings answers 200', g.status === 200, `${g.status}`)
  // Checked by CONTENT rather than status, deliberately. The app's auth preHandler runs before
  // route matching, so in the real server a missing route and a bad token are both 401 — a
  // status code can never tell anyone whether this backend is deployed. A `settings` key can.
  for (const k of ['settings', 'overrides', 'environment']) {
    check(`the response carries a "${k}" key`, k in g.body, JSON.stringify(Object.keys(g.body)))
  }
  check('a fresh install reports no settings', Object.keys(g.body.settings as object).length === 0,
    JSON.stringify(g.body.settings))

  // --- environment -----------------------------------------------------------------------
  const env = g.body.environment as Record<string, unknown>
  for (const k of ['host', 'port', 'dataDir', 'oauthRedirectUri']) {
    check(`environment carries "${k}"`, env[k] !== undefined, JSON.stringify(env))
  }
  check('environment.dataDir is the overridden data dir', env.dataDir === dir, String(env.dataDir))
  // ★ PINS THE NO-SECOND-CONSTRUCTION RULE. `localhost` and `127.0.0.1` are different strings to
  // an exact-matching OAuth provider, so the URI the panel displays must be the very one the
  // OAuth flow sends. Comparing against redirectUri() called DIRECTLY is what makes a
  // re-implementation in settingsEnv.ts fail here instead of surfacing later as a
  // redirect_uri_mismatch, which names neither file.
  // MUTATION THAT TURNS THIS RED: inline the URI in buildEnvironment() with 'localhost'.
  check('environment.oauthRedirectUri IS redirectUri(), not a rebuild of it',
    env.oauthRedirectUri === redirectUri(), `route=${env.oauthRedirectUri} direct=${redirectUri()}`)

  // --- overrides: the contract's server-side obligation, asserted rather than promised ----
  const overrides = g.body.overrides as Array<Record<string, unknown>>
  check('overrides is an array', Array.isArray(overrides), JSON.stringify(overrides))
  // Empty TODAY because no CLAUDETTE_* var maps to a setting. Asserted as "every key is real"
  // rather than "the list is empty", so this keeps holding the day a real override is added —
  // an assertion of emptiness would have to be deleted then, taking the obligation with it.
  for (const o of overrides) {
    check(`override key "${String(o.key)}" is a real AppSettings key`,
      (APP_SETTINGS_KEYS as readonly string[]).includes(String(o.key)), JSON.stringify(o))
    check(`override "${String(o.key)}" names neither HOST nor PORT`,
      o.key !== 'host' && o.key !== 'port' && o.env !== 'HOST' && o.env !== 'PORT',
      JSON.stringify(o))
  }

  // --- save ------------------------------------------------------------------------------
  const saved = await post('/api/settings/save', { defaultModel: 'opus' })
  check('POST save answers 200', saved.status === 200, `${saved.status}`)
  check('…and replies with the WHOLE payload, not just the key it touched',
    'settings' in saved.body && 'overrides' in saved.body && 'environment' in saved.body,
    JSON.stringify(Object.keys(saved.body)))
  check('…and the value is in it', (saved.body.settings as Record<string, unknown>).defaultModel === 'opus',
    JSON.stringify(saved.body.settings))
  check('…and a subsequent GET agrees', (await get()).body.settings &&
    ((await get()).body.settings as Record<string, unknown>).defaultModel === 'opus', '')

  // ★ THE ANTI-MERGE ASSERTION, AT THE HTTP LAYER. save never clears.
  const nulled = await post('/api/settings/save', { defaultModel: null })
  check('save with an explicit null is a 400, not a clear', nulled.status === 400, `${nulled.status}`)
  check('…and the 400 carries a human-readable `error` (client.ts renders it VERBATIM)',
    typeof nulled.body.error === 'string' && (nulled.body.error as string).length > 0,
    JSON.stringify(nulled.body))
  check('…and the value survived the refused save',
    ((await get()).body.settings as Record<string, unknown>).defaultModel === 'opus', '')

  const badKey = await post('/api/settings/save', { notASetting: 1 })
  check('save of an unknown key is a 400', badKey.status === 400, `${badKey.status}`)
  const badVal = await post('/api/settings/save', { maxTeamSize: 9999 })
  check('save of an out-of-range value is a 400', badVal.status === 400, `${badVal.status}`)

  // --- reset -----------------------------------------------------------------------------
  const reset = await post('/api/settings/reset', { key: 'defaultModel' })
  check('POST reset answers 200', reset.status === 200, `${reset.status}`)
  check('…and the key is gone',
    (reset.body.settings as Record<string, unknown>).defaultModel === undefined,
    JSON.stringify(reset.body.settings))
  check('…and reset also replies with the WHOLE payload',
    'overrides' in reset.body && 'environment' in reset.body, JSON.stringify(Object.keys(reset.body)))

  const badReset = await post('/api/settings/reset', { key: 'notASetting' })
  check('reset of an unknown key is a 400, not a silent success', badReset.status === 400,
    `${badReset.status}`)
  check('…and it too carries an `error` string', typeof badReset.body.error === 'string',
    JSON.stringify(badReset.body))
  const emptyReset = await post('/api/settings/reset', {})
  check('reset with no key at all is a 400 rather than a crash', emptyReset.status === 400,
    `${emptyReset.status}`)
} finally {
  await app.close()
  rmSync(dir, { recursive: true, force: true })
}

process.exit(fail === 0 ? 0 : 1)
