import type { SandboxConfig, SandboxDefaultFolder, SandboxMount } from '@claudette/shared'

// What a NEW session's sandbox picker starts with — pure, so tested (newSessionSandbox.test.ts);
// nothing imports App.tsx.
//
// Precedence: (explicit edits in the dialog, which replace this seed) > the PROJECT's default
// sandbox > the starred folders, when AppSettings.starredFoldersInNewSessions is on > built-in.
//
// ★ THE STARS ARE A CLIENT-SIDE PREFILL, NOT A SERVER RULE. The operator sees every starred mount
// in the dialog before Create, and the create request carries them explicitly through the
// auth-gated route. The server never consults the star list on create/restore (see
// sandboxDefaults.ts) — doing so would make it a confinement-widening channel.
// A star equal to the cwd is left out: the cwd is already the project mount the picker owns.
export type SandboxSeed =
  | { kind: 'builtin' }
  | { kind: 'stars'; extra: SandboxMount[] }
  | { kind: 'project'; config: SandboxConfig }

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)

export function sandboxSeed(o: { starsOn: boolean | undefined; starred: SandboxDefaultFolder[]; cwd: string; projectDefault?: SandboxConfig }): SandboxSeed {
  if (o.projectDefault) return { kind: 'project', config: structuredClone(o.projectDefault) }
  if (!o.starsOn) return { kind: 'builtin' }
  const cwd = trimSlash(o.cwd.trim())
  const seen = new Set<string>()
  const extra: SandboxMount[] = []
  for (const f of o.starred) {
    const p = trimSlash(f.path)
    if (p === cwd || seen.has(p)) continue
    seen.add(p)
    extra.push({ path: p, mode: f.mode })
  }
  return extra.length ? { kind: 'stars', extra } : { kind: 'builtin' }
}
