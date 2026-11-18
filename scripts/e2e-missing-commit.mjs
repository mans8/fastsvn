// 本地删除（missing）回归：可勾选、右侧能看到上次提交内容、能真正提交删除。
// 用法：node scripts/e2e-missing-commit.mjs（自建仓库 + 无头 Chrome 9222）
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'fastsvn-missing-commit-'));
const results=[]; const check=(n,ok,d)=>results.push([n,ok,d]);
let app, target, ws;
try {
  const repo=path.join(tmp,'repo'), wc=path.join(tmp,'wc');
  execFileSync('svnadmin',['create',repo]);
  execFileSync('svn',['mkdir','-m','init',`file://${repo}/trunk`]);
  execFileSync('svn',['checkout','-q',`file://${repo}/trunk`,wc]);
  fs.writeFileSync(path.join(wc,'gone.txt'),'第一行\n第二行\n第三行\n');
  fs.mkdirSync(path.join(wc,'folder','sub'),{recursive:true});
  fs.writeFileSync(path.join(wc,'folder','inner.txt'),'目录里的文件\n');
  fs.writeFileSync(path.join(wc,'folder','sub','inner2.txt'),'子目录里的文件\n');
  execFileSync('svn',['add',path.join(wc,'gone.txt'),path.join(wc,'folder')]);
  execFileSync('svn',['commit','-q','-m','seed',wc]);
  fs.rmSync(path.join(wc,'gone.txt'));
  fs.rmSync(path.join(wc,'folder'),{recursive:true});

  const home=path.join(tmp,'home'); fs.mkdirSync(path.join(home,'data'),{recursive:true});
  fs.writeFileSync(path.join(home,'data','working-copies.json'),JSON.stringify({paths:[wc],aliases:{}}));
  app=spawn(process.execPath,[new URL('../server.js', import.meta.url).pathname],{env:{...process.env,HOME:home,PORT:'0',FASTSVN_HOME:home},stdio:['ignore','pipe','pipe']});
  let out=''; const port=await new Promise((res,rej)=>{app.stdout.on('data',d=>{out+=d;const m=/LISTENING (\d+)/.exec(out);if(m)res(Number(m[1]))}); setTimeout(()=>rej(new Error(out)),8000)});

  const status=await (await fetch(`http://127.0.0.1:${port}/api/status?path=${encodeURIComponent(wc)}&force=1`)).json();
  const gone=status.local.find(f=>f.path==='gone.txt');
  const folder=status.local.find(f=>f.path==='folder');
  check('接口：文件和目录都是 missing/D', gone?.kind==='missing' && gone?.letter==='D' && folder?.kind==='missing', JSON.stringify([gone?.kind, folder?.kind]));

  const d1=await (await fetch(`http://127.0.0.1:${port}/api/diff?path=${encodeURIComponent(wc)}&file=gone.txt&kind=missing`)).json();
  check('删除文件能查看上次提交内容', d1.lines.some(l=>l.kind==='del' && l.text==='第二行') && d1.deleted===3, JSON.stringify(d1.lines.slice(0,4)));
  const d2=await (await fetch(`http://127.0.0.1:${port}/api/diff?path=${encodeURIComponent(wc)}&file=folder&kind=missing`)).json();
  check('删除目录能递归列出原本内容', d2.lines.some(l=>l.text==='inner.txt') && d2.lines.some(l=>l.text==='sub/inner2.txt'), JSON.stringify(d2.lines));
  check('接口：标记出这是目录', folder?.isDir===true, JSON.stringify(folder && {isDir:folder.isDir}));

  const created=await fetch('http://127.0.0.1:9222/json/new?about:blank',{method:'PUT'}); target=await created.json();
  ws=new WebSocket(target.webSocketDebuggerUrl); const pending=new Map(); let id=0;
  const send=(m,p={})=>new Promise((res,rej)=>{const n=++id;pending.set(n,{res,rej});ws.send(JSON.stringify({id:n,method:m,params:p}));setTimeout(()=>{if(pending.has(n)){pending.delete(n);rej(new Error(m))}},20000)});
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result)}});
  await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',()=>j(new Error('cdp')),{once:true})});
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:820,deviceScaleFactor:2,mobile:false});
  const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true}); if(r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result?.value;};
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/`}); await sleep(2800);

  const rowInfo=await ev(`(() => { const row=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('gone.txt')); const cb=row?.querySelector('input[type=checkbox]'); return { letter: row?.querySelector('.status-letter')?.textContent, title: row?.querySelector('.status-letter')?.getAttribute('title'), disabled: cb?.disabled ?? null, checked: cb?.checked ?? null }; })()`);
  check('界面：删除文件可勾选', rowInfo.disabled===false, JSON.stringify(rowInfo));
  const folderRow=await ev(`(() => document.querySelector('[data-file-row="folder"]')?.innerText.replace(/\\s+/g,' ') ?? '')()`);
  check('界面：目录行说明整目录被删', /整个目录已删除/.test(folderRow), folderRow);

  // 点目录行：右侧应列出目录里原本的内容（递归）
  const folderBox=await ev(`(() => { const row=document.querySelector('[data-file-row="folder"]'); const r=row.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:folderBox.x,y:folderBox.y,button:'left',clickCount:1});
  await sleep(900);
  const dirPane=await ev(`document.querySelector('main')?.innerText ?? ''`);
  check('界面：目录删除能列出子目录内容', /sub\/inner2\.txt/.test(dirPane), dirPane.slice(-160));
  const shotDir=await send('Page.captureScreenshot',{format:'png'});
  fs.mkdirSync('/Users/admin/WorkBuddy/2026-11-10-15-12-01/fastsvn/screens',{recursive:true});
  fs.writeFileSync('/Users/admin/WorkBuddy/2026-11-10-15-12-01/fastsvn/screens/missing-dir-diff-0621.png',Buffer.from(shotDir.data,'base64'));

  const box=await ev(`(() => { const row=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('gone.txt')); const r=row.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:box.x,y:box.y,button:'left',clickCount:1});
  await sleep(800);
  const paneText=await ev(`document.querySelector('main')?.innerText ?? ''`);
  check('界面：右侧显示删除的内容', /第一行/.test(paneText) && !/仍受版本控制/.test(paneText), paneText.slice(0,120));
  const shot=await send('Page.captureScreenshot',{format:'png'});
  fs.mkdirSync('/Users/admin/WorkBuddy/2026-11-10-15-12-01/fastsvn/screens',{recursive:true});
  fs.writeFileSync('/Users/admin/WorkBuddy/2026-11-10-15-12-01/fastsvn/screens/missing-diff-0619.png',Buffer.from(shot.data,'base64'));

  const commitBtn=await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^提交\\s*\\d+$/.test(x.textContent.trim())); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  if (commitBtn) for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:commitBtn.x,y:commitBtn.y,button:'left',clickCount:1});
  await sleep(700);
  await ev(`(() => { const t=document.querySelector('[role="dialog"] textarea'); t.focus(); return true; })()`);
  await send('Input.insertText',{text:'删除不再需要的文件'});
  await sleep(200);
  const submit=await ev(`(() => { const b=[...document.querySelectorAll('[role="dialog"] button')].find(x=>/^提交\\s*\\d+\\s*项$/.test(x.textContent.trim())); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
  check('界面：提交按钮包含 2 个文件', Boolean(submit), JSON.stringify(submit));
  if (submit) for (const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,x:submit.x,y:submit.y,button:'left',clickCount:1});
  let done=false;
  for (let i=0;i<120;i++){ if (await ev(`Boolean(document.querySelector('[role="dialog"] [data-commit-status="done"]'))`)) { done=true; break; } await sleep(100); }
  const dlgText=await ev(`document.querySelector('[role="dialog"]')?.innerText.replace(/\\s+/g,' ').slice(0,200) ?? ''`);
  check('界面：删除提交成功', done && /提交成功 · r\d+/.test(dlgText), dlgText);

  const log=execFileSync('svn',['log','-v','-l','2',`file://${repo}`],{encoding:'utf8'});
  check('仓库：r2 删除了文件和目录', /D\s+\/trunk\/gone\.txt/.test(log) && /D\s+\/trunk\/folder(\/|$)/m.test(log), log.split('\n').slice(0,6).join(' | '));

  const after=await (await fetch(`http://127.0.0.1:${port}/api/status?path=${encodeURIComponent(wc)}&force=1`)).json();
  check('提交后待提交清空', after.local.length===0, JSON.stringify(after.local));
} finally {
  if (app && !app.killed) app.kill('SIGTERM');
  try { ws?.close(); } catch {}
  if (target) await fetch(`http://127.0.0.1:9222/json/close/${target.id}`).catch(()=>{});
  fs.rmSync(tmp,{recursive:true,force:true});
}
let failed=0; for (const [n,ok,d] of results){console.log(`${ok?'PASS':'FAIL'}  ${n}  —  ${d}`); if(!ok)failed++;}
console.log(`\n${results.length-failed} / ${results.length} 通过`); if(failed) process.exitCode=1;
