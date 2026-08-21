// Regression tests for the review fixes (the ones that had no coverage).
//
// Each of these was a real defect found by reading the code, and each is the kind that
// re-appears under a well-meaning refactor — so the point is to pin the BEHAVIOUR, not
// the implementation.
//
//   npx tsx scratchpad/review-fixes-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fixes-'))
process.env.CLAUDETTE_DATA_DIR = DATA

let pass = 0, fail = 0
function ok(label: string, cond: unknown): void {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}
function eq(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}\n        got  ${g}\n        want ${w}`) }
}

// --- 1. stripEditorContext: the user's own tag must survive --------------------
// The old end-anchored regex matched from the FIRST <editor-context> whose closing tag
// was followed only by whitespace, so a prompt containing the literal tag had everything
// from the user's own tag onward swallowed. That also broke rewind keying, because the
// stripped point text could then never equal the raw text we sent.
{
  const { buildEditorContext, stripEditorContext } = await import('../server/src/claude/editorContext.ts')
  const OPEN = '<editor-context>', CLOSE = '</editor-context>'

  const plain = 'fix this file'
  eq('strip removes the block we appended', stripEditorContext(plain + buildEditorContext('/tmp/a.ts')), plain)

  const withTag = `fix ${OPEN}x${CLOSE} please`
  eq('a prompt containing the tag is untouched', stripEditorContext(withTag), withTag)
  eq('…and still round-trips once we append', stripEditorContext(withTag + buildEditorContext('/tmp/a.ts')), withTag)

  // An unterminated tag is not ours and must not be treated as a block.
  eq('unterminated tag is left alone', stripEditorContext(`hmm ${OPEN} dangling`), `hmm ${OPEN} dangling`)
  eq('no tag at all is a no-op', stripEditorContext('plain text'), 'plain text')
}

// --- 2. Agent lookup must not walk the prototype chain -------------------------
// `id in AGENTS` accepted 'constructor'/'toString', so setAgent stored and PERSISTED a
// bogus role and getAgent returned Object's constructor instead of falling back.
{
  const { isAgent, getAgent, AGENTS } = await import('../server/src/claude/agents.ts')
  ok('a real role validates', isAgent('reviewer'))
  ok('constructor does not validate', !isAgent('constructor'))
  ok('toString does not validate', !isAgent('toString'))
  ok('__proto__ does not validate', !isAgent('__proto__'))
  eq('getAgent falls back for a prototype key', getAgent('constructor').id, AGENTS.general.id)
  eq('getAgent still resolves a real role', getAgent('reviewer').id, 'reviewer')
  ok('reviewer is declared read-only by charter', AGENTS.reviewer.readOnly === true)
}

// --- 3. Editing a connector must not require retyping its secret ---------------
// toView redacts url/command by design, so the edit form submits them empty to mean
// "keep the stored one". Validation ran on the RAW input, before the omit-means-keep
// merge, so every edit of an existing connector was rejected.
{
  const store = await import('../server/src/connectors/connectorStore.ts')
  const created = store.saveConnector({
    id: 'gh', name: 'GitHub', transport: 'http',
    url: 'https://api.github.test/mcp', headers: { Authorization: 'Bearer secret-a' },
  } as never)
  ok('connector created', created.ok)

  // The edit the UI actually sends: no url, no headers — just a flag flipped.
  const edited = store.saveConnector({ id: 'gh', name: 'GitHub', transport: 'http', enabledByDefault: true } as never)
  ok('editing without re-supplying the url is accepted', edited.ok)
  eq('the stored url is kept', store.getConnector('gh')?.url, 'https://api.github.test/mcp')
  eq('the stored credential is kept', store.getConnector('gh')?.headers?.Authorization, 'Bearer secret-a')
  eq('the edited field landed', store.getConnector('gh')?.enabledByDefault, true)

  // Switching transport must not leave the other transport's credential on disk.
  const switched = store.saveConnector({ id: 'gh', name: 'GitHub', transport: 'stdio', command: 'gh-mcp' } as never)
  ok('transport switch accepted', switched.ok)
  eq('url dropped on http→stdio', store.getConnector('gh')?.url, undefined)
  eq('http credential dropped on http→stdio', store.getConnector('gh')?.headers, undefined)
  eq('the new transport is in force', store.getConnector('gh')?.command, 'gh-mcp')
  store.removeConnector('gh')
}

// --- 4. Tool classification lives in ONE place --------------------------------
// A module-level Map shadowed ConnectorDef.tools: every reader used the Map, so
// getConnector(x).tools was stale from the moment setTools ran.
{
  const store = await import('../server/src/connectors/connectorStore.ts')
  store.saveConnector({ id: 'db', name: 'DB', transport: 'http', url: 'https://db.test/mcp' } as never)
  store.setTools('db', [{ name: 'query', write: false }, { name: 'drop', write: true }] as never)
  eq('toolsOf sees the classification', store.toolsOf('db')?.map((t) => t.name), ['query', 'drop'])
  eq('the def carries the SAME classification', store.getConnector('db')?.tools?.map((t) => t.name), ['query', 'drop'])
  store.removeConnector('db')
  eq('removing the connector removes its tools', store.toolsOf('db'), undefined)
}

// --- 5. --disallowedTools must stay under the argv limit ----------------------
// MAX_TOOL_DENY_RULES bounds each connector on its own, but the flag is ONE argv entry
// shared by all of them. Sixteen connectors just under their individual cap still blew
// MAX_ARG_STRLEN, and the resulting E2BIG is persistent across restarts.
{
  const store = await import('../server/src/connectors/connectorStore.ts')
  const launch = await import('../server/src/connectors/connectorLaunch.ts')
  const MAX_ARG_STRLEN = 32 * 4096
  const ids: string[] = []
  for (let i = 0; i < 45; i++) {
    const id = `bulk-${i}`
    ids.push(id)
    store.saveConnector({ id, name: id, transport: 'http', url: `https://${id}.test/mcp` } as never)
    // 60 write tools with long names: under the per-connector cap, huge in aggregate.
    store.setTools(id, Array.from({ length: 60 }, (_, n) => ({ name: `tool-${String(n).padStart(2, '0')}-${'x'.repeat(60)}`, write: true })) as never)
  }
  const rules = launch.connectorDenyRules({ granted: ids, accountAllow: [], readOnlyRole: true })
  const joined = rules.join(',')
  ok(`joined deny value fits in one argv entry (${joined.length} B)`, joined.length < MAX_ARG_STRLEN)
  ok('collapsing still denies every granted connector', ids.every((id) => rules.some((r) => r.includes(id))))
  // Collapsing is strictly MORE restrictive, so the safety property is preserved.
  const collapsed = rules.filter((r) => !r.includes('tool-'))
  ok(`the budget actually engaged (${collapsed.length} connectors collapsed to a whole-server deny)`, collapsed.length > 0)
  // Collapsing is strictly MORE restrictive than enumerating, so the safety property
  // holds: a connector is denied wholesale OR per tool, never half of each.
  const mixed = ids.filter((id) => rules.includes(`mcp__${id}`) && rules.some((r) => r.startsWith(`mcp__${id}__`)))
  eq('no connector is left half-collapsed', mixed, [])
  for (const id of ids) store.removeConnector(id)
}

