// DEFAULT CWD SETTING — server half. `defaultCwd` is the folder new sessions start in instead of
// $HOME. SAVE accepts only an absolute path to an existing directory and stores its realpath;
// LOAD keeps a stored absolute path even if the folder has since been deleted (so the dialog can
// say so instead of silently forgetting the setting), and GET /api/settings reports that as
// `defaultCwdMissing`. Reset clears it. Asserted against the bytes on disk, not the cache.
//   npx tsx scratchpad/default-cwd-setting-test.mts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { check, passed, failed } from './assert.mjs'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'default-cwd-')))
process.env.CLAUDETTE_DATA_DIR = path.join(TMP, 'data')
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* best effort */ } })

const { saveSettings, getSettings, resetSetting, resetSettingsCache } = await import('../server/src/settings/settingsStore')
const { registerSettingsRoutes } = await import('../server/src/settings/settingsApi')
const { APP_SETTINGS_KEYS } = await import('@claudette/shared')
const Fastify = (await import('fastify')).default

const file = path.join(TMP, 'data', 'settings.json')
const onDisk = (): Record<string, unknown> => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {})
const err = (r: { ok: boolean; error?: string }) => (r.ok ? '' : r.error ?? '')
type Save = (p: unknown) => { ok: boolean; error?: string }
const save = saveSettings as unknown as Save

const real = path.join(TMP, 'work', 'proj'); fs.mkdirSync(real, { recursive: true })
const link = path.join(TMP, 'link'); fs.symlinkSync(path.join(TMP, 'work'), link)
const aFile = path.join(TMP, 'plain.txt'); fs.writeFileSync(aFile, 'x')

check('0. defaultCwd is a settings key', (APP_SETTINGS_KEYS as readonly string[]).includes('defaultCwd'))

// ── save-side validation ───────────────────────────────────────────────────────────────
const rel = save({ defaultCwd: 'work/proj' })
check('1a relative path refused, saying it must be absolute', !rel.ok && /absolute/i.test(err(rel)), err(rel))
const gone = save({ defaultCwd: path.join(TMP, 'nope') })
check('1b nonexistent folder refused, saying it does not exist', !gone.ok && /does not exist/i.test(err(gone)), err(gone))
const notDir = save({ defaultCwd: aFile })
check('1c a FILE refused, saying it is not a directory', !notDir.ok && /not a directory/i.test(err(notDir)), err(notDir))
const num = save({ defaultCwd: 42 })
check('1d a non-string refused', !num.ok, err(num))
const empty = save({ defaultCwd: '   ' })
check('1e an empty string refused (clearing is reset, not save)', !empty.ok, err(empty))
check('1f nothing written by any refused save', onDisk().defaultCwd === undefined, JSON.stringify(onDisk()))

// ── accepted: canonical realpath persisted ─────────────────────────────────────────────
const ok = save({ defaultCwd: `  ${path.join(link, 'proj')}/ ` })
check('2a an absolute path through a symlink, with whitespace and a trailing slash, is accepted', ok.ok, err(ok))
check('2b …and stored as the REALPATH on disk', onDisk().defaultCwd === real, JSON.stringify(onDisk()))
resetSettingsCache()
check('2c survives a reload from disk', getSettings().defaultCwd === real, JSON.stringify(getSettings()))

// ── the route reports whether it still exists ──────────────────────────────────────────
const app = Fastify(); registerSettingsRoutes(app); await app.ready()
const getRoute = async () => JSON.parse((await app.inject({ method: 'GET', url: '/api/settings' })).body)
const g1 = await getRoute()
check('3a GET /api/settings carries defaultCwd and defaultCwdMissing=false', g1.settings?.defaultCwd === real && g1.defaultCwdMissing === false, JSON.stringify(g1))

// ── deleted since: kept on load, reported missing ──────────────────────────────────────
fs.rmSync(real, { recursive: true })
resetSettingsCache()
check('4a a stored folder deleted since is KEPT on load (not silently dropped)', getSettings().defaultCwd === real, JSON.stringify(getSettings()))
const g2 = await getRoute()
check('4b …and the route reports defaultCwdMissing=true', g2.defaultCwdMissing === true, JSON.stringify(g2))
fs.mkdirSync(real, { recursive: true })

// ── a hand-edited RELATIVE value is dropped on load ────────────────────────────────────
fs.writeFileSync(file, JSON.stringify({ defaultCwd: 'relative/dir', defaultModel: 'opus' }))
resetSettingsCache()
const after = getSettings()
check('5a hand-edited relative defaultCwd dropped on load; siblings kept', after.defaultCwd === undefined && after.defaultModel === 'opus', JSON.stringify(after))
const g3 = await getRoute()
check('5b no value ⇒ defaultCwdMissing=false', g3.defaultCwdMissing === false, JSON.stringify(g3))

// ── reset clears ───────────────────────────────────────────────────────────────────────
save({ defaultCwd: real })
const rs = resetSetting('defaultCwd')
check('6a reset clears it on disk', rs.ok && onDisk().defaultCwd === undefined, JSON.stringify(onDisk()))

await app.close()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
