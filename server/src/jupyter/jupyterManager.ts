import { spawn, execFile, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { access } from 'fs/promises'
import { constants } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import type { SandboxConfig, SandboxMount } from '@claudette/shared'
import { wrapCommand, sandboxAvailable, pathVisibleInSandbox, pathInWritableMount } from '../claude/sandbox'

// An optional per-server confinement: run the Jupyter server (and therefore every
// kernel it spawns) inside a session's bwrap box, so notebook execution can't reach
// outside the mounts. Given by KernelManager per sandboxed session (see SANDBOX.md).
export interface JupyterSandbox { cfg: SandboxConfig; cwd: string }

// Runs a local Jupyter server and hands back a 127.0.0.1 URL + token. Ported from
// ClaudeMaster's `main/jupyterManager.ts`, LOCAL branch only — the remote/SSH spawn
// + tunnel (`_spawnRemote`) is Phase 3, dropped here exactly as SessionManager's
// remote branch was. The kernel client (P1.9) is server-side, so it dials this URL
// directly with the token; the browser reaches Jupyter (if at all) via JupyterProxy.

export interface JupyterInfo { url: string; token: string }

// Walk upward from `startDir` toward '/', checking `.venv/bin/python3` and
// `venv/bin/python3` at each level for an interpreter that can actually import
// jupyter_server; return the first hit, else null. (CM ran this over SSH in one
// shell loop; local we walk in node.) An explicit pythonPath always wins upstream.
// `sandbox`, when given, is the session this discovery is for — candidates inside its
// writable mounts are probed INSIDE its box (see canImportJupyter) so a confined
// session can't turn a planted `.venv/bin/python3` into unsandboxed host RCE.
export async function findNearestPython(startDir: string, sandbox?: JupyterSandbox): Promise<string | null> {
  let d = resolve(startDir)
  for (;;) {
    for (const v of ['.venv', 'venv', 'env']) {
      const py = join(d, v, 'bin', 'python3')
      if (await isExecutable(py) && await canImportJupyter(py, sandbox)) return py
    }
    const parent = dirname(d)
    if (parent === d) return null   // reached '/'
    d = parent
  }
}

// Poll GET /api/status until Jupyter answers (any HTTP response = socket accepting),
// so start() never resolves before the server is reachable. ~10s ceiling; resolves
// regardless after that so a wedged server still surfaces via the caller's fetch.
async function waitReachable(url: string, token: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      await fetch(`${url}/api/status`, { headers: { Authorization: `token ${token}` } })
      return
    } catch {
      if (Date.now() > deadline) return
      await new Promise((r) => setTimeout(r, 150))
    }
  }
}

async function isExecutable(p: string): Promise<boolean> {
  return access(p, constants.X_OK).then(() => true, () => false)
}
// Probe whether `py` can import jupyter_server. SECURITY (SANDBOX.md "Venv-probe
// escape"): `py` may live in a confined session's WRITABLE cwd, where the box could
// plant a malicious "python3". Running it here — in the unsandboxed server, with the
// server's full env incl. CLAUDETTE_TOKEN — is arbitrary host RCE (verified). So when
// the candidate's path lies in a box-writable mount, run the probe INSIDE that session's
// box (wrapCommand): a planted binary then executes confined (harmless) while a real
// project venv still imports fine. Candidates the box could NOT have placed (outside
// every rw mount — the box can't write there) are probed directly, as before.
function canImportJupyter(py: string, sandbox?: JupyterSandbox): Promise<boolean> {
  let cmd = py
  let args = ['-c', 'import jupyter_server']
  if (sandbox && sandboxAvailable() && pathInWritableMount(sandbox.cfg, sandbox.cwd, py)) {
    const wrapped = wrapCommand(sandbox.cfg, sandbox.cwd, py, args)
    cmd = wrapped.command
    args = wrapped.args
  }
  return new Promise((res) => {
    execFile(cmd, args, (err) => res(!err))
  })
}

export class JupyterManager {
  private server: ChildProcess | null = null
  private infoPromise: Promise<JupyterInfo | null> | null = null

  // `pythonPath` is the interpreter to launch Jupyter with (e.g. from
  // findNearestPython); defaults to the ambient `python3`. `sandbox`, when given AND
  // the host can confine, runs the whole server inside that bwrap box so its kernels
  // are confined too.
  constructor(private pythonPath = 'python3', private sandbox?: JupyterSandbox) {}

  start(): Promise<JupyterInfo | null> {
    if (this.infoPromise) return this.infoPromise
    this.infoPromise = this._spawnLocal()
    return this.infoPromise
  }

  private _spawnLocal(): Promise<JupyterInfo | null> {
    const token = randomBytes(24).toString('hex')
    const jupyterArgv = [
      '-m', 'jupyter', 'server',
      '--no-browser',
      '--port=0',
      '--ip=127.0.0.1',
      `--ServerApp.token=${token}`,
      '--ServerApp.disable_check_xsrf=True',
      // The kernel client / browser hit the kernel API cross-origin, so Jupyter
      // must answer CORS preflight; safe — bound to 127.0.0.1 and token-gated.
      '--ServerApp.allow_origin=*',
      // Root at "/" so a kernel can start in any notebook's directory (passed as a
      // path relative to root_dir), which sets the kernel cwd.
      '--ServerApp.root_dir=/',
    ]
    const proc = this.sandbox && sandboxAvailable()
      ? this._spawnSandboxed(jupyterArgv)
      : spawn(this.pythonPath, jupyterArgv, { env: this._launchEnv() })
    return this._await(proc, token)
  }

