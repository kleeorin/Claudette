// "3m ago" for a wall-clock timestamp. Shared by the resume and rewind pickers, which
// each carried a byte-identical private copy.
export function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  const m = s / 60; if (m < 60) return `${Math.floor(m)}m ago`
  const h = m / 60; if (h < 24) return `${Math.floor(h)}h ago`
  return `${Math.floor(h / 24)}d ago`
}
