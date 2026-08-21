import { useEffect, useRef } from 'react'

// The two dismissal gestures every overlay in the app implements, written once.
// Modals, menus, pickers and dialogs each carried their own copy of these effects — a
// dozen-plus near-identical addEventListener/removeEventListener pairs, which is a
// dozen-plus chances to drop the cleanup or subscribe on the wrong condition.
//
// Both keep the handler in a REF and subscribe once. That way a caller can pass a plain
// inline arrow (closing over fresh state) without re-subscribing on every render, and
// without having to remember a useCallback at each of the fifteen call sites.

// Escape closes. `enabled` is for an overlay whose markup is always mounted and whose
// visibility is state (a dropdown), rather than one mounted conditionally.
export function useEscape(onClose: () => void, enabled = true): void {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled])
}

// A click anywhere, or Escape, closes — the dropdown-menu gesture. The trigger that
// opens the menu must stopPropagation, or the same click that opens it closes it again;
// that was true of every hand-rolled copy of this and stays true here.
export function useDismissOnOutside(open: boolean, onClose: () => void): void {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    if (!open) return
    const close = () => ref.current()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current() }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey) }
  }, [open])
}
