// Stand-in for the `claude` CLI, for the team-orchestration tests.
//
// Three jobs:
//  1. Announce itself (system/init) so SessionManager marks the session ready.
//  2. Report its own argv as an event, so a test can assert what was in
//     --append-system-prompt (i.e. which team charter the session launched with).
//     SessionManager buffers every non-user, non-partial event, so the test just
//     reads it back out of transcriptOf().
//  3. Echo each user turn it receives, then go idle again after FAKE_TURN_MS.
//     That delay is the whole point: it gives the tests a window in which a session
//     is genuinely BUSY, which is what the mailbox's queue-until-idle rule turns on.
import readline from 'readline'

const say = (o) => process.stdout.write(JSON.stringify(o) + '\n')

say({ type: 'system', subtype: 'init', session_id: process.env.FAKE_SID || 'fake-session' })
say({ type: 'system', subtype: 'argv', argv: process.argv.slice(2) })

const turnMs = Number(process.env.FAKE_TURN_MS || '250')

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  // Surface the exact bytes the engine wrote, so a test can assert both WHAT was
  // delivered and HOW MANY turns it took (the coalescing assertion).
  say({ type: 'system', subtype: 'echo', raw: line })
  setTimeout(() => say({ type: 'result', subtype: 'success' }), turnMs)
})
