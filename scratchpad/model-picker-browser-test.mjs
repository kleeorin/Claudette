// The per-session MODEL PICKER, driven in a real browser against the shared :4321 server.
//
// ★ WHY THIS EXISTS. modelPicker.ts is well covered as pure functions (23 vitest cases), but
// the MENU that uses them had never run in a browser, and the FAILURE path — `run()` setting
// `modelErr`, the menu deliberately staying open, `busy` disabling the rows — had no test at
// any layer. Nothing in this repo imports App.tsx, so that code was invisible to vitest, to
// typecheck-as-coverage, and to every other harness.
//
// ★★ THE ASSERTION THAT MATTERS MOST IS THE FAILURE ONE. The menu is a PORTAL: on success it
// closes. The deliberate design is that on failure it must NOT, because a portal that vanishes
// has nowhere left to say what went wrong — the user would click "opus", see the menu close,
// and reasonably believe it worked. So the failure case asserts BOTH halves: the error text is
// shown AND the menu is still on screen. Asserting only the text would pass against a menu
// that flashed the message and closed.
//
//   node scratchpad/model-picker-browser-test.mjs
// Needs a server on :4321 — start one by hand with:
//   PORT=4321 HOST=127.0.0.1 CLAUDETTE_NO_AUTH=1 CLAUDETTE_DATA_DIR=$(mktemp -d) npx tsx src/index.ts
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'
import { assertSharedServerIsOurs } from './shared-server.mjs'

const APP = 'http://127.0.0.1:4321'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
let passed = 0, failed = 0
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`✅ ${name}${extra ? ` — ${extra}` : ''}`) }
  else { failed++; console.log(`❌ ${name}${extra ? ` — ${extra}` : ''}`) }
}

// Whose server is on :4321? A single-file run has no runner to probe for it, which is the
// ungoverned route this guard exists to close.
await assertSharedServerIsOurs()

const CHROME = process.env.CHROME_BIN
  ?? '/home/kleeorin/Work/Projects/Claudette/.chrome-headless/chrome/linux-151.0.7922.34/chrome-linux64/chrome'
const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-model-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=9371', `--user-data-dir=${chromeDir}`,
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1400,900',
  'about:blank',
], { stdio: 'pipe', detached: true })
// Reap by process GROUP on EVERY exit path. A throw mid-run otherwise orphans the whole
// headless tree, which quietly eats the machine.
const reapChrome = () => { try { process.kill(-chrome.pid, 'SIGKILL') } catch { try { chrome.kill('SIGKILL') } catch {} } }
process.on('exit', reapChrome)
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (e) => { reapChrome(); if (e) console.error(e); process.exit(1) })
}

async function cdpTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9371/json')).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await wait(250)
  }
  throw new Error('no CDP target')
}
const cdp = new WebSocket(await cdpTarget())
await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej) })
let cdpId = 0, cdpDone = false
const pending = new Map()
cdp.on('message', (d) => {
  const m = JSON.parse(d.toString())
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
})
// If Chrome dies mid-run every pending send() would hang forever, holding ports. Abort loudly.
cdp.on('close', () => { if (cdpDone) return; console.error('CDP socket closed — Chrome died'); process.exit(1) })
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++cdpId; pending.set(i, { res, rej }); cdp.send(JSON.stringify({ id: i, method, params })) })

await send('Page.enable'); await send('Runtime.enable')
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval threw')
  return r.result.value
}
const until = async (expr, ms = 15000, label = expr) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { try { if (await js(expr)) return true } catch {} await wait(200) }
  throw new Error(`timeout: ${label}`)
}

