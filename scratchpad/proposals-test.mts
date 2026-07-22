// Unit test for the inline edit-proposal logic (web/src/lib/proposals.ts):
// apply the tool input to disk text → proposed diff; reconstruct a permission
// decision from the user's accepted result. Run: npx tsx scratchpad/proposals-test.mts
import { applyProposal, reconstructDecision, isEditTool, filePathOf, isNotebookPath } from '../web/src/lib/proposals.ts'

let pass = 0, fail = 0
const eq = (name: string, a: unknown, b: unknown) => {
  const ok = JSON.stringify(a) === JSON.stringify(b)
  if (ok) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}\n   got: ${JSON.stringify(a)}\n   exp: ${JSON.stringify(b)}`) }
}

const BASE = 'line one\nline two\nline three\n'

// --- classification ---
eq('isEditTool Edit', isEditTool('Edit'), true)
eq('isEditTool Write', isEditTool('Write'), true)
eq('isEditTool MultiEdit', isEditTool('MultiEdit'), true)
eq('isEditTool Bash', isEditTool('Bash'), false)
eq('filePathOf', filePathOf({ file_path: '/a/b.ts' }), '/a/b.ts')
eq('filePathOf missing', filePathOf({}), undefined)
eq('isNotebookPath', isNotebookPath('/x/n.ipynb'), true)
eq('isNotebookPath no', isNotebookPath('/x/n.ts'), false)

// --- Edit apply ---
eq('Edit apply', applyProposal(BASE, 'Edit', { old_string: 'line two', new_string: 'LINE 2' }),
  { proposed: 'line one\nLINE 2\nline three\n', ok: true })
eq('Edit miss', applyProposal(BASE, 'Edit', { old_string: 'nope', new_string: 'x' }),
  { proposed: BASE, ok: false })
eq('Edit replace_all', applyProposal('a a a', 'Edit', { old_string: 'a', new_string: 'b', replace_all: true }),
  { proposed: 'b b b', ok: true })
eq('Edit first-only', applyProposal('a a a', 'Edit', { old_string: 'a', new_string: 'b' }),
  { proposed: 'b a a', ok: true })

// --- MultiEdit apply (sequential) ---
eq('MultiEdit apply', applyProposal(BASE, 'MultiEdit', { edits: [
  { old_string: 'line one', new_string: 'ONE' },
  { old_string: 'line three', new_string: 'THREE' },
] }), { proposed: 'ONE\nline two\nTHREE\n', ok: true })
eq('MultiEdit one miss → fail', applyProposal(BASE, 'MultiEdit', { edits: [
  { old_string: 'line one', new_string: 'ONE' },
  { old_string: 'ghost', new_string: 'X' },
] }).ok, false)

// --- Write apply ---
eq('Write apply', applyProposal(BASE, 'Write', { content: 'brand new' }),
  { proposed: 'brand new', ok: true })

// --- reconstructDecision: whole-file replacement from accepted result ---
const editIn = { file_path: '/f.ts', old_string: 'line two', new_string: 'LINE 2' }
// user accepted all hunks → result === proposed
eq('Edit reconstruct (all accepted)',
  reconstructDecision('Edit', editIn, BASE, 'line one\nLINE 2\nline three\n'),
  { behavior: 'allow', updatedInput: { file_path: '/f.ts', old_string: BASE, new_string: 'line one\nLINE 2\nline three\n', replace_all: false } })
// user rejected all → result === base → deny
eq('Edit reconstruct (none accepted → deny)',
  reconstructDecision('Edit', editIn, BASE, BASE),
  { behavior: 'deny', message: 'No changes accepted' })
// verify the reconstructed Edit actually reproduces the accepted text on disk
{
  const d = reconstructDecision('Edit', editIn, BASE, 'line one\nLINE 2\nline three\n') as { updatedInput: { old_string: string; new_string: string } }
  const disk = BASE.replace(d.updatedInput.old_string, d.updatedInput.new_string)
  eq('Edit reconstruct round-trips on disk', disk, 'line one\nLINE 2\nline three\n')
}

// MultiEdit → collapses to a single whole-file edit
eq('MultiEdit reconstruct',
  reconstructDecision('MultiEdit', { file_path: '/f.ts', edits: [] }, BASE, 'ONE\nline two\nTHREE\n'),
  { behavior: 'allow', updatedInput: { file_path: '/f.ts', edits: [{ old_string: BASE, new_string: 'ONE\nline two\nTHREE\n' }] } })

// Write → content = result
eq('Write reconstruct',
  reconstructDecision('Write', { file_path: '/f.ts', content: 'full' }, BASE, 'partial'),
  { behavior: 'allow', updatedInput: { file_path: '/f.ts', content: 'partial' } })

// Edit on empty file → allow original (can't use whole-file old_string)
eq('Edit reconstruct empty base',
  reconstructDecision('Edit', { file_path: '/f.ts', old_string: '', new_string: 'x' }, '', 'x'),
  { behavior: 'allow' })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
