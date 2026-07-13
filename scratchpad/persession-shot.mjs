// Verify content panes are PER SESSION: open README.md in session A and sample.ts
// in session B, then switch back and forth — each session shows only its own tab.
//   node scratchpad/persession-shot.mjs
import { spawn } from 'child_process'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { WebSocket } from 'ws'

const APP = 'http://127.0.0.1:4321'
const OUT = '/tmp/claudette-shots'
const CWD = '/tmp/claudette-fs-test'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await new Promise((r) => spawn('mkdir', ['-p', OUT]).on('exit', r))

const chromeDir = await mkdtemp(join(tmpdir(), 'chrome-ps-'))
const chrome = spawn('/usr/bin/google-chrome', ['--headless=new', '--remote-debugging-port=9350', `--user-data-dir=${chromeDir}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1500,940', 'about:blank'], { stdio: 'pipe' })
async function cdpTarget() { for (let i = 0; i < 40; i++) { try { const list = await (await fetch('http://127.0.0.1:9350/json')).json(); const p = list.find((t) => t.type === 'page'); if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl } catch {} await wait(250) } throw new Error('no CDP') }
const cdp = new WebSocket(await cdpTarget())
await new Promise((res, rej) => { cdp.on('open', res); cdp.on('error', rej) })
let cdpId = 0; const pending = new Map()
cdp.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => { const id = ++cdpId; return new Promise((res) => { pending.set(id, res); cdp.send(JSON.stringify({ id, method, params })) }) }
const evaluate = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const { writeFile } = await import('fs/promises'); await writeFile(`${OUT}/${n}.png`, Buffer.from(r.result.data, 'base64')); console.log(`📸 ${n}`) }
const waitFor = async (e, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evaluate(e)) return true; await wait(200) } throw new Error(`timeout ${e}`) }
const clickText = (l) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(l)});if(!b)return false;b.click();return true})()`)
const clickTitle = (t) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title===${JSON.stringify(t)});if(!b)return false;b.click();return true})()`)
const clickInc = (s) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent&&x.textContent.includes(${JSON.stringify(s)}));if(!b)return false;b.click();return true})()`)
// Which content tabs are present in the tab strip (readable labels).
const contentTabs = () => evaluate(`[...document.querySelectorAll('span')].filter(s=>/README\\.md|sample\\.ts/.test(s.textContent)&&s.querySelector('button')).map(s=>s.textContent.replace(/[✕●]/g,'').trim())`)
const clickSession = (name) => evaluate(`(()=>{const d=[...document.querySelectorAll('div')].find(x=>x.textContent&&x.textContent.trim()===${JSON.stringify(name)}&&x.className.includes('truncate'));if(!d)return false;(d.closest('.cursor-pointer')||d).click();return true})()`)

async function newSession(name) {
  await clickTitle('New session')
  await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Create session'))`)
  // name field (first input, placeholder mentions folder name) + cwd (mono input)
  await evaluate(`(()=>{const set=(el,v)=>{const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
    const inputs=[...document.querySelectorAll('input')];
    const nameInp=inputs.find(i=>(i.placeholder||'').includes('folder name'));
    const cwdInp=inputs.find(i=>i.className.includes('font-mono'));
    if(nameInp)set(nameInp,${JSON.stringify(name)}); if(cwdInp)set(cwdInp,${JSON.stringify(CWD)}); return true})()`)
  await clickText('Create session'); await wait(3000)
}
async function openFileViaDock(fname) {
  // ensure Files dock open
  if (!(await evaluate(`!!([...document.querySelectorAll('span')].find(s=>s.textContent==='Files'))`))) await clickTitle('Files browser')
  await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent&&b.textContent.includes(${JSON.stringify(fname)})))`, 8000)
  await clickInc(fname); await wait(900)
}

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 940, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${APP}/` })
await waitFor(`!!([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat'))`)
await wait(700)

// Session A → open README.md
await newSession('sessAAA')
await openFileViaDock('README.md')
const tabsA1 = await contentTabs()
console.log('A tabs after opening README:', tabsA1)
await shot('ps1-sessionA-readme')

// Session B → open sample.ts
await newSession('sessBBB')
const tabsB0 = await contentTabs()
console.log('B tabs on fresh session (should be empty):', tabsB0)
await openFileViaDock('sample.ts')
const tabsB1 = await contentTabs()
console.log('B tabs after opening sample.ts:', tabsB1)
await shot('ps2-sessionB-sample')

// Switch back to session A by its distinct name.
await clickSession('sessAAA')
await wait(1200)
const tabsAback = await contentTabs()
console.log('A tabs after switching back (expect README only):', tabsAback)
await shot('ps3-back-to-A')

const only = (arr, name) => arr.length === 1 && arr[0].includes(name)
const pass = only(tabsA1, 'README.md') && tabsB0.length === 0 && only(tabsB1, 'sample.ts') && only(tabsAback, 'README.md')
console.log(pass ? '\n🎉 PER-SESSION PANES OK' : '\n💥 panes leaked across sessions')

cdp.close(); chrome.kill('SIGKILL')
process.exit(pass ? 0 : 1)
