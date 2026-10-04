// SettingsPanel — the DOM wiring the pure tests cannot reach: that an env override actually
// DISABLES its control, that the environment panel offers nothing editable, and that saving a
// model sends the alias rather than a preselected default.
//
// ★ STRUCTURAL ASSERTIONS ONLY — `data-setting`, `data-locked-by`, `aria-disabled`, `disabled`,
// roles and labels. No Tailwind classes, and no negated assertion on a message copied from the
// component: that goes green the moment someone rewords the thing it was guarding.
//
// MUTATIONS (measured 2026-09-08) with `ran=N`, because a crashed mutant produces zero
// failures exactly like a clean pass:
// All measured at ran=18 — constant across every mutation, which is what shows none crashed
// rather than failing. Each reds ALONE unless noted.
//   T1  Row ignores `locked` and never disables its children
//       → the override-disables case reds.
//   T2  Row drops the `data-locked-by` attribute
//       → the same case reds, on its other assertion. Worth knowing that T1 and T2 land on
//         ONE test: it asserts both that the control is disabled and that the variable is
//         named, because either alone is a half-answer to "why can't I edit this?".
//   T3  the model buttons preselect 'opus' when settings.defaultModel is absent
//       → the unset-is-selected case reds. That is the behaviour-change-on-upgrade this
//         setting was explicitly specified to avoid.
//   T4  the environment panel renders its host as an <input>
//       → the read-only case reds. The assertion counts editable elements rather than naming
//         them, so it catches a select or textarea appearing there too.
//   T5  a clearing control calls save with a null instead of reset (the OLD contract
//       surviving in one control) → the clear-uses-reset case reds, and so does the
//       every-control-agrees case. Added when `save` became set-only on 2026-09-08: the risk
//       is not that all four controls revert together, it is that ONE does and fails only for
//       the field nobody clears often.
//   XX  a patch matching no text must REFUSE.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

const H = {
  saved: [] as Record<string, unknown>[],
  reset: [] as string[],
  overrides: [] as Array<{ key: string; env: string; value: string }>,
  settings: {} as Record<string, unknown>,
  // What `appSettings()` should do THIS test. null = the normal, well-formed response. The
  // two failure cases below need a rejection and a malformed body respectively, and a fixed
  // mock cannot express either — which is exactly why neither was covered.
  appSettingsImpl: null as null | (() => Promise<unknown>),
}
const RESP = () => ({ settings: H.settings, overrides: H.overrides, environment: { host: '127.0.0.1', port: 4319, dataDir: '/d', oauthRedirectUri: 'u' } })

vi.mock('../api/client', () => ({
  api: {
    http: {
      appSettings: async () => {
        if (H.appSettingsImpl) return H.appSettingsImpl()
        return {
          settings: H.settings,
          overrides: H.overrides,
          environment: { host: '127.0.0.1', port: 4319, dataDir: '/home/u/.config/claudette', oauthRedirectUri: 'http://127.0.0.1:4319/api/connectors/oauth/callback' },
        }
      },
      saveAppSettings: async (patch: Record<string, unknown>) => {
        H.saved.push(patch)
        H.settings = { ...H.settings, ...patch }
        return RESP()
      },
      resetAppSetting: async (key: string) => {
        H.reset.push(key)
        const next = { ...H.settings }; delete next[key]; H.settings = next
        return RESP()
      },
    },
  },
}))
vi.mock('../store/sessions', () => ({ useSessions: () => ({ agents: [{ id: 'general', name: 'General' }, { id: 'planner', name: 'Planner' }] }) }))

const { SettingsPanel } = await import('./SettingsPanel')

beforeEach(() => { H.saved = []; H.reset = []; H.overrides = []; H.settings = {}; H.appSettingsImpl = null })
afterEach(cleanup)

const row = (name: string) => document.querySelector(`[data-setting="${name}"]`) as HTMLElement

