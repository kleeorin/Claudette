// The saved-folder defaults store (server/src/claude/sandboxDefaults.ts) — the operator's
// standing list of one-click sandbox mounts.
//
// Drives the REAL module against a throwaway CLAUDETTE_DATA_DIR, so every assertion is
// about what actually lands on disk, not a re-implementation of it. The env var is set
// before the first store call rather than before the import, which is safe because
// dataDir() reads process.env on every call (util/dataDir.ts) — and with the override set
// it also skips migrateLegacy entirely, so this never touches ~/.claude.
//
// WHAT THIS IS REALLY FOR: the list is INERT (nothing here mounts itself into a session),
// so its whole job is to be a faithful, deduped menu. That makes NORMALISATION the load-
// bearing behaviour — `/a/b` and `/a/b/` must be one row, or the UI shows a folder twice
// and the second row's mode silently contradicts the first.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { check, failed as fail } from './assert.mjs'
import type { SandboxDefaultFolder } from '../shared/src/types.js'

const dir = mkdtempSync(path.join(tmpdir(), 'claudette-sbdef-'))
process.env.CLAUDETTE_DATA_DIR = dir

const store = await import('../server/src/claude/sandboxDefaults.js')
const { listDefaultFolders, saveDefaultFolder, removeDefaultFolder, resetSandboxDefaultsCache } = store

const file = path.join(dir, 'sandbox-defaults.json')
const paths = () => listDefaultFolders().map((f) => f.path)

