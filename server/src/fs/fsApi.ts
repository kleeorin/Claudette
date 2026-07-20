import { readdir, stat, readFile, writeFile, mkdir, rename, cp, rm } from 'fs/promises'
import { createReadStream } from 'fs'
import { resolve, dirname, isAbsolute, basename, extname } from 'path'
import { homedir } from 'os'
import type { FastifyInstance } from 'fastify'
import type { DirEntry, FsListResponse, FilePreview, WriteResult } from '@claudette/shared'

// Resolve a request path the same way `read`/`list` do: absolute as-is, relative
// against $HOME.
function toAbs(raw: string): string {
  return isAbsolute(raw) ? resolve(raw) : resolve(homedir(), raw)
}

// Does a path exist? Used to refuse move/copy that would clobber a destination.
async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

// Filesystem browse endpoint backing the file/folder picker. Single-user, local
// tool: the auth gate already protects /api/*, and Jupyter runs rooted at '/', so
// full-tree navigation is deliberately allowed (no chroot). Read-only listing.

// Read one directory into sorted DirEntry[]: directories first, then files, each
// alphabetical (case-insensitive). Unreadable entries still list (size/mtime 0)
// so a permission-denied child doesn't blank the whole folder.
async function listDir(abs: string): Promise<DirEntry[]> {
  const names = await readdir(abs, { withFileTypes: true })
  const entries: DirEntry[] = await Promise.all(
    names.map(async (d) => {
      let isDir = d.isDirectory()
      let size = 0
      let mtimeMs = 0
      try {
        // stat (not lstat) so symlinks resolve to their target's kind — a link to a
        // directory should navigate like one.
        const s = await stat(resolve(abs, d.name))
        isDir = s.isDirectory()
        size = isDir ? 0 : s.size
        mtimeMs = s.mtimeMs
      } catch { /* dangling symlink / EACCES → keep the dirent's best guess */ }
      return { name: d.name, isDir, size, mtimeMs }
    }),
  )
  return entries.sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

// In-app file preview (ported from ClaudeMaster's fs:readFile): images/PDFs as
// data URLs, text up to a cap, a NUL-byte binary heuristic, otherwise "binary".
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}
const MAX_TEXT_BYTES = 2 * 1024 * 1024 // 2 MB cap for text previews

