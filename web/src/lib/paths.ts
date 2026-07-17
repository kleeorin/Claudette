// Small POSIX-path helpers shared across the web UI (file browsers, tab labels,
// tool-arg formatting). Paths here are the server's absolute POSIX paths, not
// the remote-encoded form (see shared/remotePath for that).

// Last path segment, e.g. "/a/b/c.py" → "c.py". Falls back to the whole string
// when there's no separator.
export const basename = (p: string): string => p.split('/').pop() || p

// Join a directory and a name into an absolute path, avoiding a doubled root "/".
export const joinPath = (dir: string, name: string): string =>
  dir === '/' ? `/${name}` : `${dir}/${name}`

// Does this filename look like a notebook?
export const isNotebookPath = (name: string): boolean => name.endsWith('.ipynb')

// Shorten a home path to `~/…` for compact display (sidebar, chips, cwd labels).
export const prettyPath = (p: string): string => p.replace(/^\/home\/[^/]+/, '~')

// Cumulative breadcrumb segments for an absolute POSIX dir, root first.
export function crumbs(dir: string): Array<{ label: string; path: string }> {
  const parts = dir.split('/').filter(Boolean)
  const out = [{ label: '/', path: '/' }]
  let acc = ''
  for (const p of parts) { acc += `/${p}`; out.push({ label: p, path: acc }) }
  return out
}
