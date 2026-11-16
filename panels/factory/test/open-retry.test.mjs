import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'child_process';import fs from 'fs';import path from 'path';import os from 'os';
// Task 6：历史 run 重开 + 按 id 重试（自动 open）+ verify-only 重试 + delete 去引用
const RUND=fs.mkdtempSync(path.join(os.tmpdir(),'dsaf-open-'));
const PROJ=path.join(RUND,'projects.json');fs.writeFileSync(PROJ,'[]');
fs.chmodSync(path.resolve('test/mock-agent.mjs'),0o755);
// 造 blocked run：coding 阻断，但产物人工已修好（tasks 全 done + product/index.html）
const BLK=path.join(RUND,'run-hist-blocked-1');
fs.mkdirSync(path.join(BLK,'llmwiki'),{recursive:true});fs.mkdirSync(path.join(BLK,'product'),{recursive:true});
fs.writeFileSync(path.join(BLK,'manifest.json'),JSON.stringify({run_id:'run-hist-blocked-1',flow:'build'}));
fs.writeFileSync(path.join(BLK,'nodes.json'),JSON.stringify({idea:'历史阻断任务（人工已修产物）',flow:'build',
  nodeStatus:['done','done','done','done','done','blocked','pending','pending'],acceptDetails:[]}));
fs.writeFileSync(path.join(BLK,'llmwiki','tasks.json'),JSON.stringify([{task_id:'T1',status:'done'},{task_id:'T2',status:'done'}]));
fs.writeFileSync(path.join(BLK,'product','index.html'),'<html>ok</html>');
// 造已交付 run（open 应 400）
const DONE=path.join(RUND,'run-hist-done-1');
fs.mkdirSync(DONE,{recursive:true});
fs.writeFileSync(path.join(DONE,'manifest.json'),'{}');
fs.writeFileSync(path.join(DONE,'nodes.json'),JSON.stringify({idea:'已交付',flow:'build',nodeStatus:['done','done','done','done','done','done','done','done'],acceptDetails:[]}));
// 造第二个 blocked run（PRD 阻断，未 open，验证 retry 自动 open）
const BLK2=path.join(RUND,'run-hist-blocked-2');
fs.mkdirSync(path.join(BLK2,'llmwiki'),{recursive:true});
fs.writeFileSync(path.join(BLK2,'manifest.json'),'{}');
fs.writeFileSync(path.join(BLK2,'nodes.json'),JSON.stringify({idea:'未开仓的历史阻断',flow:'build',
  nodeStatus:['done','blocked','pending','pending','pending','pending','pending','pending'],acceptDetails:[]}));
const TP=String(9200+Math.floor(Math.random()*40));
const ENVV={...process.env,PORT:TP,RUNDIR:RUND,PROJFILE:PROJ,MAX_CONCURRENT:'2',FACTORY_AGENT_BIN:path.resolve('test/mock-agent.mjs')};
let child=spawn(process.execPath,['factory-server.js'],{env:ENVV,stdio:'pipe'});
async function untilUp(){for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+TP+'/api/runs');return}catch(e){await new Promise(r=>setTimeout(r,250))}}throw new Error('server not up')}
await untilUp();
const api=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:'+TP+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return{code:r.status,body:await r.json().catch(()=>({}))}};
const stream=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:'+TP+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});const out={code:r.status,body:{}};if(r.status!==200)out.body=await r.json().catch(()=>({}));else try{await r.body.cancel()}catch(e){}return out};
async function poll(fn,ms=30000,step=300){const t0=Date.now();while(Date.now()-t0<ms){if(await fn())return true;await new Promise(r=>setTimeout(r,step))}return false}

test('open：blocked 历史载入 activeRuns · 重复 open 幂等 · 已交付 400 · 不存在 404',async()=>{
  const o=await api('POST','/api/runs/open',{id:'run-hist-blocked-1'});
  assert.equal(o.code,200);
  const s=await api('GET','/api/state?id=run-hist-blocked-1');
  assert.ok(s.body.run,'open 后应可按 id 寻址');
  assert.ok(!s.body.run.executing,'载入为 paused');
  const o2=await api('POST','/api/runs/open',{id:'run-hist-blocked-1'});
  assert.equal(o2.code,200,'重复 open 幂等 200');
  const d=await api('POST','/api/runs/open',{id:'run-hist-done-1'});
  assert.equal(d.code,400,'已完整交付的 run 不应重开');
  const nf=await api('POST','/api/runs/open',{id:'run-nope'});
  assert.equal(nf.code,404);
});
test('verifyOnly 重试：不跑 agent 仅重验 accept → coding 放行 → 全链走完',async()=>{
  const r=await stream('POST','/api/retry',{id:'run-hist-blocked-1',verifyOnly:true});
  assert.equal(r.code,200,'verifyOnly 应被受理（无需先 open，已 open 幂等）');
  const ok=await poll(async()=>{const s=await api('GET','/api/state?id=run-hist-blocked-1');return s.body.run&&s.body.run.done},35000);
  assert.ok(ok,'人工修好产物 → verifyOnly 放行 → QA/交付(mock) 全链完成');
});
test('retry 带 id 自动 open 未载入的历史 blocked run',async()=>{
  const r=await stream('POST','/api/retry',{id:'run-hist-blocked-2'});
  assert.notEqual(r.code,400,'带 id 重试应自动 open 而非 no run 400');
  const ok=await poll(async()=>{const s=await api('GET','/api/state?id=run-hist-blocked-2');return s.body.run&&s.body.run.done},35000);
  assert.ok(ok,'PRD 阻断重试(mock)后全链完成');
});
test('delete 后 projects.json 去引用（无悬空 runId）',async()=>{
  // 登记 run-hist-done-1 到项目再删
  fs.writeFileSync(PROJ,JSON.stringify([{id:'P-001',name:'x',runs:['run-hist-done-1','run-hist-blocked-1']}]));
  const del=await api('POST','/api/runs/delete',{id:'run-hist-done-1'});
  assert.equal(del.code,200);
  const saved=JSON.parse(fs.readFileSync(PROJ,'utf8'));
  assert.ok(!saved[0].runs.includes('run-hist-done-1'),'删除后不应残留悬空 runId');
  assert.ok(saved[0].runs.includes('run-hist-blocked-1'),'其余 run 引用不受影响');
});
after(()=>{try{child.kill('SIGKILL')}catch(e){};try{fs.rmSync(RUND,{recursive:true,force:true})}catch(e){}});
