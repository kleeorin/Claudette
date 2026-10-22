// A grant that names a connector which no longer exists must not lock the session out of
// changing ANY of its connectors.
//
// POST /api/session/setConnectors rejects an unknown id with 400 — deliberately, so a typo
// cannot sit inert in a grant list. But the UI's ConnectorGrants toggles by re-sending the
// session's WHOLE grant list plus or minus one id. So once a granted connector disappears —
// deleted by the operator, or a built-in removed from the code (Confluence, 2026-10-21) — every
// toggle re-sent the stale id and got 400: the session could no longer change any connector,
// and the error named a connector the operator had not touched.
//
// The rule pinned here has TWO halves, and either alone is satisfiable by a wrong fix:
//   · an id the session ALREADY holds and that is now unknown is DROPPED, so the toggle lands;
//   · an id the session does NOT hold and that is unknown is still REJECTED — a typo stays a
//     visible error, and a stale id riding along cannot launder a new unknown one through.
// "Accept every unknown id" passes the first half; the old code passes the second.
//
// Drives the real route through Fastify inject, with a SessionManager that has no engine (so
// nothing is spawned or relaunched).
//   npx tsx scratchpad/connector-stale-grant-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { check, passed, failed } from './assert.mjs'

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-grant-'))
process.env.CLAUDETTE_DATA_DIR = DATA

const store = await import('../server/src/connectors/connectorStore')
const { SessionManager } = await import('../server/src/claude/sessionManager')
const { registerConnectorRoutes } = await import('../server/src/connectors/connectorApi')
const Fastify = (await import('fastify')).default

try {
  const proj = path.join(DATA, 'proj'); fs.mkdirSync(proj, { recursive: true })
  for (const id of ['keep', 'gone', 'other']) store.saveConnector({ id, name: id, transport: 'stdio', command: 'echo' })

  const mgr = new SessionManager({})
  const s = (mgr as unknown as { register: (...a: unknown[]) => { id: string } }).register(
    'stale', proj, proj, undefined, false, undefined, undefined, undefined, undefined,
    undefined, /* trusted */ true, undefined, ['keep', 'gone'], [])
  const app = Fastify()
  registerConnectorRoutes(app, mgr)
  await app.ready()
  const post = (connectors: string[]) => app.inject({
    method: 'POST', url: '/api/session/setConnectors', payload: { id: s.id, connectors, accountConnectors: [] },
  })

  check('0. precondition: the session holds both grants', JSON.stringify(mgr.grantsOf(s.id)) === '["keep","gone"]',
    JSON.stringify(mgr.grantsOf(s.id)))

  // The connector disappears out from under the grant.
  store.removeConnector('gone')
  check('0b. precondition: the granted connector is gone from the catalog',
    !store.getConnector('gone') && JSON.stringify(mgr.grantsOf(s.id)) === '["keep","gone"]')

  // 1. THE BUG: the UI's toggle re-sends the whole list plus the new id.
  {
    const r = await post(['keep', 'gone', 'other'])
    check('1. toggling ANOTHER connector succeeds despite the stale grant riding along',
      r.statusCode === 200, `${r.statusCode} ${r.body}`)
    check('1b. …and the stale id is dropped, the new one kept',
      JSON.stringify(mgr.grantsOf(s.id)) === '["keep","other"]', JSON.stringify(mgr.grantsOf(s.id)))
  }

  // 2. A NEW unknown id is still a visible error, and changes nothing.
  {
    const before = JSON.stringify(mgr.grantsOf(s.id))
    const r = await post(['keep', 'other', 'typo'])
    check('2. a NEW unknown id is still rejected with 400 naming it',
      r.statusCode === 400 && r.body.includes('typo'), `${r.statusCode} ${r.body}`)
    check('2b. …and the rejected call changed nothing', JSON.stringify(mgr.grantsOf(s.id)) === before,
      `${before} → ${JSON.stringify(mgr.grantsOf(s.id))}`)
  }

  // 3. A stale id cannot launder a new unknown one: re-seed a stale grant, send it with a typo.
  {
    store.saveConnector({ id: 'gone2', name: 'gone2', transport: 'stdio', command: 'echo' })
    await post(['keep', 'other', 'gone2'])
    store.removeConnector('gone2')
    const r = await post(['keep', 'other', 'gone2', 'typo'])
    check('3. a stale id riding along does NOT let a new unknown id through',
      r.statusCode === 400 && r.body.includes('typo') && !r.body.includes('gone2'), `${r.statusCode} ${r.body}`)
  }

  // 4. Control: an all-known list behaves exactly as before.
  {
    const r = await post(['keep'])
    check('4. control: an all-known list is accepted and applied as sent',
      r.statusCode === 200 && JSON.stringify(mgr.grantsOf(s.id)) === '["keep"]', `${r.statusCode} ${JSON.stringify(mgr.grantsOf(s.id))}`)
  }
  await app.close()
} finally {
  fs.rmSync(DATA, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
