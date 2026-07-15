// A short completion chime via the Web Audio API — no file, no network, and (unlike
// the Notification API) no permission prompt. Plays as long as the user has
// interacted with the page at least once (sticky activation), which they always
// have by the time a turn finishes (they hit Send). Used to signal a background
// session finishing, independent of the desktop-notification opt-in.

let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    if (!ctx) ctx = new Ctor()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch { return null }
}

// A soft two-note "ding-dong" (A5 → D6) — noticeable but not jarring.
export function playChime(): void {
  const ac = audio()
  if (!ac) return
  const now = ac.currentTime
  for (const [freq, at] of [[880, 0], [1174.66, 0.12]] as const) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    osc.connect(gain)
    gain.connect(ac.destination)
    const t = now + at
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34)
    osc.start(t)
    osc.stop(t + 0.36)
  }
}
