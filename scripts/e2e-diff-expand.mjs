// 差异展开 + missing 视觉回归：默认紧凑、点按钮展示完整上下文、再收起。
// 用法：node scripts/e2e-diff-expand.mjs（自建仓库 + 无头 Chrome 9222）
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'fastsvn-expand-'));
const results=[]; const check=(n,ok,d)=>results.push([n,ok,d]);
let app, target, ws;
try {
  const repo=path.join(tmp,'repo'), wc=path.join(tmp,'wc');
  execFileSync('svnadmin',['create',repo]);
  execFileSync('svn',['mkdir','-m','init',`file://${repo}/trunk`]);
  execFileSync('svn',['checkout','-q',`file://${repo}/trunk`,wc]);
  fs.writeFileSync(path.join(wc,'gone.txt'),'删掉我\n');
  fs.writeFileSync(path.join(wc,'long.txt'),Array.from({length:60},(_,i)=>`第 ${i+1} 行 内容`).join('\n')+'\n');
  execFileSync('svn',['add',path.join(wc,'gone.txt'),path.join(wc,'long.txt')]);
  execFileSync('svn',['commit','-m','seed',wc],{stdio:'ignore'});
  fs.rmSync(path.join(wc,'gone.txt'));
  const lines=fs.readFileSync(path.join(wc,'long.txt'),'utf8').split('\n');
  lines[1]='第 2 行 改了';
  lines[54]='第 55 行 改了';
  fs.writeFileSync(path.join(wc,'long.txt'),lines.join('\n'));

  const home=path.join(tmp,'home'); fs.mkdirSync(path.join(home,'data'),{recursive:true});
  fs.writeFileSync(path.join(home,'data','working-copies.json'),JSON.stringify({paths:[wc],aliases:{}}));
  app=spawn(process.execPath,[new URL('../server.js', import.meta.url).pathname],{env:{...process.env,HOME:home,PORT:'0',FASTSVN_HOME:home},stdio:['ignore','pipe','pipe']});
  let out=''; const port=await new Promise((res,rej)=>{app.stdout.on('data',d=>{out+=d;const m=/LISTENING (\d+)/.exec(out);if(m)res(Number(m[1]))}); setTimeout(()=>rej(new Error(out)),8000)});

  const status=await (await fetch(`http://127.0.0.1:${port}/api/status?path=${encodeURIComponent(wc)}&force=1`)).json();
  const gone=status.local.find(f=>f.path==='gone.txt');
  check('接口：missing 用 D + 本地已删除', gone?.letter==='D' && gone?.label==='本地已删除', JSON.stringify(gone && {letter:gone.letter,label:gone.label}));

  const normal=await (await fetch(`http://127.0.0.1:${port}/api/diff?path=${encodeURIComponent(wc)}&file=long.txt&kind=modified`)).json();
  const full=await (await fetch(`http://127.0.0.1:${port}/api/diff?path=${encodeURIComponent(wc)}&file=long.txt&kind=modified&context=full`)).json();
  check('接口：展开后行数明显变多', full.lines.length > normal.lines.length + 20, `${normal.lines.length} → ${full.lines.length}`);
  check('接口：展开后能看到未改动的第 30 行', full.lines.some(l=>l.kind==='ctx' && l.text.includes('第 30 行')), '');
  check('接口：默认紧凑模式不含第 30 行', !normal.lines.some(l=>l.text.includes('第 30 行')), '');

  const created=await fetch('http://127.0.0.1:9222/json/new?about:blank',{method:'PUT'}); target=await created.json();
  ws=new WebSocket(target.webSocketDebuggerUrl); const pending=new Map(); let id=0;
  const send=(m,p={})=>new Promise((res,rej)=>{const n=++id;pending.set(n,{res,rej});ws.send(JSON.stringify({id:n,method:m,params:p}));setTimeout(()=>{if(pending.has(n)){pending.delete(n);rej(new Error(m))}},20000)});
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result)}});
  await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',()=>j(new Error('cdp')),{once:true})});
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:820,deviceScaleFactor:2,mobile:false});
  const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result?.value;};
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/`}); await sleep(2800);

  const badge=await ev(`(() => { const rows=[...document.querySelectorAll('button')]; const row=rows.find(b=>b.textContent.includes('gone.txt')); const letter=row?.querySelector('.status-letter'); return {letter:letter?.textContent, title:letter?.getAttribute('title')}; })()`);
  check('界面：删除行显示 D，提示「本地已删除」', badge.letter==='D' && badge.title==='本地已删除', JSON.stringify(badge));

  const clickRow=async(name)=>{ const box=await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('${name}')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`); if(!box) throw new Error('找不到 '+name); for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:box.x,y:box.y,button:'left',clickCount:1}); await sleep(600); };
  await clickRow('long.txt');
  const countLines=()=>ev(`document.querySelectorAll('[role="dialog"], main .diff-line').length`);
  const compact=await countLines();
  const btn=await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('展开未变更内容')); if(!b) return null; b.setAttribute('data-probe','1'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  check('界面：差异头有「展开未变更内容」', Boolean(btn), JSON.stringify(btn));
  if (btn) { for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:btn.x,y:btn.y,button:'left',clickCount:1}); await sleep(900); }
  const expanded=await countLines();
  check('界面：展开后行数变多', expanded > compact + 20, `${compact} → ${expanded}`);
  const expandedBtn=await ev(`Boolean([...document.querySelectorAll('button')].find(x=>x.textContent.includes('收起未变更内容')))`);
  check('界面：按钮变为「收起未变更内容」', expandedBtn, String(expandedBtn));
  const shot=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync('/Users/admin/WorkBuddy/2026-11-10-15-12-01/fastsvn/screens/diff-expanded-0618.png',Buffer.from(shot.data,'base64'));
  if (expandedBtn) { const b2=await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('收起未变更内容')); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`); for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:b2.x,y:b2.y,button:'left',clickCount:1}); await sleep(800); }
  const back=await countLines();
  check('界面：收起后回到紧凑视图', Math.abs(back-compact) < 10, `${compact} → ${back}`);
} finally {
  if (app && !app.killed) app.kill('SIGTERM');
  try { ws?.close(); } catch {}
  if (target) await fetch(`http://127.0.0.1:9222/json/close/${target.id}`).catch(()=>{});
  fs.rmSync(tmp,{recursive:true,force:true});
}
let failed=0; for (const [n,ok,d] of results){console.log(`${ok?'PASS':'FAIL'}  ${n}  —  ${d}`); if(!ok)failed++;}
console.log(`\n${results.length-failed} / ${results.length} 通过`); if(failed) process.exitCode=1;