async function readPreview(path: string): Promise<FilePreview> {
  const name = basename(path)
  try {
    const ext = extname(path).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (mime) {
      const buf = await readFile(path)
      return { kind: 'image', name, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
    }
    if (ext === '.pdf') {
      const buf = await readFile(path)
      return { kind: 'pdf', name, dataUrl: `data:application/pdf;base64,${buf.toString('base64')}` }
    }
    const { size } = await stat(path)
    const buf = await readFile(path)
    // Binary heuristic: a NUL byte in the first chunk means "not text".
    if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary', name }
    const truncated = size > MAX_TEXT_BYTES
    const text = buf.subarray(0, MAX_TEXT_BYTES).toString('utf8')
    return { kind: 'text', name, text, truncated }
  } catch (err) {
    return { kind: 'error', name, message: err instanceof Error ? err.message : String(err) }
  }
}

export function registerFsRoutes(app: FastifyInstance): void {
  // One guard for the whole /api/fs/* surface (O1 + O4). The auth cookie is
  // SameSite=Lax, so it still rides a top-level CROSS-SITE request: a malicious page
  // can point window.location/<a> at /api/fs/download?path=/etc/passwd (read) or
  // auto-submit a form at a write route. Sec-Fetch metadata is the reliable signal —
  // refuse anything the browser tags cross-site. The app's own same-origin fetch()s
  // pass, dev/proxy setups report same-site, and a directly-typed URL reports 'none'.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/fs/')) return
    const site = req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
      return reply.code(403).send({ error: 'cross-site request to /api/fs refused' })
    }
  })

  app.get<{ Querystring: { path?: string } }>('/api/fs/list', async (req): Promise<FsListResponse> => {
    // Default to the user's home; resolve relatives against it too.
    const home = homedir()
    const raw = req.query.path?.trim()
    const abs = raw ? (isAbsolute(raw) ? resolve(raw) : resolve(home, raw)) : home
    try {
      const entries = await listDir(abs)
      const parent = dirname(abs)
      return { path: abs, parent: parent === abs ? null : parent, entries }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // A file path (not a dir) is a common mistake — nudge toward its folder.
      return { error: /ENOTDIR/.test(msg) ? `Not a directory: ${abs}` : msg }
    }
  })

  // Read a file for in-app preview. `path` must be absolute (the browser always
  // has one from a prior list). Images/PDFs come back as data URLs; text capped.
  app.get<{ Querystring: { path?: string } }>('/api/fs/read', async (req): Promise<FilePreview> => {
    const raw = req.query.path?.trim()
    if (!raw) return { kind: 'error', name: '', message: 'path is required' }
    return readPreview(toAbs(raw))
  })

  // --- writes (POST) — back the in-app editor + create-file/folder actions. -----

  // Overwrite a file's contents (the editor's Save). Deliberately clobbers.
  app.post<{ Body: { path?: string; text?: string } }>('/api/fs/write', async (req): Promise<WriteResult> => {
    const { path, text } = req.body
    if (!path?.trim()) return { ok: false, error: 'path is required' }
    try { await writeFile(toAbs(path), text ?? '', 'utf8'); return { ok: true } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })

  // Create a new empty file; `wx` fails (rather than clobbers) if it already exists.
  app.post<{ Body: { path?: string } }>('/api/fs/createFile', async (req): Promise<WriteResult> => {
    const { path } = req.body
    if (!path?.trim()) return { ok: false, error: 'path is required' }
    try { await writeFile(toAbs(path), '', { flag: 'wx' }); return { ok: true } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })

  // Create a directory (recursive — parents made as needed, existing dir is a no-op).
  app.post<{ Body: { path?: string } }>('/api/fs/mkdir', async (req): Promise<WriteResult> => {
    const { path } = req.body
    if (!path?.trim()) return { ok: false, error: 'path is required' }
    try { await mkdir(toAbs(path), { recursive: true }); return { ok: true } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })

  // --- move / copy / delete — back the file-browser context actions. -----------

  // Rename or move a file/dir. Atomic within a filesystem; across devices Node's
  // rename throws EXDEV, so fall back to a recursive copy-then-remove. Refuses to
  // clobber an existing destination (rename/move should never silently overwrite).
  app.post<{ Body: { from?: string; to?: string } }>('/api/fs/rename', async (req): Promise<WriteResult> => {
    const { from, to } = req.body
    if (!from?.trim() || !to?.trim()) return { ok: false, error: 'from and to are required' }
    const src = toAbs(from), dst = toAbs(to)
    if (src === dst) return { ok: true }
    try {
      if (await exists(dst)) return { ok: false, error: `already exists: ${basename(dst)}` }
      try { await rename(src, dst) }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EXDEV') { await cp(src, dst, { recursive: true }); await rm(src, { recursive: true }) }
        else throw e
      }
      return { ok: true }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })

  // Copy a file or directory (recursive). Refuses to overwrite an existing target.
  app.post<{ Body: { from?: string; to?: string } }>('/api/fs/copy', async (req): Promise<WriteResult> => {
    const { from, to } = req.body
    if (!from?.trim() || !to?.trim()) return { ok: false, error: 'from and to are required' }
    const src = toAbs(from), dst = toAbs(to)
    try {
      if (await exists(dst)) return { ok: false, error: `already exists: ${basename(dst)}` }
      await cp(src, dst, { recursive: true, errorOnExist: true, force: false })
      return { ok: true }
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })

  // Delete a file or directory (recursive). Guards the obvious catastrophes ('/'
  // and $HOME); everything else is fair game on this single-user local tool.
  app.post<{ Body: { path?: string } }>('/api/fs/delete', async (req): Promise<WriteResult> => {
    const raw = req.body.path
    if (!raw?.trim()) return { ok: false, error: 'path is required' }
    const abs = toAbs(raw)
    if (abs === '/' || abs === homedir()) return { ok: false, error: 'refusing to delete this directory' }
    try { await rm(abs, { recursive: true, force: false }); return { ok: true } }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
  })

  // Stream a file to the browser as a download (Content-Disposition: attachment).
  // Same-origin GET → the auth cookie rides along, so a plain <a href> works.
  app.get<{ Querystring: { path?: string } }>('/api/fs/download', async (req, reply) => {
    const raw = req.query.path?.trim()
    if (!raw) { reply.code(400); return { error: 'path is required' } }
    const abs = toAbs(raw)
    try {
      const s = await stat(abs)
      if (s.isDirectory()) { reply.code(400); return { error: 'cannot download a directory' } }
      const safe = basename(abs).replace(/["\\\r\n]/g, '_')
      reply.header('Content-Disposition', `attachment; filename="${safe}"`)
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Length', s.size)
      return reply.send(createReadStream(abs))
    } catch (e) { reply.code(404); return { error: e instanceof Error ? e.message : String(e) } }
  })
}
