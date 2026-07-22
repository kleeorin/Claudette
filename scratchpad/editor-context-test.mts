// Unit/integration test for the ambient editor-context feature: the block appended
// to a user turn (so Claude knows the open code file) must round-trip strip, and must
// NOT leak into resume replay, conversation titles, or rewind points — and rewind's
// user-text matching must still work against the ORIGINAL text.
//   npx tsx scratchpad/editor-context-test.mts
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir, homedir } from 'os'
import { join } from 'path'

// Point HOME at a temp dir BEFORE importing modules that resolve ~/.claude, so the
// fixture transcript lands in an isolated project dir (no pollution of the real one).
const tmpHome = await mkdtemp(join(tmpdir(), 'ec-home-'))
process.env.HOME = tmpHome

const { buildEditorContext, stripEditorContext } = await import('../server/src/claude/editorContext.ts')
const { readConversation, listRewindPoints, listConversations, projectDir } = await import('../server/src/claude/conversations.ts')

let pass = 0, fail = 0
const eq = (name: string, a: unknown, b: unknown) => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (ok) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}\n   got: ${JSON.stringify(a)}\n   exp: ${JSON.stringify(b)}`) }
}

// --- pure round-trip ---
const PROMPT = 'refactor the greet function'
const withCtx = PROMPT + buildEditorContext('/home/u/proj/foo.ts')
eq('block mentions the path', /\/home\/u\/proj\/foo\.ts/.test(withCtx), true)
eq('strip removes the appended block', stripEditorContext(withCtx), PROMPT)
eq('strip is a no-op on plain text', stripEditorContext(PROMPT), PROMPT)
eq('strip no-op when no block', stripEditorContext('has <editor-context> word but no close'), 'has <editor-context> word but no close')

// --- read-back paths must be clean (block was persisted by the CLI) ---
const cwd = join(tmpHome, 'proj')
const dir = projectDir(cwd)
await mkdir(dir, { recursive: true })
const id = 'sess-abc'
const uuid = '11111111-1111-1111-1111-111111111111'
const lines = [
  { type: 'user', uuid, timestamp: '2026-07-22T10:00:00Z', message: { role: 'user', content: withCtx } },
  { type: 'assistant', uuid: '22222222-2222-2222-2222-222222222222', timestamp: '2026-07-22T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
]
await writeFile(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

// resume replay: the user bubble must NOT contain the editor-context block
const events = await readConversation(cwd, id)
const userEv = events.find((e) => e.type === 'user') as { message: { content: unknown } } | undefined
eq('readConversation strips replayed user bubble', userEv?.message?.content, PROMPT)

// rewind points: text must be the ORIGINAL prompt (so keying matches pending.text)
const points = await listRewindPoints(cwd, id)
eq('rewind point text is the stripped prompt', points.map((p) => p.text), [PROMPT])

// conversation list: title/lastPrompt derived from the stripped first user turn
const metas = await listConversations(cwd)
const meta = metas.find((m) => m.id === id)
eq('conversation title is clean', meta?.title, PROMPT.slice(0, 80))
eq('conversation lastPrompt is clean', meta?.lastPrompt?.includes('<editor-context>'), false)

// --- injection in SessionManager.sendUserTurn (stubbed engine) ---
const { SessionManager } = await import('../server/src/claude/sessionManager.ts')
const sessCwd = await mkdtemp(join(tmpdir(), 'ec-cwd-'))   // non-git → snapshot() no-ops
let activePane: { path: string; isNotebook: boolean } | null = { path: '/tmp/foo.ts', isNotebook: false }
const sm = new SessionManager({ activePane: () => activePane })
const broadcast: string[] = []
sm.on('userTurn', (_id: string, text: string) => broadcast.push(text))
const toEngine: string[] = []
;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', {
  engine: { sendUserTurn: (t: string) => toEngine.push(t) },
  cwd: sessCwd, claudeSessionId: 'c1',
})

await sm.sendUserTurn('s1', 'fix this file', 't1')
eq('engine gets text + editor-context', toEngine[0].startsWith('fix this file') && toEngine[0].includes('/tmp/foo.ts'), true)
eq('engine text strips back to the original', stripEditorContext(toEngine[0]), 'fix this file')
eq('broadcast/UI text is the clean original', broadcast[0], 'fix this file')

activePane = { path: '/tmp/n.ipynb', isNotebook: true }   // notebooks steer via MCP, not this
await sm.sendUserTurn('s1', 'run the notebook', 't2')
eq('notebook active pane → no injection', toEngine[1], 'run the notebook')

activePane = null                                          // Claude tab focused, nothing open
await sm.sendUserTurn('s1', 'hello', 't3')
eq('no active pane → no injection', toEngine[2], 'hello')

await rm(tmpHome, { recursive: true, force: true }).catch(() => {})
await rm(sessCwd, { recursive: true, force: true }).catch(() => {})
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
