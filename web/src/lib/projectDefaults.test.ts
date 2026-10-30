import { describe, it, expect } from 'vitest'
import type { ProjectInfo } from '@claudette/shared'
import { dialogPrefill, modeToSend, modeOptions } from './projectDefaults'

const P = (defaults?: ProjectInfo['defaults']): ProjectInfo => ({ id: 'p', name: 'p', cwd: '/w', createdAt: 0, ...(defaults ? { defaults } : {}) })
const SB = { enabled: false, mounts: [{ path: '/w', mode: 'ro' as const }] }

describe('dialogPrefill — what the new-session-in-project dialog starts with', () => {
  it('no project / no defaults: nothing pre-filled (built-in sandbox, app-setting mode)', () => {
    expect(dialogPrefill(undefined)).toEqual({ sandbox: undefined, mode: undefined, elevated: false })
    expect(dialogPrefill(P())).toEqual({ sandbox: undefined, mode: undefined, elevated: false })
  })
  it('project defaults pre-fill the sandbox (enabled:false kept) and the mode', () => {
    const r = dialogPrefill(P({ sandbox: SB, permissionMode: 'plan' }))
    expect(r.sandbox).toEqual(SB)
    expect(r.mode).toBe('plan')
    expect(r.elevated).toBe(false)
  })
  it('an ELEVATED project mode is flagged so the dialog can show it red', () => {
    expect(dialogPrefill(P({ permissionMode: 'bypassPermissions' })).elevated).toBe(true)
    expect(dialogPrefill(P({ permissionMode: 'acceptEdits' })).elevated).toBe(true)
  })
  it('the pre-filled sandbox is a COPY — editing it cannot mutate the project record', () => {
    const p = P({ sandbox: SB })
    const r = dialogPrefill(p)
    r.sandbox!.mounts.push({ path: '/x', mode: 'rw' })
    expect(p.defaults!.sandbox!.mounts).toHaveLength(1)
  })
})

describe('modeToSend — send permissionMode only when the project has one or the user chose', () => {
  it('untouched, no project default: OMIT, so the app setting still applies', () => {
    expect(modeToSend({ projectDefault: undefined, chosen: undefined, touched: false })).toBeUndefined()
  })
  it('untouched with a project default: send the project default explicitly', () => {
    expect(modeToSend({ projectDefault: 'acceptEdits', chosen: undefined, touched: false })).toBe('acceptEdits')
  })
  it('the user\'s choice wins', () => {
    expect(modeToSend({ projectDefault: 'bypassPermissions', chosen: 'default', touched: true })).toBe('default')
    expect(modeToSend({ projectDefault: undefined, chosen: 'plan', touched: true })).toBe('plan')
  })
  it('choosing "app default" (no mode) with no project default omits it', () => {
    expect(modeToSend({ projectDefault: undefined, chosen: undefined, touched: true })).toBeUndefined()
  })
})

describe('modeOptions — the "app default" choice exists only when it can mean something', () => {
  it('no project default: offered; with one: not offered (omitting would fall back to the PROJECT default)', () => {
    expect(modeOptions(undefined)[0]).toEqual({ value: '', label: expect.stringMatching(/app default/i) })
    expect(modeOptions('plan').some((o) => o.value === '')).toBe(false)
    expect(modeOptions('plan').map((o) => o.value)).toEqual(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
  })
})
