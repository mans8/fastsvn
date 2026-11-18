// 重试删除回归：上次提交失败后状态已变成 D（已排删除），重试仍能提交成功。
// 用法：node scripts/e2e-delete-retry.mjs（自建仓库，不需要浏览器）
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'fastsvn-delretry-'));
const results=[]; const check=(n,ok,d)=>results.push([n,ok,d]);
let app;
try {
  const repo=path.join(tmp,'repo'), wc=path.join(tmp,'wc'), wc2=path.join(tmp,'wc2');
  execFileSync('svnadmin',['create',repo]); execFileSync('svn',['mkdir','-m','init',`file://${repo}/trunk`]);
  execFileSync('svn',['checkout','-q',`file://${repo}/trunk`,wc]);
  fs.mkdirSync(path.join(wc,'gateway','ipush-bridge'),{recursive:true});
  fs.writeFileSync(path.join(wc,'gateway','ipush-bridge','a.txt'),'a\n');
  execFileSync('svn',['add',path.join(wc,'gateway')]); execFileSync('svn',['commit','-q','-m','add',wc]);
  execFileSync('svn',['checkout','-q',`file://${repo}/trunk`,wc2]);
  fs.appendFileSync(path.join(wc2,'gateway','ipush-bridge','a.txt'),'b\n');
  execFileSync('svn',['commit','-q','-m','remote change',wc2]);
  // 模拟"上一次提交失败"：删除已排进 svn delete（状态是 D），目录又过期
  fs.rmSync(path.join(wc,'gateway','ipush-bridge'),{recursive:true});
  execFileSync('svn',['rm','--force','-q',path.join(wc,'gateway','ipush-bridge')]);

  const home=path.join(tmp,'home'); fs.mkdirSync(path.join(home,'data'),{recursive:true});
  fs.writeFileSync(path.join(home,'data','working-copies.json'),JSON.stringify({paths:[wc],aliases:{}}));
  app=spawn(process.execPath,[new URL('../server.js', import.meta.url).pathname],{env:{...process.env,HOME:home,PORT:'0',FASTSVN_HOME:home},stdio:['ignore','pipe','pipe']});
  let out=''; const port=await new Promise((res,rej)=>{app.stdout.on('data',d=>{out+=d;const m=/LISTENING (\d+)/.exec(out);if(m)res(Number(m[1]))}); setTimeout(()=>rej(new Error(out)),8000)});

  const status=await (await fetch(`http://127.0.0.1:${port}/api/status?path=${encodeURIComponent(wc)}&force=1`)).json();
  const item=status.local.find(f=>f.path==='gateway/ipush-bridge');
  check('前置：状态是已排删除（D）', item?.kind==='deleted' && item?.isDir!==false, JSON.stringify(item && {kind:item.kind,isDir:item.isDir}));

  const res=await fetch(`http://127.0.0.1:${port}/api/commit/stream`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:wc,files:['gateway/ipush-bridge'],message:'重试删除'})});
  const events=(await res.text()).split('\n\n').filter(Boolean).map(f=>{const l=f.split('\n');return {ev:l.find(x=>x.startsWith('event: '))?.slice(7),data:JSON.parse(l.find(x=>x.startsWith('data: '))?.slice(6)||'null')}});
  const err=events.find(e=>e.ev==='error'); const done=events.find(e=>e.ev==='done');
  check('重试提交成功', Boolean(done) && !err, err?.data?.message ?? JSON.stringify(done?.data));
  const log=execFileSync('svn',['log','-v','-l','1',`file://${repo}`],{encoding:'utf8'});
  check('仓库里目录已删除', /D\s+\/trunk\/gateway\/ipush-bridge/m.test(log), log.split('\n').slice(0,5).join(' | '));
} finally {
  if (app && !app.killed) app.kill('SIGTERM');
  fs.rmSync(tmp,{recursive:true,force:true});
}
let failed=0; for (const [n,ok,d] of results){console.log(`${ok?'PASS':'FAIL'}  ${n}  —  ${d}`); if(!ok)failed++;}
console.log(`\n${results.length-failed} / ${results.length} 通过`); if(failed) process.exitCode=1;
