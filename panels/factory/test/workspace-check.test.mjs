import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'child_process';import fs from 'fs';import path from 'path';import os from 'os';
// Task 5：目录规范机器巡检 checkWorkspace（只读，六类 issue）
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'dsaf-lint-'));
const RUND=path.join(ROOT,'runs');const AND=path.join(ROOT,'analyses');
fs.mkdirSync(RUND,{recursive:true});fs.mkdirSync(AND,{recursive:true});
const PROJ=path.join(ROOT,'projects.json');
fs.writeFileSync(PROJ,JSON.stringify([{id:'P-001',name:'x',runs:['run-ghost-1']}])); // ④ 悬空引用
fs.writeFileSync(path.join(ROOT,'stray.txt'),'x'); // ① 顶层散落
fs.mkdirSync(path.join(RUND,'badname')); // ② runs/ 命名违规
fs.mkdirSync(path.join(RUND,'run-incomplete')); // ③ 残缺（无 manifest/nodes）
fs.mkdirSync(path.join(AND,'bad-analysis')); // ⑤ analyses 命名违规
const good=path.join(RUND,'run-good-1'); // ⑥ run 内一级散落（自身结构完整）
fs.mkdirSync(path.join(good,'llmwiki'),{recursive:true});
fs.writeFileSync(path.join(good,'manifest.json'),'{}');
fs.writeFileSync(path.join(good,'nodes.json'),'{}');
fs.writeFileSync(path.join(good,'junk-at-root.txt'),'x');
const TP=String(9150+Math.floor(Math.random()*40));
let child=spawn(process.execPath,['factory-server.js'],{env:{...process.env,PORT:TP,RUNDIR:RUND,PROJFILE:PROJ},stdio:'pipe'});
async function untilUp(){for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:'+TP+'/api/runs');return}catch(e){await new Promise(r=>setTimeout(r,250))}}throw new Error('server not up')}
await untilUp();

test('六类 issue 全部报出 + ok=false',async()=>{
  const r=await(await fetch('http://127.0.0.1:'+TP+'/api/workspace/check')).json();
  assert.equal(r.ok,false);
  const whats=r.issues.map(i=>i.where+' :: '+i.what).join('\n');
  assert.ok(r.issues.some(i=>i.where.includes('stray.txt')),whats);
  assert.ok(r.issues.some(i=>i.where==='runs/badname'),whats);
  assert.ok(r.issues.some(i=>i.where==='runs/run-incomplete'&&/manifest/.test(i.what)),whats);
  assert.ok(r.issues.some(i=>/run-ghost-1/.test(i.what)),whats);
  assert.ok(r.issues.some(i=>i.where==='analyses/bad-analysis'),whats);
  assert.ok(r.issues.some(i=>i.where==='runs/run-good-1/junk-at-root.txt'),whats);
});
test('干净工作区 → ok=true',async()=>{
  // 清掉全部 issue 源
  fs.rmSync(path.join(ROOT,'stray.txt'));
  fs.rmSync(path.join(RUND,'badname'),{recursive:true});
  fs.rmSync(path.join(RUND,'run-incomplete'),{recursive:true});
  fs.rmSync(path.join(AND,'bad-analysis'),{recursive:true});
  fs.rmSync(path.join(good,'junk-at-root.txt'));
  fs.writeFileSync(PROJ,JSON.stringify([{id:'P-001',name:'x',runs:['run-good-1']}]));
  const r=await(await fetch('http://127.0.0.1:'+TP+'/api/workspace/check')).json();
  assert.equal(r.ok,true,JSON.stringify(r.issues));
});
after(()=>{try{child.kill('SIGKILL')}catch(e){};try{fs.rmSync(ROOT,{recursive:true,force:true})}catch(e){}});
