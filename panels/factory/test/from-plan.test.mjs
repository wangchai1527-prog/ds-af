import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'child_process';import fs from 'fs';import path from 'path';import os from 'os';
import {mkGoAnalysis} from './lib-plan.mjs';
// Task 2：from-plan 话题立项（分析产物=工厂输入料）+ GO/防重闸 + 原型确认闸（awaiting/approve）
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'dsaf-fp-')); // 模拟 DS-AF 根：analyses/ + runs/ + projects.json
const ANROOT=path.join(ROOT,'analyses');const RUNROOT=path.join(ROOT,'runs');
fs.mkdirSync(ANROOT,{recursive:true});fs.mkdirSync(RUNROOT,{recursive:true});
const PROJ=path.join(ROOT,'projects.json');fs.writeFileSync(PROJ,'[]');
// 造一个已拍板 GO 的分析会话
const ANID='an-test-1';const ANDIR=path.join(ANROOT,ANID);
fs.mkdirSync(path.join(ANDIR,'materials'),{recursive:true});
fs.writeFileSync(path.join(ANDIR,'meta.json'),JSON.stringify({id:ANID,idea:'看板观测面板（来自分析台）',state:'go',round:2,spawnedRun:null},null,1));
fs.writeFileSync(path.join(ANDIR,'IDEA.md'),'# IDEA 想法');
fs.writeFileSync(path.join(ANDIR,'RESEARCH.md'),'# RESEARCH 调研');
fs.writeFileSync(path.join(ANDIR,'BRIEF.md'),'# BRIEF 定稿\n产品形态：看板。范围：P0。');
fs.writeFileSync(path.join(ANDIR,'materials','refs.md'),'参考材料');
fs.chmodSync(path.resolve('test/mock-agent.mjs'),0o755);
const TP=String(8950+Math.floor(Math.random()*40));
const ENVV={...process.env,PORT:TP,RUNDIR:RUNROOT,PROJFILE:PROJ,MAX_CONCURRENT:'2',FACTORY_AGENT_BIN:path.resolve('test/mock-agent.mjs')};
let child=spawn(process.execPath,['factory-server.js'],{env:ENVV,stdio:'pipe'});
async function untilUp(){for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+TP+'/api/runs');return}catch(e){await new Promise(r=>setTimeout(r,250))}}throw new Error('server not up')}
await untilUp();
const api=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:'+TP+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return{code:r.status,body:await r.json().catch(()=>({}))}};
const stream=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:'+TP+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});const out={code:r.status,body:{}};if(r.status!==200)out.body=await r.json().catch(()=>({}));else try{await r.body.cancel()}catch(e){}return out};
async function poll(fn,ms=20000,step=300){const t0=Date.now();while(Date.now()-t0<ms){if(await fn())return true;await new Promise(r=>setTimeout(r,step))}return false}
let runId=null;

