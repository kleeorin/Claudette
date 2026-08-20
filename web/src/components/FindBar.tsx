import { MATCH_LIMIT, type FindOptions } from '../lib/findMatches'
import type { FindState } from '../lib/useFind'

// The find bar every editor shares — code, diff, markdown, CSV grid, notebook. One
// component so the keys, the counter and the option toggles mean the same thing
// wherever you hit Ctrl/Cmd-F, instead of each editor growing its own dialect.
//
// Purely presentational: it renders `find` (the useFind state) and calls back. The
// editor decides what a match IS and how to reveal one.
interface Props {
  find: FindState
  count: number                  // total matches for the current query
  invalid?: boolean              // query is a broken regex
  placeholder?: string
  /** Omitted for read-only surfaces (a diff review, a truncated file) — find only. */
  onReplace?: () => void
  onReplaceAll?: () => void
}

export function FindBar({ find, count, invalid, placeholder = 'Find…', onReplace, onReplaceAll }: Props) {
  const { open, query, replacement, opts, index, inputRef, setReplacement, changeQuery, setOpts, closeFind, step } = find
  if (!open) return null

  const canReplace = !!onReplace && count > 0
  const truncated = count >= MATCH_LIMIT

  const onFieldKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); step(count, e.shiftKey ? -1 : 1) }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind() }
  }

  return (
    <div className="shrink-0 bg-ctp-surface0/60 border-b border-ctp-surface0">
      {/* Wraps rather than squeezing: an editor in a narrow split still gets a usable
          query field, with the toggles dropping to a second line instead of shaving
          the input down to a few characters. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
        <span className="text-ctp-overlay text-xs">⌕</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => changeQuery(e.target.value)}
          onKeyDown={onFieldKey}
          placeholder={placeholder}
          spellCheck={false}
          className={`flex-1 min-w-[110px] bg-transparent text-xs outline-none placeholder:text-ctp-overlay ${invalid ? 'text-ctp-red' : 'text-ctp-text'}`}
        />
        <Toggle on={opts.caseSensitive} onClick={() => setOpts({ caseSensitive: !opts.caseSensitive })} title="Match case">Aa</Toggle>
        <Toggle on={opts.wholeWord} onClick={() => setOpts({ wholeWord: !opts.wholeWord })} title="Whole word">ab|</Toggle>
        <Toggle on={opts.regex} onClick={() => setOpts({ regex: !opts.regex })} title="Regular expression">.*</Toggle>
        <span className="text-[11px] text-ctp-overlay tabular-nums shrink-0 min-w-[52px] text-right">
          {invalid ? 'bad regex' : count ? `${Math.min(index, count - 1) + 1}/${count}${truncated ? '+' : ''}` : (query ? '0/0' : '')}
        </span>
        <Icon onClick={() => step(count, -1)} disabled={!count} title="Previous (Shift+Enter)">↑</Icon>
        <Icon onClick={() => step(count, 1)} disabled={!count} title="Next (Enter)">↓</Icon>
        <Icon onClick={closeFind} title="Close (Esc)">✕</Icon>
      </div>

      {onReplace && (
        <div className="flex items-center gap-2 px-3 pb-1.5">
          <span className="text-ctp-overlay text-xs">⇥</span>
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); if (canReplace) onReplace() }
              else if (e.key === 'Escape') { e.preventDefault(); closeFind() }
            }}
            placeholder={opts.regex ? 'Replace with… ($1, $&)' : 'Replace with…'}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent text-xs text-ctp-text placeholder:text-ctp-overlay outline-none"
          />
          <button
            onClick={onReplace}
            disabled={!canReplace}
            title="Replace this match (Enter)"
            className="text-[11px] px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-subtext hover:bg-ctp-surface1 disabled:opacity-30 disabled:hover:bg-ctp-surface0 transition"
          >Replace</button>
          <button
            onClick={onReplaceAll}
            disabled={!canReplace || !onReplaceAll}
            title={`Replace all ${count} matches`}
            className="text-[11px] px-2 py-0.5 rounded bg-ctp-surface0 text-ctp-subtext hover:bg-ctp-surface1 disabled:opacity-30 disabled:hover:bg-ctp-surface0 transition"
          >All</button>
        </div>
      )}
    </div>
  )
}

// An option toggle (case / word / regex). Lit when on, so the query's meaning is
// readable at a glance rather than hidden in a menu.
function Toggle({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      onMouseDown={(e) => e.preventDefault()}   // don't steal focus from the query field
      className={`shrink-0 h-5 px-1.5 rounded text-[10px] font-mono leading-none transition-colors ${
        on ? 'bg-ctp-accent/25 text-ctp-accent' : 'text-ctp-overlay hover:text-ctp-text hover:bg-ctp-surface1'
      }`}
    >
      {children}
    </button>
  )
}

function Icon({ onClick, disabled, title, children }: { onClick: () => void; disabled?: boolean; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      className="shrink-0 text-xs text-ctp-overlay hover:text-ctp-text disabled:opacity-30 disabled:hover:text-ctp-overlay px-1"
    >
      {children}
    </button>
  )
}

/** Ctrl/Cmd-F for the editors that catch it on a container rather than in a keymap. */
export function isFindKey(e: React.KeyboardEvent | KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')
}

export type { FindOptions }
