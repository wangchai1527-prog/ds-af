import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'child_process';import fs from 'fs';import path from 'path';import os from 'os';
// Task 0：Idea Plan 分析台（会话/轮次协议 · 五态 · 防重入 · 复活 · materials 路径防注入）
const ADIR=fs.mkdtempSync(path.join(os.tmpdir(),'dsaf-plan-'));
const MOCK=path.resolve('test/mock-plan-agent.mjs');
fs.chmodSync(MOCK,0o755);
const TP=String(8890+Math.floor(Math.random()*80));
const ENVV={...process.env,PORT:TP,ANALYSES:ADIR,PLAN_AGENT_CMD:MOCK,FACTORY_URL:'http://127.0.0.1:1'}; // 工厂不可达
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
test('decide go 时工厂不可达 → 仍 200 + state=go + spawnedRun=null',async()=>{
  // 第 3 轮（复活轮）mock 也输出收敛 → awaiting
  const ok=await poll(()=>JSON.parse(fs.readFileSync(path.join(ADIR,sid,'meta.json'),'utf8')).state==='awaiting',15000);
  assert.ok(ok,'复活轮应收敛 awaiting');
  const d=await api('POST','/api/analyses/'+sid+'/decide',{decision:'go'});
  assert.equal(d.code,200);
  const meta=JSON.parse(fs.readFileSync(path.join(ADIR,sid,'meta.json'),'utf8'));
  assert.equal(meta.state,'go');assert.equal(meta.spawnedRun,null,'工厂不可达 spawnedRun 应为 null');
});
after(()=>{try{child.kill('SIGKILL')}catch(e){};try{fs.rmSync(ADIR,{recursive:true,force:true})}catch(e){}});
