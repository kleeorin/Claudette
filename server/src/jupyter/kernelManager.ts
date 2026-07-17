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
  private running = new Map<string, Set<string>>()    // notebookId → cellIds currently executing/queued
  private executing = new Set<string>()               // `${notebookId}:${cellId}` actually mid-execution
  private owner = new Map<string, string>()           // notebookId → owning sessionId (kills with the session)
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
    // A dead kernel will never finish its runs — drop the running markers so the UI
    // spinners don't spin forever.
    if (status === 'dead') this.clearRunning(notebookId)
  }

  // The authoritative per-cell running set (emitted as 'running' → `notebook:running`).
  // Marking a cell running/not-running is the ONLY driver of the UI spinner, so it must
  // cover every terminal path (done, error, deleted mid-run, kernel dead/restart).
  private setRunning(notebookId: string, cellIds: string[], on: boolean): void {
    const set = this.running.get(notebookId) ?? new Set<string>()
    let changed = false
    for (const id of cellIds) {
      if (on ? !set.has(id) : set.has(id)) { on ? set.add(id) : set.delete(id); changed = true }
    }
    if (!changed) return
    this.running.set(notebookId, set)
    this.emit('running', notebookId, [...set])
    if (set.size === 0) this.docs.onKernelIdle(notebookId)   // finalize a deferred close
  }
  private clearRunning(notebookId: string): void {
    const set = this.running.get(notebookId)
    if (!set || set.size === 0) return
    set.clear()
    this.emit('running', notebookId, [])
    this.docs.onKernelIdle(notebookId)
  }

  // Is any cell of this notebook currently executing/queued?
  isRunning(notebookId: string): boolean { return (this.running.get(notebookId)?.size ?? 0) > 0 }

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
    // Ignore a re-run of a cell that's already executing — otherwise the second run
    // clears the first's partial output while the first keeps appending, interleaving
    // two runs' output in the same cell.
    const execKey = `${notebookId}:${cellId}`
    if (this.executing.has(execKey)) return
    this.executing.add(execKey)
    this.setRunning(notebookId, [cellId], true)
    try {
      let client: KernelClient
      try {
        client = await this.ensureKernel(notebookId)
      } catch (e) {
        // Kernel couldn't start (e.g. Jupyter not installed) — surface it as the
        // cell's error output rather than a swallowed rejection + stuck spinner.
        this.docs.clearCellOutputs(notebookId, cellId)
        this.docs.appendCellOutput(notebookId, cellId, {
          output_type: 'error', ename: 'KernelStartError',
          evalue: e instanceof Error ? e.message : String(e), traceback: [],
        })
        return
      }
      this.docs.clearCellOutputs(notebookId, cellId)
      await new Promise<void>((resolve) => {
        client.execute(
          cell.source,
          (o) => this.docs.appendCellOutput(notebookId, cellId, o),
          (count) => { this.docs.setCellExecutionCount(notebookId, cellId, count); resolve() },
        )
      })
    } finally {
      this.executing.delete(execKey)
      this.setRunning(notebookId, [cellId], false)
    }
  }

  // Run every code cell top-to-bottom, in order, stopping nothing on error (matches
  // a plain run-all; the error output lands on the offending cell). All target cells
  // are marked running up front (so queued cells show `[*]` like classic Jupyter) and
  // each clears as it finishes; a cell deleted mid-run is skipped, not fatal.
  async runAll(notebookId: string): Promise<void> {
    const doc = this.docs.get(notebookId)
    if (!doc) throw new Error(`no such open notebook: ${notebookId}`)
    const ids = doc.cells.filter((c) => c.cellType === 'code').map((c) => c.id)
    this.setRunning(notebookId, ids, true)
    try {
      for (const id of ids) {
        // The cell may have been deleted since we snapshotted; skip it gracefully so
        // one gone cell doesn't abort the rest of the run.
        if (!this.docs.get(notebookId)?.cells.some((c) => c.id === id)) {
          this.setRunning(notebookId, [id], false)
          continue
        }
        try { await this.runCell(notebookId, id) }
        catch { this.setRunning(notebookId, [id], false) }
      }
    } finally {
      this.setRunning(notebookId, ids, false)   // clear any stragglers
    }
  }

  kernelStatus(notebookId: string): KernelStatus | undefined { return this.status.get(notebookId) }

  interrupt(notebookId: string): Promise<void> { return this.clients.get(notebookId)?.interrupt() ?? Promise.resolve() }
  restart(notebookId: string): Promise<void> {
    const client = this.clients.get(notebookId)
    if (!client) return Promise.resolve()
    this.clearRunning(notebookId)            // in-flight runs won't finish on the old kernel
    this.setStatus(notebookId, 'starting')   // reflect the restart immediately; idle arrives via the socket
    return client.restart()
  }

  shutdown(notebookId: string): void {
    this.owner.delete(notebookId)   // explicit kill severs session ownership
    const client = this.clients.get(notebookId)
    if (!client) return
    void client.shutdown()
    client.dispose()
    this.clients.delete(notebookId)
    this.clearRunning(notebookId)
    this.docs.bindKernel(notebookId, undefined)
    this.setStatus(notebookId, 'none')   // no kernel now — clears the bogus 'idle'
  }

  // Record which session a notebook was opened in — closing that session kills its
  // kernel (see shutdownForSession). Last opener wins.
  setOwner(notebookId: string, sessionId: string): void {
    this.owner.set(notebookId, sessionId)
  }

  // Kill the kernels for every notebook opened in a now-closed session.
  shutdownForSession(sessionId: string): void {
    for (const [notebookId, sid] of [...this.owner]) {
      if (sid !== sessionId) continue
      this.shutdown(notebookId)
      this.owner.delete(notebookId)
    }
  }

  // Re-broadcast a notebook's live kernel state. Kernels OUTLIVE the doc (closing a
  // tab doesn't kill the kernel), so when a notebook is REOPENED its fresh doc/view
  // must pick the existing kernel back up — its binding, status, and running cells.
  resync(notebookId: string): void {
    const client = this.clients.get(notebookId)
    if (!client) return
    this.docs.setKernelName(notebookId, this.specName(notebookId))
    this.docs.bindKernel(notebookId, client.kernelId)
    this.emit('status', notebookId, this.status.get(notebookId) ?? 'idle')
    const running = this.running.get(notebookId)
    this.emit('running', notebookId, running ? [...running] : [])
  }

  destroy(): void {
    for (const c of this.clients.values()) c.dispose()
    this.clients.clear()
    this.jupyter.destroy()
  }
}
