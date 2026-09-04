// The quota-meter credentials path (server/src/usage/usageApi.ts) — IS IT TEST-ISOLATED?
//
// THE DEFECT THIS PINS. `CREDS` used to be `join(homedir(), '.claude', '.credentials.json')`,
// a constant computed at module load from homedir() alone. It honoured no override at all, so
// a harness that set CLAUDETTE_DATA_DIR at a throwaway directory — believing that isolated it,
// which is what util/dataDir.ts documents the variable for — still read the OPERATOR'S REAL
// OAuth token, and fetchUsage() then presented it to api.anthropic.com. Any Chrome harness
// that renders ChatView polls /api/usage through useUsage(), so a suite run could authenticate
// as the operator.
//
// READING THE REAL TOKEN IS THE FEATURE, not the defect — it is how the meter has numbers.
// What is asserted here is only that an ISOLATED run does not do it.
//
// WHAT THIS MEASURES RATHER THAN INFERS. `globalThis.fetch` is replaced for the whole run, so
// no request can leave this process even if an assertion is wrong, and the stub COUNTS calls
// and records what they carried. That turns "does it reach the network?" from an inference
// into an observation. What is deliberately NOT done: no real request to api.anthropic.com is
// ever made, and the operator's real token is never sent anywhere. The one case that exercises
// a token uses a FAKE one planted in the throwaway dir.

import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { createHash } from 'crypto'
import { tmpdir, homedir } from 'os'
import path from 'path'
import { check, failed as fail } from './assert.mjs'

const isoDir = mkdtempSync(path.join(tmpdir(), 'claudette-usage-iso-'))
const cfgDir = mkdtempSync(path.join(tmpdir(), 'claudette-usage-cfg-'))

// The real location, captured BEFORE anything is overridden, so the "was it consulted?"
// assertion below is about the operator's actual file and not a reconstruction of it.
const realCreds = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), '.credentials.json')
const realCredsHasToken = (() => {
  try {
    const t = (JSON.parse(readFileSync(realCreds, 'utf8')) as { claudeAiOauth?: { accessToken?: unknown } })
      .claudeAiOauth?.accessToken
    return typeof t === 'string' && !!t
  } catch { return false }
})()

const FAKE_TOKEN = 'fake-token-planted-by-usage-isolation-test'
const CFG_FAKE_TOKEN = 'fake-token-from-claude-config-dir'
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// Only tokens this harness planted itself. Anything NOT in here is treated as potentially the
// operator's and is never rendered in the clear.
const KNOWN_FAKES: Record<string, string> = { isolated: FAKE_TOKEN, 'claude-config-dir': CFG_FAKE_TOKEN }

// --- the fetch stub: a hard network stop AND the instrument ------------------------------
//
// THE CAPTURED Authorization HEADER IS NEVER PRINTED IN THE CLEAR, and that is not fussiness.
// The headline assertion here fails precisely when the code reads the OPERATOR'S REAL TOKEN,
// so the naive failure message — "0 calls expected, got 1: {...}" with the header spliced in —
// would print a live OAuth token into suite output and into whatever transcript quotes it, in
// exactly the run that proves the defect is present. A credential-isolation harness must not
// be the thing that leaks the credential. Comparison stays exact; only the DISPLAY is
// fingerprinted, and a token this test planted itself is named rather than hashed because it
// is fake and knowing which fake it was is the useful part.
const fingerprint = (v: string | null): string => {
  if (v === null) return 'none'
  for (const [name, tok] of Object.entries(KNOWN_FAKES)) if (v === `Bearer ${tok}`) return `Bearer <${name}>`
  return `Bearer <redacted sha256:${createHash('sha256').update(v).digest('hex').slice(0, 8)} len=${v.length}>`
}

interface Seen { url: string; auth: string | null; beta: string | null }
const seen: Seen[] = []
// What is safe to put in an assertion message.
const seenSafe = (): string => JSON.stringify(seen.map((s) => ({ url: s.url, auth: fingerprint(s.auth), beta: s.beta })))
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
  const h = init?.headers ?? {}
  seen.push({ url: String(input), auth: h.Authorization ?? null, beta: h['anthropic-beta'] ?? null })
  return {
    ok: true,
    json: async () => ({ limits: [{ kind: 'session', group: 'session', percent: 41.6, resets_at: '2026-09-03T12:00:00Z' }] }),
  }
}) as unknown as typeof globalThis.fetch

const plant = (dir: string, token: string): void => {
  writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }))
}

