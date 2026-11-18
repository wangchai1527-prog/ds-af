import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'child_process';import fs from 'fs';import path from 'path';import os from 'os';
// v1.3 回归（DIAGNOSIS §6 判据 1–7·9 的 API 可测面）：全局根目录树（任意深度/非 /root 可见/黑名单）
// + hasChildren 真探测 + 目录增删（/root 收紧·保护路径·仅空目录）+ 磁盘桶聚合防「同桶不同组」分裂
const ADIR=fs.mkdtempSync(path.join(os.tmpdir(),'dsaf-plan13-')); // analyses（读域外也可）
const WROOT=fs.mkdtempSync('/root/.dsaf-plan13-'); // 写域临时根（增/删限 /root 子树）
const MOCK=path.resolve('test/mock-plan-agent.mjs');fs.chmodSync(MOCK,0o755);
const TP=String(9020+Math.floor(Math.random()*60));
const child=spawn(process.execPath,['plan-server.js'],{env:{...process.env,PORT:TP,ANALYSES:ADIR,PLAN_AGENT_CMD:MOCK},stdio:'pipe'});
async function untilUp(){for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+TP+'/api/analyses');return}catch(e){await new Promise(r=>setTimeout(r,250))}}throw new Error('plan-server not up')}
await untilUp();
const api=async(m,u,b)=>{const r=await fetch('http://127.0.0.1:'+TP+u,{method:m,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return{code:r.status,body:await r.json().catch(()=>({}))}};
const deep=path.join(WROOT,'a','b','c'); // 四级：WROOT/a/b/c/d
fs.mkdirSync(path.join(deep,'d'),{recursive:true});

test('判据1：三级及以下目录可见可选 · 以其为归属建会话成功（全路径标签）',async()=>{
  const b1=await api('GET','/api/dirs?base='+encodeURIComponent(WROOT));
  assert.ok(b1.body.dirs.some(d=>d.name==='a'&&d.hasChildren===true),'a 应可见且真有子目录');
  const b2=await api('GET','/api/dirs?base='+encodeURIComponent(path.join(WROOT,'a','b')));
  assert.ok(b2.body.dirs.some(d=>d.name==='c'&&d.hasChildren===true),'三级 c 应可见且真有子目录');
  const b3=await api('GET','/api/dirs?base='+encodeURIComponent(deep));
  assert.ok(b3.body.dirs.some(d=>d.name==='d'&&d.hasChildren===false),'四级 d 应可见且为叶子（无假 ▸）');
  const topic=deep.slice(1); // 相对全局根全路径标签（如 root/.dsaf-plan13-x/a/b/c）
  const r=await api('POST','/api/new',{idea:'以深层目录为归属的会话创建验证',topic});
  assert.equal(r.code,200);
  assert.ok(fs.existsSync(path.join(ADIR,topic.replace(/\//g,'_'),r.body.id)),'应落入 slug(全路径) 桶');
});

test('判据2：非 /root 路径可见可选（全局根语义）；根列表含 root/tmp',async()=>{
  const t=await api('GET','/api/dirs?base=/tmp');
  assert.equal(t.code,200,'/tmp 应可见可选（v1.2 会 400「须位于 /root 之内」）');
  const root=await api('GET','/api/dirs?base=');
  const names=root.body.dirs.map(d=>d.name);
  assert.ok(names.includes('root')&&names.includes('tmp'),'全局根应含 root 与 tmp');
});

test('判据3：黑名单目录任何层不出现 · base=/etc 与 ../etc 均 400 · 隐藏/node_modules 过滤保留',async()=>{
  const root=await api('GET','/api/dirs?base=');
  const names=root.body.dirs.map(d=>d.name);
  for(const b of ['proc','sys','dev','run','boot','etc','var','usr','lost+found'])
    assert.ok(!names.includes(b),'根层不应出现黑名单目录 '+b);
  assert.equal((await api('GET','/api/dirs?base=/etc')).code,400,'黑名单 base 应 400');
  assert.equal((await api('GET','/api/dirs?base=/proc/self')).code,400,'黑名单子路径应 400');
  fs.mkdirSync(path.join(WROOT,'nm','node_modules','x'),{recursive:true});
  fs.mkdirSync(path.join(WROOT,'nm','.hid'),{recursive:true});
  const nm=await api('GET','/api/dirs?base='+encodeURIComponent(path.join(WROOT,'nm')));
  assert.deepEqual(nm.body.dirs.map(d=>d.name),[],'隐藏与 node_modules 目录应被过滤');
});

test('判据9：撞桶不分裂 —— x/panel 与 x_panel 同磁盘桶（bucket 一致）、标签语义可区分',async()=>{
  const r1=await api('POST','/api/new',{idea:'撞桶验证：斜杠路径归属的会话',topic:'x/panel'});
  const r2=await api('POST','/api/new',{idea:'撞桶验证：下划线路径归属的会话',topic:'x_panel'});
  assert.equal(r1.code,200);assert.equal(r2.code,200);
  const list=await api('GET','/api/analyses');
  const s1=list.body.analyses.find(a=>a.id===r1.body.id),s2=list.body.analyses.find(a=>a.id===r2.body.id);
  assert.equal(s1.bucket,'x_panel');assert.equal(s2.bucket,'x_panel','两者磁盘桶一致（侧栏按 bucket 聚合 → 同组不分裂）');
  assert.equal(s1.topic,'x/panel');assert.equal(s2.topic,'x_panel','全路径标签语义可区分');
});

test('判据6：目录增删 —— /root 子树内可建可删空目录 · 即时可见 · 非空/保护/出界/非法名被拒且有报错',async()=>{
  const mk=await api('POST','/api/dirs/mkdir',{base:WROOT,name:'nd1'});
  assert.equal(mk.code,200);assert.ok(fs.existsSync(path.join(WROOT,'nd1')),'mkdir 应落盘');
  const ls=await api('GET','/api/dirs?base='+encodeURIComponent(WROOT));
  assert.ok(ls.body.dirs.some(d=>d.name==='nd1'&&d.hasChildren===false),'新建目录应即时出现在树数据源且为叶子');
  assert.equal((await api('POST','/api/dirs/rmdir',{path:path.join(WROOT,'nd1')})).code,200,'空目录可删');
  assert.ok(!fs.existsSync(path.join(WROOT,'nd1')));
  const ne=await api('POST','/api/dirs/rmdir',{path:path.join(WROOT,'a')});
  assert.equal(ne.code,409);assert.match(ne.body.error,/非空/,'非空删除应拒且有原因');
  for(const p of ['/root/.dsh',ADIR]){
    const pr=await api('POST','/api/dirs/rmdir',{path:p});
    assert.equal(pr.code,403);assert.match(pr.body.error,/保护路径|子树/,'保护/出界删除应拒且有原因');
  }
  assert.equal((await api('POST','/api/dirs/mkdir',{base:os.tmpdir(),name:'out'})).code,403,'/root 外 mkdir 应拒');
  assert.equal((await api('POST','/api/dirs/mkdir',{base:WROOT,name:'../esc'})).code,422,'非法名应拒');
  assert.ok(fs.readFileSync(path.join(ADIR,'dir-ops.jsonl'),'utf8').trim().split('\n').length>=2,'不可逆操作应写操作日志');
});

after(()=>{try{child.kill('SIGKILL')}catch(e){};for(const d of [ADIR,WROOT])try{fs.rmSync(d,{recursive:true,force:true})}catch(e){}});
