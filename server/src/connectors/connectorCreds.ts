import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, statSync, unlinkSync } from 'fs'
import path from 'path'
import { dataDir } from '../util/dataDir'
import { errMessage } from '../util/errMessage'

// OAuth tokens for catalog connectors: the refresh tokens that let a connector keep working
// after its one-hour access token expires, and the access tokens themselves.
//
// THE MOST SENSITIVE FILE CLAUDETTE WRITES. A refresh token is a long-lived bearer for the
// operator's Google account — mail, drive, calendar — and unlike an access token it does not
// expire on its own. So the governing question is not "is it encrypted" (it cannot be; we must
// present it to the token endpoint) but "who can read the file".
//
// WHY dataDir(), ARGUED BY REACHABILITY RATHER THAN BY INSPECTION. dataDir() is
// ~/.config/claudette. Every sandboxed session rw-binds the Claude config dir (~/.claude) and a
// bind carries the whole subtree, which is why Claudette's own state was moved out of there
// (util/dataDir.ts). The property that matters is not "I read the mount list and did not see
// it" — that goes stale the moment someone edits a mount list. It is that dataDir() reaches the
// sandbox code in exactly ONE place, and that place is the DENY side:
//   · sandbox.ts stateDirsToHide() = [resolve(dataDir()), dirname(tokenFilePath())] — VERIFIED
//     to be the only occurrence of dataDir() in sandbox.ts / sandboxPaths.ts;
//   · sandboxPathAccess() refuses any path under those dirs, so the authorizer says no even if
//     something else says yes;
//   · hiddenStateDests() goes further than absence: for every mount that WOULD expose the dir
//     it computes where the box would see it and overlays an empty tmpfs there. So a user who
//     mounts a parent of ~/.config (their whole home, say) does not thereby expose the tokens —
//     the overlay lands on top of the broader bind.
// The check that keeps this true is therefore a grep: does dataDir() appear in sandbox.ts
// anywhere other than stateDirsToHide()? If it ever does — in a mount list rather than the hide
// list — this comment is the thing that was wrong, and every stored refresh token is readable
// from inside a confined session.
//
// Written 0600 via tmp + rename + explicit chmod, matching connectorStore.ts.

// A single stored grant. Deliberately NOT keyed by connector alone.
export interface ConnectorToken {
  connectorId: string
  // WHICH ACCOUNT CONSENTED. One Google OAuth client serves Drive, Docs, Sheets, Calendar and
  // Gmail, but a token belongs to a (client, user, scope-set) consent — so keying by connector
  // alone is wrong the moment a second person authorizes on the same install: the second
  // consent silently overwrites the first, and the first user's session starts acting as the
  // second user with no visible change. Cheap to carry now; a migration once tokens exist.
  // The provider's own account identifier when it tells us one, else 'default'.
  account: string
  accessToken: string          // SECRET
  refreshToken?: string        // SECRET, long-lived — absent when the provider issued none
  // Absolute epoch MILLISECONDS. Stored as an instant, not a duration: `expires_in` is relative
  // to a moment that has already passed by the time anyone reads the file back.
  expiresAt?: number
  scopes: string[]             // what this token was actually granted, per the token response
  obtainedAt: number
}

interface Creds { tokens: ConnectorToken[] }

const file = (): string => path.join(dataDir(), 'connector-creds.json')

let cache: Creds | null = null

// The composite key. One function so a reader and a writer cannot disagree about what "the
// same grant" means.
const keyOf = (connectorId: string, account: string): string => `${connectorId} ${account}`

// Validate on LOAD, not only on save — the lesson from sandboxDefaults, and it bites harder
// here. A row with a non-string accessToken reaches the proxy and becomes
// `Authorization: Bearer undefined`, which an upstream answers with a 401 indistinguishable
// from an expired token, sending whoever debugs it to re-authorize instead of to this file.
// Note what is NOT done: nothing here is canonicalised. These are opaque provider strings, and
// "helpfully" trimming or normalising a token is how you send a credential that is almost right.
function isToken(x: unknown): x is ConnectorToken {
  if (!x || typeof x !== 'object') return false
  const t = x as Record<string, unknown>
  if (typeof t.connectorId !== 'string' || !t.connectorId.trim()) return false
  if (typeof t.account !== 'string' || !t.account.trim()) return false
  if (typeof t.accessToken !== 'string' || !t.accessToken) return false
  if (t.refreshToken !== undefined && typeof t.refreshToken !== 'string') return false
  if (t.expiresAt !== undefined && typeof t.expiresAt !== 'number') return false
  if (typeof t.obtainedAt !== 'number') return false
  return Array.isArray(t.scopes) && t.scopes.every((s) => typeof s === 'string')
}