// --- 6. One malformed .mcp.json entry must not abort the whole import ---------
// `raw as RawServer` was unchecked, so a non-string url reached `input.url?.trim()` —
// optional chaining does not guard a non-function property — and the TypeError escaped
// addImported's loop before persist. The route 500'd and NOTHING was imported.
{
  const store = await import('../server/src/connectors/connectorStore.ts')
  const { added, rejected } = store.addImportedDetailed([
    { id: 'good-one', name: 'good-one', transport: 'http', url: 'https://ok.test/mcp' },
    { id: 'bad__id', name: 'bad', transport: 'http', url: 'https://bad.test/mcp' },   // '__' breaks tool attribution
  ] as never)
  eq('the valid entry still landed', added.map((d) => d.id), ['good-one'])
  eq('the rejected one is REPORTED, not silently dropped', rejected.length, 1)
  ok('the reject carries a reason the operator can act on', typeof rejected[0]?.reason === 'string' && rejected[0].reason.length > 0)
  store.removeConnector('good-one')
}

// --- 7. Rewind snapshot refs are pruned ---------------------------------------
// One ref per user turn, each gc-proof by construction and pinning a whole tree. There
// was no delete path anywhere in the server.
{
  const snap = await import('../server/src/git/shadowSnapshots.ts')
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rewind-prune-'))
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 't@t.test'); git('config', 'user.name', 'T')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello')
  git('add', '-A'); git('commit', '-qm', 'init')

  const commit = await snap.snapshot(repo)
  ok('snapshot produced a commit', typeof commit === 'string' && commit!.length > 0)

  const KEEP = 200
  for (let i = 0; i < KEEP + 25; i++) await snap.saveRef(repo, `uuid-${String(i).padStart(4, '0')}`, commit!)
  const refs = git('for-each-ref', '--format=%(refname)', 'refs/claudette/rewind').split('\n').filter(Boolean)
  ok(`refs are capped (${refs.length} kept of ${KEEP + 25} written)`, refs.length <= KEEP)
  ok('the most recent turn survived the prune', (await snap.snapshottedUuids(repo)).has(`uuid-${String(KEEP + 24).padStart(4, '0')}`))
  fs.rmSync(repo, { recursive: true, force: true })
}


