// Shared helper: answer the workspace-trust modal that now sits in the session-create flow.
//
// WHY THIS EXISTS. Creating a session from the UI used to be "type a cwd, click Create
// session". It no longer is. App.tsx:1175 checks `api.http.checkTrust(dir)` first and, for
// an untrusted folder, sets `pendingTrust` and RETURNS — a ConfirmDialog titled "Trust this
// folder?" drives the rest. Two harnesses predated that gate and never answered it, so no
// session was ever created; the next line then did
//   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta, …)
// with `ta === null`, which throws `TypeError: Illegal invocation` — an error that names
// neither the textarea nor the trust dialog and reads like a CDP fault. Both files sat red
// on it. The cost of that diagnosis is why this lives in ONE place: a third copy is how it
// rots again.
//
// WHY IT CLICKS THE MODAL rather than pre-trusting over the API. `POST /api/session/trust`
// would also work and is one line, but it walks around the gate instead of through it — the
// harness would then pass even if the modal were broken, and these files exist to drive the
// real UI. Answering the dialog exercises the path a user takes. (No existing harness had a
// path to reuse: the ones that create sessions successfully, e.g. scroll-memory-check.mjs,
// POST /api/session/create directly and never render the dialog at all.)
//
// It is deliberately CONDITIONAL, not an assertion. A folder already trusted in the server's
// data dir shows no modal, and that is a correct state, not a failure — so `absent` is a
// normal return. What it must never do is swallow a real breakage: if the dialog is missing
// because the create flow died for some other reason, the caller's own wait for the composer
// still fails, and now with a legible message instead of the TypeError above.

const TRUST_BUTTON = 'Trust folder'   // App.tsx confirmLabel on the "Trust this folder?" dialog

/**
 * Click the workspace-trust confirmation if it is showing.
 * @param evaluate  the caller's CDP evaluate(expression) → value
 * @returns 'answered' if the dialog appeared and was confirmed, 'absent' if it never showed
 */
export async function answerTrustGate(evaluate, { timeoutMs = 6000, pollMs = 200 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const clicked = await evaluate(
      `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(TRUST_BUTTON)});if(!b)return false;b.click();return true})()`,
    )
    if (clicked) return 'answered'
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return 'absent'
}

/**
 * Wait for the chat composer. Exists so that "no session was created" reports itself as
 * exactly that, instead of as a TypeError from a value-setter called on null three lines
 * later. Throws with a message naming the real precondition.
 */
export async function waitForComposer(evaluate, { timeoutMs = 15000, pollMs = 200 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(`!!document.querySelector('textarea')`)) return true
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(
    'composer textarea never appeared — the session was not created. Check whether the ' +
    '"Trust this folder?" dialog is showing (see answerTrustGate) or /api/session/create failed.',
  )
}