test('from-plan 闸：非 go 话题 400 · /api/analyses 立项池列表 · 建run + 拷分析产物 + 回写 spawnedRun + 重复立项 409',async()=>{
  const bad=await api('POST','/api/mission/from-plan',{analysisDir:'/etc'+path.join(ROOT,'../evil'),idea:'x'});
  assert.equal(bad.code,400,'analysisDir 越界应 400');
  const open=mkGoAnalysis(ANROOT,'未拍板话题（open 态）','open');
  const notGo=await api('POST','/api/mission/from-plan',{analysisDir:open});
  assert.equal(notGo.code,400,'未拍板 GO 的话题应 400');
  const lst=await api('GET','/api/analyses');
  assert.ok(lst.body.analyses.some(a=>a.id===ANID&&a.state==='go'&&!a.spawnedRun),'立项池应含 GO 未 spawn 话题');
  const r=await api('POST','/api/mission/from-plan',{analysisDir:ANDIR,idea:'看板观测面板（来自分析台）'}); // from-plan 返回 JSON
  assert.equal(r.code,200);runId=r.body.id||r.body.runId;assert.ok(runId,'应返回 runId');
  const meta=JSON.parse(fs.readFileSync(path.join(ANDIR,'meta.json'),'utf8'));
  assert.equal(meta.spawnedRun,runId,'spawnedRun 应回写分析台 meta');
  const dup=await api('POST','/api/mission/from-plan',{analysisDir:ANDIR,idea:'x'});
  assert.equal(dup.code,409,'同一话题重复立项应 409');
  assert.equal(dup.body.runId,runId,'409 应带已立项 runId');
  const rd=path.join(RUNROOT,runId);
  const ok=await poll(()=>fs.existsSync(path.join(rd,'llmwiki','prompt-product.txt')));
  assert.ok(ok,'PRD 节点应已执行');
  assert.ok(fs.readFileSync(path.join(rd,'materials','analysis','BRIEF.md'),'utf8').includes('BRIEF 定稿'),'BRIEF 应拷入');
  assert.ok(fs.existsSync(path.join(rd,'materials','analysis','IDEA.md')));
  assert.ok(fs.existsSync(path.join(rd,'materials','analysis','materials','refs.md')),'materials/ 子目录应一并拷入');
  const pp=fs.readFileSync(path.join(rd,'llmwiki','prompt-product.txt'),'utf8');
  assert.ok(pp.includes('materials/analysis/BRIEF.md'),'PRD prompt 应以 BRIEF 为主要输入');
});
test('自由文本 build 立项已收口：/api/mission 422 引导走分析台',async()=>{
  const r=await api('POST','/api/mission',{idea:'做一个记账小工具'});
  assert.equal(r.code,422);
  assert.ok((r.body.error||'').includes('Idea PLAN'),'错误信息应引导到分析台');
});
test('原型确认闸：prototype 过 → awaiting（停住不跑 architect）+ retry 400',async()=>{
  const ok=await poll(async()=>{
    const s=await api('GET','/api/state?id='+runId);
    return s.body.run&&s.body.run.awaiting&&s.body.run.awaiting.gate==='prototype';
  },25000);
  assert.ok(ok,'prototype 验收通过后应置 awaiting');
  const s=await api('GET','/api/state?id='+runId);
  assert.ok(!s.body.run.executing,'awaiting 态不应执行');
  assert.ok(s.body.run.nodes.find(n=>n.id==='architect').status==='pending','architect 未被带跑');
  const rt=await api('POST','/api/retry',{id:runId});
  assert.equal(rt.code,400,'awaiting run 的 retry 应 400');
});
test('approve redo：只重跑 prototype + feedback 拼进 prompt，随后再 awaiting',async()=>{
  const r=await stream('POST','/api/approve',{id:runId,decision:'redo',feedback:'改成深色主题'});
  assert.equal(r.code,200);
  const rd=path.join(RUNROOT,runId);
  const ok=await poll(async()=>{
    const pp=fs.existsSync(path.join(rd,'llmwiki','prompt-prototype.txt'))?fs.readFileSync(path.join(rd,'llmwiki','prompt-prototype.txt'),'utf8'):'';
    const s=await api('GET','/api/state?id='+runId);
    return pp.includes('深色主题')&&s.body.run&&s.body.run.awaiting;
  },25000);
  assert.ok(ok,'feedback 应拼进原型 prompt 且重跑后再 awaiting');
  const s=await api('GET','/api/state?id='+runId);
  assert.ok(s.body.run.nodes.find(n=>n.id==='product').status==='done','redo 不应重跑 PRD');
});
test('approve go：清 awaiting 续跑 architect→…→交付；完成后 approve 400',async()=>{
  const r=await stream('POST','/api/approve',{id:runId,decision:'go'});
  assert.equal(r.code,200);
  const ok=await poll(async()=>{const s=await api('GET','/api/state?id='+runId);return s.body.run&&s.body.run.done},40000);
  assert.ok(ok,'go 后应走完全程交付');
  const again=await api('POST','/api/approve',{id:runId,decision:'go'});
  assert.equal(again.code,400,'非 awaiting run 的 approve 应 400');
});
test('awaiting 持久化：重启后 awaiting 不丢',async()=>{
  // 新话题再开一个 from-plan run 到 awaiting，杀进程重启验证
  const ad2=mkGoAnalysis(ANROOT,'第二个话题验证持久化');
  const r=await api('POST','/api/mission/from-plan',{analysisDir:ad2}); // JSON，idea 回退 meta 真源
  const id2=r.body.id||r.body.runId;assert.ok(id2);
  const ok=await poll(async()=>{const s=await api('GET','/api/state?id='+id2);return s.body.run&&s.body.run.awaiting},25000);
  assert.ok(ok,'第二个 run 应到 awaiting');
  try{child.kill('SIGKILL')}catch(e){}
  await new Promise(r2=>setTimeout(r2,400));
  child=spawn(process.execPath,['factory-server.js'],{env:ENVV,stdio:'pipe'});
  await untilUp();
  const ok2=await poll(async()=>{const s=await api('GET','/api/state?id='+id2);return s.body.run&&s.body.run.awaiting&&s.body.run.awaiting.gate==='prototype'},15000);
  assert.ok(ok2,'重启后 awaiting 应从 nodes.json 恢复');
});
test('混主责合同：qa 属主任务未标 done 不阻断 coding（验收只查 coding 任务）',async()=>{
  const ad3=mkGoAnalysis(ANROOT,'混主责 验证：合同含 qa 任务 coding 不代标');
  const r=await api('POST','/api/mission/from-plan',{analysisDir:ad3,idea:'混主责 验证：合同含 qa 任务 coding 不代标'});
  const id3=r.body.runId;assert.ok(id3);
  const ok=await poll(async()=>{
    await api('POST','/api/approve',{id:id3,decision:'go'}).catch(()=>{}); // 放行原型闸
    const s=await api('GET','/api/state?id='+id3);
    return s.body.run&&(s.body.run.done||s.body.run.blocked)},40000);
  assert.ok(ok,'run 应走完或明确 blocked');
  const s=await api('GET','/api/state?id='+id3);
  assert.ok(!s.body.run.blocked,'coding 不应因 qa 任务未标 done 而阻断');
  const codingNode=s.body.run.nodes.find(n=>n.id==='coding');
  assert.equal(codingNode.status,'done','coding 节点应验收通过');
  assert.ok((codingNode.acceptDetail||'').includes('coding任务done:2/3'),'验收明细应显示 2/3（qa 任务豁免）');
});
test('deployTo 面板部署：设目标→上线即同步产物+跑 deploy.sh · 非法目标 400 · 空串清除',async()=>{
  // 造一个 delivered 终态 run（build 链 9 节点、末位 deploy=skipped）+ 目标面板目录（带 deploy.sh 与既有文件）
  const rid='run-dt-1';fs.mkdirSync(path.join(RUNROOT,rid,'product'),{recursive:true});
  fs.writeFileSync(path.join(RUNROOT,rid,'product','index.html'),'<h1>dt</h1>');
  fs.writeFileSync(path.join(RUNROOT,rid,'manifest.json'),JSON.stringify({run_id:rid,flow:'build',repo:null}));
  fs.writeFileSync(path.join(RUNROOT,rid,'nodes.json'),JSON.stringify({flow:'build',nodeStatus:['done','done','done','done','done','done','done','done','skipped']}));
  fs.writeFileSync(PROJ,JSON.stringify([{id:'P-901',name:'面板部署验证',repo:null,created:new Date().toISOString(),runs:[rid]}]));
  const panel=path.join(ROOT,'panel');fs.mkdirSync(panel,{recursive:true});
  fs.writeFileSync(path.join(panel,'keep.txt'),'既有文件不可被清掉');
  fs.writeFileSync(path.join(panel,'deploy.sh'),'#!/bin/bash\necho ran > deploy-ran.txt\n');
  // 非法目标：相对路径 / runs/ 区内 / 不存在目录 → 400
  assert.equal((await api('POST','/api/projects/deploy',{projectId:'P-901',deployTo:'relative/path'})).code,400,'相对路径应 400');
  assert.equal((await api('POST','/api/projects/deploy',{projectId:'P-901',deployTo:path.join(RUNROOT,'runs-in')})).code,400,'runs/ 区内应 400');
  assert.equal((await api('POST','/api/projects/deploy',{projectId:'P-901',deployTo:'/no/such/dir'})).code,400,'不存在目录应 400');
  // 合法：设 deployTo + 补办部署 → 产物同步 + deploy.sh 执行 + 指针记账
  const r=await api('POST','/api/projects/deploy',{projectId:'P-901',deployTo:panel});
  assert.equal(r.code,200,r.body.error||'');
  assert.ok(fs.existsSync(path.join(panel,'index.html')),'产物应同步进面板目录');
  assert.ok(fs.existsSync(path.join(panel,'keep.txt')),'面板既有文件不应被删');
  assert.ok(fs.existsSync(path.join(panel,'deploy-ran.txt')),'deploy.sh 应被执行');
  assert.ok(r.body.deploy&&r.body.deploy.files>=1,'响应应带同步文件数');
  const pr=JSON.parse(fs.readFileSync(PROJ,'utf8')).find(x=>x.id==='P-901');
  assert.equal(pr.deployTo,panel,'deployTo 应持久化到 projects.json');
  assert.equal(pr.deployed.runId,rid,'deployed 指针应记账');
  // 空串 = 清除目标
  const c=await api('POST','/api/projects/deploy',{projectId:'P-901',deployTo:''});
  assert.equal(c.code,200,c.body.error||'');
  assert.equal(JSON.parse(fs.readFileSync(PROJ,'utf8')).find(x=>x.id==='P-901').deployTo,null,'空串应清除 deployTo');
});
test('已立项话题提交升级整改：spawnedRun 已设 → iterate 放行建 run（防重闸只拦 build）',async()=>{
  // 造一个已立项（spawnedRun 已设）的 GO 话题 + 它名下已有带产品的 run（deployTo 测试造的 P-901/run-dt-1）
  const an2=path.join(ANROOT,'an-spawned-2');fs.mkdirSync(an2,{recursive:true});
  fs.writeFileSync(path.join(an2,'meta.json'),JSON.stringify({id:'an-spawned-2',idea:'已立项话题的升级整改诉求（第二轮）',state:'go',round:2,spawnedRun:'run-dt-1'},null,1));
  fs.writeFileSync(path.join(an2,'BRIEF.md'),'# 升级整改 BRIEF');
  let r=null;
  const ok=await poll(async()=>{ // 并发满时 409，等前序 run 收尾后重试
    r=await api('POST','/api/mission/from-plan',{analysisDir:an2,mode:'iterate',projectId:'P-901'});
    return r.code===200||!/并发已满/.test(r.body.error||'');
  },30000,500);
  assert.ok(ok,'dispatch 应有非并发结论');
  assert.equal(r.code,200,'已立项话题 iterate 应放行（实际: '+(r.body.error||r.code)+'）');
  assert.equal(r.body.mode,'iterate');
  const meta=JSON.parse(fs.readFileSync(path.join(an2,'meta.json'),'utf8'));
  assert.equal(meta.spawnedRun,r.body.runId,'spawnedRun 指针应切到新 iterate run');
  assert.ok((JSON.parse(fs.readFileSync(PROJ,'utf8')).find(x=>x.id==='P-901').runs||[]).includes(r.body.runId),'run 应挂回 P-901');
});
after(()=>{try{child.kill('SIGKILL')}catch(e){};try{fs.rmSync(ROOT,{recursive:true,force:true})}catch(e){}});
