import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionInfo, SessionState } from '@claudette/shared'
import { api } from '../api/client'
import { playChime } from './chime'

// Signals for a session finishing / needing input while you're NOT actively watching
// it — i.e. a DIFFERENT session, or the tab in the background. "Actively watching" =
// this session is the active tab AND the tab is focused; only then do we stay silent.
//
// Two independent signals:
//   • Sound (chime) — on by default, no permission, no opt-in. This is the always-on
//     nudge; the tab need NOT be unfocused.
//   • Desktop notification — opt-in via the bell (needs OS permission). Also fires
//     regardless of focus now (for background sessions), clicking it switches to them.
// (The sidebar's red attention light is separate, in the sessions store.)

const LS_NOTIF = 'claudette.notifications'
const LS_SOUND = 'claudette.sound'
const ICON = '/icon-192.png'

export type NotifyPermission = 'default' | 'granted' | 'denied' | 'unsupported'

export interface NotificationsApi {
  /** Desktop-notification opt-in AND a granted browser permission — i.e. firing. */
  enabled: boolean
  permission: NotifyPermission
  /** Toggle desktop notifications; enabling requests permission (needs a gesture). */
  toggle: () => void
  /** Completion sound on/off (default on; no permission needed). */
  soundOn: boolean
  toggleSound: () => void
}

function currentPermission(): NotifyPermission {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.permission
}

export function useNotifications(
  sessions: SessionInfo[],
  activeId: string | null,
  setActive: (id: string) => void,
): NotificationsApi {
  const [permission, setPermission] = useState<NotifyPermission>(currentPermission)
  const [wanted, setWanted] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_NOTIF) === '1' } catch { return false }
  })
  const [soundOn, setSoundOn] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_SOUND) !== '0' } catch { return true }  // default ON
  })
  const enabled = wanted && permission === 'granted'

  // Live refs so the once-mounted WS subscribers always read current values.
  const enabledRef = useRef(enabled); enabledRef.current = enabled
  const soundRef = useRef(soundOn); soundRef.current = soundOn
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions
  const activeRef = useRef(activeId); activeRef.current = activeId
  const setActiveRef = useRef(setActive); setActiveRef.current = setActive

  const nameOf = (id: string) => sessionsRef.current.find((s) => s.id === id)?.name ?? 'Session'

  // Are you actively watching this session right now? (active tab + focused window)
  const watching = (id: string) => id === activeRef.current && !document.hidden

  const signal = useCallback((id: string, title: string, body: string) => {
    if (watching(id)) return  // you're looking right at it — no need to nudge
    if (soundRef.current) playChime()
    if (enabledRef.current && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        const n = new Notification(title, { body, tag: id, icon: ICON })
        n.onclick = () => { window.focus(); setActiveRef.current(id); n.close() }
      } catch { /* construction unsupported in this context */ }
    }
  }, [])

  const prevState = useRef<Record<string, SessionState>>({})
  useEffect(() => {
    const offState = api.on.stateChange((id, state: SessionState) => {
      const prev = prevState.current[id]
      prevState.current[id] = state
      if (state === 'idle' && (prev === 'running' || prev === 'waiting')) {
        signal(id, `${nameOf(id)} — turn complete`, 'Claude finished responding.')
      }
    })
    const offPerm = api.on.permission((id) => {
      signal(id, `${nameOf(id)} — permission needed`, 'Claude is asking to use a tool.')
    })
    return () => { offState(); offPerm() }
  }, [signal])

  const toggle = useCallback(() => {
    if (wanted) {
      setWanted(false)
      try { localStorage.setItem(LS_NOTIF, '0') } catch { /* private mode */ }
      return
    }
    const grant = () => {
      setWanted(true)
      try { localStorage.setItem(LS_NOTIF, '1') } catch { /* private mode */ }
    }
    if (typeof Notification === 'undefined') { setPermission('unsupported'); return }
    if (Notification.permission === 'granted') { grant(); return }
    if (Notification.permission === 'denied') { setPermission('denied'); return }
    void Notification.requestPermission().then((p) => {
      setPermission(p)
      if (p === 'granted') grant()
    })
  }, [wanted])

  const toggleSound = useCallback(() => {
    setSoundOn((v) => {
      const next = !v
      try { localStorage.setItem(LS_SOUND, next ? '1' : '0') } catch { /* private mode */ }
      if (next) playChime()  // audible confirmation + unlocks the AudioContext on this gesture
      return next
    })
  }, [])

  return { enabled, permission, toggle, soundOn, toggleSound }
}
