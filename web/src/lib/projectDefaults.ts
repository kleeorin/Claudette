import type { PermissionMode, ProjectInfo, SandboxConfig } from '@claudette/shared'
import { PERMISSION_MODES, isElevatedMode } from '@claudette/shared'

// PROJECT DEFAULTS in the new-session-in-project dialog — pure, so tested
// (projectDefaults.test.ts); nothing imports App.tsx.
//
// The server applies, per field: explicit request > project default > app setting > built-in.
// The dialog makes the project default VISIBLE before Create rather than leaving it implicit:
// the sandbox picker is seeded from it (enabled:false included) and the mode select shows it,
// red when elevated. A project default is therefore always SENT explicitly; with none, the mode
// is omitted unless the user picks one, so the app-setting fallback still applies.

export function dialogPrefill(project: ProjectInfo | undefined): { sandbox: SandboxConfig | undefined; mode: PermissionMode | undefined; elevated: boolean } {
  const d = project?.defaults
  const mode = d?.permissionMode
  return {
    // A copy: the dialog edits it, and the project record must stay what the server sent.
    sandbox: d?.sandbox ? structuredClone(d.sandbox) : undefined,
    mode,
    elevated: isElevatedMode(mode),
  }
}

export function modeToSend(s: { projectDefault: PermissionMode | undefined; chosen: PermissionMode | undefined; touched: boolean }): PermissionMode | undefined {
  return s.touched ? s.chosen : s.projectDefault
}

const LABELS: Record<PermissionMode, string> = {
  default: 'ask each time',
  acceptEdits: 'auto-accept edits',
  plan: 'plan only',
  bypassPermissions: 'bypass permissions',
}

// The select's options. "App default" (value '') is offered only when the project has NO mode
// default: with one, omitting the field would fall back to the PROJECT default, not the app
// setting, so the option would lie about what it does.
export function modeOptions(projectDefault: PermissionMode | undefined): { value: PermissionMode | ''; label: string }[] {
  const modes = PERMISSION_MODES.map((m) => ({ value: m, label: LABELS[m] }))
  return projectDefault ? modes : [{ value: '', label: 'app default' }, ...modes]
}
