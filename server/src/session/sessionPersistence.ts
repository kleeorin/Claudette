import { join } from 'path'
import { homedir } from 'os'
import { readFile, writeFile, mkdir } from 'fs/promises'
import type { SavedSession } from '@claudette/shared'

// Persist the open session set so a server restart restores them (each re-launched
// with --resume into its saved claudeSessionId). Ported from ClaudeMaster's
// `main/sessionPersistence.ts`; the data dir replaces Electron's app.getPath —
// Claudette keeps its state under ~/.claude/claudette/ (next to Claude's own dir),
// overridable via CLAUDETTE_DATA_DIR (used by tests to isolate).
const DIR = process.env.CLAUDETTE_DATA_DIR || join(homedir(), '.claude', 'claudette')
const FILE = join(DIR, 'sessions.json')

export async function saveState(sessions: SavedSession[]): Promise<void> {
  try {
    await mkdir(DIR, { recursive: true })
    // Atomic-ish: write temp + rename so a crash mid-write can't corrupt the file.
    const tmp = `${FILE}.tmp`
    await writeFile(tmp, JSON.stringify(sessions))
    const { rename } = await import('fs/promises')
    await rename(tmp, FILE)
  } catch { /* best-effort; a failed save just means no restore next boot */ }
}

export async function loadState(): Promise<SavedSession[]> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as SavedSession[]
  } catch {
    return []
  }
}
