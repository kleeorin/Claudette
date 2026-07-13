// Remote paths travel through the whole fs/git IPC surface as plain strings, so
// we encode the owning remote directly in the path — VS Code style — instead of
// threading a separate remoteId argument through ~25 handlers:
//
//   remote://<remoteId>/home/user/proj   ⇢  { remoteId, path: '/home/user/proj' }
//   /home/user/proj                       ⇢  { remoteId: null, path: '/home/user/proj' }
//
// The scheme is deliberately chosen so POSIX path ops used on both sides
// (dirname/basename/join) keep working on the encoded string:
//   dirname('remote://id/a/b') === 'remote://id/a'
//   join('remote://id/a', 'x') === 'remote://id/a/x'
//
// Lives in shared/ so both the main process (fs/git/session routing) and the
// renderer (notebook kernels, path display) use the exact same encoding.

const PREFIX = 'remote://'

export function isRemote(p: string): boolean {
  return p.startsWith(PREFIX)
}

// Split an encoded path into its remote id and the clean absolute remote path.
// Local paths pass through unchanged with remoteId === null.
export function parseTarget(p: string): { remoteId: string | null; path: string } {
  if (!isRemote(p)) return { remoteId: null, path: p }
  const rest = p.slice(PREFIX.length)          // "<id>/abs/path" or just "<id>"
  const slash = rest.indexOf('/')
  if (slash === -1) return { remoteId: rest, path: '/' }
  return { remoteId: rest.slice(0, slash), path: rest.slice(slash) }
}

// Encode an absolute remote path under a remote id.
export function makeRemotePath(remoteId: string, absPath: string): string {
  const abs = absPath.startsWith('/') ? absPath : `/${absPath}`
  return `${PREFIX}${remoteId}${abs}`
}
