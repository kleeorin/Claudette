import { spawn, execFile, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { access } from 'fs/promises'
import { constants } from 'fs'
import { dirname, join, resolve } from 'path'

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
export async function findNearestPython(startDir: string): Promise<string | null> {
  let d = resolve(startDir)
  for (;;) {
    for (const v of ['.venv', 'venv']) {
      const py = join(d, v, 'bin', 'python3')
      if (await isExecutable(py) && await canImportJupyter(py)) return py
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
function canImportJupyter(py: string): Promise<boolean> {
  return new Promise((res) => {
    execFile(py, ['-c', 'import jupyter_server'], (err) => res(!err))
  })
}

export class JupyterManager {
  private server: ChildProcess | null = null
  private infoPromise: Promise<JupyterInfo | null> | null = null

  // `pythonPath` is the interpreter to launch Jupyter with (e.g. from
  // findNearestPython); defaults to the ambient `python3`.
  constructor(private pythonPath = 'python3') {}

  start(): Promise<JupyterInfo | null> {
    if (this.infoPromise) return this.infoPromise
    this.infoPromise = this._spawnLocal()
    return this.infoPromise
  }

  private _spawnLocal(): Promise<JupyterInfo | null> {
    const token = randomBytes(24).toString('hex')
    const proc = spawn(this.pythonPath, [
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
    ], { env: process.env as Record<string, string> })
    return this._await(proc, token)
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

  // pip-install the server + kernel into the launch interpreter. PEP-668
  // "externally managed" interpreters refuse a plain install → --break-system-packages.
  install(): Promise<boolean> {
    const pkgs = 'jupyter-server notebook ipykernel'
    const py = this.pythonPath
    const script = `${py} -m pip install ${pkgs} || ${py} -m pip install --break-system-packages ${pkgs}`
    return new Promise((resolve) => {
      const proc = spawn('sh', ['-c', script], { env: process.env as Record<string, string> })
      proc.on('exit', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
      setTimeout(() => resolve(false), 300_000)
    })
  }

  destroy(): void {
    this.server?.kill()
    this.reset()
  }
}
