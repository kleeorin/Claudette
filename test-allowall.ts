import { ClaudeEngine } from './server/src/claude/claudeEngine'
import type { PermissionMode } from './shared/src/types'

// Drive the engine with the fake CLI and observe: did it PROMPT (emit 'permission')
// or AUTO-ALLOW (write a behavior:allow control_response, echoed back on stderr)?
function run(mode: PermissionMode): Promise<{ prompted: boolean; autoAllowed: boolean }> {
  return new Promise((resolve) => {
    const engine = new ClaudeEngine({
      command: 'node', args: ['./fake-claude.mjs'],
      cwd: process.cwd(), env: process.env as Record<string, string>,
      permissionMode: mode,
    })
    let prompted = false
    let autoAllowed = false
    engine.on('permission', () => { prompted = true })
    engine.on('event', (e: { type?: string; text?: string }) => {
      if (e.type === 'stderr' && typeof e.text === 'string'
        && e.text.includes('RESP') && e.text.includes('"behavior":"allow"')) autoAllowed = true
    })
    engine.start()
    setTimeout(() => { engine.kill(); resolve({ prompted, autoAllowed }) }, 1200)
  })
}

const bypass = await run('bypassPermissions')
const def = await run('default')
console.log('bypassPermissions →', bypass, '(expect prompted:false, autoAllowed:true)')
console.log('default           →', def, '(expect prompted:true,  autoAllowed:false)')
const ok = !bypass.prompted && bypass.autoAllowed && def.prompted && !def.autoAllowed
console.log(ok ? '\nPASS ✅  allow-all auto-approves; default still prompts' : '\nFAIL ❌')
process.exit(ok ? 0 : 1)
