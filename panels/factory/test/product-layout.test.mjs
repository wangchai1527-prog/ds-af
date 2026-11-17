import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'child_process';import fs from 'fs';import path from 'path';import os from 'os';
import {mkGoAnalysis,approveAllAwaiting} from './lib-plan.mjs';
// Task 3：product/ 独立产品仓布局（coding 写作目标与交付 git 都在 product/ 内）
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'dsaf-prod-'));
const RUND=path.join(ROOT,'runs');const ANROOT=path.join(ROOT,'analyses');
fs.mkdirSync(RUND,{recursive:true});fs.mkdirSync(ANROOT,{recursive:true});
const PROJ=path.join(ROOT,'projects.json');fs.writeFileSync(PROJ,'[]');
fs.chmodSync(path.resolve('test/mock-agent.mjs'),0o755);
const TP=String(9010+Math.floor(Math.random()*40));
const ENVV={...process.env,PORT:TP,RUNDIR:RUND,PROJFILE:PROJ,MAX_CONCURRENT:'1',FACTORY_AGENT_BIN:path.resolve('test/mock-agent.mjs')};
let child=spawn(process.execPath,['factory-server.js'],{env:ENVV,stdio:'pipe'});
async function untilUp(){for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+TP+'/api/runs');return}catch(e){await new Promise(r=>setTimeout(r,250))}}throw new Error('server not up')}
await untilUp();
const api=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:'+TP+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return{code:r.status,body:await r.json().catch(()=>({}))}};
async function poll(fn,ms=25000,step=300){const t0=Date.now();while(Date.now()-t0<ms){if(await fn())return true;await new Promise(r=>setTimeout(r,step))}return false}
let runId=null,rd=null;

test('from-plan 建 run → scaffold 含 product/ + manifest.productDir',async()=>{
  const r=await fetch('http://127.0.0.1:'+TP+'/api/mission/from-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({analysisDir:mkGoAnalysis(ANROOT,'产品仓布局验证小工具')})});
  assert.equal(r.status,200);
  await r.json();
  const ok=await poll(async()=>{const s=await api('GET','/api/state');const rr=(s.body.runs||[])[0];if(rr){runId=rr.id;rd=path.join(RUND,runId)}return !!rr});
  assert.ok(ok);
  assert.ok(fs.existsSync(path.join(rd,'product')),'run 根应有 product/ 目录');
  const mf=JSON.parse(fs.readFileSync(path.join(rd,'manifest.json'),'utf8'));
  assert.equal(mf.productDir,'product');
});
test('coding 产物落在 product/ + 交付 git 提交在 product/ 内（不对 run 根 init）',async()=>{
  const ok=await poll(async()=>{
    await approveAllAwaiting('http://127.0.0.1:'+TP); // 原型闸放行后才可能走到交付
    const s=await api('GET','/api/state?id='+runId);return s.body.run&&s.body.run.done},30000);
  assert.ok(ok,'mock 全链应跑完');
  assert.ok(fs.existsSync(path.join(rd,'product','index.html')),'入口页应在 product/ 内');
  assert.ok(fs.existsSync(path.join(rd,'product','.git')),'交付 git 仓应在 product/ 内');
  assert.ok(!fs.existsSync(path.join(rd,'.git')),'不得对 run 根 init');
});
after(()=>{try{child.kill('SIGKILL')}catch(e){};try{fs.rmSync(ROOT,{recursive:true,force:true})}catch(e){}});
