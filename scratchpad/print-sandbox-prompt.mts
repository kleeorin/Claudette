import { sandboxSystemPrompt } from '../server/src/claude/sandbox.ts'
console.log(sandboxSystemPrompt(
  { enabled: true, gpu: false, mounts: [{ path: '/home/kleeorin/Work/Projects', mode: 'rw' }] } as any,
  '/home/kleeorin/Work/Projects/Claudette',
))
