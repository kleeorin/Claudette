import http from 'http'
import { randomUUID } from 'crypto'
import type { AddressInfo } from 'net'

// In-process HTTP MCP server exposing app-control tools to each session's claude.
// Ported verbatim from ClaudeMaster's `main/mcpServer.ts` (pure Node, zero Electron
// coupling). Hand-rolled JSON-RPC-over-POST — the CLI's streamable-HTTP client is
// happy with plain JSON replies (verified against 2.1.198; local CLI is 2.1.205).
// Bound to loopback; each session gets a unique URL token so every tool call is
// attributable to its origin session (needed for "the calling session's …").

export interface McpToolResult { text?: string; error?: string }
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (sessionId: string, args: Record<string, unknown>) => Promise<McpToolResult>
}

export class AppControlMcpServer {
  private server: http.Server | null = null
  private port = 0
  private tokens = new Map<string, string>()   // url token → sessionId
  private tools = new Map<string, McpTool>()

  register(tool: McpTool): void { this.tools.set(tool.name, tool) }

  get portNumber(): number { return this.port }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.onRequest(req, res))
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port
        this.server = server
        resolve(this.port)
      })
    })
  }

  stop(): void { this.server?.close(); this.server = null }

  // Per-session --mcp-config JSON string. The token in the URL attributes calls.
  configFor(sessionId: string): string {
    const token = randomUUID()
    this.tokens.set(token, sessionId)
    return JSON.stringify({ mcpServers: { app: { type: 'http', url: `http://127.0.0.1:${this.port}/mcp/${token}` } } })
  }

  release(sessionId: string): void {
    for (const [tok, sid] of this.tokens) if (sid === sessionId) this.tokens.delete(tok)
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const m = /^\/mcp\/([^/?]+)/.exec(req.url || '')
    const sessionId = m ? this.tokens.get(m[1]) : undefined

    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      let msg: { id?: unknown; method?: string; params?: Record<string, unknown> }
      try { msg = JSON.parse(body) } catch { msg = {} }
      const id = msg.id
      const reply = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId ?? 'app' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
      }

      switch (msg.method) {
        case 'initialize':
          return reply({
            protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'claudette-app', version: '0.1.0' },
          })
        case 'notifications/initialized':
          res.writeHead(202).end(); return
        case 'tools/list':
          return reply({
            tools: [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
          })
        case 'tools/call': {
          const name = msg.params?.name as string
          const tool = this.tools.get(name)
          const asErr = (text: string) => reply({ content: [{ type: 'text', text }], isError: true })
          if (!tool) return asErr(`unknown tool: ${name}`)
          if (!sessionId) return asErr('error: this tool call could not be attributed to a session')
          try {
            const r = await tool.handler(sessionId, (msg.params?.arguments as Record<string, unknown>) ?? {})
            return reply({ content: [{ type: 'text', text: r.error ?? r.text ?? 'ok' }], isError: !!r.error })
          } catch (e) {
            return asErr(`error: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        default:
          if (msg.method) return reply({})
          res.writeHead(202).end()
      }
    })
  }
}
