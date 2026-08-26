// outputKeys is a pure function, so this needs no DOM, no renderer and no browser — the
// same reason the session reducer is testable. Test 2 is the one that fails against the
// array-index keying it replaces.
//
//   npx tsx scratchpad/output-keys-test.mts
import { outputKeys } from '../web/src/components/notebook/outputKeys'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}
const outs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }))

// 1. Below the cap, appending never disturbs an existing key.
{
  const before = outputKeys({ outputs: outs(3) })
  const after = outputKeys({ outputs: outs(5) })
  check('appending below the cap keeps every existing key', after.slice(0, 3).join() === before.join(),
    `${before.join()} vs ${after.slice(0, 3).join()}`)
  check('each appended output gets a new key', new Set(after).size === 5)
}

// 2. THE ONE THAT MATTERS. Crossing MAX_OUTPUTS splices the front, so the array shifts —
//    but each SURVIVING output must keep the key it already had. With key={i} the survivor
//    at old index 2 becomes index 0 and silently inherits the first output's mounted node.
{
  // 5 outputs, then 2 dropped from the front: the survivors are old indices 2,3,4.
  const beforeDrop = outputKeys({ outputs: outs(5), outputsDropped: 0 })
  const afterDrop = outputKeys({ outputs: outs(3), outputsDropped: 2 })
  check('survivors keep their original keys across a front-drop',
    afterDrop.join() === beforeDrop.slice(2).join(), `${beforeDrop.slice(2).join()} vs ${afterDrop.join()}`)
  // State the counterfactual explicitly, so the test says WHY it exists rather than only
  // what it checks.
  const indexKeys = outs(3).map((_, i) => `o${i}`)
  check('…and the array index would NOT have (this is the bug being fixed)',
    indexKeys.join() !== afterDrop.join(), `index=${indexKeys.join()} stable=${afterDrop.join()}`)
}

// 3. Keys are unique within a cell — a duplicate key silently drops a rendered output.
{
  const k = outputKeys({ outputs: outs(50), outputsDropped: 17 })
  check('keys are unique within a cell', new Set(k).size === k.length)
}

// 4. Degenerate shapes: a markdown cell with no outputs, and a cell the server has not yet
//    annotated. The second is the pre-server-half state and MUST equal today's behaviour,
//    which is what makes this file safe to ship before notebookDocManager changes.
{
  check('no outputs → no keys', outputKeys({}).length === 0)
  check('empty outputs → no keys', outputKeys({ outputs: [] }).length === 0)
  const unannotated = outputKeys({ outputs: outs(4) })
  check('without outputsDropped the keys are exactly the array index (ships inert)',
    unannotated.join() === 'o0,o1,o2,o3', unannotated.join())
}

// WHEN THE SERVER HALF LANDS, add here: drive a real NotebookDocManager past MAX_OUTPUTS
// via appendCellOutput and assert the emitted cell's outputsDropped matches the number
// spliced at notebookDocManager.ts:474. That is the integration half this file cannot reach
// today, and without it the counter could drift from the splice with these tests still green.
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