try {
  // --- a fresh install ------------------------------------------------------------
  check('a fresh install has no saved folders', listDefaultFolders().length === 0,
    `got ${JSON.stringify(listDefaultFolders())}`)
  check('and writes nothing until something is saved', !existsSync(file), file)

  // --- save, and the normalisation that makes dedupe work --------------------------
  const first = saveDefaultFolder({ path: '/tmp/alpha', mode: 'ro' })
  check('saving a folder succeeds', first.ok === true, JSON.stringify(first))
  check('and it comes back in the list', paths().join() === '/tmp/alpha', paths().join())

  const dup = saveDefaultFolder({ path: '/tmp/alpha/', mode: 'rw' })
  check('a trailing slash is the SAME entry, not a second one',
    dup.ok === true && listDefaultFolders().length === 1,
    `${listDefaultFolders().length} row(s): ${JSON.stringify(listDefaultFolders())}`)
  check('and the re-save rewrote its mode in place', listDefaultFolders()[0]?.mode === 'rw',
    listDefaultFolders()[0]?.mode)

  saveDefaultFolder({ path: '/tmp/beta/../gamma', mode: 'ro' })
  check('a `..` segment is collapsed before storing', paths().includes('/tmp/gamma'), paths().join())

  // Upsert must keep POSITION, not move the row to the end — a menu that reorders itself
  // when you flip one row's access is a menu you have to re-read every time.
  saveDefaultFolder({ path: '/tmp/alpha', mode: 'ro' })
  check('re-saving keeps the row where it was', paths().join() === '/tmp/alpha,/tmp/gamma', paths().join())

  // --- refusals -------------------------------------------------------------------
  const rel = saveDefaultFolder({ path: 'relative/dir', mode: 'ro' })
  check('a relative path is refused', rel.ok === false, JSON.stringify(rel))
  const empty = saveDefaultFolder({ path: '   ', mode: 'ro' })
  check('an empty path is refused', empty.ok === false, JSON.stringify(empty))
  const badMode = saveDefaultFolder({ path: '/tmp/delta', mode: 'wr' as 'rw' })
  check('a mode that is neither rw nor ro is refused', badMode.ok === false, JSON.stringify(badMode))
  check('and none of the three refusals left a row behind', listDefaultFolders().length === 2,
    JSON.stringify(paths()))

  // --- the cap ---------------------------------------------------------------------
  for (let i = 0; i < 48; i++) saveDefaultFolder({ path: `/tmp/bulk-${i}`, mode: 'ro' })
  check('the list fills to the 50-entry cap', listDefaultFolders().length === 50,
    String(listDefaultFolders().length))
  const over = saveDefaultFolder({ path: '/tmp/one-too-many', mode: 'ro' })
  check('the 51st is REFUSED, not silently dropped', over.ok === false, JSON.stringify(over))
  check('and the cap does not block re-saving a folder already listed',
    saveDefaultFolder({ path: '/tmp/alpha', mode: 'rw' }).ok === true,
    'an upsert at the cap must still work — it adds no row')

  // --- removal ---------------------------------------------------------------------
  const before = listDefaultFolders().length
  removeDefaultFolder('/tmp/never-added')
  check('removing an unknown path is a no-op, not an error', listDefaultFolders().length === before,
    `${before} -> ${listDefaultFolders().length}`)
  removeDefaultFolder('/tmp/alpha/')   // the un-normalised form the UI might hold
  check('removing by the trailing-slash form still finds the row', !paths().includes('/tmp/alpha'),
    paths().slice(0, 4).join())

  // --- what actually reached the disk ----------------------------------------------
  check('the file is 0600 — nobody else on the host reads the operator\'s folder list',
    (statSync(file).mode & 0o777) === 0o600, (statSync(file).mode & 0o777).toString(8))
  resetSandboxDefaultsCache()
  check('the list survives a cold read (cache dropped, re-parsed from disk)',
    listDefaultFolders().length === 49 && paths().includes('/tmp/gamma'),
    `${listDefaultFolders().length} row(s)`)

  // --- THE CASE THE catch(e) IN load() DOES NOT COVER -------------------------------
  // A file that PARSES but holds a row of the wrong shape never reaches that catch, so
  // "starts empty, loudly" does not apply to it. The question is whether such a row can
  // reach a caller and blow up somewhere with no context — the store's own save path
  // normalises every stored path, and the web UI calls prettyPath (a .replace) on it.
  //
  // The fixture deliberately surrounds the bad rows with GOOD ones. A file whose only row is
  // malformed cannot distinguish "drop the bad rows" from "empty the whole list" — both
  // return [] — and the difference is the entire point: losing one shortcut beats losing all
  // fifty. Two shapes of bad row, because they fail at different fields.
  writeFileSync(file, JSON.stringify({ folders: [
    { path: '/tmp/keep-me', mode: 'ro' },
    { path: 123, mode: 'ro' },              // path is not a string
    { path: '/tmp/bad-mode', mode: 'wr' },  // mode is neither rw nor ro
    { path: '/tmp/keep-me-too', mode: 'rw' },
  ] }))
  resetSandboxDefaultsCache()
  let listThrew: string | null = null
  let rows: unknown[] = []
  try { rows = listDefaultFolders() } catch (e) { listThrew = String(e) }
  let saveThrew: string | null = null
  try { saveDefaultFolder({ path: '/tmp/after-corruption', mode: 'ro' }) } catch (e) { saveThrew = String(e) }

  const survivedTyped = !listThrew && rows.every((r) => typeof (r as { path: unknown }).path === 'string')
  check('a parseable-but-malformed row does not reach callers as a non-string path',
    survivedTyped,
    {
      pass: `handed out ${JSON.stringify(rows)}`,
      fail: listThrew
        ? `listDefaultFolders() THREW: ${listThrew}`
        : `handed out ${JSON.stringify(rows)} — the web UI calls prettyPath() (a .replace) on .path, so a number here throws inside render`,
    })
  // The half of the behaviour the single-bad-row fixture could not see: the GOOD rows are
  // still there, in order. If this ever reads 0, the file is being emptied rather than
  // filtered and one mistyped entry costs the operator their whole menu.
  const kept = (rows as SandboxDefaultFolder[]).map((r) => r.path)
  check('and the good rows either side of it SURVIVE — bad rows are dropped, not the list',
    kept.join() === '/tmp/keep-me,/tmp/keep-me-too', `kept ${JSON.stringify(kept)}`)
  check('and a later save does not throw on the malformed row', saveThrew === null,
    saveThrew ?? 'ok')

  // --- FINDING 4: the guard must restore EVERY invariant the save path establishes -------
  // saveDefaultFolder guarantees three things about a stored path — string, non-empty after
  // trim, absolute — and the guard originally restored only string-ness. The other two are
  // reachable by exactly the hand edit the guard exists for, and both are silent rather than
  // loud: `path.resolve('')` returns the SERVER'S OWN CWD (so the row compares equal to the
  // install directory in the upsert scan), and a relative path renders in the UI as typed
  // while naming a different directory entirely.
  // MUTATION THAT TURNS THIS RED: drop either the non-empty or the isAbsolute check from
  // isFolder() in sandboxDefaults.ts — each one alone re-admits its own row below.
  writeFileSync(file, JSON.stringify({ folders: [
    { path: '/tmp/well-formed', mode: 'ro' },
    { path: '', mode: 'rw' },        // resolves to the server's cwd
    { path: '   ', mode: 'rw' },     // ditto, after trim
    { path: 'docs', mode: 'rw' },    // displays as `docs`, names <server cwd>/docs
  ] }))
  resetSandboxDefaultsCache()
  const guarded = listDefaultFolders().map((r) => r.path)
  check('a row whose path is empty or relative is DROPPED, not resolved against the server cwd',
    guarded.join() === '/tmp/well-formed',
    {
      pass: `kept only ${JSON.stringify(guarded)}`,
      fail: `kept ${JSON.stringify(guarded)} — an empty path resolves to ${JSON.stringify(process.cwd())}, `
        + 'so such a row compares equal to the install directory in the upsert scan',
    })
  // The CONSEQUENCE, asserted directly rather than by inspecting the returned strings. An
  // earlier version of this checked `!guarded.includes(process.cwd())`, which stayed GREEN
  // under the very mutation it was cited for: list hands back the RAW stored path (`""`), and
  // the resolve to the install directory happens later, inside the upsert scan. So the
  // assertion could not fail for the reason it named — the shape the handovers call "a test
  // that cannot falsify what it is cited for".
  // What actually goes wrong: `normalise('')` is the server's cwd, so a surviving empty row
  // compares EQUAL to the install directory, and saving that directory as a default silently
  // rewrites the junk row in place instead of adding a row.
  const beforeCwdSave = listDefaultFolders().length
  saveDefaultFolder({ path: process.cwd(), mode: 'ro' })
  check('and an empty stored row cannot masquerade as the install directory in the upsert scan',
    listDefaultFolders().length === beforeCwdSave + 1,
    `${beforeCwdSave} -> ${listDefaultFolders().length} row(s): saving ${process.cwd()} must ADD a row, `
      + 'not collide with a surviving empty-path row and overwrite it in place')

  // --- FINDING 3: an UNPARSEABLE file is preserved, not overwritten by the next save -----
  // The two remedies for a corrupt list were mutually exclusive: starting empty caches
  // {folders: []}, so the next save — the reflex of someone whose buttons just vanished —
  // persisted straight over the corrupt file, destroying the bytes the "restore it" advice
  // needed. Moving it aside first is what makes the recoverability claim true.
  // MUTATION THAT TURNS THIS RED: remove the renameSync from load()'s catch — the first
  // assertion then finds no .corrupt file and the second finds the original overwritten.
  // The sidecar is found by LISTING rather than by name: the name carries the file's mtime so
  // that a second corruption cannot discard the copy the first one preserved, and hardcoding
  // one spelling here would pin the test to a naming scheme instead of to the property.
  const sidecars = (): string[] => readdirSync(dir).filter((f) => f.endsWith('.corrupt'))
  const readSidecars = (): string[] => sidecars().map((f) => readFileSync(path.join(dir, f), 'utf8'))
  for (const f of sidecars()) rmSync(path.join(dir, f), { force: true })
  const corruptBytes = '{ this is not json at all'
  writeFileSync(file, corruptBytes)
  resetSandboxDefaultsCache()
  check('an unparseable file starts empty rather than taking the server down',
    listDefaultFolders().length === 0, `${listDefaultFolders().length} row(s)`)
  check('and the unreadable bytes are MOVED ASIDE, not left for the next save to destroy',
    readSidecars().includes(corruptBytes),
    sidecars().length
      ? `sidecar(s) ${JSON.stringify(sidecars())} hold ${JSON.stringify(readSidecars())}`
      : 'no .corrupt sidecar — the original is now only recoverable until the next save')
  saveDefaultFolder({ path: '/tmp/after-the-corruption', mode: 'ro' })
  check('so a save after the corruption cannot have destroyed the original bytes',
    readSidecars().includes(corruptBytes), JSON.stringify(readSidecars()).slice(0, 120))

  // A SECOND corruption must not discard the first preserved copy — the same
  // destroy-the-unrecoverable mistake as the original defect, one level along.
  // MUTATION THAT TURNS THIS RED: rename to a fixed `${p}.corrupt` instead of an mtime-keyed
  // name; the second rename then overwrites the first and only the newer bytes survive.
  const secondCorruption = '{ a DIFFERENT corruption, later'
  writeFileSync(file, secondCorruption)
  resetSandboxDefaultsCache()
  listDefaultFolders()
  const held = readSidecars()
  check('a second corruption preserves its own copy WITHOUT discarding the first',
    held.includes(corruptBytes) && held.includes(secondCorruption),
    `${sidecars().length} sidecar(s) holding ${JSON.stringify(held)} — both corruptions must survive`)

  // --- FINDING 1: ONE normal form, so the editor's join cannot see two rows for one folder
  // The store canonicalises with path.resolve; normalizeSandbox used to pass mounts through
  // verbatim; the editor joined the two by raw string equality. `/tmp/proj/` and `/tmp/proj`
  // were therefore two rows for one folder — a star that could never fill, plus a phantom row
  // whose tick added a SECOND mount of the same directory.
  // MUTATION THAT TURNS THIS RED: drop the `cfg.mounts = dedupeMounts(...)` line from
  // normalizeSandbox in sessionManager.ts.
  const { normalizeSandbox } = await import('../server/src/claude/sessionManager.js')
  const joined = normalizeSandbox(
    { enabled: true, mounts: [{ path: '/tmp/proj/', mode: 'rw' }] }, '/tmp/proj', true)
  check('normalizeSandbox returns CANONICAL mount paths, the same normal form the store uses',
    joined.mounts.map((m) => m.path).join() === '/tmp/proj',
    `got ${JSON.stringify(joined.mounts)} — the editor joins these against path.resolve'd defaults by string equality`)
  const collapsed = normalizeSandbox(
    { enabled: true, mounts: [
      { path: '/tmp/proj/', mode: 'ro' },
      { path: '/tmp/proj', mode: 'rw' },
      { path: '/tmp/other/../proj', mode: 'ro' },
    ] }, '/tmp/proj', true)
  check('and three spellings of one folder collapse to a single rw row (rw wins, as at launch)',
    collapsed.mounts.length === 1 && collapsed.mounts[0]?.mode === 'rw',
    JSON.stringify(collapsed.mounts))
  // Relative paths are RESOLVED rather than refused — deliberate, and behaviour-preserving:
  // dedupeMounts has always resolved them against the server's process cwd on the way to
  // bwrap, so this stops the UI displaying a bare word for a directory it does not name.
  // Refusing instead would silently drop a mount from an already-approved session on restore.
  const relMount = normalizeSandbox({ enabled: true, mounts: [{ path: 'docs', mode: 'rw' }] }, '/tmp/proj', true)
  check('a relative mount is resolved (not refused, not left to display a name it does not mean)',
    relMount.mounts[0]?.path === path.resolve('docs'),
    `got ${JSON.stringify(relMount.mounts)} — expected ${path.resolve('docs')}, what bwrap has always bound`)
  // An empty mount path resolves to the server's own cwd, i.e. bind-mounting the Claudette
  // install directory into the box. Dropping is strictly narrowing, so it cannot widen a box
  // that worked before.
  const emptyMount = normalizeSandbox(
    { enabled: true, mounts: [{ path: '', mode: 'rw' }, { path: '/tmp/real', mode: 'rw' }] }, '/tmp/proj', true)
  check('an empty mount path is dropped rather than resolving to the install directory',
    emptyMount.mounts.map((m) => m.path).join() === '/tmp/real',
    `got ${JSON.stringify(emptyMount.mounts)} — an empty path resolves to ${process.cwd()}`)

  // --- THE SAME DEFECT ONE JOIN OVER: mounts vs session.cwd ------------------------------
  // Canonicalising mounts moved the mismatch rather than removing it. SandboxEditor marks the
  // project row with `r.path === session.cwd`, and cwd was stored verbatim — so for the very
  // input the mount fix was written for (`/tmp/proj/`) the star started filling and the
  // "(project)" label went missing. Both populations must share one normal form.
  // Driven through the REAL creation path, not by calling canonicalDir directly. Asserting on
  // the helper alone looked equivalent and was not: it stayed green when the call was removed
  // from register(), because nothing in the assertion went near register. `launch` is shadowed
  // on the instance so create() stops short of spawning a CLI — everything before it, which is
  // the part under test, runs untouched.
  // MUTATION THAT TURNS THIS RED: drop the `cwd = canonicalDir(cwd)` line from register().
  const { canonicalDir, SessionManager } = await import('../server/src/claude/sessionManager.js')
  const mgr = new SessionManager()
  ;(mgr as unknown as { launch: () => void }).launch = () => {}
  const sid = mgr.create('canon', '/tmp/proj/', '/tmp/proj/')
  const made = mgr.list().find((s) => s.id === sid)
  check('a session created with a trailing-slash cwd STORES it canonical',
    made?.cwd === '/tmp/proj',
    `stored cwd ${JSON.stringify(made?.cwd)} — SandboxEditor marks the project row with r.path === session.cwd`)
  check('and rootDir gets the same treatment, so the pair cannot disagree with each other',
    made?.rootDir === '/tmp/proj', `stored rootDir ${JSON.stringify(made?.rootDir)}`)
  check('so the stored cwd EQUALS the canonical mount of the same folder — the "(project)" join',
    made?.cwd === made?.sandbox?.mounts?.[0]?.path,
    `cwd ${JSON.stringify(made?.cwd)} vs mount ${JSON.stringify(made?.sandbox?.mounts?.[0]?.path)}`)
  check('and `..` in a typed cwd is collapsed too, not just a trailing slash',
    canonicalDir('/tmp/other/../proj') === '/tmp/proj', canonicalDir('/tmp/other/../proj'))
  // EMPTY MUST STAY EMPTY. path.resolve('') is the server's own cwd, and an absent cwd is a
  // real state: runDirOf falls back to homedir() and normalizeSandbox seeds no mount at all.
  // Resolving it would hand every cwd-less session the install directory as an rw mount.
  // MUTATION THAT TURNS THIS RED: `return path.resolve(p)` unconditionally in canonicalDir.
  check('an empty or blank cwd stays empty rather than becoming the install directory',
    canonicalDir('') === '' && canonicalDir('   ') === '',
    `got ${JSON.stringify([canonicalDir(''), canonicalDir('   ')])} — must not be ${process.cwd()}`)

  // --- THE LOAD PATH MUST CANONICALISE TOO, not merely validate --------------------------
  // isFolder validates; it does not normalise. A hand-edited `/a/b/` passes every check and
  // used to reach the client raw, where it meets canonical mount paths in the editor's union —
  // the phantom-row bug arriving through the load door instead of the save door.
  // MUTATION THAT TURNS THIS RED: drop the `.map(f => ({...f, path: normalise(f.path)}))`
  // from load() in sandboxDefaults.ts.
  writeFileSync(file, JSON.stringify({ folders: [
    { path: '/tmp/loaded-raw/', mode: 'ro' },
    { path: '/tmp/loaded/../loaded-two', mode: 'rw' },
  ] }))
  resetSandboxDefaultsCache()
  check('paths arriving through LOAD are canonicalised, not just validated',
    paths().join() === '/tmp/loaded-raw,/tmp/loaded-two',
    `got ${JSON.stringify(paths())} — a hand-edited trailing slash must not reach the client raw`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

process.exit(fail === 0 ? 0 : 1)
