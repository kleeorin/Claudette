// A FAILED TURN MUST NOT RENDER AS A SUCCESSFUL ONE.
//
// The CLI reports an authentication failure in a `result` frame that ALSO carries
// `subtype: 'success'`. Frame shape verified 2026-08-24 by starving the CLI of credentials
// (CLAUDE_CONFIG_DIR pointed at an empty dir). The old classifier was:
//     is_error === true || /error/i.test(subtype)
// which is FALSE for that frame — so the turn rendered as a success: no error text, no notice,
// nothing at all. The user sees a turn that silently did nothing, and logs in again. That is
// what "OAuth keeps coming up" looks like from the outside. The CLI writes NOTHING to stderr on
// this path, so this frame is the only witness there is.
//
// Test 1 is the one that fails against the old classifier. The rest are regression guards, and
// test 5 is the control that stops the fix from over-firing.
//
//   npx tsx scratchpad/result-error-classification-test.mts
import { itemsFromEvent } from '../web/src/store/chat'

let pass = 0, fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  ok ? pass++ : fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`)
}
const resultOf = (e: unknown) => itemsFromEvent(e as never).find((i) => i.kind === 'result') as
  { kind: 'result'; isError?: boolean; errorText?: string } | undefined

// The real frame, as captured. NOTE subtype:'success' and NO is_error field.
const AUTH_FAIL = {
  type: 'result', subtype: 'success',
  error: 'authentication_failed', is_api_error_message: true, terminal_reason: 'api_error',
  result: 'Not logged in · Please run /login',
}

// 1. THE ONE THAT FAILS AGAINST THE OLD CLASSIFIER.
{
  const r = resultOf(AUTH_FAIL)
  check('an auth failure labelled subtype:success is classified as an ERROR', r?.isError === true,
    `isError=${r?.isError}`)
}
// 2. …and the user is told what actually happened, not given a generic message.
{
  const t = resultOf(AUTH_FAIL)?.errorText ?? ''
  check('the auth failure surfaces actionable text mentioning login', /not logged in/i.test(t) && /login/i.test(t),
    JSON.stringify(t))
}
// 3. is_api_error_message alone is enough (a future frame may drop `error`).
{
  const r = resultOf({ type: 'result', subtype: 'success', is_api_error_message: true, result: 'boom' })
  check('is_api_error_message alone marks the turn failed', r?.isError === true)
}
// 4. terminal_reason alone is enough.
{
  const r = resultOf({ type: 'result', subtype: 'success', terminal_reason: 'api_error', result: 'boom' })
  check('terminal_reason:api_error alone marks the turn failed', r?.isError === true)
}
// 5. CONTROL — the fix must not turn every successful turn red. Without this, "classify
//    everything as an error" would pass tests 1-4 and be catastrophically wrong.
{
  const r = resultOf({ type: 'result', subtype: 'success', result: 'all good', total_cost_usd: 0.01 })
  check('(control) a genuine success is STILL not an error', r?.isError === false && r?.errorText === undefined,
    `isError=${r?.isError}`)
}
// 6. Regression: the pre-existing paths still classify.
{
  const a = resultOf({ type: 'result', subtype: 'error_during_execution' })
  const b = resultOf({ type: 'result', subtype: 'success', is_error: true, result: 'x' })
  check('(regression) subtype containing "error" still classifies', a?.isError === true)
  check('(regression) explicit is_error:true still classifies', b?.isError === true)
}

console.log(`\n${fail === 0 ? '🎉 all passed' : `💥 ${fail} failed`}  (${pass} passed)`)
process.exit(fail === 0 ? 0 : 1)
