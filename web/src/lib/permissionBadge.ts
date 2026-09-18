// Should the sidebar shout about this session's permission mode?
//
// ★ WHY THIS EXISTS, AND WHY IT IS A MITIGATION RATHER THAN A FIX.
// A user found a teammate session running in "allow all" that they had never granted. The
// actual defect is server-side: `restore()` replays a persisted `permissionMode` verbatim with
// `/* trusted */ true`, so an elevated mode survives a restart without anyone re-approving it
// — measured, 3 of 4 restored sessions came back elevated. That must be fixed where it
// happens, and this file does not fix it.
//
// What this closes is the second half of the complaint: **they did not know.** The mode was
// only ever visible once you OPENED a session — the composer's mode control, the permissions
// panel, the session-info dialog. Nothing in the session LIST said anything, so a session
// sitting in allow-all looked exactly like a session that was not. A privilege that is
// invisible until you go looking is one nobody audits.
//
// The rule is deliberately about ELEVATION, not about a named mode: these are exactly the two
// values `setPermissionMode` refuses from an untrusted caller, which is the server's own
// definition of "a privilege only the operator may grant". Keying on that keeps the two in
// agreement rather than having the UI maintain a second opinion about what counts as risky.
import { isElevatedMode, type PermissionMode } from '@claudette/shared'

// 'default' and 'plan' only ever RAISE prompting, so neither is a privilege and neither is
// worth a warning. Marking them would train the user to ignore the badge, which costs exactly
// the attention the two modes below need.
// ★ DELEGATES to shared's isElevatedMode rather than restating the comparison. This was the
// FOURTH independent copy of `mode === 'bypassPermissions' || mode === 'acceptEdits'`, and the
// only one in the browser — so a fifth elevated mode would have gone unwarned in the sidebar
// as well as undowngraded on the server, with nothing failing to compile anywhere. The shared
// version is an exhaustive Record, so the union growing is a build failure there.
// Kept as a named re-export rather than deleted: this module is the UI's vocabulary for
// permission risk, and its callers read better asking `isElevated(mode)`.
export function isElevated(mode: PermissionMode | undefined): boolean {
  return isElevatedMode(mode)
}

// What the badge says. Two distinct words, because the two modes are not equally dangerous and
// collapsing them would misreport one of them: `bypassPermissions` runs EVERY tool unasked,
// while `acceptEdits` only auto-approves file edits and still prompts for the rest.
export function elevationLabel(mode: PermissionMode | undefined): { glyph: string; title: string } | null {
  if (mode === 'bypassPermissions') {
    return { glyph: '!', title: 'Allow all — this session runs every tool without asking. You did not have to approve each one.' }
  }
  if (mode === 'acceptEdits') {
    return { glyph: '~', title: 'Auto-edit — this session applies file edits without asking.' }
  }
  return null
}
