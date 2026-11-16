import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'child_process';import fs from 'fs';import path from 'path';import os from 'os';
// Task 4：项目绑 GitHub 远程 + 交付 best-effort 推送（token 只从 env，绝不落盘）
const RUND=fs.mkdtempSync(path.join(os.tmpdir(),'dsaf-push-'));
const PROJ=path.join(RUND,'projects.json');fs.writeFileSync(PROJ,'[]');
fs.chmodSync(path.resolve('test/mock-agent.mjs'),0o755);
const TP=String(9050+Math.floor(Math.random()*40));
const ENVV={...process.env,PORT:TP,RUNDIR:RUND,PROJFILE:PROJ,MAX_CONCURRENT:'1',FACTORY_AGENT_BIN:path.resolve('test/mock-agent.mjs')};
delete ENVV.DSH_GIT_TOKEN; // 无 token 场景
let child=spawn(process.execPath,['factory-server.js'],{env:ENVV,stdio:'pipe'});
async function untilUp(){for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+TP+'/api/runs');return}catch(e){await new Promise(r=>setTimeout(r,250))}}throw new Error('server not up')}
await untilUp();
const api=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:'+TP+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return{code:r.status,body:await r.json().catch(()=>({}))}};
async function poll(fn,ms=30000,step=300){const t0=Date.now();while(Date.now()-t0<ms){if(await fn())return true;await new Promise(r=>setTimeout(r,step))}return false}
let runId=null;

test('绑远程：非法 URL 400 · 合法 GitHub URL 绑定/解绑',async()=>{
  const r=await fetch('http://127.0.0.1:'+TP+'/api/mission',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idea:'远程推送验证小工具'})});
  assert.equal(r.status,200);try{await r.body.cancel()}catch(e){}
  const ok=await poll(async()=>{const s=await api('GET','/api/projects');return (s.body.projects||[]).length>0&&((s.body.projects[0].runs||[]).length>0)});
  assert.ok(ok,'run 应登记项目且挂上 run');
  const projs=(await api('GET','/api/projects')).body.projects;
  const pid=projs[0].id;
  const bad=await api('POST','/api/projects/remote',{id:pid,remote:'https://gitlab.com/x/y'});
  assert.equal(bad.code,400,'非 GitHub URL 应 400');
  const bad2=await api('POST','/api/projects/remote',{id:pid,remote:'https://github.com.evil.com/x/y'});
  assert.equal(bad2.code,400,'伪造前缀应 400');
  const good=await api('POST','/api/projects/remote',{id:pid,remote:'https://github.com/dsh/test-repo'});
  assert.equal(good.code,200);assert.equal(good.body.remote,'https://github.com/dsh/test-repo');
  const saved=JSON.parse(fs.readFileSync(PROJ,'utf8'));
  assert.equal(saved[0].remote,'https://github.com/dsh/test-repo','projects.json 应含 remote');
  assert.ok(!fs.readFileSync(PROJ,'utf8').includes('DSH_GIT_TOKEN'),'token 绝不落 projects.json');
  const off=await api('POST','/api/projects/remote',{id:pid,remote:''});
  assert.equal(off.code,200);assert.equal(off.body.remote,null,'空 remote 解绑置 null');
  await api('POST','/api/projects/remote',{id:pid,remote:'https://github.com/dsh/test-repo'}); // 再绑回供后续
  runId=projs[0].runs[0].id; // /api/projects 的 runs 是对象数组
});
test('无 token：delivery 后 run 仍 done（push 静默跳过不阻断）',async()=>{
  const ok=await poll(async()=>{const s=await api('GET','/api/state?id='+runId);return s.body.run&&s.body.run.done},30000);
  assert.ok(ok,'无 token 推送跳过，全链仍应交付');
});
after(()=>{try{child.kill('SIGKILL')}catch(e){};try{fs.rmSync(RUND,{recursive:true,force:true})}catch(e){}});
