import type { ActivePane } from '@claudette/shared'

// Per-session record of what the user is currently LOOKING AT — the file open in a
// session's active content tab, or null when the Claude tab is focused. The web
// client publishes this over WS (`session:activePane`) on every tab/session switch;
// the app-control notebook tools read it so a path-less call targets the notebook
// the user is actually viewing (see notebookTools.resolveNotebook). This is the
// Claudette port of ClaudeMaster's `activePane` map — the only piece of active-pane
// steering that was deferred out of Phase 1 (the doc mutation half is already live).
export class ActivePaneRegistry {
  private bySession = new Map<string, ActivePane | null>()

  // Record (or clear, with null) the pane a session is viewing.
  set(sessionId: string, pane: ActivePane | null): void {
    this.bySession.set(sessionId, pane)
  }

  // The pane a session is viewing, or undefined if it has never reported one
  // (distinct from an explicit null = "the Claude tab is focused, no file open").
  get(sessionId: string): ActivePane | null | undefined {
    return this.bySession.get(sessionId)
  }

  // Drop a session's entry when it goes away.
  release(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}
