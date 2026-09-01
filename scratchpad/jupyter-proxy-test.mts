// JupyterProxy HTTP test (P1.6): token injected server-side, path rewritten. Run:
//   npx tsx scratchpad/jupyter-proxy-test.mts
import http from 'http'
import { JupyterManager } from '../server/src/jupyter/jupyterManager.ts'
import { JupyterProxy } from '../server/src/jupyter/jupyterProxy.ts'

import { check as ok, failed } from './assert.mjs'

const jupyter = new JupyterManager()
const proxy = new JupyterProxy()

const info = await jupyter.start()
ok('jupyter started', info != null)
proxy.setTarget(info)

// A throwaway front server that forwards /jupyter/* through the proxy.
const front = http.createServer((req, res) => proxy.handleHttp(req, res))
await new Promise<void>((r) => front.listen(0, '127.0.0.1', r))
const port = (front.address() as any).port

// NO token in our request — the proxy must inject it. /api/status needs auth.
const res = await fetch(`http://127.0.0.1:${port}/jupyter/api/status`)
ok(`proxied /jupyter/api/status → 200 (got ${res.status}, token injected)`, res.status === 200)
const body = await res.json() as any
ok('response is a Jupyter status payload', typeof body.started === 'string' || 'kernels' in body)

// Sanity: hitting Jupyter directly WITHOUT a token is rejected (proves the proxy added it).
const direct = await fetch(`${info!.url}/api/status`)
ok(`direct (no token) rejected (${direct.status})`, direct.status === 403 || direct.status === 401)

front.close()
jupyter.destroy()
console.log(failed === 0 ? '\n🎉 all passed' : `\n💥 ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
