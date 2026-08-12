import { useEffect, useRef } from 'react'

// Remembered scroll offsets, keyed by what you were looking at (a notebook/file
// path). Module-level so a position OUTLIVES the view: only the active tab of the
// active session is mounted, so switching file, tab or session unmounts the whole
// editor — without this, coming back always dropped you at the top.
const positions = new Map<string, number>()

// Restoring can't be a single scrollTop assignment on mount: the content lays out
// over many frames (cells mount, CodeMirror measures itself, markdown renders,
// images/outputs size up), so an early assignment clamps to a short scrollHeight.
// We re-apply every frame until the offset sticks — or until the content STOPS
// GROWING, which is the honest signal that this is as far as it will ever scroll.
// A flat time budget was the bug here: a notebook whose cells took longer than it
// to reach full height gave up mid-restore and left you at the top.
const STABLE_FRAMES = 60
// Backstop for content that never settles (a streaming run appending output the
// whole time) — past this we stop forcing the offset and let the view be.
const RESTORE_MS = 8000
// How long to keep looking for the container itself — some are created by a library
// after an async init (Milkdown's `create()`, react-data-grid's `.rdg`).
const ATTACH_MS = 10000
// Events that mean "the human is driving now" — stop re-applying immediately so a
// still-restoring view never fights a scroll/keypress.
const USER_EVENTS = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const

/**
 * Remember a scroll container's offset under `key` and restore it on the next mount.
 *
 * `getEl` is polled (not captured once) so it also works for containers rendered by
 * a library — e.g. react-data-grid's inner `.rdg` — which don't exist yet on mount.
 * Pass a null key to opt out (e.g. before the doc's path is known).
 */
export function useScrollMemory(key: string | null, getEl: () => HTMLElement | null) {
  const getRef = useRef(getEl)
  getRef.current = getEl

  useEffect(() => {
    if (!key) return
    const target = positions.get(key) ?? 0
    let el: HTMLElement | null = null
    // While `restoring`, scrolls are ours, not the user's — don't record them, or the
    // clamped intermediate offsets would overwrite the position we're restoring TO.
    // Nothing to restore for offset 0, so start recording straight away.
    let restoring = target > 0
    let raf = 0
    // Consecutive frames the content height hasn't changed → layout has settled.
    let lastHeight = -1
    let settled = 0
    const attachDeadline = performance.now() + ATTACH_MS
    // Set once the container exists, so a slow-to-appear one still gets a full
    // restore window rather than one that already expired while we waited.
    let restoreDeadline = attachDeadline

    // A scroll offset only means something while the view can actually scroll. A
    // container that is (transiently) no taller than its viewport — content still
    // mounting, a notebook rebuilding its cells, the pane collapsed by a layout
    // change — has its scrollTop clamped to 0 by the browser, and that clamp fires a
    // scroll event. Recording it would wipe where the user actually was.
    const save = () => {
      if (restoring || !el) return
      if (el.scrollHeight - el.clientHeight <= 0) return
      positions.set(key, el.scrollTop)
    }
    const stop = () => { restoring = false }
    const attach = (node: HTMLElement) => {
      el = node
      restoreDeadline = performance.now() + RESTORE_MS
      node.addEventListener('scroll', save, { passive: true })
      for (const ev of USER_EVENTS) node.addEventListener(ev, stop, { passive: true })
    }

    const tick = () => {
      raf = 0
      const now = performance.now()
      if (!el) {
        const node = getRef.current()
        if (node) attach(node)
      }
      if (el && restoring) {
        if (el.scrollHeight === lastHeight) settled++
        else { settled = 0; lastHeight = el.scrollHeight }
        const max = el.scrollHeight - el.clientHeight
        if (max > 0 && Math.abs(el.scrollTop - target) > 1) el.scrollTop = Math.min(target, max)
        const landed = Math.abs(el.scrollTop - target) <= 1
        // Give up only once we're there, or the content has stopped growing (it can't
        // reach the old offset — the doc genuinely got shorter), or the backstop hits.
        if (landed || settled >= STABLE_FRAMES || now >= restoreDeadline) restoring = false
      }
      if ((!el && now < attachDeadline) || restoring) raf = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      if (raf) cancelAnimationFrame(raf)
      // Record a settled offset only (`save` no-ops mid-restore). If we never reached
      // the target — switched away while the content was still growing — keep the
      // stored one rather than overwriting it with a clamped value.
      save()
      if (el) {
        el.removeEventListener('scroll', save)
        for (const ev of USER_EVENTS) el.removeEventListener(ev, stop)
      }
    }
  }, [key])
}
