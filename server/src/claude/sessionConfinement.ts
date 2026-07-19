import { join } from 'path'
import type { SandboxConfig } from '@claudette/shared'
import { sandboxAvailable, sandboxPathAccess } from './sandbox'

// The single seam every server-side actor uses to confine work it does ON BEHALF OF a
// session (SANDBOX.md). It replaces the three copy-pasted
//   (sessionId) => s?.sandbox ? { cfg, cwd } : undefined
// resolvers whose shared `undefined`-means-run-on-host default was the fail-OPEN root
// cause behind the notebook-MCP, venv-probe, and unowned-kernel escapes: a session that
// couldn't be resolved (unknown id, missing owner, torn-down session) silently became
// "unconfined" instead of "denied".
//
// The fix is one decision type that DISTINGUISHES the two cases the old `undefined`
// conflated, and defaults the unresolved one to the most-restrictive branch.

// What the confinement logic needs to know about a session. `SessionManager.get(id)`
// already returns a superset of this (its SessionInfo), so the lookup is just `get`.
export interface SessionBox { sandbox?: SandboxConfig; cwd: string }

export type Confinement =
  // A known, sandbox-enabled session on a host that can actually sandbox.
  | { mode: 'confined'; cfg: SandboxConfig; cwd: string }
  // Legitimately unconfined: the operator opted this session out
  // (CLAUDETTE_ALLOW_UNSANDBOXED, normalized into sandbox.enabled=false), or the host
  // cannot create user namespaces at all (honest "sandbox unavailable" mode).
  | { mode: 'host' }
  // FAIL CLOSED: the session is unknown / unresolved. Its work must NEVER run on the
  // host — treat it as maximally confined (deny a file op; a data-mount-less box, or a
  // hard refusal, for an executor).
  | { mode: 'deny' }

// A box with the runtime baseline but NO data mounts: the fail-closed executor. It
// runs, but every user path is invisible and every write lands in throwaway tmpfs.
export const DENY_ALL_SANDBOX: SandboxConfig = { enabled: true, mounts: [] }

export class SessionConfinement {
  constructor(private lookup: (sessionId: string) => SessionBox | undefined) {}

  // Map a sessionId to its confinement. A missing id or an unknown session is `deny`
  // (fail closed); a resolved-but-not-sandboxed session (or a non-sandbox host) is
  // `host`; a resolved, sandbox-enabled session on a capable host is `confined`.
  resolve(sessionId: string | undefined): Confinement {
    const s = sessionId ? this.lookup(sessionId) : undefined
    if (!s) return { mode: 'deny' }
    if (!s.sandbox?.enabled || !sandboxAvailable()) return { mode: 'host' }
    return { mode: 'confined', cfg: s.sandbox, cwd: s.cwd }
  }

  // For IN-PROCESS handlers (the notebook MCP tools, and any future server-side file op
  // done for a session): may this session read/write this host path? `host` → yes (the
  // caller was already token-gated; single-user whole-FS by design); `deny` → no; a
  // `confined` session → only inside its mounts (rw for writes), symlinks canonicalized.
  authorizePath(sessionId: string | undefined, absPath: string, need: 'read' | 'write'): boolean {
    const c = this.resolve(sessionId)
    if (c.mode === 'host') return true
    if (c.mode === 'deny') return false
    const a = sandboxPathAccess(c.cfg, c.cwd, absPath)
    return need === 'write' ? a.write : a.read
  }

  // TOCTOU-safe variant (SANDBOX.md G1): authorize an I/O whose parent directory the caller
  // has ALREADY canonicalized to `realDir` (via a single `realpath(dirname)`), passing that
  // exact value on to the write/open as its swap-guard. Because the containment decision and
  // the guard derive from the SAME filesystem observation, there is no window in which the
  // parent could be relinked between "authorized" and "guard captured" — the gap the plain
  // `authorizePath` + a second realpath would leave. `realDir === null` (parent unresolvable)
  // ⇒ deny. `base` is the final component, joined onto the canonical dir (not re-resolved).
  authorizeResolved(sessionId: string | undefined, realDir: string | null, base: string, need: 'read' | 'write'): boolean {
    const c = this.resolve(sessionId)
    if (c.mode === 'host') return true
    if (c.mode === 'deny' || realDir === null) return false
    const a = sandboxPathAccess(c.cfg, c.cwd, join(realDir, base))
    return need === 'write' ? a.write : a.read
  }
}
