// DIAGNOSTIC PROBE — why is a reattached terminal blank?
//
//   CHROME_BIN=… node scratchpad/xterm-replay-probe.mjs
//
// Not a test: it asserts nothing and always exits 0. It stands up the smallest fixture
// that reproduces a refresh-reattach (one session, one live pty whose shell stamps a
// marker into its scrollback, a seeded layout pointing at it) and then DUMPS the terminal
// DOM plus every /api/pane/attach response the page received.
//
// It exists because scratchpad/refresh-survival-check.mjs went red on scrollback replay
// and the red said only "no marker on screen" — which is consistent with the pty never
// emitting, the server buffer being empty, the attach never firing, the response being
// dropped, or xterm rendering to a canvas the DOM cannot read. Separating those needed
// the two halves this prints side by side: the attach log showed the marker ARRIVING at
// the client twice while the screen stayed empty, which pointed straight at TerminalView
// discarding it — the paneIdRef re-arm bug now fixed and commented in TerminalView.tsx.
//
// Keep it. The next "the terminal is blank" question is the same question, and the useful
// output is the pairing, not either half alone.
// Own ports (4498 / 5298 / CDP 9358) so it never collides with the harness above.
import { spawn } from 'child_process'
import { mkdtemp, writeFile, mkdir, chmod } from 'fs/promises'
import { tmpdir } from 'os'; import { join } from 'path'
import { WebSocket } from 'ws'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = 4498, WEB = 5298, CDPP = 9358, TOKEN = 't'
const DATA = await mkdtemp(join(tmpdir(),'xp-data-')), PROJ = await mkdtemp(join(tmpdir(),'xp-proj-')), BIN = await mkdtemp(join(tmpdir(),'xp-bin-'))
const D1 = join(PROJ,'p-a1'); await mkdir(D1,{recursive:true})
const SHIM = join(BIN,'pane-shell')
await writeFile(SHIM, `#!/bin/sh\nprintf 'PANE-MARKER %s\\r\\n' "$(basename "$PWD")"\nwhile : ; do sleep 3600 ; done\n`); await chmod(SHIM,0o755)
await writeFile(join(BIN,'claude'), `#!/usr/bin/env node\n// exit when the server that spawned us dies, so we do not reparent to init and\n// clutter the ps of whoever is diagnosing a real orphan\nprocess.stdin.on('end',()=>process.exit(0))\nprocess.stdin.on('close',()=>process.exit(0))\nprocess.stdin.resume()\nsetTimeout(()=>process.exit(0),120000)\n`); await chmod(join(BIN,'claude'),0o755)
const srv = spawn('npx',['tsx','server/src/index.ts'],{env:{...process.env,PATH:`${BIN}:${process.env.PATH}`,SHELL:SHIM,PORT:String(PORT),CLAUDETTE_TOKEN:TOKEN,CLAUDETTE_DATA_DIR:DATA,CLAUDETTE_ALLOW_UNSANDBOXED:'1'},stdio:['ignore','pipe','pipe'],detached:true})
let log=''; srv.stdout.on('data',d=>log+=d); srv.stderr.on('data',d=>log+=d)
const web = spawn('npx',['vite','--port',String(WEB),'--strictPort'],{cwd:'web',env:{...process.env,PORT:String(PORT),WEB_PORT:String(WEB)},stdio:['ignore','pipe','pipe'],detached:true})
let wl=''; web.stdout.on('data',d=>wl+=d); web.stderr.on('data',d=>wl+=d)
let chrome=null
// Process GROUPS, not bare pids — all three children are spawned detached so `-pid` has a
// group to hit. Load-bearing for the npx-wrapped server/vite (killing the wrapper can
// strand the port); defence in depth for Chrome, which was measured NOT to orphan under a
// bare kill. See rule 3 in scratchpad/port-and-reap-lint.mts.
const reap=()=>{for(const p of [srv,web,chrome]){ if(!p) continue; try{process.kill(-p.pid,'SIGKILL')}catch{try{p.kill('SIGKILL')}catch{}} }}
// Reap on EVERY exit path, not just the happy one — a probe that throws halfway (which is
// what a probe does) would otherwise leave a server, a vite and a Chrome behind each time.
process.on('exit',reap)
for (const sig of ['SIGINT','SIGTERM','uncaughtException','unhandledRejection']) {
  process.on(sig,(e)=>{ reap(); if(e) console.error(e); process.exit(1) })
}
for(let i=0;i<90&&!log.includes('Server listening');i++)await wait(500)
for(let i=0;i<90&&!wl.includes('ready in');i++)await wait(500)
const hdr={'content-type':'application/json',cookie:`claudette_auth=${TOKEN}`}
const post=(p,b)=>fetch(`http://127.0.0.1:${PORT}${p}`,{method:'POST',headers:hdr,body:JSON.stringify(b)}).then(r=>r.json())
const s1=await post('/api/session/create',{name:'Alpha',cwd:PROJ,rootDir:PROJ,sandbox:{enabled:false,mounts:[]}})
const p1=await post('/api/pane/create',{cwd:D1,cols:80,rows:24,sessionId:s1.id})
chrome=spawn(process.env.CHROME_BIN,['--headless=new',`--remote-debugging-port=${CDPP}`,`--user-data-dir=${await mkdtemp(join(tmpdir(),'ch-xp-'))}`,'--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--window-size=1440,900','about:blank'],{stdio:'pipe',detached:true})
let wsurl
for(let i=0;i<40;i++){try{const l=await (await fetch(`http://127.0.0.1:${CDPP}/json`)).json();const pg=l.find(t=>t.type==='page');if(pg?.webSocketDebuggerUrl){wsurl=pg.webSocketDebuggerUrl;break}}catch{} await wait(250)}
const cdp=new WebSocket(wsurl); await new Promise((r,j)=>{cdp.on('open',r);cdp.on('error',j)})
let id=0; const pend=new Map()
// A CDP reply is awaited on a promise that ONLY the socket can resolve, so if Chrome dies
// mid-run — crash, OOM, or an external pkill — every pending send() hangs forever and the
// harness sleeps in ep_poll holding its ports. That is not hypothetical: it happened here,
// and the next run failed with "server did not start" pointing at an innocent edit. Turn a
// dead socket into a loud failure instead of a silent squatter.
cdp.on('close', () => { console.error('CDP socket closed — Chrome died; aborting rather than hanging'); reap(); process.exit(1) })
cdp.on('message',d=>{const m=JSON.parse(d.toString()); if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}})
const send=(method,params={})=>{const i=++id;cdp.send(JSON.stringify({id:i,method,params}));return new Promise(r=>pend.set(i,r))}
const ev=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true}); if(r.result?.exceptionDetails) return 'EXC '+JSON.stringify(r.result.exceptionDetails).slice(0,300); return r.result?.result?.value}
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
await send('Page.navigate',{url:`http://127.0.0.1:${WEB}/api/auth?token=${TOKEN}`}); await wait(1200)
const LAYOUT={v:1,layout:'side',sizes:{sideW:420,stackH:280,dockW:320,termH:240,sidebarW:288},seq:10,
  terms:{[s1.id]:{open:true,active:'t1',terms:[{key:'t1',paneId:p1.id,cwd:D1}]}},content:{}}