// Click a button by its visible text. Returns false when absent, so callers can assert rather
// than hang.
const clickText = (txt) => js(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith(${JSON.stringify(txt)}));if(!b)return false;b.click();return true})()`)
// ★ STRUCTURAL, NOT innerText. MEASURED 2026-10-05: the "Full model id" label is rendered and
// its input is in the DOM, yet `document.body.innerText` does NOT contain that string — the
// menu is a fixed-position portal and innerText skipped it. A text probe here is a FALSE
// NEGATIVE that reads as "the menu never opened", which is what it cost on the first run.
const menuOpen = () => js(`!!document.querySelector('input[aria-label="Full model id"]')`)
const bodyHas = (txt) => js(`document.body.innerText.includes(${JSON.stringify(txt)})`)

// Open the ⋯ menu on OUR row. Every call used to click the FIRST "Session actions" button on the
// page. Alone on a fresh server that is ours; in the suite's shared :4321 group other harnesses'
// sessions are listed too, so the harness drove someone else's session — the ✓ still moved (it
// re-opened the same wrong menu) but the next-message notice did not appear. Measured 2026-10-06:
// 3 reds in 4 group runs, 5/5 green standalone. Walk up from the row's name to the nearest
// ancestor that holds a Session actions button, and refuse (false) if there is none.
const openOurMenu = () => js(`(()=>{const leaf=[...document.querySelectorAll('*')].find(n=>n.children.length===0&&n.textContent.trim()==='ModelPick');
  for(let e=leaf;e;e=e.parentElement){const b=e.querySelector&&e.querySelector('button[title="Session actions"]');if(b){b.click();return true}}
  return false})()`)

try {
  await send('Page.navigate', { url: APP })
  await until(`document.querySelector('#root')?.children.length > 0`, 20000, 'app mounted')

  // A session to operate on. Created through the API so the harness does not depend on the
  // new-session dialog's markup, which is not this file's subject.
  const cwd = await mkdtemp(join(tmpdir(), 'model-pick-'))
  const created = await js(`fetch('/api/session/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'ModelPick',cwd:${JSON.stringify(cwd)}})}).then(r=>r.json())`)
  check('a session was created to drive the menu', !!created?.id, JSON.stringify(created))
  await until(`document.body.innerText.includes('ModelPick')`, 15000, 'session row appears')

  // Open the ⋯ menu on that row, then the Model submenu.
  check('our row\'s Session actions button was found', await openOurMenu())
  await wait(400)
  check('the session menu opened', await clickText('🧠 Model'), 'clicked 🧠 Model')
  await until(`!!document.querySelector('input[aria-label="Full model id"]')`, 8000, 'model submenu')

  // ── PICK AN ALIAS ────────────────────────────────────────────────────────────────────────
  check('an alias row is offered', await js(`!!([...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('opus')))`))
  await clickText('opus')
  await wait(900)
  // The menu CLOSES on success — that is the designed difference from the failure path below.
  check('★ picking an alias closes the menu (success path)', (await menuOpen()) === false)

  // Re-open and confirm the tick moved, and the next-message notice is shown.
  await openOurMenu()
  await wait(300); await clickText('🧠 Model'); await wait(400)
  check('★ the ✓ moved to the chosen alias',
    await js(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('opus'));return !!b&&b.textContent.includes('✓')})()`))
  // POLLED, and on textContent. The ✓ comes from session.model and the notice from
  // session.modelPending; they can land a render apart, and one read after a fixed 400ms wait
  // went red 1 run in 4 on 2026-10-06 with the ✓ already moved. innerText also skips content it
  // considers not rendered, which is the portal trap recorded above; textContent does not.
  const sawNotice = await until(`document.body.textContent.includes('Applies to your next message.')`, 4000, 'next-message notice')
    .then(() => true, () => false)
  check('★ "Applies to your next message." is shown', sawNotice)

  // ── FULL ID, THEN CLEAR ──────────────────────────────────────────────────────────────────
  const typeInto = async (value) => js(`(()=>{const i=document.querySelector('input[aria-label="Full model id"]');if(!i)return false;
    const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(value)});
    i.dispatchEvent(new Event('input',{bubbles:true}));
    i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true})()`)
  check('the full-id field is present', await menuOpen())
  await typeInto('claude-opus-5-5'); await wait(900)
  check('★ submitting a full id closes the menu', (await menuOpen()) === false)
  await openOurMenu()
  await wait(300); await clickText('🧠 Model'); await wait(400)
  check('★ the custom id is seeded back into the field (it is the session\'s model)',
    await js(`document.querySelector('input[aria-label="Full model id"]')?.value === 'claude-opus-5-5'`),
    await js(`document.querySelector('input[aria-label="Full model id"]')?.value`))

  await typeInto(''); await wait(900)
  await openOurMenu()
  await wait(300); await clickText('🧠 Model'); await wait(400)
  check('★ an empty submission clears the override (Account default is ticked)',
    await js(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('Account default'));return !!b&&b.textContent.includes('✓')})()`))

  // ── ★★ THE FAILURE PATH ──────────────────────────────────────────────────────────────────
  // Intercept setModel IN THE PAGE and answer 500. Patching window.fetch rather than using the
  // CDP Fetch domain keeps the failure confined to this one route: a CDP-level block would
  // also break the websocket reconnect and session:list, and the menu would then be failing
  // for a reason the test did not choose.
  await js(`(()=>{const orig=window.fetch;window.__origFetch=orig;window.fetch=(u,o)=>{
    const url=typeof u==='string'?u:(u&&u.url)||'';
    if(url.includes('/api/session/setModel')) return Promise.resolve(new Response(JSON.stringify({ok:false}),{status:500,headers:{'content-type':'application/json'}}));
    return orig(u,o)};return true})()`)
  await clickText('sonnet')
  await wait(900)
  check('★★ the menu STAYS OPEN when setModel fails', (await menuOpen()) === true)
  check('★★ …and shows "Setting the model failed."', await bodyHas('Setting the model failed.'))
  // ★ PORTED from the duplicate harness (model-picker-ui-test.mjs) before it was removed —
  // the one assertion it had that this file lacked, and it is worth keeping. A write that
  // FAILED must not move the ✓: showing the error while the tick has already jumped to the
  // row the user clicked tells them two contradictory things at once, and the tick is the one
  // they will believe. Reads the tick from the rendered menu, so it fails if the UI optimistically
  // moved the selection ahead of the server.
  const checkedRow = () => js(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('✓'));return b?b.textContent.replace('✓','').trim():null})()`)
  check('★ …and the selection does NOT move on a failed write',
    (await checkedRow()) === 'Account default', `✓ on ${await checkedRow()}`)
  await js(`window.fetch = window.__origFetch; true`)
} finally {
  cdpDone = true
  try { cdp.close() } catch {}
  reapChrome()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
