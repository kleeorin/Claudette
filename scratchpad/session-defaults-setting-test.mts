// defaultModel / defaultAgentId / defaultPermissionMode — the three stored settings ACTUALLY
// OBEYED at session creation (server/src/session/sessionApi.ts, POST /api/session/create).
//
// ★ THE SHAPE THIS CLOSES. All three round-tripped faithfully through the settings API and were
// then read by nothing: `/api/session/create` took model/agentId/permissionMode straight off the
// request body. Three ENABLED CONTROLS THAT SILENTLY DID NOTHING — the class this repo has now
// corrected several times and the one the settings contract was written to prevent.
//
// ★★ A PREMISE THAT TURNED OUT TO BE FALSE, RECORDED BECAUSE IT CHANGES THE THREAT MODEL.
// This file was commissioned on the understanding that `defaultPermissionMode` "can legitimately
// hold bypassPermissions", making a stored elevated default a real risk to scope carefully.
// IT CANNOT. `settingsStore.saveSettings` REFUSES every elevated mode outright —
//   "acceptEdits" grants elevated permissions, so it cannot be stored as a default —
//   elevation is a live decision and must be granted per session by a human.
// — and `settings-store-test.mts` already pins both halves of that: refused on SAVE, and
// DROPPED ON LOAD from a hand-edited file, so not even file tampering plants one. So the
// hazard is closed one layer below this route and is not re-tested here.
//
// ★ CONSEQUENCE FOR `??` vs `||`, STATED PLAINLY BECAUSE IT IS EASY TO OVER-CLAIM.
// The fallback is written `??` and should stay `??` — it says "omitted", which is the rule
// actually intended. But no test in this file can DISTINGUISH it from `||`, and I will not
// pretend otherwise: every valid value of these three fields is a non-empty string, hence
// truthy, so the two operators agree on every input reachable through the API. The
// worst-case scenario the brief feared — an explicit `permissionMode: 'default'` silently
// becoming a stored `bypassPermissions` — is impossible for two independent reasons: the
// string 'default' is truthy (so even `||` preserves it), and an elevated default cannot be
// stored at all. `??` remains correct and intention-revealing; it is simply not load-bearing
// here, and a future field whose valid values include '' or 0 would change that.
//
// MUTATIONS (measured 2026-09-22; ran=N reported alongside, because a mutant that fails to
// PARSE yields zero failures exactly like a clean pass):
//   D1  drop the model fallback     → the omitted-model case reds alone.
//   D2  drop the agentId fallback   → the omitted-agentId case reds alone.
//   D3  drop the mode fallback      → the omitted-mode case reds alone.
//   D4  fallback pushed down into sessions.create() (import added + `?? settings` inside
//       create) → ran=10, red=2: BOTH teammate cases, model and permissionMode, and nothing
//       else. I predicted "the teammate case, alone" — singular — and the measurement is
//       kept over the prediction. The pair is the more useful signal anyway: it shows the leak
//       is not specific to the field one happens to be thinking about.
//       All of D1–D3 measured ran=10, red=1, each reding alone. XX refused (0 matches).
//   XX  a patch matching no text must REFUSE.
import Fastify from 'fastify'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { check, passed as pass, failed as fail } from './assert.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = mkdtempSync(path.join(tmpdir(), 'claudette-sess-defaults-'))
const work = mkdtempSync(path.join(tmpdir(), 'claudette-sess-defaults-cwd-'))
process.env.CLAUDETTE_DATA_DIR = dir

// Shim BEFORE importing SessionManager — create() LAUNCHES, and launch spawns the literal
// command `claude`. Shim + stub live inside `work` because that is the session cwd and so the
// only directory the default sandbox mounts.
copyFileSync(path.join(here, 'fake-claude-team.mjs'), path.join(work, 'fake-claude.mjs'))
const shim = path.join(work, 'claude')
writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(path.join(work, 'fake-claude.mjs'))} "$@"\n`)
chmodSync(shim, 0o755)
process.env.PATH = `${work}${path.delimiter}${process.env.PATH ?? ''}`
process.env.FAKE_TURN_MS = '20'

const { SessionManager } = await import('../server/src/claude/sessionManager.js')
const { registerSessionRoutes } = await import('../server/src/session/sessionApi.js')
const { saveSettings, resetSettingsCache } = await import('../server/src/settings/settingsStore.js')

const sessions = new SessionManager({})
const app = Fastify({ logger: false })
registerSessionRoutes(app, sessions)

// Create through the REAL route, then read the stored session back. Asserting on the created
// session's own fields rather than on the response body is deliberate: the response carries
// only an id, and a fallback that "worked" in the echo while never reaching the session object
// is exactly the failure an echo-based test cannot see.
async function createVia(body: Record<string, unknown>) {
  const r = await app.inject({ method: 'POST', url: '/api/session/create', payload: { name: 'T', cwd: work, ...body } })
  const id = (r.json() as { id: string }).id
  return sessions.get(id)
}

try {
  // ── (a) AN OMITTED FIELD TAKES THE STORED SETTING ────────────────────────────────────────
  // 'plan' rather than an elevated mode because the store refuses elevated ones (see header).
  resetSettingsCache()
  const saved = saveSettings({ defaultModel: 'opus', defaultAgentId: 'planner', defaultPermissionMode: 'plan' })
  // Asserted, not assumed: saveSettings validates and is ATOMIC — one rejected key rejects the
  // whole patch. An earlier draft of this file stored an elevated mode here, the save was
  // refused wholesale, and every case below failed for a reason that had nothing to do with
  // the route under test.
  check('the fixture settings were actually stored', saved.ok === true, JSON.stringify(saved))
  resetSettingsCache()

  const fellBack = await createVia({})
  check('an omitted model takes the stored defaultModel', fellBack?.model === 'opus', String(fellBack?.model))
  check('an omitted agentId takes the stored defaultAgentId', fellBack?.agentId === 'planner', String(fellBack?.agentId))
  check('an omitted permissionMode takes the stored defaultPermissionMode',
    fellBack?.permissionMode === 'plan', String(fellBack?.permissionMode))

  // ── (b) AN EXPLICIT VALUE WINS OVER THE STORED ONE ───────────────────────────────────────
  const explicit = await createVia({ model: 'sonnet', agentId: 'general', permissionMode: 'default' })
  check('an explicit model wins over the stored default', explicit?.model === 'sonnet', String(explicit?.model))
  check('an explicit agentId wins over the stored default', explicit?.agentId === 'general', String(explicit?.agentId))
  check("an explicit permissionMode:'default' wins over a stored 'plan'",
    explicit?.permissionMode === 'default', String(explicit?.permissionMode))

  // ── (c) THE SCOPE BOUNDARY: a HIRED TEAMMATE takes NO stored default ─────────────────────
  // employ_teammate's exact call shape: seven positional args straight into sessions.create —
  // no mode, untrusted, and never through the HTTP route where the fallback lives. If someone
  // later "simplifies" by moving the settings lookup down into create(), every teammate starts
  // inheriting the operator's stored defaults and THIS is the only case that reds.
  const teammateId = sessions.create('hired', work, work, fellBack?.id, false, undefined, 'general')
  const teammate = sessions.get(teammateId)
  check('★★ a teammate hired in-process takes NO stored defaultModel', teammate?.model === undefined, String(teammate?.model))
  check('★★ …and no stored defaultPermissionMode', teammate?.permissionMode === undefined, String(teammate?.permissionMode))
  check('…while the agentId it was hired WITH is preserved', teammate?.agentId === 'general', String(teammate?.agentId))
} finally {
  sessions.shutdown()
  await app.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
