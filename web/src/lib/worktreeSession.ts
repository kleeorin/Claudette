// Isolated (git worktree) sessions — the client-side pieces that are pure and therefore tested
// (worktreeSession.test.ts); nothing imports App.tsx, so rules written inline there would be
// tested by nothing.

// The branch-name field's default: a slug of the session name. MIRRORS slugify() in
// server/src/git/worktrees.ts — the server re-derives the same slug for the worktree dir when
// the field is left as-is, so the two must agree or the dialog would preview a name it does
// not get.
export function slugify(name: string): string {
  const s = (name ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return s || 'session'
}

// Why the "Isolated (git worktree)" option is unavailable, or null when it can be ticked.
// `repo` is /api/project/repoStatus's answer; undefined while it is still loading.
export function isolatedUnavailableReason(repo: { hasCommit: boolean } | null | undefined): string | null {
  if (repo === undefined) return 'Checking the project’s git repository…'
  if (repo === null) return 'The project folder is not inside a git repository.'
  if (!repo.hasCommit) return 'The repository has no commits yet — a worktree needs one to branch from.'
  return null
}
