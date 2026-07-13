// JupyterProxy HTTP test (P1.6): token injected server-side, path rewritten. Run:
//   npx tsx scratchpad/jupyter-proxy-test.mts
import http from 'http'
import { JupyterManager } from '../server/src/jupyter/jupyterManager.ts'
import { JupyterProxy } from '../server/src/jupyter/jupyterProxy.ts'

let failed = 0
const ok = (c: unknown, m: string) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++ }

const jupyter = new JupyterManager()
const proxy = new JupyterProxy()

const info = await jupyter.start()
ok(info != null, 'jupyter started')
proxy.setTarget(info)

// A throwaway front server that forwards /jupyter/* through the proxy.
const front = http.createServer((req, res) => proxy.handleHttp(req, res))
await new Promise<void>((r) => front.listen(0, '127.0.0.1', r))
const port = (front.address() as any).port

// NO token in our request — the proxy must inject it. /api/status needs auth.
const res = await fetch(`http://127.0.0.1:${port}/jupyter/api/status`)
ok(res.status === 200, `proxied /jupyter/api/status → 200 (got ${res.status}, token injected)`)
const body = await res.json() as any
ok(typeof body.started === 'string' || 'kernels' in body, 'response is a Jupyter status payload')

// Sanity: hitting Jupyter directly WITHOUT a token is rejected (proves the proxy added it).
const direct = await fetch(`${info!.url}/api/status`)
ok(direct.status === 403 || direct.status === 401, `direct (no token) rejected (${direct.status})`)

front.close()
jupyter.destroy()
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
