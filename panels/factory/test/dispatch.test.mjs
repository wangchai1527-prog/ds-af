import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'child_process';import fs from 'fs';import path from 'path';import os from 'os';
import {mkGoAnalysis,approveAllAwaiting} from './lib-plan.mjs';
// 话题三通：from-plan mode=fix（带 repo → fix run 绑仓）· mode=iterate（带 projectId → iterate run 挂项目）· mode 校验
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'dsaf-disp-'));
const RUND=path.join(ROOT,'runs');const ANROOT=path.join(ROOT,'analyses');
fs.mkdirSync(RUND,{recursive:true});fs.mkdirSync(ANROOT,{recursive:true});
const PROJ=path.join(ROOT,'projects.json');fs.writeFileSync(PROJ,'[]');
const REPO=path.join(ROOT,'target-repo');fs.mkdirSync(path.join(REPO,'.git'),{recursive:true});fs.writeFileSync(path.join(REPO,'index.html'),'<h1>hi</h1>');
fs.chmodSync(path.resolve('test/mock-agent.mjs'),0o755);
const TP=String(9110+Math.floor(Math.random()*40));
const ENVV={...process.env,PORT:TP,RUNDIR:RUND,PROJFILE:PROJ,MAX_CONCURRENT:'2',FACTORY_AGENT_BIN:path.resolve('test/mock-agent.mjs')};
let child=spawn(process.execPath,['factory-server.js'],{env:ENVV,stdio:'pipe'});
async function untilUp(){for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+TP+'/api/runs');return}catch(e){await new Promise(r=>setTimeout(r,250))}}throw new Error('server not up')}
await untilUp();
const post=async b=>{const r=await fetch('http://127.0.0.1:'+TP+'/api/mission/from-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return{code:r.status,body:await r.json().catch(()=>({}))}};
async function poll(fn,ms=30000,step=300){const t0=Date.now();while(Date.now()-t0<ms){if(await fn())return true;await new Promise(r=>setTimeout(r,step))}return false}

test('fix 模式：go 话题 + 有效 repo → fix- run 绑仓 + 分析产物随行 + 回写 spawnedRun + 重复 409',async()=>{
  const ad=mkGoAnalysis(ANROOT,'给登录页修复 401 报错工单');
  const r=await post({analysisDir:ad,mode:'fix',repo:REPO});
  assert.equal(r.code,200);assert.ok(r.body.runId&&r.body.runId.startsWith('fix-'),'应建 fix- 前缀 run');
  assert.equal(r.body.mode,'fix');
  const mf=JSON.parse(fs.readFileSync(path.join(RUND,r.body.runId,'manifest.json'),'utf8'));
  assert.equal(mf.flow,'fix');assert.equal(mf.repo,REPO,'manifest.repo 应绑目标仓');
  assert.ok(fs.existsSync(path.join(RUND,r.body.runId,'materials','analysis')),'分析产物应随行入料');
  const am=JSON.parse(fs.readFileSync(path.join(ad,'meta.json'),'utf8'));
  assert.equal(am.spawnedRun,r.body.runId,'meta.spawnedRun 应回写');
  const dup=await post({analysisDir:ad,mode:'fix',repo:REPO});
  assert.equal(dup.code,409,'同话题重复立项应 409');
  const badRepo=await post({analysisDir:mkGoAnalysis(ANROOT,'坏路径修复验证'),mode:'fix',repo:'/nonexistent/xx'});
  assert.equal(badRepo.code,400,'无效 repo 应 400');
  const badMode=await post({analysisDir:mkGoAnalysis(ANROOT,'坏 mode 验证'),mode:'research'});
  assert.equal(badMode.code,422,'非法 mode 应 422');
});
test('iterate 模式：先 build 交付项目 → 话题转升级 → iterate run 挂同一项目 · 坏 projectId 404',async()=>{
  const adB=mkGoAnalysis(ANROOT,'先建个导出面板产品再升级它');
  const b=await post({analysisDir:adB}); // 默认 build
  assert.equal(b.code,200);
  const ok=await poll(async()=>{await approveAllAwaiting('http://127.0.0.1:'+TP); // 原型闸放行走到交付
    const s=await(await fetch('http://127.0.0.1:'+TP+'/api/state?id='+b.body.runId)).json().catch(()=>({}));
    return s.run&&s.run.done&&fs.existsSync(path.join(RUND,b.body.runId,'product','index.html'))},30000);
  assert.ok(ok,'build 应交付完成且产品落 product/');
  const projs=JSON.parse(fs.readFileSync(PROJ,'utf8'));
  const pr=projs.find(p=>(p.runs||[]).includes(b.body.runId));
  const adI=mkGoAnalysis(ANROOT,'给已交付面板加 CSV 导出的升级');
  const it=await post({analysisDir:adI,mode:'iterate',projectId:pr.id});
  assert.equal(it.code,200);assert.ok(it.body.runId.startsWith('run-'));
  const mf=JSON.parse(fs.readFileSync(path.join(RUND,it.body.runId,'manifest.json'),'utf8'));
  assert.equal(mf.flow,'iterate');
  assert.ok(mf.repo&&mf.repo.startsWith(RUND),'iterate repo 应指向父产品');
  assert.ok(fs.existsSync(path.join(RUND,it.body.runId,'materials','analysis')),'分析产物应随行');
  const amI=JSON.parse(fs.readFileSync(path.join(adI,'meta.json'),'utf8'));
  assert.equal(amI.spawnedRun,it.body.runId);
  const none=await post({analysisDir:mkGoAnalysis(ANROOT,'坏项目升级验证'),mode:'iterate',projectId:'P-999'});
  assert.equal(none.code,404,'不存在的项目应 404');
});
after(()=>{try{child.kill('SIGKILL')}catch(e){};try{fs.rmSync(ROOT,{recursive:true,force:true})}catch(e){}});
