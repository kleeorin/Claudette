// Role handover notes (server/src/mcp/teamNotes.ts) — IS THE EXIT INTERVIEW STILL ON DISK?
//
// THE INCIDENT THIS PINS. `MAX_ENTRY_CHARS = 4000` used to be applied inside appendRoleNote,
// BEFORE writeFileSync, so the surplus was never written at all. On 2026-09-02 five exit
// interviews (PM, Architect, Critic, QA, Devil) were found already destroyed at rest — every
// one cut mid-sentence inside its recurring-defect section, taking the defect-pattern
// catalogue, the repo traps, the items VERIFIED CLOSED that a successor must not re-open, and
// the findings raised but never dispositioned. Three new hires reported the stubs before
// anyone realised there had never been a fuller copy. Those five are unrecoverable.
//
// The cap's PURPOSE is bounding what a new hire's first turn costs. That is a read-time
// concern, and doing it at write time additionally destroys the one artefact whose author is
// gone by the time anyone notices. So the property under test is the SPLIT:
//   · what reaches DISK is complete
//   · what reaches a FIRST TURN is bounded
// A test that checked only one of those would have passed against the old code.

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { check, failed as fail } from './assert.mjs'

const dir = mkdtempSync(path.join(tmpdir(), 'claudette-notes-'))
process.env.CLAUDETTE_DATA_DIR = dir

const notes = await import('../server/src/mcp/teamNotes.js')
const { appendRoleNote, readRoleNotes } = notes

const CWD = '/home/someone/Work/Projects/Demo'
const ROLE = 'reviewer'
const INJECT_CAP = 4000

// A note comfortably past the injection cap, with a UNIQUE MARKER IN ITS TAIL — the part the
// old code discarded. Everything here turns on whether that marker survives.
const TAIL_MARKER = 'THE-DEFECT-CATALOGUE-THAT-USED-TO-BE-DESTROYED'
const longNote = [
  '# EXIT INTERVIEW — the parts that matter are at the END',
  'x'.repeat(6000),
  '## 7. VERIFIED CLOSED — DO NOT RE-OPEN',
  TAIL_MARKER,
].join('\n')

