import { EventEmitter } from 'events'
import type { KernelSpec } from '@claudette/shared'
import type { NotebookDocManager } from '../notebook/notebookDocManager'
import { JupyterManager, type JupyterInfo } from './jupyterManager'
import { KernelClient, type KernelStatus } from './kernelClient'

// Ties Jupyter + kernel client + the authoritative doc together: starts a kernel
// per open notebook and routes its outputs back INTO the doc by cellId (the sink
// the renderer used in ClaudeMaster is now the server doc). This is where P1.9's
// "route outputs by cell id" lives. Emits 'status' (notebookId, KernelStatus) —
// bridged to the WS hub as `notebook:kernel` so the UI can show the kernel dot.
export class KernelManager extends EventEmitter {
  private clients = new Map<string, KernelClient>()   // notebookId → client
  private status = new Map<string, KernelStatus>()
  private specByNotebook = new Map<string, string>()  // notebookId → chosen kernelspec name
  // The default kernelspec for notebooks that haven't chosen one. Seeded from
  // CLAUDETTE_DEFAULT_KERNEL (set it to e.g. 'python-autovenv' to make the auto-venv
  // kernel the permanent default), and updated to whatever the user last picked so
  // the choice carries to notebooks opened afterwards.
  private defaultSpec = process.env.CLAUDETTE_DEFAULT_KERNEL || 'python3'

  private specName(notebookId: string): string {
    return this.specByNotebook.get(notebookId) ?? this.defaultSpec
  }

  // Fires when the Jupyter server is first up — index.ts uses it to point the
  // JupyterProxy at the (lazily-started) server without forcing an early spawn.
  onJupyterStart?: (info: JupyterInfo) => void

  constructor(
    private docs: NotebookDocManager,
    private jupyter: JupyterManager,
  ) { super() }

  private setStatus(notebookId: string, status: KernelStatus): void {
    this.status.set(notebookId, status)
    this.emit('status', notebookId, status)
  }

  private async info(): Promise<JupyterInfo> {
    const info = await this.jupyter.start()
    if (!info) throw new Error('Jupyter server failed to start (is jupyter-server installed?)')
    this.onJupyterStart?.(info)
    return info
  }

  // Start (or reuse) a kernel bound to a notebook. The kernel's cwd is set to the
  // notebook's OWN directory (so cells resolve relative paths like open('data.csv')
  // against the folder the .ipynb lives in, not Jupyter's root). We pass the
  // notebook path relative to root_dir (which is '/'); Jupyter derives the kernel
  // cwd from its parent directory.
  async ensureKernel(notebookId: string): Promise<KernelClient> {
    const existing = this.clients.get(notebookId)
    if (existing) return existing
    const doc = this.docs.get(notebookId)
    if (!doc) throw new Error(`no such open notebook: ${notebookId}`)
    // root_dir is '/', so the resource path relative to it is the absolute path
    // minus its leading slash(es).
    const relPath = doc.path.replace(/^\/+/, '')

    const info = await this.info()
    const spec = this.specName(notebookId)
    this.docs.setKernelName(notebookId, spec)
    const res = await fetch(`${info.url}/api/kernels`, {
      method: 'POST',
      headers: { Authorization: `token ${info.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: spec, path: relPath }),
    })
    if (!res.ok) throw new Error(`failed to start kernel: ${res.status} ${await res.text()}`)
    const { id } = await res.json() as { id: string }

    const client = new KernelClient(info.url, info.token, id)
    client.onStatusChange = (s) => this.setStatus(notebookId, s)
    this.setStatus(notebookId, 'starting')
    await client.connect()
    this.clients.set(notebookId, client)
    this.docs.bindKernel(notebookId, id)
    return client
  }

  // Available kernelspecs (starts Jupyter lazily if needed — the same server a run
  // would spin up). Returns Jupyter's default so the UI can preselect it.
  async listKernelSpecs(): Promise<{ specs: KernelSpec[]; default: string }> {
    const info = await this.info()
    const res = await fetch(`${info.url}/api/kernelspecs`, { headers: { Authorization: `token ${info.token}` } })
    if (!res.ok) throw new Error(`failed to list kernelspecs: ${res.status}`)
    const data = await res.json() as {
      default: string
      kernelspecs: Record<string, { name: string; spec: { display_name: string; language: string } }>
    }
    const specs = Object.values(data.kernelspecs).map((k) => ({
      name: k.name, displayName: k.spec.display_name, language: k.spec.language,
    }))
    return { specs, default: data.default }
  }

  // Choose the kernelspec a notebook uses and START it now (Jupyter-style: picking a
  // kernel launches it, so the header goes no-kernel → starting → idle instead of
  // sitting on "no kernel"). The pick also becomes the default for notebooks opened
  // afterwards. A running kernel on the old spec is shut down first.
  async setKernelSpec(notebookId: string, name: string): Promise<void> {
    this.specByNotebook.set(notebookId, name)
    this.defaultSpec = name
    this.docs.setKernelName(notebookId, name)
    if (this.clients.has(notebookId)) this.shutdown(notebookId)
    await this.ensureKernel(notebookId)
  }

  // Run one cell: clear its outputs, execute the source, stream outputs back into
  // the doc keyed by THIS cellId (survives reorders — the bug this design kills).
  async runCell(notebookId: string, cellId: string): Promise<void> {
    const doc = this.docs.get(notebookId)
    const cell = doc?.cells.find((c) => c.id === cellId)
    if (!doc || !cell) throw new Error(`no such cell: ${cellId}`)
    if (cell.cellType !== 'code') return   // only code cells execute
    const client = await this.ensureKernel(notebookId)
    this.docs.clearCellOutputs(notebookId, cellId)
    await new Promise<void>((resolve) => {
      client.execute(
        cell.source,
        (o) => this.docs.appendCellOutput(notebookId, cellId, o),
        (count) => { this.docs.setCellExecutionCount(notebookId, cellId, count); resolve() },
      )
    })
  }

  // Run every code cell top-to-bottom, in order, stopping nothing on error (matches
  // a plain run-all; the error output lands on the offending cell).
  async runAll(notebookId: string): Promise<void> {
    const doc = this.docs.get(notebookId)
    if (!doc) throw new Error(`no such open notebook: ${notebookId}`)
    for (const cell of doc.cells.filter((c) => c.cellType === 'code')) {
      await this.runCell(notebookId, cell.id)
    }
  }

  kernelStatus(notebookId: string): KernelStatus | undefined { return this.status.get(notebookId) }

  interrupt(notebookId: string): Promise<void> { return this.clients.get(notebookId)?.interrupt() ?? Promise.resolve() }
  restart(notebookId: string): Promise<void> {
    const client = this.clients.get(notebookId)
    if (!client) return Promise.resolve()
    this.setStatus(notebookId, 'starting')   // reflect the restart immediately; idle arrives via the socket
    return client.restart()
  }

  shutdown(notebookId: string): void {
    const client = this.clients.get(notebookId)
    if (!client) return
    void client.shutdown()
    client.dispose()
    this.clients.delete(notebookId)
    this.docs.bindKernel(notebookId, undefined)
    this.setStatus(notebookId, 'none')   // no kernel now — clears the bogus 'idle'
  }

  destroy(): void {
    for (const c of this.clients.values()) c.dispose()
    this.clients.clear()
    this.jupyter.destroy()
  }
}
