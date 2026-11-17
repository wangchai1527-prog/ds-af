import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'child_process';import fs from 'fs';import path from 'path';import os from 'os';
// Task 0：Idea Plan 分析台（会话/轮次协议 · 五态 · 防重入 · 复活 · materials 路径防注入）
const ADIR=fs.mkdtempSync(path.join(os.tmpdir(),'dsaf-plan-'));
const MOCK=path.resolve('test/mock-plan-agent.mjs');
fs.chmodSync(MOCK,0o755);
const TP=String(8890+Math.floor(Math.random()*80));
const ENVV={...process.env,PORT:TP,ANALYSES:ADIR,PLAN_AGENT_CMD:MOCK};
let child=spawn(process.execPath,['plan-server.js'],{env:ENVV,stdio:'pipe'});
async function untilUp(){for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+TP+'/api/analyses');return}catch(e){await new Promise(r=>setTimeout(r,250))}}throw new Error('plan-server not up')}
await untilUp();
const api=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:'+TP+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return{code:r.status,body:await r.json().catch(()=>({}))}};
async function poll(fn,ms=12000,step=250){const t0=Date.now();while(Date.now()-t0<ms){if(await fn())return true;await new Promise(r=>setTimeout(r,step))}return false}
let sid=null;

test('/api/new 建会话并自动跑第 1 轮 → open + r001-out.md + 列表可见',async()=>{
  const r=await api('POST','/api/new',{idea:'做一个并发流水线观测面板的预研分析'});
  assert.equal(r.code,200);sid=r.body.id;assert.ok(sid&&sid.startsWith('an-'));
  const dir=path.join(ADIR,sid);
  const ok=await poll(()=>fs.existsSync(path.join(dir,'rounds','r001-out.md')));
  assert.ok(ok,'r001-out.md 应由 agent 写出');
  const meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8'));
  assert.equal(meta.state,'open');assert.equal(meta.round,1);
  const list=await api('GET','/api/analyses');
  assert.ok(list.body.analyses.some(a=>a.id===sid&&a.state==='open'));
});
test('一轮进行中 reply → 409；materials 带 ../ filename → 400',async()=>{
  const r=await api('POST','/api/new',{idea:'第二个会话：重入防护验证'});
  const id2=r.body.id;
  const early=await api('POST','/api/analyses/'+id2+'/reply',{answers:{}});
  assert.equal(early.code,409); // mock 200ms 内必在跑
  await poll(()=>fs.existsSync(path.join(ADIR,id2,'rounds','r001-out.md')),15000); // 第 1 轮跑完再验 400
  const bad=await api('POST','/api/analyses/'+id2+'/reply',{answers:{},materials:[{filename:'../evil.txt',content:'x'}]});
  assert.equal(bad.code,400);
});
test('reply 续轮 → agent 收敛 → state=awaiting；decide no-go → 归档保留',async()=>{
  const r=await api('POST','/api/analyses/'+sid+'/reply',{answers:{D1:'Web',D2:'P0最小'},message:'形态定了'});
  assert.equal(r.code,200);
  const dir=path.join(ADIR,sid);
  const ok=await poll(()=>JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8')).state==='awaiting');
  assert.ok(ok,'第 2 轮收敛后 state 应 awaiting');
  assert.ok(fs.existsSync(path.join(dir,'rounds','r002-in.json')),'r002-in.json 应落盘');
  const d=await api('POST','/api/analyses/'+sid+'/decide',{decision:'no-go',note:'暂缓'});
  assert.equal(d.code,200);
  const meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8'));
  assert.equal(meta.state,'no-go');assert.ok(fs.existsSync(dir),'归档后目录保留');
});
test('复活：no-go 会话 reply → state 回 open 且 round+1',async()=>{
  const r=await api('POST','/api/analyses/'+sid+'/reply',{answers:{},message:'重新捡起来'});
  assert.equal(r.code,200);
  const dir=path.join(ADIR,sid);
  const ok=await poll(()=>JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8')).state==='open');
  assert.ok(ok);
  const meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8'));
  assert.equal(meta.round,3,'round 应 +1');
});
test('decide go → 仅提交立项池（state=go + spawnedRun=null），不直接建工厂 run',async()=>{
  // 第 3 轮（复活轮）mock 也输出收敛 → awaiting
  const ok=await poll(()=>JSON.parse(fs.readFileSync(path.join(ADIR,sid,'meta.json'),'utf8')).state==='awaiting',15000);
  assert.ok(ok,'复活轮应收敛 awaiting');
  const d=await api('POST','/api/analyses/'+sid+'/decide',{decision:'go'});
  assert.equal(d.code,200);
  const meta=JSON.parse(fs.readFileSync(path.join(ADIR,sid,'meta.json'),'utf8'));
  assert.equal(meta.state,'go');assert.equal(meta.spawnedRun,null,'GO 仅提交，spawnedRun 待工厂 from-plan 回写');
});
test('话题管理：open 态可直接否决/搁置（不必等收敛）· 硬删目录 · spawnedRun 守卫',async()=>{
  const r=await api('POST','/api/new',{idea:'话题管理闭环验证专用会话'});
  const id=r.body.id;const dir=path.join(ADIR,id);
  await poll(()=>fs.existsSync(path.join(dir,'rounds','r001-out.md'))); // 第 1 轮跑完 → open
  const ng=await api('POST','/api/analyses/'+id+'/decide',{decision:'no-go'});
  assert.equal(ng.code,200,'open 态否决应放行');
  const del=await api('POST','/api/analyses/'+id+'/delete');
  assert.equal(del.code,200);assert.ok(!fs.existsSync(dir),'硬删应移除磁盘目录');
  // 手工造态：go + spawnedRun → 删除/否决/撤回全被守卫拦
  const id2='an-manual-1';const d2=path.join(ADIR,id2);
  fs.mkdirSync(path.join(d2,'rounds'),{recursive:true});
  fs.writeFileSync(path.join(d2,'meta.json'),JSON.stringify({id:id2,idea:'手工造态守卫验证',state:'go',round:1,spawnedRun:'run-x'}));
  assert.equal((await api('POST','/api/analyses/'+id2+'/delete')).code,409,'已 spawn 不可删');
  assert.equal((await api('POST','/api/analyses/'+id2+'/decide',{decision:'withdraw'})).code,409,'已 spawn 不可撤回');
  assert.equal((await api('POST','/api/analyses/'+id2+'/decide',{decision:'no-go'})).code,409,'已 spawn 不可否决');
  fs.rmSync(d2,{recursive:true,force:true});
});
test('open 态可强制拍板 go（跳过收敛）→ state=go',async()=>{
  const id='an-manual-4';const d2=path.join(ADIR,id);
  fs.mkdirSync(path.join(d2,'rounds'),{recursive:true});
  fs.writeFileSync(path.join(d2,'meta.json'),JSON.stringify({id,idea:'强制提交验证',state:'open',round:1,spawnedRun:null}));
  const g=await api('POST','/api/analyses/'+id+'/decide',{decision:'go'});
  assert.equal(g.code,200);assert.equal(g.body.state,'go');
  fs.rmSync(d2,{recursive:true,force:true});
});
test('withdraw：go 未 spawn → 回 awaiting；非 go 态 400',async()=>{
  const id='an-manual-2';const d2=path.join(ADIR,id);
  fs.mkdirSync(path.join(d2,'rounds'),{recursive:true});
  fs.writeFileSync(path.join(d2,'meta.json'),JSON.stringify({id,idea:'撤回验证',state:'go',round:1,spawnedRun:null}));
  const w=await api('POST','/api/analyses/'+id+'/decide',{decision:'withdraw'});
  assert.equal(w.code,200);assert.equal(w.body.state,'awaiting');
  const w2=await api('POST','/api/analyses/'+id+'/decide',{decision:'withdraw'});
  assert.equal(w2.code,400,'awaiting 态再撤回应 400');
  fs.rmSync(d2,{recursive:true,force:true});
});
test('/api/dispatch 代理工厂（stub）：转发 mode/repo/projectId · 工厂不可达 502',async()=>{
  const http=await import('node:http');
  let got=null;
  const stub=http.createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{got=JSON.parse(b||'{}');
    s.writeHead(200,{'Content-Type':'application/json'});s.end(JSON.stringify({id:'fix-1',runId:'fix-1',mode:'fix'}))})});
  await new Promise(r=>stub.listen(0,r));
  const SP=stub.address().port;
  const TP2=String(8970+Math.floor(Math.random()*20));
  let child2=spawn(process.execPath,['plan-server.js'],{env:{...ENVV,PORT:TP2,FACTORY_URL:'http://127.0.0.1:'+SP},stdio:'pipe'});
  for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+TP2+'/api/analyses');break}catch(e){await new Promise(r=>setTimeout(r,250))}}
  const api2=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:'+TP2+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return{code:r.status,body:await r.json().catch(()=>({}))}};
  const id='an-manual-3';const d3=path.join(ADIR,id);
  fs.mkdirSync(path.join(d3,'rounds'),{recursive:true});
  fs.writeFileSync(path.join(d3,'meta.json'),JSON.stringify({id,idea:'代理转发验证',state:'go',round:1,spawnedRun:null}));
  const dp=await api2('POST','/api/dispatch',{id,mode:'fix',repo:'/tmp/xxx'});
  assert.equal(dp.code,200);assert.equal(dp.body.runId,'fix-1');
  assert.equal(got.mode,'fix');assert.equal(got.repo,'/tmp/xxx');assert.ok(got.analysisDir.startsWith(ADIR),'analysisDir 应由服务端补全');
  assert.equal((await api2('POST','/api/dispatch',{id:'evil!'})).code,422,'非法 id 应 422');
  // 工厂不可达：起第三个实例指向死端口
  const TP3=String(8995);
  let child3=spawn(process.execPath,['plan-server.js'],{env:{...ENVV,PORT:TP3,FACTORY_URL:'http://127.0.0.1:1'},stdio:'pipe'});
  for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+TP3+'/api/analyses');break}catch(e){await new Promise(r=>setTimeout(r,250))}}
  const r3=await fetch('http://127.0.0.1:'+TP3+'/api/dispatch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,mode:'fix',repo:'/tmp/x'})});
  assert.equal(r3.status,502,'工厂不可达应 502');
  try{child2.kill('SIGKILL')}catch(e){};try{child3.kill('SIGKILL')}catch(e){};stub.close();
  fs.rmSync(d3,{recursive:true,force:true});
});
after(()=>{try{child.kill('SIGKILL')}catch(e){};try{fs.rmSync(ADIR,{recursive:true,force:true})}catch(e){}});
