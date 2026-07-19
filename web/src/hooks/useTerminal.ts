import { useCallback, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

// xterm setup for a terminal pane. Ported from ClaudeMaster's `useTerminal.ts`,
// minus the `terminalRegistry` (a multi-pane right-click-paste helper we don't need
// for the single pane yet). Wire it to a pane via the `api` object; output arrives
// over WS, input/resize go back over WS.

const THEME = {
  background:          '#1e1e2e',
  foreground:          '#cdd6f4',
  cursor:              '#f5c2e7',
  cursorAccent:        '#1e1e2e',
  selectionBackground: '#45475a88',
  black:               '#45475a',
  red:                 '#f38ba8',
  green:               '#a6e3a1',
  yellow:              '#f9e2af',
  blue:                '#89b4fa',
  magenta:             '#f5c2e7',
  cyan:                '#94e2d5',
  white:               '#bac2de',
  brightBlack:         '#585b70',
  brightRed:           '#f38ba8',
  brightGreen:         '#a6e3a1',
  brightYellow:        '#f9e2af',
  brightBlue:          '#89b4fa',
  brightMagenta:       '#f5c2e7',
  brightCyan:          '#94e2d5',
  brightWhite:         '#a6adc8',
}

const OPTIONS = {
  theme: THEME,
  fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", "Courier New", monospace',
  fontSize: 14,
  lineHeight: 1.2,
  cursorBlink: true,
  allowTransparency: false,
  scrollback: 50000,
} as const

export interface TerminalAPI {
  sendInput: (data: string) => void
  sendResize: (cols: number, rows: number) => void
  subscribeOutput: (cb: (data: string) => void) => () => void
}

export function useTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  api: TerminalAPI,
): { fit: () => void; focus: () => void; getSize: () => { cols: number; rows: number } | null } {
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const apiRef = useRef(api)
  apiRef.current = api

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const term = new Terminal(OPTIONS)
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    const rafId = requestAnimationFrame(() => fit.fit())
    fitRef.current = fit
    termRef.current = term

    term.onData((data) => apiRef.current.sendInput(data))
    term.onResize(({ cols, rows }) => apiRef.current.sendResize(cols, rows))

    const ro = new ResizeObserver((entries) => {
      if (entries[0]?.contentRect.width > 0) fit.fit()
    })
    ro.observe(el)

    const offOutput = apiRef.current.subscribeOutput((data) => term.write(data))

    return () => {
      cancelAnimationFrame(rafId)
      offOutput()
      ro.disconnect()
      term.dispose()
      fitRef.current = null
      termRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const fit = useCallback(() => fitRef.current?.fit(), [])
  const focus = useCallback(() => termRef.current?.focus(), [])
  const getSize = useCallback(() => {
    const t = termRef.current
    return t ? { cols: t.cols, rows: t.rows } : null
  }, [])
  return { fit, focus, getSize }
}
