import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'child_process';import fs from 'fs';import path from 'path';import os from 'os';
// Task 1：多 run 并发执行制（MAX_CONCURRENT=2，mock agent 快速完成）
const RUND=fs.mkdtempSync(path.join(os.tmpdir(),'dsaf-conc-'));
const PROJ=path.join(RUND,'projects.json');
fs.writeFileSync(PROJ,'[]');
fs.chmodSync(path.resolve('test/mock-agent.mjs'),0o755);
const TP=String(8810+Math.floor(Math.random()*80));
const ENVV={...process.env,PORT:TP,RUNDIR:RUND,PROJFILE:PROJ,MAX_CONCURRENT:'2',FACTORY_AGENT_BIN:path.resolve('test/mock-agent.mjs')};
let child=spawn(process.execPath,['factory-server.js'],{env:ENVV,stdio:'pipe'});
async function untilUp(){for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+TP+'/api/runs');return}catch(e){await new Promise(r=>setTimeout(r,250))}}throw new Error('server not up')}
await untilUp();
const api=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:'+TP+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return{code:r.status,body:await r.json().catch(()=>({}))}};
const mission=async idea=>{const r=await fetch('http://127.0.0.1:'+TP+'/api/mission',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idea})});
  const out={code:r.status,body:{}}; // 200 是 NDJSON 流：只收 header 即返回，勿等全量 body
  if(r.status!==200)out.body=await r.json().catch(()=>({}));else try{await r.body.cancel()}catch(e){}
  return out};
async function poll(fn,ms=15000,step=300){const t0=Date.now();while(Date.now()-t0<ms){if(await fn())return true;await new Promise(r=>setTimeout(r,step))}return false}
const idOf=r=>r.body.run&&r.body.run.dir&&path.basename(r.body.run.dir);

test('两 mission 并发在跑 + 第 3 个 409 并发已满',async()=>{
  const a=await mission('建造甲号记账小工具产品');const b=await mission('建造乙号待办清单产品');
  assert.equal(a.code,200);assert.equal(b.code,200); // 旧单例实现此处即 409 factory busy → FAIL
  const ok=await poll(async()=>{const s=await api('GET','/api/state');return (s.body.runs||[]).length>=2});
  assert.ok(ok,'runs[] 应含 2 个并发 run');
  const s=await api('GET','/api/state');
  const exec=s.body.runs.filter(r=>r.executing).length;
  assert.ok(exec>=1,'应有 run 在执行'); // mock 节点很快，宽松断言
  const c=await mission('建造丙号天气页产品');
  assert.equal(c.code,409);assert.equal(c.body.error,'并发已满');
});
test('按 id 独立寻址 /api/state?id=',async()=>{
  const s=await api('GET','/api/state');
  assert.ok(s.body.runs.length>=2);
  for(const r of s.body.runs){
    const one=await api('GET','/api/state?id='+r.id);
    assert.equal(one.body.run.id,r.id);
    assert.ok(one.body.run.nodes.length>0);
  }
});
test('一个 blocked 不影响另一个跑完 + projects 无丢更新',async()=>{
  // 甲 = 含「必阻塞」的 mission → coding 节点写残件 → blocked；乙正常 → 全绿交付
  await poll(async()=>{const s=await api('GET','/api/state');return (s.body.runs||[]).filter(r=>r.executing).length<2},25000); // 等并发额度空出
  const blk=await mission('建造丁号产品 必阻塞 的实验品');assert.equal(blk.code,200);
  const done=await poll(async()=>{
    const s=await api('GET','/api/state');
    const y=s.body.runs.find(r=>r.idea.includes('乙号'));
    return y&&y.done},20000);
  assert.ok(done,'乙号应完成交付');
  const dblk=await poll(async()=>{const s=await api('GET','/api/state');const d=s.body.runs.find(r=>r.idea.includes('丁号'));return d&&d.blocked},20000);
  assert.ok(dblk,'丁号应 blocked');
  const s=await api('GET','/api/state');
  const d=s.body.runs.find(r=>r.idea.includes('丁号'));
  const s2=await api('GET','/api/state?id='+d.id);
  assert.ok(s2.body.run.nodes.some(n=>n.status==='blocked'));
  const projs=JSON.parse(fs.readFileSync(PROJ,'utf8'));
  const registered=projs.flatMap(p=>p.runs||[]);
  const yid=(await api('GET','/api/state')).body.runs.find(r=>r.idea.includes('乙号')).id;
  assert.ok(registered.includes(yid),'乙号 run 应登记进 projects.json');
  assert.equal(registered.filter(x=>x===yid).length,1,'同一 run 只登记一次');
});
test('重启服务 → 全量恢复 paused（不自动续跑、不占并发额度）',async()=>{
  const before=await api('GET','/api/state');
  const had=before.body.runs.length;
  try{child.kill('SIGKILL')}catch(e){}
  await new Promise(r=>setTimeout(r,400));
  child=spawn(process.execPath,['factory-server.js'],{env:ENVV,stdio:'pipe'});
  await untilUp();
  const ok=await poll(async()=>{const s=await api('GET','/api/state');return (s.body.runs||[]).length>=1});
  assert.ok(ok,'未完 run 应恢复');
  const s=await api('GET','/api/state');
  assert.ok(s.body.runs.every(r=>!r.executing),'恢复态应为 paused（executing=false）');
  const n=await mission('建造戊号恢复后新产品'); // 丁号 paused 不占额度 → 应受理
  assert.equal(n.code,200);
});
after(()=>{try{child.kill('SIGKILL')}catch(e){};try{fs.rmSync(RUND,{recursive:true,force:true})}catch(e){}});
