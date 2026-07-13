import type { FastifyInstance } from 'fastify'
import type { NotebookDoc, CellLock, KernelStatus, WsClientMessage } from '@claudette/shared'
import type { WsHub } from '../ws/hub'
import type { NotebookDocManager } from './notebookDocManager'
import type { KernelManager } from '../jupyter/kernelManager'

// Mirrors sessionApi.ts: bridge the managers' events to the WS hub, register the
// HTTP open/create/save/conflict routes, and route notebook WS client messages.
// Keeps the managers transport-agnostic (they only emit).

export function bridgeNotebookEvents(
  notebooks: NotebookDocManager, kernels: KernelManager, hub: WsHub,
): void {
  notebooks.on('update', (doc: NotebookDoc) =>
    hub.broadcast({ type: 'notebook:update', doc }))
  notebooks.on('opFocus', (notebookId: string, cellId: string, reveal: boolean) =>
    hub.broadcast({ type: 'notebook:focus', notebookId, cellId, reveal }))
  notebooks.on('locks', (notebookId: string, locks: CellLock[]) =>
    hub.broadcast({ type: 'notebook:locks', notebookId, locks }))
  kernels.on('status', (notebookId: string, status: KernelStatus) =>
    hub.broadcast({ type: 'notebook:kernel', notebookId, status }))
}

export function registerNotebookRoutes(app: FastifyInstance, notebooks: NotebookDocManager): void {
  app.post<{ Body: { path: string } }>('/api/notebook/open', async (req, reply) => {
    try {
      const doc = await notebooks.openPath(req.body.path)
      return { doc }
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  app.post<{ Body: { path: string } }>('/api/notebook/create', async (req, reply) => {
    try {
      const doc = await notebooks.createPath(req.body.path)
      return { doc }
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  app.post<{ Body: { notebookId: string } }>('/api/notebook/save', async (req, reply) => {
    try {
      await notebooks.save(req.body.notebookId)
      return { ok: true }
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // Conflict resolution: disk changed under unsaved edits (doc.conflict). The UI
  // offers "reload from disk" (discard local) or "keep mine" (overwrite disk).
  app.post<{ Body: { notebookId: string } }>('/api/notebook/reload', async (req, reply) => {
    try { await notebooks.reloadFromDisk(req.body.notebookId); return { ok: true } }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) }) }
  })
  app.post<{ Body: { notebookId: string } }>('/api/notebook/keepMine', async (req, reply) => {
    try { await notebooks.keepMine(req.body.notebookId); return { ok: true } }
    catch (e) { return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) }) }
  })
}

// Notebook WS messages come from a UI (human origin). Returns true if handled.
export function handleNotebookClientMessage(
  notebooks: NotebookDocManager, kernels: KernelManager, msg: WsClientMessage,
): boolean {
  switch (msg.type) {
    case 'notebook:op':
      // runCell/runAll execute via the kernel client (P1.9); mutation ops apply here.
      if (msg.op.op === 'runCell') void kernels.runCell(msg.op.notebookId, msg.op.cellId).catch(() => {})
      else if (msg.op.op === 'runAll') void kernels.runAll(msg.op.notebookId).catch(() => {})
      else notebooks.applyOp(msg.op, 'human')
      return true
    case 'notebook:claim':
      notebooks.claimCell(msg.notebookId, msg.cellId, msg.reason)
      return true
    case 'notebook:release':
      notebooks.releaseCell(msg.notebookId, msg.cellId)
      return true
    default:
      return false
  }
}
