import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { xml } from '@codemirror/lang-xml'
import { rust } from '@codemirror/lang-rust'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { go } from '@codemirror/lang-go'
import { php } from '@codemirror/lang-php'
import { sql } from '@codemirror/lang-sql'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'

// Filename → CodeMirror language, for syntax colouring in the file editor. Ported
// from ClaudeMaster. Unknown types render as editable plain text (no tokens).
const ts = () => javascript({ jsx: true, typescript: true })
const js = () => javascript({ jsx: true })
const sh = () => StreamLanguage.define(shell)

// Map file extension (no dot, lowercase) → CodeMirror language extension.
const byExt: Record<string, () => Extension> = {
  py: python, pyw: python, pyi: python,
  js: js, mjs: js, cjs: js, jsx: js,
  ts: ts, mts: ts, cts: ts, tsx: ts,
  json: json, jsonc: json,
  html: html, htm: html, vue: html, svelte: html,
  css: css, scss: css, less: css,
  md: markdown, markdown: markdown,
  yml: yaml, yaml: yaml,
  xml: xml, svg: xml,
  rs: rust,
  c: cpp, h: cpp, cc: cpp, cpp: cpp, cxx: cpp, hpp: cpp, hh: cpp,
  java: java,
  go: go,
  php: php,
  sql: sql,
  sh: sh, bash: sh, zsh: sh,
  toml: () => StreamLanguage.define(toml),
  dockerfile: () => StreamLanguage.define(dockerFile),
}

// Filenames that have no useful extension.
const byName: Record<string, () => Extension> = {
  dockerfile: () => StreamLanguage.define(dockerFile),
  '.bashrc': sh, '.zshrc': sh, '.profile': sh,
}

// Returns a language extension for the given filename, or null if we don't
// recognize it (CodeMirror then renders editable plain text with no tokens).
export function languageForFilename(name: string): Extension | null {
  const lower = name.toLowerCase()
  if (byName[lower]) return byName[lower]()
  const dot = lower.lastIndexOf('.')
  const ext = dot >= 0 ? lower.slice(dot + 1) : ''
  return byExt[ext] ? byExt[ext]() : null
}
