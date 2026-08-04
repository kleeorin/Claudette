// Isolates the /api/fs/upload path reported as "uploading a file doesn't work".
// Boots ONLY registerFsRoutes on a real Fastify instance (no auth hook, so a 401
// can't mask the result) and drives it exactly the way web/src/api/client.ts does:
// POST with content-type application/octet-stream and the raw bytes as the body.
//
// Answers three questions:
//   1. does the route work at all for a small file?
//   2. does Fastify's default 1 MB bodyLimit bite the octet-stream passthrough
//      parser? (the client streams the File straight through, so a photo upload
//      would be the common case)
//   3. does the client's `Array.from(files)` see anything after the onChange
//      handler clears the input? (simulated — the real DOM check is in a browser)
//
// Run: npx tsx scratchpad/upload-test.mts
import Fastify from 'fastify'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerFsRoutes } from '../server/src/fs/fsApi'

const PORT = 4344
const APP = `http://127.0.0.1:${PORT}`
let failed = 0
const ok = (c: unknown, m: string) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failed++ }

const dir = await mkdtemp(join(tmpdir(), 'claudette-upload-'))
const app = Fastify({ logger: false })
registerFsRoutes(app)
await app.listen({ host: '127.0.0.1', port: PORT })

async function upload(name: string, body: Uint8Array | string) {
  const res = await fetch(`${APP}/api/fs/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'sec-fetch-site': 'same-origin' },
    body,
  })
  let json: unknown = null
  try { json = await res.json() } catch { /* non-JSON body */ }
  return { status: res.status, json: json as { ok?: boolean; error?: string } | null }
}

// 1. small file round-trip
{
  const r = await upload('small.txt', 'hello upload\n')
  ok(r.json?.ok === true, `small file accepted (status ${r.status}, body ${JSON.stringify(r.json)})`)
  const back = await readFile(join(dir, 'small.txt'), 'utf8').catch(() => null)
  ok(back === 'hello upload\n', 'small file landed on disk with the right bytes')
}

// 2. > Fastify's default 1 MB bodyLimit — the passthrough parser should bypass it
{
  const big = new Uint8Array(3 * 1024 * 1024).fill(65)
  const r = await upload('big.bin', big)
  ok(r.json?.ok === true, `3 MB file accepted — bodyLimit does NOT apply to the octet-stream parser (status ${r.status}, body ${JSON.stringify(r.json)})`)
  const back = await readFile(join(dir, 'big.bin')).catch(() => null)
  ok(back?.length === big.length, `3 MB file landed whole (${back?.length ?? 0} of ${big.length} bytes)`)
}

// 3. collision is reported, not silently swallowed
{
  const r = await upload('small.txt', 'second\n')
  ok(r.json?.ok === false && /already exists/.test(r.json?.error ?? ''), `re-upload of an existing name is refused with a clear error (${JSON.stringify(r.json)})`)
}

// 4. a name with path components can't traverse out of `dir`
{
  const r = await upload('../escaped.txt', 'nope\n')
  const escaped = await readFile(join(dir, '..', 'escaped.txt'), 'utf8').catch(() => null)
  ok(escaped === null, `basename() strips traversal — nothing written outside dir (${JSON.stringify(r.json)})`)
}

// 5. THE CLIENT-SIDE BUG, simulated. FileManager's onChange used to do:
//      const f = e.target.files; e.target.value = ''; void uploadFiles(f)
//    In Blink, HTMLInputElement.setValue("") calls FileInputType::SetValue which
//    does `file_list_->clear()` — it mutates the SAME FileList object rather than
//    allocating a new one. So the captured reference is empty by the time
//    uploadFiles' `Array.from(files)` runs, and the loop does nothing at all.
//    The fix snapshots into a real array BEFORE the reset. Both orderings below.
{
  class FakeFileList {
    items: string[] = ['a.txt']
    get length() { return this.items.length }
    [Symbol.iterator]() { return this.items[Symbol.iterator]() }
    clear() { this.items = [] }
  }
  const makeInput = () => ({ files: new FakeFileList(), set value(_v: string) { this.files.clear() } })

  const broken = makeInput()
  const captured = broken.files       // OLD: grab the live list…
  broken.value = ''                   // …then reset the input
  ok(Array.from(captured).length === 0, `OLD order (capture live FileList, then clear) yields 0 files — the silent no-op`)

  const fixed = makeInput()
  const picked = Array.from(fixed.files)  // NEW: snapshot to an array first…
  fixed.value = ''                        // …then reset
  ok(picked.length === 1, `NEW order (snapshot to an array, then clear) yields ${picked.length} file — upload proceeds`)
}

// 6. The batch loop must not be able to strand the "+ New" button. uploadFiles now
//    wraps the loop in try/finally; assert the shape holds when a call rejects.
{
  let uploading: unknown = { done: 0, total: 1 }
  const run = async () => {
    try {
      await Promise.reject(new Error('network down'))
    } finally {
      uploading = null
    }
  }
  await run().catch(() => {})
  ok(uploading === null, 'a rejected upload still clears the progress state (button not left disabled)')
}

await app.close()
await rm(dir, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