await ev(`localStorage.setItem('claudette:layout:v1', ${JSON.stringify(JSON.stringify(LAYOUT))}); sessionStorage.setItem('claudette.clientId','xp'); true`)
await send('Page.addScriptToEvaluateOnNewDocument',{source:`
window.__attachLog=[]; window.__errs=[];
const of=window.fetch;
window.fetch=function(u,o){ const url=String(u&&u.url||u);
  const p=of.apply(this,arguments);
  if(url.includes('/api/pane/attach')) p.then(r=>r.clone().json()).then(j=>window.__attachLog.push(j)).catch(e=>window.__attachLog.push('ERR '+e));
  return p; };
addEventListener('error',e=>window.__errs.push(String(e.message)));
addEventListener('unhandledrejection',e=>window.__errs.push('rej '+String(e.reason)));
`})
await send('Page.navigate',{url:`http://127.0.0.1:${WEB}/`})
for(let i=0;i<100;i++){ if(await ev(`!!document.querySelector('aside')`)) break; await wait(200) }
await wait(4000)
console.log('rows count      :', await ev(`document.querySelectorAll('.xterm-rows').length`))
console.log('xterm els       :', await ev(`document.querySelectorAll('.xterm').length`))
console.log('rows html       :', JSON.stringify(await ev(`(document.querySelector('.xterm-rows')||{}).innerHTML?.slice(0,400) ?? null`)))
console.log('rows innerText  :', JSON.stringify(await ev(`(document.querySelector('.xterm-rows')||{}).innerText ?? null`)))
console.log('rows textContent:', JSON.stringify(await ev(`(document.querySelector('.xterm-rows')||{}).textContent?.slice(0,200) ?? null`)))
console.log('screen text     :', JSON.stringify(await ev(`(document.querySelector('.xterm-screen')||{}).textContent?.slice(0,300) ?? null`)))
console.log('term rect       :', await ev(`JSON.stringify((document.querySelector('.xterm')||{getBoundingClientRect:()=>null}).getBoundingClientRect?.() ?? null)`))
console.log('dock visible    :', await ev(`(()=>{const e=document.querySelector('.xterm'); if(!e) return 'no xterm'; let n=e,hid=[]; while(n&&n!==document.body){const s=getComputedStyle(n); if(s.display==='none') hid.push(n.className); n=n.parentElement} return hid.length? 'hidden by: '+hid.join(' | ') : 'visible chain'})()`))
console.log('body has MARKER :', await ev(`document.body.innerText.includes('PANE-MARKER')`))
console.log('canvas count    :', await ev(`document.querySelectorAll('.xterm canvas').length`))
console.log('attach log      :', JSON.stringify(await ev(`JSON.stringify(window.__attachLog)`)))
console.log('page errors     :', JSON.stringify(await ev(`JSON.stringify(window.__errs)`)))
console.log('exited banner   :', await ev(`document.body.innerText.includes('exited')`))
process.exit(0)
