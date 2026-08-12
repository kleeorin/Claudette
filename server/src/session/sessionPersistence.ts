import { join } from 'path'
import { readFile, writeFile, mkdir, rename } from 'fs/promises'
import type { SavedSession } from '@claudette/shared'
import { dataDir } from '../util/dataDir'

// Persist the open session set so a server restart restores them (each re-launched
// with --resume into its saved claudeSessionId). Ported from ClaudeMaster's
// `main/sessionPersistence.ts`; the data dir replaces Electron's app.getPath.
//
// This file is SECURITY-RELEVANT, which is why it lives where dataDir() puts it rather
// than under ~/.claude: restore() replays it as trusted, so anything able to write here
// could hand itself `teamEmploy: true` or `sandbox: {enabled:false}` on the next boot.
// See util/dataDir.ts for the full reasoning.
const file = (): string => join(dataDir(), 'sessions.json')

export async function saveState(sessions: SavedSession[]): Promise<void> {
  try {
    const FILE = file()
    await mkdir(dataDir(), { recursive: true })
    // Atomic-ish: write temp + rename so a crash mid-write can't corrupt the file.
    const tmp = `${FILE}.tmp`
    await writeFile(tmp, JSON.stringify(sessions))
    await rename(tmp, FILE)
  } catch { /* best-effort; a failed save just means no restore next boot */ }
}

export async function loadState(): Promise<SavedSession[]> {
  try {
    return JSON.parse(await readFile(file(), 'utf8')) as SavedSession[]
  } catch {
    return []
  }
}