  // `python -m jupyter server` finds the `jupyter-server` subcommand by scanning PATH,
  // so a stray/broken `jupyter-server` earlier on PATH (e.g. a system /usr/local/bin
  // stub whose python lacks jupyter_server) shadows the venv's and the server dies with
  // "No module named 'jupyter_server'". Prepend the launch interpreter's own bin dir so
  // ITS subcommands win — the same precedence `source .venv/bin/activate` would give.
  // No-op for the bare `python3` (not an absolute path ⇒ nothing to prepend).
  private venvBinPath(base = process.env.PATH ?? ''): string | undefined {
    if (!this.pythonPath.startsWith('/')) return undefined
    const bin = dirname(this.pythonPath)
    return base ? `${bin}:${base}` : bin
  }
  private _launchEnv(): Record<string, string> {
    const env = { ...process.env } as Record<string, string>
    const p = this.venvBinPath()
    if (p) env.PATH = p
    return env
  }

  // Run the server inside the session's box. The kernelspecs + auto-venv launcher live
  // under the user Jupyter data dir (~/.local/share/jupyter) which isn't otherwise in
  // the sandbox, so mount it ro and point JUPYTER_PATH at it; the runtime dir must be
  // WRITABLE, so send it to the sandbox's tmpfs /tmp. The kernels this server spawns
  // inherit the box; kernel↔server ZMQ works because we don't --unshare-net.
  private _spawnSandboxed(jupyterArgv: string[]): ChildProcess {
    const dataDir = join(homedir(), '.local', 'share', 'jupyter')
    const extraMounts: SandboxMount[] = [{ path: dataDir, mode: 'ro' }]
    // The launch interpreter (e.g. a project's …/.venv/bin/python3) must be visible
    // INSIDE the box to exec. When it lives under cwd it already is (cwd is bound); an
    // ancestor/out-of-tree venv is NOT, so ro-bind its prefix (…/.venv) — skipping the
    // bare `python3` (resolved from /usr, already in the baseline) and any interpreter
    // a mount already covers, so we never re-bind (or accidentally override) cwd.
    if (this.pythonPath.startsWith('/')) {
      const prefix = dirname(dirname(this.pythonPath))   // …/.venv/bin/python3 → …/.venv
      if (!pathVisibleInSandbox(this.sandbox!.cfg.mounts, prefix)) extraMounts.push({ path: prefix, mode: 'ro' })
    }
    const extraEnv: Record<string, string> = { JUPYTER_PATH: dataDir, JUPYTER_RUNTIME_DIR: '/tmp/jupyter-runtime' }
    // Same PATH precedence fix as the unconfined spawn, but set INSIDE the box (bwrap
    // passes our env through, so the venv bin must be prepended via --setenv here too).
    const p = this.venvBinPath()
    if (p) extraEnv.PATH = p
    const { command, args } = wrapCommand(this.sandbox!.cfg, this.sandbox!.cwd, this.pythonPath, jupyterArgv, {
      extraMounts,
      extraEnv,
    })
    return spawn(command, args, { env: process.env as Record<string, string> })
  }

  // Jupyter prints its listening URL to stderr; the first such line means it's up.
  private _await(proc: ChildProcess, token: string): Promise<JupyterInfo | null> {
    return new Promise((resolve) => {
      this.server = proc
      let resolved = false
      const done = (val: JupyterInfo | null) => {
        if (resolved) return
        resolved = true
        resolve(val)
      }
      const onData = (data: Buffer) => {
        const text = data.toString()
        process.stderr.write('[jupyter] ' + text)
        const m = text.match(/https?:\/\/[^:]+:(\d+)/)
        if (!m) return
        proc.stdout?.off('data', onData)
        proc.stderr?.off('data', onData)
        const url = `http://127.0.0.1:${m[1]}`
        // The banner is logged just BEFORE tornado's IOLoop starts accepting, so a
        // fetch fired the instant we parse it can hit ECONNREFUSED. Poll /api/status
        // until the server truly answers, then resolve — every caller gets a server
        // that's actually reachable.
        void waitReachable(url, token).then(() => done({ url, token }))
      }
      proc.stdout?.on('data', onData)
      proc.stderr?.on('data', onData)
      proc.on('error', (err) => { console.error('[jupyter] spawn error:', err.message); this.reset(); done(null) })
      proc.on('exit', (code) => { console.error('[jupyter] exited with code', code); this.reset(); done(null) })
      setTimeout(() => { console.error('[jupyter] timed out after 30s'); done(null) }, 30_000)
    })
  }

  private reset(): void {
    this.server = null
    this.infoPromise = null
  }

  destroy(): void {
    this.server?.kill()
    this.reset()
  }
}