try {
  appendRoleNote(CWD, ROLE, 'Critic', longNote)

  // --- what reached the DISK --------------------------------------------------------------
  const file = path.join(dir, 'team-notes', CWD.replace(/[^a-zA-Z0-9]/g, '-'), `${ROLE}.md`)
  check('the note is written to the role file', existsSync(file), file)
  const onDisk = readFileSync(file, 'utf8')
  check('THE TAIL SURVIVES ON DISK — the part the old write-time cap destroyed',
    onDisk.includes(TAIL_MARKER),
    {
      pass: `${onDisk.length} chars stored, tail intact`,
      fail: `${onDisk.length} chars stored and the marker is GONE — the exit interview is being `
        + 'truncated at rest again, and its author cannot be asked to rewrite it',
    })
  // Compared against the LENGTH OF THE NOTE, not against the cap. `> INJECT_CAP` was the
  // obvious phrasing and it stayed green under the write-time mutation — the stub is 4181
  // chars once the header and the truncation notice are added, so it clears a 4000 bar while
  // still being a destroyed note. Same "cannot falsify what it is cited for" shape caught in
  // the sandbox-defaults work; the only thing that catches it is running the mutation.
  check('and the whole note body is on disk, not merely more than the cap',
    onDisk.includes(longNote),
    `${onDisk.length} chars stored for a ${longNote.length}-char note — must contain it in full`)
  // POSITIVE and structural: the stored entry is the header line followed by EXACTLY the note.
  // The previous phrasing was `!onDisk.includes('truncated to')` — a NEGATED substring test
  // against a prose literal copied from the implementation's own message. Rewording the notice
  // (which Finding A then did) turns that green while the thing it forbids is happening, and
  // prose gets reworded by people who never open the test. Exact equality cannot drift: it
  // fails if anything at all is appended, whatever the wording.
  const storedBody = onDisk.slice(onDisk.indexOf('\n') + 1).trim()
  check('the stored copy is EXACTLY the note — no read-time notice is ever persisted',
    storedBody === longNote,
    `stored body is ${storedBody.length} chars for a ${longNote.length}-char note; `
      + `tail: ${JSON.stringify(storedBody.slice(-70))}`)

  // --- what reaches a FIRST TURN ----------------------------------------------------------
  const injected = readRoleNotes(CWD, ROLE)
  check('a new hire still receives a BOUNDED note — the cap survives, it just moved',
    !!injected && injected.length < onDisk.length,
    `injected ${injected?.length} chars vs ${onDisk.length} on disk`)
  check('and the injected copy stops at the cap rather than carrying the whole file',
    !!injected && !injected.includes(TAIL_MARKER),
    injected?.includes(TAIL_MARKER)
      ? 'the tail was injected — the first-turn cost is now unbounded, which is what the cap exists to prevent'
      : 'tail withheld from the first turn, as intended')
  // The sentence that turns a silent loss into a recovery. Without it a reader knows only
  // that something was cut, which is exactly the position three new hires were in.
  check('the truncation notice SAYS WHERE THE FULL NOTE IS, so the reader can ask for it',
    !!injected && injected.includes(file),
    `notice must name ${file}; got: ${JSON.stringify(injected?.slice(-220))}`)
  // THE NOTICE MUST NOT LIE TO THE FIVE NOTES THE FIX WAS WRITTEN FOR. Their surplus was
  // destroyed at write time, so "the full note is on disk" is FALSE for them — and they do
  // reach this path, because an old stub's body carries the previous implementation's own
  // truncation line, which pushes it over the cap. Sending a new hire to fetch text that no
  // longer exists turns an unknown into a confident falsehood, which is worse than the silence
  // it replaced. A POSITIVE assertion on the date: positive tests red on drift, which is the
  // safe direction — the negated prose checks this file used to carry went green on drift.
  check('and it CAVEATS entries written before the fix, whose surplus is already gone',
    !!injected && injected.includes('before 2026-09-04'),
    `the notice must not promise recoverable text for pre-fix stubs; got: ${JSON.stringify(injected?.slice(-260))}`)
  // THE BUDGET MUST BUY NOTE TEXT, not header. Measured as "how many leading characters of the
  // note actually arrived", because that is the quantity that matters and it is the only
  // phrasing that falsifies: asserting the header SURVIVES cannot detect this at all — under
  // entry-based capping the header is still there, intact, at the front, and it is the note's
  // last ~38 characters that quietly vanish instead. (Checked: that phrasing stayed green
  // under the mutation it was written for. Third instance of the same trap in this file, and
  // the first one I caught before reporting it as verified rather than after.)
  const noteStart = injected ? injected.indexOf(longNote.slice(0, 50)) : -1
  let delivered = 0
  while (injected && noteStart >= 0 && delivered < longNote.length
    && injected[noteStart + delivered] === longNote[delivered]) delivered++
  check('the injection budget is spent on the NOTE, not on its `## <iso> — <author>` header',
    delivered >= INJECT_CAP - 1,
    `only ${delivered} characters of the note arrived out of a ${INJECT_CAP}-character budget — `
      + 'the header is being charged to the content allowance')

  // --- a short note is untouched in both directions ---------------------------------------
  appendRoleNote(CWD, 'planner', 'PM', 'a short handover that needs no truncation at all')
  const shortInjected = readRoleNotes(CWD, 'planner')
  // Also positive, for the same reason: "ENDS WITH the note" is exactly "nothing was appended",
  // and it stays true however the notice is worded.
  const SHORT = 'a short handover that needs no truncation at all'
  check('a note under the cap is delivered whole, with nothing bolted on the end',
    !!shortInjected && shortInjected.endsWith(SHORT),
    `injected tail: ${JSON.stringify(shortInjected?.slice(-90))}`)

  // --- the rolling window still bounds the COUNT ------------------------------------------
  // MAX_ENTRIES exists for a different reason than the size cap and must not have been lost
  // in the move: an unbounded log of predecessors eventually costs more than it teaches.
  for (let i = 0; i < 7; i++) appendRoleNote(CWD, 'implementer', `author-${i}`, `note number ${i}`)
  const implFile = path.join(dir, 'team-notes', CWD.replace(/[^a-zA-Z0-9]/g, '-'), 'implementer.md')
  const kept = readFileSync(implFile, 'utf8').split('<!-- entry -->').length
  check('only the last 5 predecessors are kept — the count cap is intact',
    kept === 5, `${kept} entries kept`)
  check('and it keeps the NEWEST, not the oldest',
    readFileSync(implFile, 'utf8').includes('note number 6')
      && !readFileSync(implFile, 'utf8').includes('note number 0'),
    'the newest predecessor is the one most likely to still be true')
} finally {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.CLAUDETTE_DATA_DIR
}

process.exit(fail === 0 ? 0 : 1)