try {
  process.env.CLAUDETTE_DATA_DIR = isoDir
  const usage = await import('../server/src/usage/usageApi.js')
  const { fetchUsage, resetUsageCache } = usage

  // --- CASE 1: isolated, no credentials planted ------------------------------------------
  // The shape a suite run actually hits. QA's direct probe returned {windows: []}; the open
  // question was whether it reached the network to get there. Now measured: it must not.
  resetUsageCache()
  seen.length = 0
  const isolatedResult = await fetchUsage()
  check('an isolated run (CLAUDETTE_DATA_DIR set, no creds planted) yields no usage data',
    isolatedResult === null, `got ${JSON.stringify(isolatedResult)}`)
  check('and it makes NO outbound request — measured on the fetch stub, not inferred',
    seen.length === 0,
    {
      pass: '0 calls to fetch()',
      fail: `${seen.length} call(s): ${seenSafe()} — an isolated harness reached the network. The Authorization header is fingerprinted, not shown: if it is not one of this test's own fakes, the code just read the operator's real OAuth token.`,
    })
  // The route's own fallback, which is what a polling ChatView would receive.
  check('so /api/usage answers with an empty window list rather than an error',
    JSON.stringify((isolatedResult ?? { windows: [] }).windows) === '[]',
    JSON.stringify(isolatedResult ?? { windows: [] }))

  // The assertion that names the operator's real file. Only meaningful when that file really
  // exists and really holds a token — otherwise "we did not read it" is vacuously true, and a
  // green tick for a check that could not have failed is worse than no tick. So it is reported
  // honestly either way rather than being quietly counted as a pass.
  if (realCredsHasToken) {
    check('and the OPERATOR\'S REAL credentials file was NOT consulted while isolated',
      isolatedResult === null && seen.length === 0,
      `${realCreds} exists and holds a token, yet the isolated run produced `
        + `${JSON.stringify(isolatedResult)} and ${seen.length} request(s)`)
  } else {
    console.log(`ℹ️  not exercised: ${realCreds} holds no OAuth token on this host, so "the real file `
      + 'was not read" cannot be distinguished from "there was nothing to read". The isolation '
      + 'assertions above stand on their own; this one is reported as not-run rather than green.')
  }

  // --- CASE 2: isolated, with a FAKE token planted in the throwaway dir -------------------
  // Closes the other half: isolation must not work by breaking the feature. The credentials
  // file still drives the request, and this observes the request being built from it — with a
  // fake token, a stubbed fetch, and nothing leaving the process.
  resetUsageCache()
  seen.length = 0
  plant(isoDir, FAKE_TOKEN)
  const planted = await fetchUsage()
  check('a token planted in the ISOLATED dir is picked up — isolation redirects the lookup, it does not disable it',
    seen.length === 1, `${seen.length} call(s): ${JSON.stringify(seen.map((s) => s.url))}`)
  check('and the request carries THAT token, so the creds file demonstrably drives the call',
    seen[0]?.auth === `Bearer ${FAKE_TOKEN}`, `Authorization: ${fingerprint(seen[0]?.auth ?? null)}`)
  check('sent to the usage endpoint with the oauth beta header',
    seen[0]?.url === USAGE_URL && seen[0]?.beta === 'oauth-2025-04-20',
    `${seen[0]?.url} beta=${JSON.stringify(seen[0]?.beta)}`)
  check('and the reply is parsed into a window the meter can render',
    planted?.windows.length === 1 && planted.windows[0]?.percent === 42,
    JSON.stringify(planted))

  // --- CASE 3: NOT isolated — the production path still resolves the configured location ---
  // Proves the fix is behaviour-preserving where it matters. CLAUDE_CONFIG_DIR is used rather
  // than the operator's real ~/.claude so this never depends on, or touches, their token —
  // and it pins the same bug permissions.ts already fixed for the user settings scope, where
  // hardcoding ~/.claude meant reading a file no session was using.
  resetUsageCache()
  seen.length = 0
  delete process.env.CLAUDETTE_DATA_DIR
  process.env.CLAUDE_CONFIG_DIR = cfgDir
  plant(cfgDir, CFG_FAKE_TOKEN)
  await fetchUsage()
  check('with no isolation set, the creds come from claudeConfigDir() — CLAUDE_CONFIG_DIR honoured, not hardcoded ~/.claude',
    seen[0]?.auth === `Bearer ${CFG_FAKE_TOKEN}`,
    `Authorization: ${fingerprint(seen[0]?.auth ?? null)} — expected the token planted in ${cfgDir}`)

  // --- the standing guarantee of this harness --------------------------------------------
  check('no request in this whole run went anywhere but the stub',
    seen.every((s) => s.url === USAGE_URL) && globalThis.fetch !== realFetch,
    `${seen.length} recorded call(s); every one intercepted before the network`)
  check('and the operator\'s real credentials file was never planted to, or modified, by this test',
    !existsSync(path.join(isoDir, 'REAL')) && realCreds !== path.join(isoDir, '.credentials.json'),
    `real=${realCreds} isolated=${path.join(isoDir, '.credentials.json')}`)
} finally {
  globalThis.fetch = realFetch
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDETTE_DATA_DIR
  rmSync(isoDir, { recursive: true, force: true })
  rmSync(cfgDir, { recursive: true, force: true })
}

process.exit(fail === 0 ? 0 : 1)
