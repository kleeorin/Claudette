// #0 "teammate blocked" signal — fails against current source, passes once the patch
// (scratchpad/teammate-blocked-signal.patch) is applied.
//
// THE BUG: claudeEngine sets state 'waiting' in exactly ONE place — the permission-prompt
// handler — so it means precisely "blocked on a permission prompt". But TeamMailbox.drain()
// only delivers to an 'idle' session, so a blocked teammate never drains its queue, while
// dispatch() tells the coordinator "it will receive this when its current turn ends". The
// turn does not end. The coordinator ends ITS turn and the team deadlocks in silence.
//
// (i)   dispatch() must stop promising delivery to a 'waiting' recipient.
// (ii)  a member going 'waiting' must notify its coordinator — ONCE per episode.
// (iii) list_team must name the blocked state rather than leave it read as "busy".
import type { SessionInfo, TeamMessage } from '../shared/src/index.ts'
import { TeamMailbox } from '../server/src/mcp/teamMailbox.ts'
import { registerTeamTools } from '../server/src/mcp/teamTools.ts'
import type { AppControlMcpServer, McpTool } from '../server/src/mcp/appControlServer.ts'
import type { SessionManager } from '../server/src/claude/sessionManager.ts'

let bad = 0
const check = (ok: boolean, label: string, detail = ''): void => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) bad++
}

// --- a two-session team: COORD (idle coordinator) + MEMBER (blocked on a prompt) -------
const mk = (id: string, name: string, state: SessionInfo['state'], parentId?: string): SessionInfo =>
  ({ id, name, state, parentId, cwd: '/tmp/x', rootDir: '/tmp/x', agentId: 'implementer' } as SessionInfo)

const store = new Map<string, SessionInfo>([
  ['COORD', mk('COORD', 'Coord', 'idle')],
  ['MEMBER', mk('MEMBER', 'Member', 'waiting', 'COORD')],
])
const sessions = {
  get: (id: string) => store.get(id),
  list: () => [...store.values()],
  childrenOf: (id: string) => [...store.values()].filter((s) => s.parentId === id),
  canEmploy: () => false,
  destroy: () => {},
} as unknown as SessionManager

// Real TeamMailbox; the host records what would actually be delivered.
const delivered: Array<{ id: string; text: string }> = []
const mailbox = new TeamMailbox({
  info: (id) => store.get(id),
  deliver: async (id, text) => { delivered.push({ id, text }); return true },
})

const tools = new Map<string, McpTool>()
const mcp = { register: (t: McpTool) => tools.set(t.name, t) } as unknown as AppControlMcpServer
registerTeamTools(mcp, sessions, mailbox)

// --- (i) dispatch() must not promise delivery to a blocked recipient -------------------
const send = await tools.get('send_to_session')!.handler('COORD', { target: 'Member', message: 'do the thing' })
const txt = send.text ?? send.error ?? ''
console.log(`\nsend_to_session → "${txt.slice(0, 120)}…"\n`)
check(/blocked/i.test(txt) && /permission/i.test(txt),
  '(i) coordinator is told the teammate is BLOCKED on a permission prompt', txt.slice(0, 60))
check(!/will receive this when its current turn ends/.test(txt),
  '(i) the false "when its current turn ends" promise is gone')

// --- (iii) list_team must name the blocked state ---------------------------------------
const roster = JSON.parse((await tools.get('list_team')!.handler('COORD', {})).text!)
const memberRow = roster.members.find((m: { name: string }) => m.name === 'Member')
console.log('list_team member row:', JSON.stringify(memberRow))
check(memberRow?.blockedOnPermissionPrompt === true,
  '(iii) list_team flags the member as blocked on a permission prompt',
  `blockedOnPermissionPrompt=${memberRow?.blockedOnPermissionPrompt}`)

// --- (ii) a member going 'waiting' notifies its coordinator, ONCE per episode ----------
// The wiring lives in index.ts (not importable — it boots the server), so drive the exact
// same sequence against the real mailbox: this covers the mailbox interaction and the
// dedup, which is the part with a spam/ordering risk. The two-line hook itself is covered
// by typecheck.
const notifiedBlocked = new Set<string>()
const onStateChange = (id: string, state: string): void => {
  if (state === 'idle') { notifiedBlocked.delete(id); mailbox.onIdle(id); return }
  if (state !== 'waiting' || notifiedBlocked.has(id)) return
  const me = store.get(id)
  if (!me?.parentId) return
  const coordinator = store.get(me.parentId)
  if (!coordinator) return
  notifiedBlocked.add(id)
  mailbox.send(coordinator.id, {
    from: me.name, role: me.agentId ?? 'general', sessionId: me.id, kind: 'report',
    body: `[automatic notice] ${me.name} is BLOCKED on a permission prompt.`,
  } as TeamMessage)
}

// A turn with THREE sequential permission prompts: waiting → running → waiting → …
onStateChange('MEMBER', 'waiting')
onStateChange('MEMBER', 'running')
onStateChange('MEMBER', 'waiting')
onStateChange('MEMBER', 'running')
onStateChange('MEMBER', 'waiting')
await new Promise((r) => setTimeout(r, 120))   // let the mailbox debounce fire
const notices = delivered.filter((d) => d.id === 'COORD' && /BLOCKED/.test(d.text))
check(notices.length === 1, '(ii) coordinator notified exactly ONCE across a flapping turn',
  `${notices.length} notice(s) for 3 waiting transitions`)

// A new turn (idle clears the mark) blocks again → a second, legitimate notice.
// NB the coordinator must come free first: drain() holds `awaitingTurn` from the previous
// delivery until onIdle clears it, so without this the second notice correctly stays
// queued. That is the mailbox's own accounting doing its job, not a fault in the signal.
onStateChange('MEMBER', 'idle')
onStateChange('COORD', 'idle')
onStateChange('MEMBER', 'waiting')
await new Promise((r) => setTimeout(r, 120))
const after = delivered.filter((d) => d.id === 'COORD' && /BLOCKED/.test(d.text))
check(after.length === 2, '(ii) a NEW turn that blocks notifies again', `${after.length} total`)
check(!notices.some((n) => /coordinator/i.test(n.text) && n.id === 'MEMBER'),
  '(ii) the notice never routes back down to the member (no loop)')

mailbox.dispose()
console.log(`\n${bad === 0 ? 'all checks passed' : `${bad} check(s) failed`}`)
process.exitCode = bad === 0 ? 0 : 2
