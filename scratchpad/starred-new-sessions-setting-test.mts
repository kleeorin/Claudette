// STARRED FOLDERS IN NEW SESSIONS — server half. `starredFoldersInNewSessions` is an app setting
// (boolean; absent = false = today's inert stars). It is consumed CLIENT-SIDE ONLY, as a prefill
// of the new-session dialog; the server must never consult the star list on create/restore
// (sandboxDefaults.ts: that would make it a confinement-widening channel). So this pins:
// validation + persistence of the key, and that the server's own session paths stay star-blind
// even with the setting ON and a star saved.
//   npx tsx scratchpad/starred-new-sessions-setting-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { check, passed, failed } from './assert.mjs'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starred-setting-')))
process.env.CLAUDETTE_DATA_DIR = path.join(TMP, 'data')
fs.mkdirSync(process.env.CLAUDETTE_DATA_DIR, { recursive: true })
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* best effort */ } })

const { saveSettings, getSettings, resetSetting, resetSettingsCache } = await import('../server/src/settings/settingsStore')
const { APP_SETTINGS_KEYS } = await import('../shared/src/settings')   // relative, not @claudette/shared: the workspace link would resolve to the LIVE tree when this runs in a HEAD copy
const save = saveSettings as unknown as (p: unknown) => { ok: boolean; error?: string }
const file = path.join(TMP, 'data', 'settings.json')
const onDisk = (): Record<string, unknown> => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {})

check('0. starredFoldersInNewSessions is a settings key', (APP_SETTINGS_KEYS as readonly string[]).includes('starredFoldersInNewSessions'))
check('1a absent by default (= off, today\'s behaviour)', getSettings().starredFoldersInNewSessions === undefined)
for (const bad of ['yes', 1, 'true', {}]) {
  const r = save({ starredFoldersInNewSessions: bad })
  check(`1b non-boolean ${JSON.stringify(bad)} refused`, !r.ok && /true or false/.test(r.error ?? ''), r.error)
}
check('1c nothing written by the refusals', onDisk().starredFoldersInNewSessions === undefined)
const on = save({ starredFoldersInNewSessions: true })
check('2a true saved, on disk', on.ok && onDisk().starredFoldersInNewSessions === true, JSON.stringify(onDisk()))
resetSettingsCache()
check('2b survives a reload', getSettings().starredFoldersInNewSessions === true)
fs.writeFileSync(file, JSON.stringify({ starredFoldersInNewSessions: 'yes', defaultModel: 'opus' }))
resetSettingsCache()
check('2c a hand-edited non-boolean is dropped on load, siblings kept', getSettings().starredFoldersInNewSessions === undefined && getSettings().defaultModel === 'opus')
save({ starredFoldersInNewSessions: true })
check('2d reset clears it (back to absent = off)', resetSetting('starredFoldersInNewSessions').ok && onDisk().starredFoldersInNewSessions === undefined)

// ── the server stays star-blind ──────────────────────────────────────────────────────────
save({ starredFoldersInNewSessions: true })
const { saveDefaultFolder, listDefaultFolders } = await import('../server/src/claude/sandboxDefaults')
const STAR = path.join(TMP, 'starred'); fs.mkdirSync(STAR)
saveDefaultFolder({ path: STAR, mode: 'rw' })
const saved = listDefaultFolders().some((f) => f.path === STAR)
check('3- precondition: the star IS saved (else 3a would be vacuous)', saved)
const { SessionManager } = await import('../server/src/claude/sessionManager')
const m = new SessionManager({}) as unknown as { launch: () => void; register: (...a: unknown[]) => { id: string; sandbox: { mounts: { path: string }[] } } }
m.launch = () => {}
const cwd = path.join(TMP, 'proj'); fs.mkdirSync(cwd)
const s = m.register('s', cwd, cwd)
check('3a a session created with NO sandbox gets only the built-in seed — no star mounted by the server',
  JSON.stringify(s.sandbox.mounts.map((x) => x.path)) === JSON.stringify([cwd]), `${JSON.stringify(s.sandbox.mounts)} (star saved: ${saved !== null})`)
const src = fs.readFileSync(path.join(import.meta.dirname, '../server/src/claude/sessionManager.ts'), 'utf8')
check('3b sessionManager.ts still does not import sandboxDefaults', !/from '\.\/sandboxDefaults'/.test(src))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