// --- 8. The proxy classifies tools from an SSE reply too -----------------------
// Capture was gated on `application/json`, but streamable-HTTP MCP servers built on the
// official SDK answer `text/event-stream` unless configured otherwise — and the CLI's
// Accept offers both. So against the SDK DEFAULT the probe never ran: `tools` stayed
// undefined forever, the catalog showed "not probed yet" permanently, and a read-only
// role was denied the whole server for good. Fail-closed, but never resolving.
// (Both upstreams in connectors-test answer JSON, which is why this went unnoticed.)
{
  const http = await import('http')
  const store = await import('../server/src/connectors/connectorStore.ts')
  const { ConnectorProxy } = await import('../server/src/connectors/connectorProxy.ts')

  const TOOLS = { tools: [
    { name: 'read_thing', annotations: { readOnlyHint: true } },
    { name: 'write_thing' },
  ] }

  // An upstream that answers tools/list as Server-Sent Events, the way the MCP SDK does.
  const upstream = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const msg = JSON.parse(body || '{}') as { id?: unknown }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write('event: message\n')
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: TOOLS })}\n\n`)
      res.end()
    })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
  const port = (upstream.address() as { port: number }).port

  store.saveConnector({ id: 'sse-srv', name: 'SSE', transport: 'http', url: `http://127.0.0.1:${port}/mcp` } as never)
  eq('unprobed connector has no classification', store.toolsOf('sse-srv'), undefined)

  const proxy = new ConnectorProxy(() => true)
  await proxy.start()
  const target = proxy.urlFor('sess-sse', 'sse-srv')

  const call = (method: string): Promise<string> => new Promise((resolve) => {
    const u = new URL(target)
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } },
      (res) => { let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve(b)) })
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method }))
  })

  const body = await call('tools/list')
  ok('the SSE reply is passed through verbatim', body.includes('data:') && body.includes('read_thing'))

  const learned = store.toolsOf('sse-srv')
  eq('the SSE tools/list WAS classified', learned?.map((t) => t.name).sort(), ['read_thing', 'write_thing'])
  eq('readOnlyHint is honoured', learned?.find((t) => t.name === 'read_thing')?.write, false)
  eq('an unhinted tool counts as write-capable', learned?.find((t) => t.name === 'write_thing')?.write, true)

  // And the point of classifying at all: a read-only role now gets a per-tool deny
  // instead of losing the whole server.
  const launch = await import('../server/src/connectors/connectorLaunch.ts')
  const rules = launch.connectorDenyRules({ granted: ['sse-srv'], accountAllow: [], readOnlyRole: true })
  ok('read-only role denies the write tool', rules.includes('mcp__sse-srv__write_thing'))
  ok('…and is NOT denied the whole server any more', !rules.includes('mcp__sse-srv'))

  // The capture is gated on the REQUEST being a tools/list, not on the reply shape.
  // Without that, a tools/call response carrying `result.tools` could rewrite the
  // persisted classification at a moment of the upstream's choosing — and since a
  // read-only role's deny list is computed from it, that is a privilege decision.
  store.setTools('sse-srv', [{ name: 'read_thing', write: false }] as never)
  await call('tools/call')
  eq('a non-tools/list reply does NOT rewrite classification',
     store.toolsOf('sse-srv')?.map((t) => t.name), ['read_thing'])

  proxy.stop?.()
  upstream.close()
  store.removeConnector('sse-srv')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
