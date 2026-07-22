import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { claudeConfigDir } from './sandbox'
import { errMessage } from '../util/errMessage'

// Workspace trust (mirrors Claude Code's native trust dialog). Claude gates a project's
// `.claude/settings.local.json` `permissions.allow` entries behind a per-project flag —
// `projects[<resolved cwd>].hasTrustDialogAccepted` in `.claude.json`. Until the folder
// is trusted those entries are ignored and Claude warns "…this workspace has not been
// trusted." Natively you clear this by running `claude` in the folder and accepting the
// prompt; Claudette surfaces the same prompt at session creation and writes the flag here.
//
// Two `.claude.json` files can diverge and both matter depending on how a session runs:
//   • <configDir>/.claude.json — read by SANDBOXED sessions (sandbox.ts points
//     CLAUDE_CONFIG_DIR at claudeConfigDir()) and by the scrubbed host-mode mirror
//     (which symlinks .claude.json back here). This is the canonical file for Claudette.
//   • $HOME/.claude.json — read by a plain non-sandboxed session.
// We READ the canonical one and WRITE both, so the flag is honoured in every mode.

// The .claude.json files to write the trust flag into. De-duped: when CLAUDE_CONFIG_DIR
// is unset (or equals $HOME) both entries resolve to the same path.
function claudeJsonPaths(): string[] {
  const paths = [
    path.join(claudeConfigDir(), '.claude.json'),
    path.join(homedir(), '.claude.json'),
  ]
  return [...new Set(paths.map((p) => path.resolve(p)))]
}

// The canonical file a Claudette session reads its trust from (see header).
function canonicalClaudeJson(): string {
  return path.join(claudeConfigDir(), '.claude.json')
}

// Is `cwd` trusted? Keyed by the resolved absolute path, matching how Claude stores it.
export function isTrusted(cwd: string): boolean {
  try {
    const p = canonicalClaudeJson()
    if (!existsSync(p)) return false
    const d = JSON.parse(readFileSync(p, 'utf8'))
    const entry = d?.projects?.[path.resolve(cwd)]
    return entry?.hasTrustDialogAccepted === true
  } catch {
    return false
  }
}

// Mark `cwd` trusted in every .claude.json (best-effort per file so one bad path can't
// block the other). Preserves all other keys on the project entry and in the file.
export function setTrusted(cwd: string): void {
  const key = path.resolve(cwd)
  for (const p of claudeJsonPaths()) {
    try {
      const d = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
      if (!d.projects || typeof d.projects !== 'object') d.projects = {}
      if (!d.projects[key] || typeof d.projects[key] !== 'object') d.projects[key] = {}
      d.projects[key].hasTrustDialogAccepted = true
      writeFileSync(p, JSON.stringify(d, null, 2), 'utf8')
    } catch (e) {
      console.warn(`[trust] could not update ${p}: ${errMessage(e)}`)
    }
  }
}
