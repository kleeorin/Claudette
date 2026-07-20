import { EventEmitter } from 'events'
import { errMessage } from '../util/errMessage'
import { dirname } from 'path'
import type { KernelSpec, KernelSpecsResponse } from '@claudette/shared'
import type { NotebookDocManager } from '../notebook/notebookDocManager'
import { JupyterManager, findNearestPython, type JupyterInfo, type JupyterSandbox } from './jupyterManager'
import { KernelClient, type KernelStatus } from './kernelClient'
import { sandboxKey } from '../claude/sandbox'
import type { Confinement, Owner, SessionConfinement } from '../claude/sessionConfinement'

// Sentinel owner for a notebook opened OUTSIDE any session — the operator's own view via
// the token-gated HTTP route with no sessionId. Its kernel runs on the host, deliberately.
// Distinct from NO owner at all (a notebook nothing claimed → fail closed: refuse to start
// a kernel, since it would otherwise land on the unconfined `off:` server).

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
  private owner = new Map<string, Owner>()           // notebookId → owning sessionId (kills with the session)
  private specByNotebook = new Map<string, string>()  // notebookId → chosen kernelspec name
  // Pool of Jupyter servers keyed by sandbox key (see sandboxKey): 'off' is the shared
  // unconfined server; a sandboxed session gets its own server confined to its box, so
  // the kernels it spawns can't escape the mounts. Lazily started, reused across
  // notebooks with the same box, torn down on destroy().
  private servers = new Map<string, JupyterManager>()
  // Cache of the interpreter discovered for a directory (dir → python path). The venv
  // doesn't move mid-session, so we don't re-walk the tree on every run.
  private pythonCache = new Map<string, string>()
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
    // The single confinement seam (SANDBOX.md): resolves a notebook's OWNER session to a
    // box so its kernel runs confined. A notebook whose owner can't be resolved fails
    // closed (deny) — the kernel is refused, never dropped to the unconfined `off:` server.
    private confinement: SessionConfinement,
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

  // Get (or lazily spawn) the pooled Jupyter server for a sandbox key, and its URL +
  // token. The 'off' server is the shared unconfined one and drives the browser proxy
  // target; a sandboxed key gets a server confined to that session's box.
  private async serverInfo(key: string, pythonPath: string, sandbox?: JupyterSandbox): Promise<JupyterInfo> {
    let jm = this.servers.get(key)
    if (!jm) {
      jm = new JupyterManager(pythonPath, sandbox)
      this.servers.set(key, jm)
    }
    const info = await jm.start()
    if (!info) throw new Error(`Jupyter server failed to start with ${pythonPath} (is jupyter-server installed there?)`)
    if (!sandbox) this.onJupyterStart?.(info)   // browser proxy points at a non-sandboxed server
    return info
  }

  // Resolve the interpreter to launch Jupyter with for a directory: the nearest
  // .venv/venv/env that has jupyter_server (walking upward), else the ambient python3.
  // This is why a project venv "just works" even when the system has no jupyter. The
  // session's `sandbox` (when any) is passed to discovery so a candidate inside its
  // writable mounts is probed INSIDE the box, not executed on the host (SANDBOX.md
  // "Venv-probe escape").
  private async pythonFor(dir: string, sandbox?: JupyterSandbox): Promise<string> {
    // Cache per (dir, box): the same dir probed confined vs unconfined can legitimately
    // differ, so results must not cross between a sandboxed and unsandboxed use of it.
    const key = `${dir}|${sandbox ? sandboxKey(sandbox.cfg, sandbox.cwd) : 'off'}`
    const cached = this.pythonCache.get(key)
    if (cached) return cached
    const py = (await findNearestPython(dir, sandbox)) ?? 'python3'
    this.pythonCache.set(key, py)
    return py
  }

  // The confinement decision for a notebook's kernel, from its OWNER (SANDBOX.md). No
  // owner at all ⇒ `deny` (nothing claimed it — fail closed); the HOST sentinel ⇒ `host`
  // (an operator's session-less notebook); a real owner ⇒ resolved via the seam (which is
  // itself `host` for an unconfined session, `deny` for one that's since gone).
  private confinementForNotebook(notebookId: string): Confinement {
    return this.confinement.resolveOwner(this.owner.get(notebookId))
  }

  // The box a notebook's kernel runs in, or undefined for a host (unconfined) kernel.
  // Throws on `deny` — an unowned/orphaned notebook must NOT start a kernel, since that
  // kernel would land on the shared unconfined `off:` server (SANDBOX.md "Unowned-kernel
  // escape"). Refusing is safe: with ownership claimed on every MCP/HTTP open, `deny`
  // only means a genuine wiring bug or a torn-down session.
  private boxForNotebook(notebookId: string): JupyterSandbox | undefined {
    const c = this.confinementForNotebook(notebookId)
    if (c.mode === 'deny') throw new Error(`notebook ${notebookId} has no resolvable owning session — refusing to start a kernel (it would run unconfined)`)
    return c.mode === 'confined' ? { cfg: c.cfg, cwd: c.cwd } : undefined
  }

  // The Jupyter server a notebook's kernel should run on: its owning session's confined
  // server when that session is sandboxed, else a server for the notebook's discovered
  // venv (non-sandboxed servers are pooled per interpreter, so notebooks sharing a venv
  // share a server and different venvs each get their own).
  private async serverFor(notebookId: string): Promise<JupyterInfo> {
    const sandbox = this.boxForNotebook(notebookId)
    const doc = this.docs.get(notebookId)
    // Discover the project's venv the same way for both boxes — a confined session's
    // Jupyter must run under the same interpreter that "just works" unconfined, not the
    // bare system python3 (which usually lacks jupyter_server). JupyterManager ro-binds
    // that venv into the box when it's outside the mounts; the discovery probe for a
    // box-writable candidate runs INSIDE the box (see pythonFor / findNearestPython).
    const python = await this.pythonFor(doc ? dirname(doc.path) : (sandbox?.cwd ?? process.cwd()), sandbox)
    return this.serverForBox(python, sandbox)
  }

  // The pooled Jupyter server for an interpreter in (or out of) a box: keyed per box
  // (`<sandboxKey>|<python>`) or `off:<python>` for the unconfined host. One place so
  // serverFor and listKernelSpecs can't drift on the key format.
  private serverForBox(python: string, sandbox?: JupyterSandbox): Promise<JupyterInfo> {
    const key = sandbox ? `${sandboxKey(sandbox.cfg, sandbox.cwd)}|${python}` : `off:${python}`
    return this.serverInfo(key, python, sandbox)
  }

  // Start (or reuse) a kernel bound to a notebook. The kernel's cwd is set to the
  // notebook's OWN directory (so cells resolve relative paths like open('data.csv')
  // against the folder the .ipynb lives in, not Jupyter's root). We pass the
  // notebook path relative to root_dir (which is '/'); Jupyter derives the kernel
  // cwd from its parent directory.
  async ensureKernel(notebookId: string): Promise<KernelClient> {
    const doc = this.docs.get(notebookId)
    if (!doc) throw new Error(`no such open notebook: ${notebookId}`)
    // Resolve the server the notebook's CURRENT owner requires BEFORE reusing a kernel
    // (pooled, so this is cheap when the box is unchanged). SECURITY (SANDBOX.md
    // "Unowned-kernel escape"): a live kernel is reused only when it runs on that exact
    // server. If the notebook's confinement has since changed — e.g. a sandboxed session
    // claimed a notebook whose kernel had been started on the unconfined `off:` server —
    // discard the stale kernel and start a fresh one on the correct (confined) server, so
    // execution can never keep running outside the owner's box.
    const info = await this.serverFor(notebookId)
    const existing = this.clients.get(notebookId)
    if (existing) {
      if (existing.serverUrl === info.url) return existing
      void existing.shutdown()
      existing.dispose()
      this.clients.delete(notebookId)
      this.clearRunning(notebookId)
      this.docs.bindKernel(notebookId, undefined)
    }
    // root_dir is '/', so the resource path relative to it is the absolute path
    // minus its leading slash(es).
    const relPath = doc.path.replace(/^\/+/, '')

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
  async listKernelSpecs(): Promise<KernelSpecsResponse> {
    // Read specs off the same venv server a run would use (discovered from an open
    // notebook's dir), so the list reflects the project's kernels — not the system
    // python's. Falls back to python3 when nothing is open / no venv is found.
    // A confined notebook's specs come from ITS box (reusing the pooled confined
    // server), never an unconfined `off:` server — otherwise a box-writable interpreter
    // would be launched unsandboxed (SANDBOX.md "Venv-probe escape"). The discovery
    // probe is likewise confined via pythonFor.
    // Operator-initiated + token-gated (not box-reachable), so an unresolvable owner
    // here falls back to the host `off:` server rather than throwing — but a CONFINED
    // notebook still reads its specs from its own box, so a box-writable interpreter is
    // never launched unsandboxed via the picker.
    const first = this.docs.list()[0]
    const c = first ? this.confinementForNotebook(first.notebookId) : { mode: 'host' as const }
    const sandbox: JupyterSandbox | undefined = c.mode === 'confined' ? { cfg: c.cfg, cwd: c.cwd } : undefined
    const python = await this.pythonFor(first ? dirname(first.path) : process.cwd(), sandbox)
    const info = await this.serverForBox(python, sandbox)
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
          evalue: errMessage(e), traceback: [],
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
  setOwner(notebookId: string, owner: Owner): void {
    this.owner.set(notebookId, owner)
  }

  // The owner of a notebook (whose box confines its kernel), or undefined if none.
  // Exposed so the confinement of a notebook's execution is testable.
  ownerOf(notebookId: string): Owner | undefined { return this.owner.get(notebookId) }

  // Kill the kernels for every notebook opened in a now-closed session (host-owned
  // notebooks have no session and are left alone).
  shutdownForSession(sessionId: string): void {
    for (const [notebookId, owner] of [...this.owner]) {
      if (!('session' in owner) || owner.session !== sessionId) continue
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
    for (const jm of this.servers.values()) jm.destroy()   // kill every pooled server
    this.servers.clear()
  }
}
