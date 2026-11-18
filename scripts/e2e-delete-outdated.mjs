// 删除过期目录回归：另一个工作副本先改了目录，本地删除后仍能提交（不再 E155011）。
// 用法：node scripts/e2e-delete-outdated.mjs（自建仓库，不需要浏览器）
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'fastsvn-e155011-'));
const results=[]; const check=(n,ok,d)=>results.push([n,ok,d]);
let app;
try {
  const repo=path.join(tmp,'repo'), wc=path.join(tmp,'wc'), wc2=path.join(tmp,'wc2');
  execFileSync('svnadmin',['create',repo]);
  execFileSync('svn',['mkdir','-m','init',`file://${repo}/trunk`]);
  execFileSync('svn',['checkout','-q',`file://${repo}/trunk`,wc]);
  const dir=path.join(wc,'gateway','ipush-bridge');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'a.txt'),'a\n');
  execFileSync('svn',['add',path.join(wc,'gateway')]);
  execFileSync('svn',['commit','-q','-m','add',wc]);
  // 另一个工作副本在服务器上更新这个目录
  execFileSync('svn',['checkout','-q',`file://${repo}/trunk`,wc2]);
  fs.appendFileSync(path.join(wc2,'gateway','ipush-bridge','a.txt'),'b\n');
  execFileSync('svn',['commit','-q','-m','remote change',wc2]);
  // 本地删除整个目录
  fs.rmSync(path.join(wc,'gateway','ipush-bridge'),{recursive:true});

  const home=path.join(tmp,'home'); fs.mkdirSync(path.join(home,'data'),{recursive:true});
  fs.writeFileSync(path.join(home,'data','working-copies.json'),JSON.stringify({paths:[wc],aliases:{}}));
  app=spawn(process.execPath,[new URL('../server.js', import.meta.url).pathname],{env:{...process.env,HOME:home,PORT:'0',FASTSVN_HOME:home},stdio:['ignore','pipe','pipe']});
  let out=''; const port=await new Promise((res,rej)=>{app.stdout.on('data',d=>{out+=d;const m=/LISTENING (\d+)/.exec(out);if(m)res(Number(m[1]))}); setTimeout(()=>rej(new Error(out)),8000)});

  const status=await (await fetch(`http://127.0.0.1:${port}/api/status?path=${encodeURIComponent(wc)}&force=1`)).json();
  const item=status.local.find(f=>f.path==='gateway/ipush-bridge');
  check('前置：目录本地已删除', item?.kind==='missing', JSON.stringify(item && {kind:item.kind,letter:item.letter}));

  const res=await fetch(`http://127.0.0.1:${port}/api/commit/stream`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:wc,files:['gateway/ipush-bridge'],message:'删除过期目录'})});
  const text=await res.text();
  const events=text.split('\n\n').filter(Boolean).map(f=>{const l=f.split('\n');const ev=l.find(x=>x.startsWith('event: '))?.slice(7);const data=l.find(x=>x.startsWith('data: '))?.slice(6);return {ev,data:data?JSON.parse(data):null};});
  const done=events.find(e=>e.ev==='done');
  const err=events.find(e=>e.ev==='error');
  check('提交不再报 E155011', Boolean(done) && !err, err?.data?.message ?? JSON.stringify(done?.data));
  const log=execFileSync('svn',['log','-v','-l','1',`file://${repo}`],{encoding:'utf8'});
  check('服务器上目录已删除', /D\s+\/trunk\/gateway\/ipush-bridge/m.test(log), log.split('\n').slice(0,6).join(' | '));
  const after=await (await fetch(`http://127.0.0.1:${port}/api/status?path=${encodeURIComponent(wc)}&force=1`)).json();
  check('待提交已清空', after.local.length===0, JSON.stringify(after.local));
} finally {
  if (app && !app.killed) app.kill('SIGTERM');
  fs.rmSync(tmp,{recursive:true,force:true});
}
let failed=0; for (const [n,ok,d] of results){console.log(`${ok?'PASS':'FAIL'}  ${n}  —  ${d}`); if(!ok)failed++;}
console.log(`\n${results.length-failed} / ${results.length} 通过`); if(failed) process.exitCode=1;
