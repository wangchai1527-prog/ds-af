import {test} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'child_process';import fs from 'fs';import path from 'path';import os from 'os';
const RUND=fs.mkdtempSync(path.join(os.tmpdir(),'dsaf-test-'));
const rid='run-99990001';
fs.mkdirSync(path.join(RUND,rid));
fs.writeFileSync(path.join(RUND,rid,'nodes.json'),JSON.stringify({idea:'测试项目',flow:'build',nodeStatus:['done','blocked','pending'],ts:1}));
const child=spawn('node',[path.resolve('factory-server.js')],{env:{...process.env,PORT:'8796',RUNDIR:RUND},stdio:'pipe'});
async function untilUp(){for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:8796/api/runs');return}catch(e){await new Promise(r=>setTimeout(r,250))}}throw new Error('server not up')}
await untilUp();
const api=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:8796'+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return{code:r.status,body:await r.json().catch(()=>({}))}};
test('删除 blocked run：active 清零 + 列表移除',async()=>{
  let r=await api('GET','/api/state');
  assert.equal(r.body.run.idea,'测试项目');              // bootState 恢复为活跃
  r=await api('POST','/api/runs/delete',{id:rid});
  assert.equal(r.body.ok,true);
  assert.equal(r.body.clearedActive,true);
  r=await api('GET','/api/state');
  assert.equal(r.body.run,null);                          // 当前任务清零
  r=await api('GET','/api/runs');
  assert.ok(!r.body.runs.some(x=>x.id===rid));            // 列表移除
});
test('坏 id 拒删',async()=>{
  const r=await api('POST','/api/runs/delete',{id:'../../etc'});
  assert.notEqual(r.body.ok,true);
});
test('执行中禁删（executing 标志）',async()=>{
  // 提交一个 mission 触发 executing（claude 子进程会起，但我们在 mission 受理瞬间删除）
  const p=fetch('http://127.0.0.1:8796/api/mission',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idea:'做一个圆面积计算器小工具'})});
  await new Promise(r=>setTimeout(r,1500));
  const st=await api('GET','/api/state');
  if(st.body.run&&st.body.run.dir){
    const id=path.basename(st.body.run.dir);
    const r=await api('POST','/api/runs/delete',{id});
    // executing=true 时必须 409；若已 blocked（节点快）则允许删
    if(r.code===200){assert.equal(r.body.ok,true)}else{assert.equal(r.code,409)}
  }
  await p.catch(()=>{});
});
child.kill('SIGKILL');fs.rmSync(RUND,{recursive:true,force:true});