describe('SettingsPanel', () => {
  // ★ THE RULE THIS PANEL MOST NEEDS PINNED. Precedence is env-wins; a control the operator
  // can still edit under an override is a silent no-op, which is the class this repo has
  // corrected three times.
  it('an env override DISABLES its control and names the variable', async () => {
    H.overrides = [{ key: 'maxTeamSize', env: 'CLAUDETTE_MAX_TEAM_SIZE', value: '4' }]
    render(<SettingsPanel />)
    await waitFor(() => expect(row('maxTeamSize')).toBeTruthy())
    expect(row('maxTeamSize').getAttribute('aria-disabled')).toBe('true')
    expect(row('maxTeamSize').getAttribute('data-locked-by')).toBe('CLAUDETTE_MAX_TEAM_SIZE')
    expect((screen.getByTestId('max-team-size') as HTMLInputElement).disabled).toBe(true)
  })

  it('…and leaves every other control editable', async () => {
    H.overrides = [{ key: 'maxTeamSize', env: 'CLAUDETTE_MAX_TEAM_SIZE', value: '4' }]
    render(<SettingsPanel />)
    await waitFor(() => expect(row('defaultModel')).toBeTruthy())
    expect(row('defaultModel').getAttribute('aria-disabled')).toBe('false')
    expect((screen.getByTestId('model-opus') as HTMLButtonElement).disabled).toBe(false)
  })

  // ★ ABSENT IS SELECTED, not opus. Preselecting a model would change behaviour for every
  // existing install the first time anyone saved anything from this screen.
  it('ships with no model chosen, and says so as a real selection', async () => {
    render(<SettingsPanel />)
    await waitFor(() => expect(screen.queryByTestId('model-unset')).toBeTruthy())
    expect(screen.getByTestId('model-unset').getAttribute('aria-pressed')).toBe('true')
    for (const m of ['opus', 'sonnet', 'fable']) {
      expect(screen.getByTestId(`model-${m}`).getAttribute('aria-pressed')).toBe('false')
    }
    expect(H.saved).toEqual([])   // rendering the panel saves nothing
  })

  it('choosing an alias sends that alias', async () => {
    render(<SettingsPanel />)
    fireEvent.click(await screen.findByTestId('model-sonnet'))
    await waitFor(() => expect(H.saved).toEqual([{ defaultModel: 'sonnet' }]))
  })

  // ★ CLEARING USES THE OTHER VERB. `save` is set-only, so "no preference" must go to
  // /reset — and the assertion checks BOTH that reset was called and that save was NOT,
  // because sending `{defaultModel: null}` to save would be the old contract silently
  // surviving in one control while the others moved.
  it('clearing the model calls reset, and does not save a null', async () => {
    H.settings = { defaultModel: 'opus' }
    render(<SettingsPanel />)
    fireEvent.click(await screen.findByTestId('model-unset'))
    await waitFor(() => expect(H.reset).toEqual(['defaultModel']))
    expect(H.saved).toEqual([])
  })

  // Every control that can express "no preference" must agree on the verb. One of them
  // choosing differently would fail only for the field nobody clears often.
  it('every clearable control routes its empty state through reset', async () => {
    H.settings = { defaultAgentId: 'planner', defaultPermissionMode: 'plan', maxTeamSize: 4 }
    render(<SettingsPanel />)
    fireEvent.change(await screen.findByTestId('default-agent'), { target: { value: '' } })
    fireEvent.change(screen.getByTestId('default-permission-mode'), { target: { value: '' } })
    const team = screen.getByTestId('max-team-size')
    fireEvent.change(team, { target: { value: '' } })
    fireEvent.blur(team)
    await waitFor(() => expect(H.reset.length).toBe(3))
    expect(new Set(H.reset)).toEqual(new Set(['defaultAgentId', 'defaultPermissionMode', 'maxTeamSize']))
    expect(H.saved).toEqual([])
  })

  it('the environment panel exposes no editable control', async () => {
    render(<SettingsPanel />)
    const env = await screen.findByTestId('environment-panel')
    expect(env.querySelectorAll('input, select, textarea').length).toBe(0)
    expect(screen.getByTestId('env-host').textContent).toBe('127.0.0.1')
    // The redirect URI is shown with a copy control, because it must be registered verbatim.
    expect(screen.getByTestId('env-redirect-uri').textContent).toContain('/api/connectors/oauth/callback')
    expect(screen.getByLabelText('Copy the redirect URI')).toBeTruthy()
  })

  it('refuses a team size above the hard maximum, and does not save it', async () => {
    render(<SettingsPanel />)
    const input = await screen.findByTestId('max-team-size')
    fireEvent.change(input, { target: { value: '13' } })
    fireEvent.blur(input)
    await waitFor(() => expect(screen.queryByTestId('team-size-error')).toBeTruthy())
    expect(H.saved).toEqual([])
  })

  // ★★ THE TWO CASES BELOW ARE THE USER-REPORTED BUG AND ITS SHADOW. ★★
  // Reported: opening Settings showed "Cannot read properties of undefined (reading 'host')"
  // and took out the whole app — the only ErrorBoundary is at the ROOT, wrapping <App/>, so a
  // throw in this panel is not a degraded panel, it is a blank application.
  //
  // The chain had TWO silent links, and fixing only the first just moves the silence:
  //   1. `get()` returned a 404 body as if it were the success type, so the failure never
  //      presented as a failure to the COMPONENT. (Fixed in client.ts; covered by client.test.ts.)
  //   2. Even once it did, the component could not present it to the USER: `load` leaves
  //      `data` null on failure, and the early `if (!data)` returned only "Loading settings…",
  //      so the "Could not load settings." branch — which sits inside the main return — was
  //      unreachable. Correct, written, and dead.

  it('shows the error instead of loading FOREVER when the fetch fails', async () => {
    // Nothing retries, so "loading" here is not a transient state that resolves — it is the
    // permanent end state of a failed load, and it tells the user the opposite of the truth.
    H.appSettingsImpl = () => Promise.reject(new Error('GET /api/settings failed: 404'))
    render(<SettingsPanel />)
    await waitFor(() => expect(screen.getByTestId('settings-error')).toBeTruthy())
    // And the loading text must be GONE, not merely accompanied — the assertion that fails if
    // someone renders both.
    expect(screen.queryByTestId('settings-loading')).toBeNull()
  })

  it('renders the rest of the panel when the server omits `environment` entirely', async () => {
    // `environment` is typed as required, but the object came off the wire through JSON.parse:
    // the type is an assertion about a SERVER, not a fact about a value, and typecheck can
    // never catch this. A read-only facts block is never worth the whole application.
    H.appSettingsImpl = async () => ({ settings: H.settings, overrides: H.overrides })
    render(<SettingsPanel />)
    // The settings themselves still render — the panel degrades rather than dying.
    await waitFor(() => expect(row('defaultModel')).toBeTruthy())
    expect(screen.queryByTestId('environment-panel')).toBeNull()
  })

  // ★ THE CONTROL THAT OFFERS FEWER OPTIONS THAN THE USER EXPECTS MUST SAY WHY.
  // defaultPermissionMode lists only the prompting modes, because the server refuses to store
  // an elevated one as a default — on save, and again on load, so a hand-edited settings file
  // cannot plant one either. Without a word here that reads as a truncated list rather than a
  // deliberate refusal, and the obvious "fix" is to add the missing options to the dropdown.
  //
  // This case REPLACED one asserting that three rows were marked "not in effect yet", which was
  // true while the panel had shipped ahead of its server half and became false the moment
  // /api/session/create started consulting app settings. Recorded because the note and the
  // server behaviour must move together: a stale honesty-note is a lie with good intentions.
  it('explains why the permission-mode default offers no elevated option', async () => {
    render(<SettingsPanel />)
    await waitFor(() => expect(row('defaultPermissionMode')).toBeTruthy())
    expect(row('defaultPermissionMode')?.textContent ?? '').toMatch(/cannot be stored as a default/i)
    // And nothing anywhere still claims the settings do nothing.
    expect(document.body.textContent ?? '').not.toMatch(/Not in effect yet/i)
  })
})
