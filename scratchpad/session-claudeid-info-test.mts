// SessionInfo.claudeSessionId — the server half of "each session shows its OWN history at
// startup, even when several share a cwd". The client (web/src/lib/autoResume.ts) used to learn
// a session's conversation id only from system/init, which arrives with a turn; after a restart
// every session sharing a cwd opened empty. Now toInfo() carries the persisted id (the one
// restore passes to --resume), and session:list is re-broadcast on 'ready' so a tab never trails
// an id the engine replaced. Imports defensively so it runs (RED) on a tree without the helper.
//   npx tsx scratchpad/session-claudeid-info-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { check, passed, failed } from './assert.mjs'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudeid-info-')))
process.env.CLAUDETTE_DATA_DIR = path.join(TMP, 'data')
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* best effort */ } })

const { SessionManager } = await import('../server/src/claude/sessionManager')
const api = await import('../server/src/session/sessionApi') as Record<string, unknown>
const broadcastSessionLists = api.broadcastSessionLists as undefined | ((s: unknown, h: unknown) => void)
type Info = { id: string; claudeSessionId?: string }
type AnyMgr = InstanceType<typeof SessionManager> & Record<string, unknown>
const newMgr = (): AnyMgr => {
  const m = new SessionManager({}) as AnyMgr
  ;(m as unknown as { launch: () => void }).launch = () => {}
  return m
}

const cwd = path.join(TMP, 'shared-cwd'); fs.mkdirSync(cwd)
const m = newMgr()
const reg = (m as unknown as { register: (...a: unknown[]) => { id: string } }).register.bind(m)
const a = reg('A', cwd, cwd, undefined, true, 'conv-A')
const b = reg('B', cwd, cwd, undefined, true, 'conv-B')
const ia = m.get(a.id) as unknown as Info, ib = m.get(b.id) as unknown as Info
check('1a toInfo carries the session\'s own claudeSessionId', ia?.claudeSessionId === 'conv-A', JSON.stringify(ia?.claudeSessionId))
check('1b two sessions sharing a cwd carry DIFFERENT ids', ib?.claudeSessionId === 'conv-B')
const listed = m.list() as unknown as Info[]
check('1c list() (what session:list sends) carries them too', listed.find((x) => x.id === a.id)?.claudeSessionId === 'conv-A' && listed.find((x) => x.id === b.id)?.claudeSessionId === 'conv-B')

// restore path: the persisted id comes back on the restored session's info
const m2 = newMgr()
const ids = m2.restore(m.saved() as never)
const restored = ids.map((id) => m2.get(id) as unknown as Info)
check('2a after restore, each session\'s info carries ITS persisted id', restored.map((r) => r?.claudeSessionId).sort().join(',') === 'conv-A,conv-B', JSON.stringify(restored.map((r) => r?.claudeSessionId)))

// broadcast on 'ready'
check('3a broadcastSessionLists exists', typeof broadcastSessionLists === 'function')
const sent: { type: string; sessions?: Info[] }[] = []
if (broadcastSessionLists) broadcastSessionLists(m, { broadcast: (msg: { type: string; sessions?: Info[] }) => sent.push(msg) })
// what the engine 'ready' handler does: update the id, then emit
;(m as unknown as { sessions: Map<string, { claudeSessionId: string }> }).sessions.get(a.id)!.claudeSessionId = 'conv-A2'
m.emit('ready', a.id, 'conv-A2')
const last = sent.at(-1)
check('3b \'ready\' broadcasts session:list carrying the NEW id', last?.type === 'session:list' && last.sessions?.find((x) => x.id === a.id)?.claudeSessionId === 'conv-A2', JSON.stringify(last?.sessions?.map((x) => x.claudeSessionId)))
const n = sent.length
m.emit('changed')
check('3c \'changed\' still broadcasts session:list', sent.length === n + 1 && sent.at(-1)?.type === 'session:list')

for (const id of [...ids]) (m2 as unknown as { cleanup: (id: string) => void }).cleanup(id)
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
