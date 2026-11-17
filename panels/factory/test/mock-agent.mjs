#!/usr/bin/env node
// 测试用 mock agent：按 prompt 关键词写出对应交付物，输出 stream-json 结果行
// 用法：FACTORY_AGENT_BIN=<本文件> 由 factory-server spawn；args 同 claude -p <prompt> ...
import fs from 'node:fs';import path from 'node:path';import {execSync} from 'node:child_process';
const i=process.argv.indexOf('-p');
const prompt=i>=0?process.argv[i+1]:'';
const d=process.cwd();
const W=(f,c)=>{fs.mkdirSync(path.dirname(path.join(d,f)),{recursive:true});fs.writeFileSync(path.join(d,f),c)};
const pad=(s,n)=>s.repeat(Math.ceil(n/s.length)).slice(0,n);
await new Promise(r=>setTimeout(r,250));
if(prompt.includes('Product Agent')){W('llmwiki/prompt-product.txt',prompt);if(prompt.includes('必阻塞'))W('llmwiki/block-marker','1');if(prompt.includes('混主责'))W('llmwiki/mixed-owner','1');W('llmwiki/PRD.md','# PRD\n## 产品定位\n'+pad('并发工厂测试产品需求文档：本产品面向工程团队的并发流水线管理场景，提供看板、泳道、节点验收与产物目录浏览能力。',260)+'\n## 功能清单\n- P0 并发看板\n## 验收标准\n- 全绿\n');}
else if(prompt.includes('Prototype Agent')){W('llmwiki/prompt-prototype.txt',prompt);W('runtime/prototype.html','<!DOCTYPE html><html><body><button onclick="alert(1)">x</button><script>'+pad('/*mock*/',2000)+'</script></body></html>');}
else if(prompt.includes('Architect Agent'))W('llmwiki/TechSpec.md','# TechSpec\n## 文件结构\n- js/\n## 数据结构\nlocalStorage 键表。\n'+pad('技术方案正文：文件结构、每个文件职责、数据结构与 localStorage 键表设计说明。',260));
else if(prompt.includes('Engineering Manager'))W('llmwiki/tasks.json',JSON.stringify([{task_id:'T1',objective:'骨架',owner_agent:'coding',acceptance_criteria:'index 存在',git_branch:'t1'},{task_id:'T2',objective:'逻辑',owner_agent:'coding',acceptance_criteria:'js 存在',git_branch:'t2'}],null,1));
else if(prompt.includes('Coding Agent')){ // cwd=product/（独立产品仓根），llmwiki 在 ../llmwiki
  if(fs.existsSync(path.join(d,'..','llmwiki','block-marker'))){ /* 写残件 → accept 不过 → blocked */ W('partial.txt','x'); }
  else{W('index.html','<!DOCTYPE html><html><body>ok</body></html>');
    const tasks=[{task_id:'T1',objective:'骨架',owner_agent:'coding',acceptance_criteria:'index',git_branch:'t1',status:'done'},{task_id:'T2',objective:'逻辑',owner_agent:'coding',acceptance_criteria:'js',git_branch:'t2',status:'done'}];
    if(fs.existsSync(path.join(d,'..','llmwiki','mixed-owner')))tasks.push({task_id:'T3',objective:'e2e 回归',owner_agent:'qa',acceptance_criteria:'PASS',git_branch:'t3'}); // 单主责（R-009）：qa 任务 coding 不代标（标记由 PRD 节点按 idea 落）
    W('../llmwiki/tasks.json',JSON.stringify(tasks,null,1));}
}else if(prompt.includes('QA'))W('llmwiki/QA-Report.md','# QA\n'+pad('逐项检查全部通过，证据充分：入口存在、交互可用、数据落盘正确。',200)+'\n结论：PASS\n');
else if(prompt.includes('DevOps Agent')){ // 交付 git 只在 product/ 内，不对 run 根 init
  W('llmwiki/DELIVERY.md','# DELIVERY\n清单+运行方式+已知限制。\n');
  try{const p=path.join(d,'product');execSync('git init -q',{cwd:p});execSync('git -c user.email=t@t -c user.name=t add -A',{cwd:p});execSync('git -c user.email=t@t -c user.name=t commit -qm "delivery v1.0.0" --allow-empty',{cwd:p})}catch(e){}
}
process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'mock 节点完成'}]}})+'\n');
process.stdout.write(JSON.stringify({type:'result',subtype:'success',num_turns:1})+'\n');
