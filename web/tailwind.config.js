/** @type {import('tailwindcss').Config} */
// Claudette's design system — a refined dark, dev-tool aesthetic: near-black slate
// surfaces, one warm coral accent, hairline borders, high contrast, compact.
//
// The token namespace is `ctp-*` for historical reasons (components ported from
// ClaudeMaster reference it), but the VALUES are Claudette's own — not Catppuccin.
// `ctp-blue` / `ctp-accent` are the single coral accent (primary actions, focus,
// links, your messages); green/yellow/red stay semantic (allow / warn / error);
// `ctp-mauve` is a calm cool secondary used only for tool headers.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      animation: {
        blink: 'blink 1s step-end infinite',
        'fade-in': 'fade-in 0.18s ease-out',
      },
      keyframes: {
        blink: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0' } },
        'fade-in': { from: { opacity: '0', transform: 'translateY(2px)' }, to: { opacity: '1', transform: 'none' } },
      },
      colors: {
        ctp: {
          base:     '#17181c', // app background
          mantle:   '#1d1e23', // panels: sidebar, composer, cards
          crust:    '#131417', // deepest: code blocks
          text:     '#e7e8ea',
          subtext:  '#aeb3bb',
          overlay:  '#7b818b', // muted / metadata
          surface0: '#24262c', // hairline borders, subtle hover
          surface1: '#31343b', // stronger borders
          surface2: '#474b54', // faint text on bars
          blue:     '#e08a5f', // ← the coral accent (primary)
          accent:   '#e08a5f',
          green:    '#82b896',
          yellow:   '#d6a95f',
          peach:    '#e0a67d',
          red:      '#dc7b7b',
          mauve:    '#93a4d6', // tool headers (cool secondary)
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.3)',
        pop: '0 8px 24px rgba(0,0,0,0.45)',
      },
    },
  },
  plugins: [],
}
