// Per-session "working notebook" pin, scoped to a single Claude turn. The FIRST
// time a path-optional notebook tool resolves a target during a turn — via the
// user's active pane, an explicit path, open_notebook, or create_notebook — that
// notebook is pinned here. Every later path-unset tool call in the same turn then
// targets the pinned notebook instead of re-reading the live active pane, so a
// multi-cell task stays on the notebook it started on even if the user switches
// tabs (or closes the notebook) mid-task. The pin is CLEARED at the next turn
// boundary (SessionManager emits 'userTurn' on sendUserTurn), so a fresh task
// re-binds to wherever the user is looking then. Paths are stored verbatim (the
// same string resolveNotebook would otherwise return); callers compare with
// path.resolve() when robustness against non-canonical forms matters.
export class TurnNotebookRegistry {
  private bySession = new Map<string, string>()

  // The notebook pinned for this session's current turn, or undefined if none has
  // been established yet this turn.
  get(sessionId: string): string | undefined {
    return this.bySession.get(sessionId)
  }

  // Pin (or re-pin) the working notebook. open_notebook/create_notebook call this to
  // OVERRIDE — Claude explicitly choosing what it's working on; implicit resolution
  // only pins when nothing is set yet (see resolveNotebook).
  set(sessionId: string, path: string): void {
    this.bySession.set(sessionId, path)
  }

  // Turn boundary: drop the pin so the next turn re-binds to the user's current view.
  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  // Drop a session's entry when it goes away.
  release(sessionId: string): void {
    this.bySession.delete(sessionId)
  }
}
