// The new-session dialog's working-directory field — pure, so it is tested (defaultCwd.test.ts);
// nothing imports App.tsx.
//
// PRECEDENCE: the project's cwd (a project-locked dialog), then the operator's default folder
// (AppSettings.defaultCwd), then $HOME.
//
// LATE ARRIVAL. homeDir comes from an async health probe and the default folder from an async
// settings fetch, in either order. Until the user touches the field it simply SHOWS the current
// best answer, so whichever arrives later still lands — including the default folder replacing
// an auto-filled $HOME, which a "fill only an empty field" rule would have lost whenever the
// probe won the race. Once the user edits (or picks via Browse) the field is theirs, and nothing
// arriving later changes it — even if they cleared it.
//
// A default folder deleted since it was saved (the server reports defaultCwdMissing) falls back
// to $HOME with a one-line note, rather than pre-filling a path that would fail on create.
export interface CwdFieldInput {
  edited: boolean           // the user has typed in / browsed for this field
  typed: string             // what they put there
  projectCwd?: string       // set for a "new session in project" dialog
  defaultCwd?: string       // AppSettings.defaultCwd (undefined until settings load, or unset)
  defaultCwdMissing?: boolean
  homeDir: string           // '' until the health probe answers
}

export function cwdField(s: CwdFieldInput): { value: string; note: string | null } {
  if (s.projectCwd) return { value: s.projectCwd, note: null }
  if (s.edited) return { value: s.typed, note: null }
  if (s.defaultCwd && !s.defaultCwdMissing) return { value: s.defaultCwd, note: null }
  if (s.defaultCwd) {
    return { value: s.homeDir, note: `Your default folder ${s.defaultCwd} no longer exists — starting in your home folder instead. Change it in Settings.` }
  }
  return { value: s.homeDir, note: null }
}