function load(): Creds {
  if (cache) return cache
  try {
    const p = file()
    if (!existsSync(p)) return (cache = { tokens: [] })
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<Creds>
    const raw: unknown[] = Array.isArray(parsed.tokens) ? parsed.tokens : []
    const tokens = raw.filter(isToken)
    if (tokens.length !== raw.length) {
      // COUNT ONLY, never the row. Every field that would identify which grant was dropped sits
      // in the same object as the secret, and this line goes to a log that is not 0600.
      console.warn(`[connector-creds] dropped ${raw.length - tokens.length} malformed token row(s) — `
        + 're-authorize the affected connector; other connectors are unaffected.')
    }
    cache = { tokens }
    return cache
  } catch (e) {
    // MOVE THE UNREADABLE FILE ASIDE before starting empty. Same reasoning as sandboxDefaults,
    // at a higher price: starting empty caches {tokens: []}, so the next successful
    // authorization persists over the file and destroys every OTHER account's refresh token
    // with it. One re-auth is an inconvenience; five silent ones, discovered days apart as each
    // connector separately stops working, is not. The bytes are also often still usable by
    // hand — a half-written JSON file usually still contains whole tokens.
    const p = file()
    let kept = ''
    try {
      if (existsSync(p)) {
        let dest = `${p}.${Math.floor(statSync(p).mtimeMs)}.corrupt`
        for (let n = 2; existsSync(dest); n++) dest = `${p}.${Math.floor(statSync(p).mtimeMs)}-${n}.corrupt`
        renameSync(p, dest)
        chmodSync(dest, 0o600)   // it still holds refresh tokens; rename preserves mode, this is belt and braces
        kept = ` The unreadable file has been kept as ${dest} (0600 — it may hold recoverable refresh tokens).`
      }
    } catch (moveErr) {
      kept = ` It could NOT be moved aside (${errMessage(moveErr)}), so the next authorization will overwrite it.`
    }
    console.error(`[connector-creds] could not read stored tokens, starting empty: ${errMessage(e)}.${kept}`)
    return (cache = { tokens: [] })
  }
}

function persist(c: Creds): void {
  const p = file()
  const tmp = `${p}.tmp`
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 })
  chmodSync(tmp, 0o600)   // explicit: a pre-existing tmp would keep its old mode
  renameSync(tmp, p)
  cache = c
}

// --- reads ---------------------------------------------------------------------------

export function getToken(connectorId: string, account = 'default'): ConnectorToken | undefined {
  const k = keyOf(connectorId, account)
  return load().tokens.find((t) => keyOf(t.connectorId, t.account) === k)
}

// Every account that has authorized this connector. For the UI, which must be able to say
// WHICH account is connected rather than merely that one is.
export function accountsFor(connectorId: string): string[] {
  return load().tokens.filter((t) => t.connectorId === connectorId).map((t) => t.account)
}

export function hasToken(connectorId: string): boolean {
  return load().tokens.some((t) => t.connectorId === connectorId)
}

// --- writes --------------------------------------------------------------------------

// Upsert by (connector, account), keeping list position so the file does not churn.
//
// REFRESH TOKEN IS OMIT-MEANS-KEEP, the same rule connectorStore applies to secrets. A refresh
// RESPONSE routinely omits refresh_token because the old one stays valid, so writing the
// response through verbatim would erase the only long-lived credential we hold and turn the
// next expiry into a silent re-auth prompt.
export function saveToken(t: ConnectorToken): ConnectorToken {
  const c = load()
  const k = keyOf(t.connectorId, t.account)
  const i = c.tokens.findIndex((x) => keyOf(x.connectorId, x.account) === k)
  const merged: ConnectorToken = i >= 0
    ? { ...c.tokens[i], ...t, refreshToken: t.refreshToken ?? c.tokens[i].refreshToken }
    : t
  const tokens = i >= 0 ? c.tokens.map((x, n) => (n === i ? merged : x)) : [...c.tokens, merged]
  persist({ tokens })
  return merged
}

// Forget one grant, or every grant for a connector when no account is named. Returns how many
// were removed, so a caller can tell "revoked" from "there was nothing there".
//
// NB this only forgets OUR copy. It does not tell the provider, so the grant stays live in the
// user's Google account until they revoke it there. UI wording must not claim otherwise.
export function removeToken(connectorId: string, account?: string): number {
  const c = load()
  const before = c.tokens.length
  const tokens = c.tokens.filter((t) => t.connectorId !== connectorId
    || (account !== undefined && t.account !== account))
  if (tokens.length !== before) persist({ tokens })
  return before - tokens.length
}

// Test seam, matching resetConnectorCache / resetSandboxDefaultsCache.
export function resetConnectorCredsCache(): void { cache = null }

// Only used by tests that created a store under a CLAUDETTE_DATA_DIR override.
export function deleteCredsFile(): void {
  try { unlinkSync(file()) } catch { /* nothing to remove */ }
  resetConnectorCredsCache()
}
