import type { FastifyInstance } from 'fastify'
import type {
  CreatePaneRequest, CreatePaneResponse, WsClientMessage,
  ListPanesResponse, AttachPaneRequest, AttachPaneResponse, PrunePanesRequest,
} from '@claudette/shared'
import type { WsHub } from '../ws/hub'
import type { PaneManager } from './paneManager'

// Mirrors sessionApi/notebookApi: bridge pty events to the WS hub, register the
// create/destroy HTTP routes, and route pane WS client messages (input/resize).

export function bridgePaneEvents(panes: PaneManager, hub: WsHub): void {
  panes.on('output', (id: string, data: string) => hub.broadcast({ type: 'pane:output', id, data }))
  panes.on('exit', (id: string) => hub.broadcast({ type: 'pane:exit', id }))
}

export function registerPaneRoutes(app: FastifyInstance, panes: PaneManager): void {
  app.post<{ Body: CreatePaneRequest }>('/api/pane/create', async (req): Promise<CreatePaneResponse> => {
    return { id: panes.create(req.body.cwd, req.body.cols, req.body.rows, req.body.sessionId) }
  })
  app.post<{ Body: { id: string } }>('/api/pane/destroy', async (req) => {
    panes.destroy(req.body.id)
    return { ok: true }
  })
  // Reattach support (refresh survival). `list` lets a reloaded client see which of its
  // saved pane ids are still live; `attach` returns the buffered scrollback to replay
  // into a fresh xterm before it subscribes to live output; `prune` kills every pane
  // NOT in the client's restored set (sweeps orphans from past refreshes).
  app.get('/api/pane/list', async (): Promise<ListPanesResponse> => {
    return { panes: panes.list() }
  })
  app.post<{ Body: AttachPaneRequest }>('/api/pane/attach', async (req): Promise<AttachPaneResponse> => {
    return { data: panes.snapshot(req.body.id) }
  })
  app.post<{ Body: PrunePanesRequest }>('/api/pane/prune', async (req) => {
    panes.prune(req.body.keep)
    return { ok: true }
  })
}

// Pane WS messages (keystrokes + resize). Returns true if handled.
export function handlePaneClientMessage(panes: PaneManager, msg: WsClientMessage): boolean {
  switch (msg.type) {
    case 'pane:input': panes.sendInput(msg.id, msg.data); return true
    case 'pane:resize': panes.resize(msg.id, msg.cols, msg.rows); return true
    default: return false
  }
}
