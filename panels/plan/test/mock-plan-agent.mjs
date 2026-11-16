#!/usr/bin/env node
// 测试用 mock 分析 agent：按已有轮次决定本轮 out.md 形态（第 1 轮=决策点表→open；第 ≥2 轮=收敛→awaiting）
// 用法：PLAN_AGENT_CMD=<本文件> 由 plan-server spawn；cwd=会话目录
import fs from 'node:fs';import path from 'node:path';
const d=process.cwd();
const i=process.argv.indexOf('-p');
const prompt=i>=0?process.argv[i+1]:'';
await new Promise(r=>setTimeout(r,200));
const outs=fs.existsSync(path.join(d,'rounds'))?fs.readdirSync(path.join(d,'rounds')).filter(f=>/r\d+-out\.md$/.test(f)):[];
const n=outs.length+1;
const tag=String(n).padStart(3,'0');
let md;
if(n===1){
  md=['# 第 1 轮分析','## 事实基线','mock 事实基线：技术可行、无历史同名立项。','',
    '## 决策点表','','| # | 决策点 | 选项 | 推荐 | 依据 |','|---|--------|------|------|------|',
    '| D1 | 形态 | Web / CLI | Web | 用户已有面板习惯 |','| D2 | 范围 | P0最小 / 全量 | P0最小 | 快速验证 |',''].join('\n');
}else{
  md=['# 第 '+n+' 轮分析','本轮已无待决点，输出收敛声明。','','状态:收敛','','## BRIEF 结论','（mock 定稿）产品形态与范围已拍板。',''].join('\n');
}
fs.writeFileSync(path.join(d,'rounds','r'+tag+'-out.md'),md);
fs.writeFileSync(path.join(d,'BRIEF.md'),'# BRIEF（mock）');
process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'mock 分析轮完成'}]}})+'\n');
process.stdout.write(JSON.stringify({type:'result',subtype:'success',num_turns:1})+'\n');
