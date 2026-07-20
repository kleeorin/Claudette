// The message of an unknown thrown value: `e.message` for a real Error, else its
// string form. Replaces the `e instanceof Error ? e.message : String(e)` ternary that
// was re-inlined across the fs / notebook / permissions / sandbox layers.
export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
