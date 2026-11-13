// SessionManager.whenReady — the wait that /rewind and /clear now do before answering.
//
// The race it closes: resumeInto/restartFresh set `replacing` and kill the engine; the new
// engine only appears on the old one's exit event. A turn sent in between hits
// sendUserTurn's `replacing` guard and is reported undelivered. "Edit last message" =
// rewind, then send at once — straight into that window.
//
// Real SessionManager, real kill/exit/relaunch sequence; `claude` is a stub on PATH
// (fake-claude-team.mjs: init, then echo each stdin line). Shim + stub live inside the
// session cwd for the sandbox reason agent-pending-test.mts spells out.
//   npx tsx scratchpad/when-ready-test.mts
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
process.env.CLAUDETTE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claudette-whenready-data-'))
const work = mkdtempSync(path.join(tmpdir(), 'claudette-whenready-cwd-'))
copyFileSync(path.join(here, 'fake-claude-team.mjs'), path.join(work, 'fake-claude.mjs'))
const shim = path.join(work, 'claude')
writeFileSync(shim, `#!/bin/sh\nexec node ${JSON.stringify(path.join(work, 'fake-claude.mjs'))} "$@"\n`)
chmodSync(shim, 0o755)
process.env.PATH = `${work}${path.delimiter}${process.env.PATH ?? ''}`
process.env.FAKE_TURN_MS = '50'

const { SessionManager } = await import('../server/src/claude/sessionManager')
const Fastify = (await import('fastify')).default
const { registerSessionRoutes } = await import('../server/src/session/sessionApi')
import { check, failed } from './assert.mjs'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sessions = new SessionManager({})
const echoes = (id: string): string[] => sessions.transcriptOf(id)
  .filter((e) => (e as unknown as { subtype?: string }).subtype === 'echo')
  .map((e) => (e as unknown as { raw: string }).raw)
const delivered = async (id: string, text: string) => {
  for (let i = 0; i < 40 && !echoes(id).some((r) => r.includes(text)); i++) await wait(50)
  return echoes(id).some((r) => r.includes(text))
}

try {
  const id = sessions.create('wr', work, work, undefined, false)
  check('fresh session becomes ready', await sessions.whenReady(id, 5000))

  // --- resumeInto (the /rewind conversation path) ---------------------------
  sessions.resumeInto(id, crypto.randomUUID())
  check('resumeInto leaves the session mid-replace on return', sessions.get(id) !== undefined && !!(sessions as unknown as { sessions: Map<string, { replacing?: boolean }> }).sessions.get(id)?.replacing)
  // Control: this IS the race — a send right now is rejected.
  check('control: a send straight after resumeInto is rejected', (await sessions.sendUserTurn(id, 'too-early')) === false)
  const t0 = Date.now()
  const ready = await sessions.whenReady(id, 5000)
  check('whenReady resolves true after resumeInto', ready, `${Date.now() - t0}ms`)
  check('…and at that point replacing is cleared', !(sessions as unknown as { sessions: Map<string, { replacing?: boolean }> }).sessions.get(id)?.replacing)
  check('sendUserTurn after whenReady returns true', (await sessions.sendUserTurn(id, 'after-resume')) === true)
  check('…and the relaunched engine actually received it', await delivered(id, 'after-resume'))

  // --- restartFresh (the /rewind empty-fork path, and /clear) ----------------
  sessions.restartFresh(id)
  check('control: a send straight after restartFresh is rejected', (await sessions.sendUserTurn(id, 'too-early-2')) === false)
  check('whenReady resolves true after restartFresh', await sessions.whenReady(id, 5000))
  check('sendUserTurn after it returns true', (await sessions.sendUserTurn(id, 'after-fresh')) === true)
  check('…and is received', await delivered(id, 'after-fresh'))

  // --- bounded ---------------------------------------------------------------
  sessions.resumeInto(id, crypto.randomUUID())
  check('timeout: whenReady(id, 0) mid-replace returns false', (await sessions.whenReady(id, 0)) === false)
  check('…the relaunch still completes afterwards', await sessions.whenReady(id, 5000))
  check('unknown session → false', (await sessions.whenReady('no-such-id', 5000)) === false)

  // --- the /clear route now answers only once a send will land ---------------
  const app = Fastify()
  registerSessionRoutes(app, sessions)
  const r = await app.inject({ method: 'POST', url: '/api/session/restartFresh', payload: { id } })
  check('POST /api/session/restartFresh → ok:true', r.json().ok === true, r.body)
  check('send immediately after the route returns is delivered', (await sessions.sendUserTurn(id, 'after-route')) === true)
  check('…and received', await delivered(id, 'after-route'))
  const r2 = await app.inject({ method: 'POST', url: '/api/session/restartFresh', payload: { id: 'no-such-id' } })
  check('restartFresh route on an unknown id → ok:false', r2.json().ok === false, r2.body)

  // --- the /resume route: same wait ------------------------------------------
  const r3 = await app.inject({ method: 'POST', url: '/api/session/resumeInto', payload: { id, claudeSessionId: crypto.randomUUID() } })
  check('POST /api/session/resumeInto → ok:true', r3.statusCode === 200 && r3.json().ok === true, `${r3.statusCode} ${r3.body}`)
  check('send immediately after the resumeInto route returns is delivered', (await sessions.sendUserTurn(id, 'after-resume-route')) === true)
  check('…and received', await delivered(id, 'after-resume-route'))
  const r4 = await app.inject({ method: 'POST', url: '/api/session/resumeInto', payload: { id: 'no-such-id', claudeSessionId: crypto.randomUUID() } })
  check('resumeInto route on an unknown id → 200 ok:false, no throw', r4.statusCode === 200 && r4.json().ok === false, `${r4.statusCode} ${r4.body}`)
  await app.close()

  sessions.destroy(id)
  check('destroyed session → false', (await sessions.whenReady(id, 5000)) === false)
} finally {
  sessions.shutdown()
}
process.exit(failed === 0 ? 0 : 1)
