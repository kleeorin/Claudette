// A rejected value → something showable. The client-side twin of the server's
// util/errMessage: `fetch` rejects with an Error on a dropped connection, but
// `res.json()` on a non-JSON body (a proxy 502, an expired-cookie redirect to HTML)
// throws a SyntaxError, and a few paths reject with a bare string. Every panel that
// awaits an api call needs the same three lines, so they live here once.
export function errText(e: unknown, fallback = 'request failed'): string {
  if (e instanceof Error) return e.message || fallback
  if (typeof e === 'string' && e) return e
  return fallback
}
