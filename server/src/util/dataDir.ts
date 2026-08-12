import path from 'path'
import os from 'os'
import { existsSync, mkdirSync, renameSync, readdirSync, lstatSync, writeFileSync, rmSync, cpSync } from 'fs'

// THE single definition of where Claudette keeps its own state — the session roster
// (sessionPersistence), the config-exposure ledger + scrubbed host-mode config mirrors
// (configProtection), and role handover notes (teamNotes).
//
// WHY ~/.config AND NOT ~/.claude: every sandboxed session rw-binds the Claude config dir
// (`~/.claude`) so claude can write its credentials and config at runtime — and a bind
// brings the WHOLE subtree. While this state lived at `~/.claude/claudette` it was
// therefore readable and writable from inside every box, which quietly defeated several
// guarantees enforced nowhere else:
//   * `sessions.json` is replayed at boot by SessionManager.restore() as TRUSTED, so a box
//     that edited its own entry could grant itself `teamEmploy: true` or
//     `sandbox: {enabled:false}` and come back unconfined after a restart — bypassing the
//     refusals in setTeamEmploy / normalizeSandbox that exist precisely to stop that.
//   * `exposed-configs.json` is the hook-poisoning ledger; a box could delete its own taint
//     entry so the next host-mode session got the REAL config instead of the scrubbed
//     mirror, re-opening the cross-session hook→host-exec path.
//   * `team-notes/` is injected verbatim into a new teammate's first turn, so a box could
//     plant instructions for a future session in another team.
// `~/.config` is never bind-mounted into a session sandbox — the loopback auth token
// already lives there for exactly this reason (auth.ts tokenFilePath). Putting the rest of
// our state beside it is what makes those guarantees true rather than merely documented.
// See SANDBOX.md.
//
// `CLAUDETTE_DATA_DIR` still overrides everything (tests use it to isolate).

const LEGACY_DIR = (): string => path.join(os.homedir(), '.claude', 'claudette')

function configuredDir(): string {
  const override = process.env.CLAUDETTE_DATA_DIR?.trim()
  if (override) return override
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config')
  return path.join(base, 'claudette')
}

// Marker written into the NEW dir once migration has been attempted. Its existence is what
// makes this a strictly ONE-TIME upgrade step, and that matters far more than it looks.
//
// The legacy dir lives inside `~/.claude`, which every box binds rw — so a confined session
// can recreate it at any time and plant whatever it likes. Migrating on every boot would be
// a standing invitation: plant, wait for a restart, and the server adopts it into the
// trusted location. Looking at that path exactly once, ever, closes the door permanently
// instead of for one boot.
const MIGRATED_MARKER = '.migrated-from-claude-dir'

// Migrate state left at the old in-mount location. Best-effort: a failed migration must
// never stop the server booting — worst case some sessions aren't restored, which is
// recoverable, unlike crashing on startup.
//
// Deliberately a MOVE, not a copy: leaving a readable duplicate inside the sandbox mount
// would preserve the very exposure this relocation exists to close.
let migrated = false
function migrateLegacy(target: string): void {
  if (migrated) return
  // An explicit override means the operator (or a test) chose the location; don't drag
  // unrelated machine state into it. Checked BEFORE the flag is set, so a later call
  // without the override still gets its chance.
  if (process.env.CLAUDETTE_DATA_DIR?.trim()) return
  migrated = true
  const legacy = LEGACY_DIR()
  if (path.resolve(legacy) === path.resolve(target)) return
  try {
    mkdirSync(target, { recursive: true })
    const marker = path.join(target, MIGRATED_MARKER)
    if (existsSync(marker)) return                                   // done once; never look again
    if (!existsSync(legacy)) { writeFileSync(marker, ''); return }   // fresh install; record it

    let moved = 0
    const failed: string[] = []
    const refused: string[] = []
    for (const entry of readdirSync(legacy)) {
      const from = path.join(legacy, entry)
      const to = path.join(target, entry)
      // REFUSE SYMLINKS. The legacy dir was writable from inside every sandbox, so a
      // confined session could have left `sessions.json` (replayed at boot as trusted) or
      // `host-scrubbed-config/` (a host-mode session's CLAUDE_CONFIG_DIR, i.e. hooks that
      // run unsandboxed) as a link to something it still controls. renameSync moves the
      // LINK, not its target, so a naive migration carries the exposure into the trusted
      // location rather than ending it — and existsSync() follows links, so it cannot be
      // used to detect this. lstat is the only thing that sees the difference.
      try {
        if (lstatSync(from).isSymbolicLink()) { refused.push(entry); continue }
      } catch { failed.push(entry); continue }
      if (existsSync(to)) continue          // never clobber state already at the new home
      try {
        renameSync(from, to)
      } catch (e) {
        // Different filesystems (a symlinked ~/.claude, separate mounts) fail with EXDEV.
        // Copy-then-remove reaches the same end state; anything else is a real error.
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') { failed.push(entry); continue }
        try {
          cpSync(from, to, { recursive: true, dereference: false })
          rmSync(from, { recursive: true, force: true })
        } catch { failed.push(entry); continue }
      }
      moved++
    }

    if (refused.length) {
      console.warn(`[claudette] REFUSED to migrate symlinked entries from ${legacy}: ${refused.join(', ')} — `
        + 'a symlink there is a sign of tampering (that directory was writable from inside every sandbox). '
        + 'They are NOT in use; inspect them, then delete the directory by hand.')
    }
    if (failed.length) {
      console.warn(`[claudette] could not migrate ${failed.join(', ')} out of ${legacy} — `
        + 'that state remains in a sandbox-readable location. Move it by hand.')
    }
    // Report what HAPPENED, not what was attempted: the previous version logged success
    // unconditionally, so a migration that moved nothing at all (EXDEV, permissions) told
    // the operator their state was safe when every byte was still in the mount.
    if (moved) {
      console.log(`[claudette] moved ${moved} item(s) out of ${legacy} → ${target} (the old location sat inside every sandbox mount — see SANDBOX.md)`)
    }
    // Only close the door when nothing was left behind. A refused symlink must stay put for
    // the operator to inspect, and a dir still holding real state must not be deleted — in
    // either case we also leave the marker off, so the next boot retries.
    if (!failed.length && !refused.length) {
      try { rmSync(legacy, { recursive: true, force: true }) } catch { /* an empty dir left behind is harmless */ }
      writeFileSync(marker, '')
    }
  } catch (e) {
    console.warn(`[claudette] could not migrate state out of ${legacy}:`, e)
  }
}

export function dataDir(): string {
  const dir = configuredDir()
  migrateLegacy(dir)
  return dir
}
