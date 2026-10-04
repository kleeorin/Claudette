// The per-session model picker's DECISIONS, extracted from App.tsx.
//
// Same reason lib/sessionLights.ts and lib/bashProcLights.ts give in their own headers:
// NOTHING IN THIS REPO IMPORTS App.tsx, so a rule written inline at a JSX call site is
// invisible to the web suite, to typecheck and to every harness at once. Every rule here has a
// failure mode; the rendering stays in App.tsx.
import { MODEL_ALIASES, isCustomModel } from './settingsLogic'
import type { SessionState } from '@claudette/shared'

// What the picker should show as selected.
//
// Modelled as a discriminated union rather than "the string, or ''", because the three cases
// are genuinely different things to render: a cleared override (the account/role default), one
// of the known aliases, and a free-text full model id. Collapsing custom into "not an alias"
// loses the id itself, which is the one the user typed and the whole reason the field exists.
export type ModelChoice =
  | { kind: 'default' }
  | { kind: 'alias'; alias: string }
  | { kind: 'custom'; id: string }

// ★ `undefined` AND EMPTY-ISH BOTH MEAN "ACCOUNT DEFAULT", because that is what the server
// does: setModel() trims and treats a blank as `undefined`. If this disagreed, a user who
// cleared the field would see "custom: ''" marked as current while the server had cleared the
// override — the control would describe a state the server was not in.
export function currentModelChoice(model: string | undefined): ModelChoice {
  const v = model?.trim()
  if (!v) return { kind: 'default' }
  return isCustomModel(v) ? { kind: 'custom', id: v } : { kind: 'alias', alias: v }
}

// One row in the picker. Deliberately a union rather than a string, because the custom row is
// not named by a value: it is "whatever the free-text field holds", and giving it a string
// would invite comparing the ✓ against that text — which is the bug isSelected exists to make
// impossible (see below).
export type ModelRow =
  | { kind: 'default' }
  | { kind: 'alias'; alias: string }
  | { kind: 'custom' }

// Which row carries the ✓.
//
// ★ THE CUSTOM ROW'S TICK DEPENDS ON THE SESSION'S MODEL, NEVER ON THE TYPED TEXT.
// The free-text field is editable: a user types a new id and, until they press Enter, the
// session is still on whatever it was. A tick keyed on the field's contents would move the
// moment they started typing, telling them the session had changed when nothing had been
// sent. So this compares against `choice` — derived from `session.model` — and takes no
// argument for the field at all, which makes the wrong version unwriteable rather than merely
// discouraged.
//
// Extracted from App.tsx because three inline `choice.kind === …` conditions lived at the call
// site with no test anywhere, and NOTHING IN THIS REPO IMPORTS App.tsx.
export function isSelected(choice: ModelChoice, row: ModelRow): boolean {
  switch (row.kind) {
    case 'default': return choice.kind === 'default'
    case 'alias': return choice.kind === 'alias' && choice.alias === row.alias
    case 'custom': return choice.kind === 'custom'
    default: {
      const _exhaustive: never = row
      void _exhaustive
      return false
    }
  }
}

// What the free-text field should start with when the menu opens.
//
// ★ EMPTY UNLESS THE SESSION IS ACTUALLY ON A CUSTOM ID. Seeding it from `session.model`
// unconditionally put `sonnet` in a box labelled "Full model id" — an alias is not a full id,
// and the field then looked like it was holding a value the user had typed. Worse, pressing
// Enter on it would re-post the alias through the custom path.
export function seedCustomId(model: string | undefined): string {
  const c = currentModelChoice(model)
  return c.kind === 'custom' ? c.id : ''
}

// Is this pick a no-op? The role picker one line above guards `if (id !== roleId)`; this is the
// same guard for the model, and it has to normalise both sides because `undefined`, `''` and
// `'  '` are all "account default" to the server. Without normalising, clearing an
// already-cleared override would post, and the server would answer a no-op success — harmless
// but a request that says something changed when nothing did.
export function isSameModel(current: string | undefined, next: string | undefined): boolean {
  return (current?.trim() || undefined) === (next?.trim() || undefined)
}

// The aliases offered, straight from settingsLogic — NOT re-listed here. A second copy would
// drift the moment a model family is added, and the picker would quietly stop offering it
// while the settings panel still did.
export const MODEL_OPTIONS: readonly string[] = MODEL_ALIASES

// Normalise what the free-text field submits, mirroring the server's own rule so the two
// cannot disagree. Blank or whitespace-only clears the override rather than setting a model
// whose name is a space.
export function normalizeModelInput(raw: string): string | undefined {
  const v = raw.trim()
  return v ? v : undefined
}

// What to say, and whether to offer "apply now", when the requested model differs from the one
// the running engine was spawned with.
//
// ★★ THE KEY DIFFERENCE FROM THE SANDBOX PENDING BANNER, AND WHY THIS IS NOT THAT GRAMMAR.
// A pending SANDBOX change is auto-applied by the server the moment the session goes idle, so
// its idle text is "Applying changes…" — something is happening. A pending MODEL change is
// not: `--model` is a spawn argument, and the server applies it by relaunching inside the NEXT
// SEND (applyModelForTurn, called from session:send). So while idle nothing is in flight, and
// saying "Applying…" would assert activity that is not occurring. It applies when the user
// next sends something.
//
// ★ AND APPLY-NOW IS A RESTART. relaunchApply replaces the engine, which ENDS A RUNNING TURN.
// Offering it mid-turn without saying so would let a user lose work to a button they read as
// "make it take effect sooner". So the warning is part of the returned value, not an optional
// decoration the call site may forget: a caller that renders `label` has already rendered it.
export interface ModelPendingNotice {
  text: string
  /** Whether to offer the apply-now control at all. */
  applyNow: boolean
  /** The apply-now label, carrying the consequence for the CURRENT state. */
  label: string
  /** True when applying now would end a turn in progress. */
  interrupts: boolean
}

export function modelPendingNotice(pending: boolean, state: SessionState): ModelPendingNotice | null {
  if (!pending) return null
  const running = state === 'running' || state === 'waiting'
  return running
    ? {
      text: 'Applies to your next message.',
      applyNow: true,
      // Spelled out, not "Apply now": this one ends the turn that is running.
      label: 'Apply now (ends this turn)',
      interrupts: true,
    }
    : {
      text: 'Applies to your next message.',
      applyNow: true,
      // Idle: a restart costs nothing in progress, so the label stays plain.
      label: 'Apply now',
      interrupts: false,
    }
}
