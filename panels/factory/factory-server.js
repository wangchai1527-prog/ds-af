// Engineering Factory v2.1 · 节点管理制 × 多 run 并发执行制
// 每个节点有进入条件/负责人/交付物/验收判据；验收不过 → 节点 blocked → 流水线停止
// 并发模型：activeRuns: Map<runDir, runState>，executing 态并发上限 MAX_CONCURRENT（默认 3）
const http=require('http'),{spawn,execSync}=require('child_process'),fs=require('fs'),path=require('path');
const PORT=process.env.PORT||8794, RUNDIR=process.env.RUNDIR||'/root/.dsh/DS-AF/runs';
const ANALYSES=path.join(path.dirname(RUNDIR),'analyses'); // 分析台会话根（from-plan 校验边界，防路径注入）
const PROJFILE=process.env.PROJFILE||path.join(path.dirname(RUNDIR),'projects.json');
const MAX_CONCURRENT=Math.max(1,parseInt(process.env.MAX_CONCURRENT||'3',10)||3);
let _runSeq=0;const newRunDir=prefix=>path.join(RUNDIR,prefix+Date.now()+'-'+String(++_runSeq).padStart(2,'0')); // 序号防同毫秒碰撞

// ===== projects.json 读-改-写串行化（进程内 Promise 链互斥，防并发丢更新） =====
let _projQ=Promise.resolve();
function projMutate(fn){ // fn(projs) 原地修改并可返回值；全部排队串行执行
  const p=_projQ.then(()=>new Promise(resolve=>{
    let out;try{const projs=loadProjects();out=fn(projs);saveProjects(projs)}catch(e){}
    resolve(out);
  }));
  _projQ=p.catch(()=>{});
  return p;
}
function loadProjects(){ // 损坏→重建空索引，不崩溃
  try{const p=JSON.parse(fs.readFileSync(PROJFILE,'utf8'));if(Array.isArray(p))return p}catch(e){}
  try{fs.writeFileSync(PROJFILE,'[]')}catch(e){}
  return [];
}
function saveProjects(p){fs.writeFileSync(PROJFILE,JSON.stringify(p,null,1))}
function newProject(name,repo){return projMutate(p=>{const proj={id:'P-'+String(p.length+1).padStart(3,'0'),name,repo,created:new Date().toISOString(),runs:[]};p.push(proj);return proj})}
function attachRun(projId,runId,name,repo){return projMutate(p=>{let pr=p.find(x=>x.id===projId);
  if(!pr){pr={id:projId,name:name||runId,repo:repo||null,created:new Date().toISOString(),runs:[]};p.push(pr)}
  if(!pr.runs.includes(runId))pr.runs.push(runId)})}
const ENV={...process.env,PATH:'/home/administrator/.hermes/node/bin:'+process.env.PATH};
// ===== 并发池：run 全局单例已废除 =====
const activeRuns=new Map(); // runDir -> runState
const execCount=()=>[...activeRuns.values()].filter(r=>r.executing).length;
const latestRun=()=>{let l=null;for(const rs of activeRuns.values())l=rs;return l};
const findRun=id=>{if(!id)return null;for(const rs of activeRuns.values())if(path.basename(rs.dir)===id)return rs;return null};

const j=(r,c,o)=>{r.writeHead(c,{'Content-Type':'application/json; charset=utf-8'});r.end(JSON.stringify(o))};
// Workspace Standard 1.0
function scaffold(dir,flow,idea,repo){
  for(const d of ['loop','llmwiki','runtime','skills','plugins','product'])fs.mkdirSync(path.join(dir,d),{recursive:true});
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({run_id:path.basename(dir),standard:'workspace-1.0',flow,idea,repo:repo||null,productDir:'product',created:new Date().toISOString()},null,1));
  fs.writeFileSync(path.join(dir,'plugins','used.json'),'[]');
  fs.writeFileSync(path.join(dir,'skills','README.md'),'本次运行沉淀的技能候选\n');
}
function logLoop(dir,ev){try{fs.appendFileSync(path.join(dir,'loop','events.jsonl'),JSON.stringify({ts:new Date().toISOString(),...ev})+'\n')}catch(e){}}
const W=(r,s)=>r.write(JSON.stringify(s)+'\n');
const rf=(d,f)=>{try{return fs.readFileSync(path.join(d,f),'utf8')}catch(e){return null}};

// ===== 研发流程节点定义（可管理：进入条件→执行→验收判据→放行/阻断） =====
// accept(d, rs)：d=run 目录，rs=runState（并发下不得引用全局单例）
// ===== 流程路由：立项开发(Build) vs 运维修复(Fix) vs 研究拒收 =====
function classify(idea){
  const symptom=/修复|bug|报错|不对|不行|无法推进|失败|fix|error|崩|卡住|异常/.test(idea);
  if(symptom)return{flow:'fix'};
  if(/理解|分析|研究|梳理|看看|了解一下|review/.test(idea))return{flow:'research',reason:'研究/理解类任务不进工厂 —— 请走 Cockpit 的 Research 入口或直接与 Agent 对话，工厂只办「造产品」和「修产品」'};
  return{flow:'build'};
}
function extractPath(idea){const m=idea.match(/(\/[\w.-]+)+(\/)?/);if(m){const p=m[0];try{if(fs.statSync(p).isDirectory())return p}catch(e){}}return null}

// 运维修复流节点：绑定现有仓库，勘察→根因→修复→回归→交付
const FIXNODES=[
 {id:'kickoff',name:'工单立项',owner:'👤 人',entry:'故障/问题已提交',prompt:null,deliverable:'run 元数据',
  accept:(d,rs)=>({pass:true,detail:'fix 工单: '+rs.idea.slice(0,50)})},
 {id:'survey',name:'现场勘察',owner:'Diagnosis Agent',entry:'工单立项',deliverable:'SURVEY.md',
  prompt:(i,rs)=>`你是诊断 Agent（只读）。工作目录是一个现有项目（上级指示的问题：${i}）。勘察：目录结构、README、入口文件、git log 最近提交、运行方式。目标仓库：${rs.repo}。写 llmwiki/SURVEY.md（中文：项目概况/技术栈/相关文件定位/复现方式；用 Read/Bash 只读勘察目标仓库）。禁止修改目标仓库任何文件。`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'SURVEY.md')||'';return{pass:c.length>200,detail:`${c.length}字勘察报告`}}},
 {id:'diagnosis',name:'根因定位',owner:'Diagnosis Agent',entry:'勘察完成',deliverable:'DIAGNOSIS.md',
  prompt:(i,rs)=>`你是诊断 Agent。读 llmwiki/SURVEY.md，用只读方式查看目标仓库代码（${rs.repo}),定位问题根因（问题：${i}）。能运行复现的就真实运行复现。写 llmwiki/DIAGNOSIS.md（中文：症状/复现步骤/根因/影响范围/修复方案建议/回归判据）。`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'DIAGNOSIS.md')||'';return{pass:c.length>200&&/根因/.test(c),detail:`${c.length}字 · 含根因分析`}}},
 {id:'fix',name:'修复实施',owner:'Coding Agent',entry:'根因已定位',deliverable:'代码修复 diff',
  prompt:(i,rs)=>`你是 Coding Agent。读 llmwiki/DIAGNOSIS.md，到目标仓库 ${rs.repo} 按其修复方案实施修复：外科式最小改动，只改根因涉及文件，禁止顺手重构/删死代码（只报告）。改完按 DIAGNOSIS 的回归判据真实运行验证。回执 [STATUS]/[CHANGES]/[TESTS]。`,
  accept:d=>{try{const out=require('child_process').execSync('git -C '+d+' status --short 2>/dev/null||echo NOGIT',{encoding:'utf8',env:ENV}).trim();return{pass:!!out&&out!=='NOGIT',detail:`工作区变更: ${out.split('\n').length} 个文件`}}catch(e){return{pass:false,detail:'无法检测变更'}}}},
 {id:'regression',name:'回归验证',owner:'QA Agent',entry:'修复已实施',deliverable:'QA-Report.md',
  prompt:(i,rs)=>`你是 QA Agent（只读+可运行，禁改代码）。读 llmwiki/DIAGNOSIS.md 回归判据，到目标仓库 ${rs.repo} 逐项验证修复效果，并检查无新破坏。写 llmwiki/QA-Report.md（逐项 通过/未通过+证据，结论含 PASS/PARTIAL/FAIL）。`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'QA-Report.md')||'';return{pass:c.length>150&&/PASS|PARTIAL|FAIL/.test(c),detail:`结论:${(c.match(/PASS|PARTIAL|FAIL/g)||[]).join(',')}`}}},
 {id:'delivery',name:'交付',owner:'DevOps Agent',entry:'回归 PASS/PARTIAL',deliverable:'DELIVERY.md + git 提交',
  prompt:i=>`你是 DevOps Agent。git add -A && git commit -m "fix: per DIAGNOSIS（无 .git 则 init+本地身份）"。写 DELIVERY.md（中文：修复摘要/根因/改动文件/回归结果/版本）。不改代码。`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'DELIVERY.md');let commits='';try{commits=execSync('git -C '+d+' log --oneline',{encoding:'utf8',env:ENV}).trim()}catch(e){}
    return{pass:!!c&&commits.includes('fix'),detail:`DELIVERY.md:${!!c} · fix提交:${commits.split('\n').length} 条`}}},
];

const ITERNODES=[
 {id:'kickoff',name:'迭代立项',owner:'👤 人',entry:'增量需求已提交',prompt:null,deliverable:'run 元数据',
  accept:(d,rs)=>({pass:true,detail:'iterate: '+rs.idea.slice(0,50)})},
 {id:'product',name:'增量PRD',owner:'Product Agent',entry:'迭代立项',deliverable:'llmwiki/PRD.md',
  prompt:(i,rs)=>`你是 Product Agent。这是对已有产品的迭代（仓库 ${rs.repo}）。先 Read 仓库现有代码了解现状，再写 llmwiki/PRD.md（中文：迭代目标/新增或修改功能清单/验收标准/不改动范围——明确外科式边界）。增量需求：${i}`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'PRD.md')||'';return{pass:c.length>250&&/验收标准/.test(c),detail:c.length+'字 · 含验收标准:'+(/验收标准/.test(c))}}},
 {id:'manager',name:'任务拆解',owner:'Eng Manager',entry:'增量PRD通过',deliverable:'llmwiki/tasks.json',
  prompt:(i,rs)=>`你是 Engineering Manager。读 llmwiki/PRD.md 和目标仓库 ${rs.repo} 的现有代码结构，写 llmwiki/tasks.json：JSON数组(2-5个增量任务)，每项含 task_id,objective,owner_agent(coding|qa),acceptance_criteria,git_branch。改动必须最小化。`,
  accept:d=>{try{const t=JSON.parse(rf(path.join(d,'llmwiki'),'tasks.json'));return{pass:Array.isArray(t)&&t.length>=1&&t.every(x=>x.task_id&&x.objective&&x.acceptance_criteria),detail:t.length+' 份增量合同'}}catch(e){return{pass:false,detail:'解析失败'}}}},
 {id:'coding',name:'增量开发',owner:'Coding Agent',entry:'合同通过',deliverable:'父仓代码 diff',
  prompt:(i,rs)=>`你是 Coding Agent。读 llmwiki/PRD.md 和 llmwiki/tasks.json，到目标仓库 ${rs.repo} 实施增量改动：外科式最小修改，禁止重构无关代码，每完成一个任务在 llmwiki/tasks.json 标 status:done。改完运行可运行的验证。回执 [STATUS]/[CHANGES]/[TESTS]。`,
  accept:(d,rs)=>{try{const out=execSync('git -C '+rs.repo+' status --short 2>/dev/null||echo NO',{encoding:'utf8',env:ENV}).trim();let all=true;try{all=JSON.parse(rf(path.join(d,'llmwiki'),'tasks.json')).every(t=>t.status==='done')}catch(e){}return{pass:!!out&&out!=='NO'&&all,detail:'父仓变更 '+out.split('\n').length+' 文件 · 任务全done:'+all}}catch(e){return{pass:false,detail:'无法检测'}}}},
 {id:'qa',name:'回归验证',owner:'QA Agent',entry:'增量完成',deliverable:'llmwiki/QA-Report.md',
  prompt:(i,rs)=>`你是 QA Agent（只读+可运行，禁改代码）。对照 llmwiki/PRD.md 验收标准，在仓库 ${rs.repo} 逐项验证增量功能，并抽查原有功能无回归。写 llmwiki/QA-Report.md（结论含 PASS/PARTIAL/FAIL）。`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'QA-Report.md')||'';return{pass:c.length>150&&/PASS|PARTIAL|FAIL/.test(c),detail:'结论:'+(c.match(/PASS|PARTIAL|FAIL/g)||[]).join(',')}}},
 {id:'delivery',name:'交付',owner:'DevOps Agent',entry:'回归 PASS/PARTIAL',deliverable:'父仓版本提交',
  prompt:(i,rs)=>`你是 DevOps Agent。在目标仓库 ${rs.repo} 执行 git add -A && git commit -m "iterate: 增量交付 v+（保持外科式边界）"。写 llmwiki/DELIVERY.md（增量摘要/改动文件/回归结果）。不改代码。`,
  accept:(d,rs)=>{const c=rf(path.join(d,'llmwiki'),'DELIVERY.md');let ok=false;try{ok=execSync('git -C '+rs.repo+' log --oneline -1',{encoding:'utf8',env:ENV}).includes('iterate')}catch(e){}
    return{pass:!!c&&ok,detail:'DELIVERY.md:'+!!c+' · iterate提交:'+ok}}},
];
function findIndexHtmlRoot(dir){ // 返回含 index.html 的最近目录（product/ 优先，旧布局 runtime/ 兼容）
  if(!dir)return null;
  const cand=[path.join(dir,'product'),path.join(dir,'runtime'),dir];
  for(const c of cand){if(rf(c,'index.html')||rf(c,'prototype.html'))return c}
  return null;
}

const NODES=[
 {id:'kickoff',name:'立项',owner:'👤 人',entry:'产品想法已提交',
  prompt:null,deliverable:'run 元数据',
  accept:(d,rs)=>({pass:true,detail:'idea: '+rs.idea.slice(0,50)})},
 {id:'product',name:'PRD',owner:'Product Agent',entry:'立项通过',
  prompt:(i,rs)=>{const brief=rs&&rf(path.join(rs.dir,'materials','analysis'),'BRIEF.md');
    if(brief)return `你是 Product Agent。主要输入是分析台已收敛的立项简报 materials/analysis/BRIEF.md（同目录还有 IDEA.md/RESEARCH.md 与 materials/ 材料，按需 Read）：\n\n${brief.slice(0,2000)}\n\n据此写 llmwiki/PRD.md（中文，必须包含章节：产品定位/目标用户/功能清单(标P0/P1)/验收标准/非目标；BRIEF 已定的决策不得推翻）。原始想法（附注）：${i}。只写这一个文件。`;
    return `你是 Product Agent。把下面的产品想法转成 PRD，写入 llmwiki/PRD.md（中文，必须包含章节：产品定位/目标用户/功能清单(标P0/P1)/验收标准/非目标）。只写这一个文件。产品想法：${i}`},
  deliverable:'PRD.md',
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'PRD.md')||'';return{pass:c.length>300&&/验收标准/.test(c)&&/功能清单|功能/.test(c),detail:`${c.length}字 · 含验收标准:${/验收标准/.test(c)} · 含功能清单:${/功能清单|功能/.test(c)}`}}},
 {id:'prototype',name:'原型 Demo',owner:'Prototype Agent',entry:'PRD 验收通过（先看原型再实施）',
  prompt:(i,rs)=>`你是 Prototype Agent。读当前目录 PRD.md，产出 runtime/prototype.html：单文件可交互高保真原型（纯 HTML+CSS+JS 内联，浅色现代风格，实现 P0 功能的界面与交互骨架，数据可用内存 mock）。只写这一个文件，供人预览确认方向。${rs&&rs.prototypeFeedback?'\n\n⚠️ 人工看过上一版原型后打回，反馈（必须照改）：'+rs.prototypeFeedback:''}`,
  deliverable:'prototype.html',
  accept:d=>{const c=rf(path.join(d,'runtime'),'prototype.html')||'';return{pass:c.length>1500&&/<html/i.test(c)&&/script|button|input/i.test(c),detail:`${c.length}B · 可交互原型:${/script|button|input/i.test(c)}`}}},
 {id:'architect',name:'技术方案',owner:'Architect Agent',entry:'PRD 验收通过',
  prompt:i=>`你是 Architect Agent。先读当前目录 PRD.md，然后写 llmwiki/TechSpec.md（中文，必须包含：技术选型(纯静态HTML+CSS+JS零依赖)/文件结构/每个文件职责/数据结构(localStorage)/任务拆分建议）。只写这一个文件，不写代码。`,
  deliverable:'TechSpec.md',
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'TechSpec.md')||'';return{pass:c.length>300&&/文件结构|文件/.test(c)&&/数据结构|localStorage/.test(c),detail:`${c.length}字 · 含文件结构:${/文件结构|文件/.test(c)} · 含数据结构:${/数据结构|localStorage/.test(c)}`}}},
 {id:'manager',name:'任务拆解',owner:'Eng Manager',entry:'TechSpec 验收通过',
  prompt:i=>`你是 Engineering Manager。读 PRD.md 和 TechSpec.md，写 llmwiki/tasks.json：JSON数组，每项必须含 task_id,objective,owner_agent(coding|qa),acceptance_criteria,git_branch，不含 status 字段。只产出 3-6 个 P0 子任务。只写这一个文件。`,
  deliverable:'tasks.json',
  accept:d=>{try{const t=JSON.parse(rf(path.join(d,'llmwiki'),'tasks.json'));return{pass:Array.isArray(t)&&t.length>=2&&t.length<=8&&t.every(x=>x.task_id&&x.objective&&x.acceptance_criteria),detail:`${t.length} 份合同 · 字段齐全:${t.every(x=>x.task_id&&x.objective&&x.acceptance_criteria)}`}}catch(e){return{pass:false,detail:'tasks.json 解析失败: '+e.message}}}},
 {id:'coding',name:'真实开发',owner:'Coding Agent',entry:'任务合同验收通过',
  prompt:i=>`你是 Coding Agent。读 ../llmwiki/PRD.md、../llmwiki/TechSpec.md、../llmwiki/tasks.json，逐个完成全部 coding 任务：在当前目录（product/ —— 它本身就是独立产品仓库根）真实创建代码文件（index.html 必须存在于当前目录）并用 node 运行能跑的验证。每完成一个任务，把 ../llmwiki/tasks.json 里该 task 加 "status":"done"。遵守 TechSpec 文件结构，零外部依赖，浅色现代风格。完成后回执 [STATUS]/[CHANGES]/[TESTS]。`,
  deliverable:'代码 + tasks.json(status=done)',
  accept:d=>{const root=findIndexHtmlRoot(d);const idx=root?path.relative(d,root):null;let all=true,n=0;try{const t=JSON.parse(rf(path.join(d,'llmwiki'),'tasks.json'));n=t.length;all=t.every(x=>x.status==='done')}catch(e){all=false}
    return{pass:!!idx&&all,detail:`入口页:${idx||'未找到'} · 任务done:${all?`全部${n}`:'否(未逐个标记)'}`}}},
 {id:'qa',name:'QA 验证',owner:'QA Agent',entry:'开发验收通过（全部任务 done）',
  prompt:i=>`你是 QA/Review Agent（只读代码，可用 node 运行验证，禁止修改代码文件）。对照 PRD.md 验收标准和 tasks.json 逐项检查，能运行的一律真实运行。写 llmwiki/QA-Report.md（中文：逐项 通过/未通过+证据，结论行必须含 PASS、PARTIAL 或 FAIL）。`,
  deliverable:'QA-Report.md',
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'QA-Report.md')||'';return{pass:c.length>200&&/PASS|PARTIAL|FAIL/.test(c),detail:`${c.length}字 · 结论:${(c.match(/PASS|PARTIAL|FAIL/g)||[]).join(',')}`}}},
 {id:'delivery',name:'交付',owner:'DevOps Agent',entry:'QA 结论为 PASS/PARTIAL',
  prompt:i=>`你是 DevOps Agent。在 product/ 目录内（它本身就是独立产品仓）：若无 .git 先 git init 并 config 本地身份，然后 git add -A && git commit -m "delivery v1.0.0"（不对 run 根 init）。写 llmwiki/DELIVERY.md（中文：交付清单/如何运行/已知限制/版本）。不改代码。`,
  deliverable:'DELIVERY.md + product/ 内 git 提交',
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'DELIVERY.md');let commits='';try{commits=execSync('git -C '+path.join(d,'product')+' log --oneline',{encoding:'utf8',env:ENV}).trim()}catch(e){}
    return{pass:!!c&&commits.includes('delivery'),detail:`DELIVERY.md:${!!c} · product/git提交:${commits.split('\n').length} 条`}}},
];

function claudeStream(prompt,cwd,onEvent,onDone){
  const p=spawn(process.env.FACTORY_AGENT_BIN||'claude',['-p',prompt,'--output-format','stream-json','--verbose',
    '--permission-mode','acceptEdits',
    '--allowedTools','Read Write Edit Bash(node *) Bash(ls *) Bash(cat *) Bash(git *) Bash(mkdir *)',
    '--max-turns',process.env.FACTORY_MAX_TURNS||'60'],{cwd,env:ENV}); // 30 对 6 任务体量的 coding 节点不够（实测 3 连败 error_max_turns）
  let buf='',summary='';
  p.stdout.on('data',d=>{buf+=d;let i;
    while((i=buf.indexOf('\n'))>=0){
      const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
      if(!line||line.startsWith('['))continue;
      let e;try{e=JSON.parse(line)}catch{continue}
      if(e.type==='assistant'){
        for(const c of e.message.content){
          if(c.type==='tool_use')onEvent({type:'tool',tool:c.name,brief:brief(c.name,c.input||{})});
          else if(c.type==='text'&&c.text.trim()){summary=c.text.slice(0,400);onEvent({type:'text',text:c.text.slice(0,900)})}
        }
      }else if(e.type==='result')onEvent({type:'meta',status:e.subtype,turns:e.num_turns});
    }});
  p.on('error',e=>{try{onDone('spawn失败: '+e.message)}catch(e2){}}); // cwd 不存在/解释器缺失等：不崩服务，按节点失败处理
  p.on('close',()=>onDone(summary));
}
function brief(n,inp){
  if(n==='Read')return '读取 '+inp.file_path;
  if(n==='Write')return '创建 '+inp.file_path;
  if(n==='Edit')return '编辑 '+inp.file_path;
  if(n==='Bash')return '$ '+(inp.command||'').slice(0,90);
  return n;
}
function findIndexHtml(dir){ // 产品入口允许在任意子目录
  if(rf(dir,'index.html'))return 'index.html';
  for(const f of fs.readdirSync(dir)){if(f==='.git')continue;const p=path.join(dir,f);
    if(fs.statSync(p).isDirectory()){const r=findIndexHtml(p);if(r)return f+'/'+r}}
  return null;
}
function listArtifacts(dir){
  const out=[];
  for(const f of fs.readdirSync(dir)){
    if(['.git','nodes.json'].includes(f))continue;
    const p=path.join(dir,f);const st=fs.statSync(p);
    if(st.isDirectory()&&['llmwiki','runtime','loop','skills','plugins','materials'].includes(f)){
      out.push({name:f,size:'dir',type:'dir'});
      for(const g of fs.readdirSync(p)){if(g==='.git')continue;const q=path.join(p,g);const st2=fs.statSync(q);
        out.push({name:f+'/'+g,size:st2.isDirectory()?'dir':st2.size+'B',type:st2.isDirectory()?'dir':path.extname(g)})}
    }else out.push({name:f,size:st.isDirectory()?'dir':st.size+'B',type:st.isDirectory()?'dir':path.extname(f)});
  }
  return out;
}
// ===== runState 纯函数化（不再引用全局单例） =====
const flowNodes=flow=>flow==='fix'?FIXNODES:(flow==='iterate'?ITERNODES:NODES);
function nodeState(rs){const ns=flowNodes(rs.flow);return ns.map((n,i)=>({id:n.id,name:n.name,owner:n.owner,entry:n.entry,deliverable:n.deliverable,status:rs.nodeStatus[i],acceptDetail:rs.acceptDetails[i]||null}))}
function persist(rs){if(rs)fs.writeFileSync(path.join(rs.dir,'nodes.json'),JSON.stringify({idea:rs.idea,flow:rs.flow,nodeStatus:rs.nodeStatus,acceptDetails:rs.acceptDetails,gate:rs.gate||undefined,awaiting:rs.awaiting||undefined,ts:Date.now()},null,1))}
function summarize(rs){const cur=nodeState(rs).find(n=>n.status==='running');
  return {id:rs.id,idea:rs.idea.slice(0,120),flow:rs.flow,stage:rs.stage,executing:!!rs.executing,done:rs.done,
    blocked:rs.nodeStatus.includes('blocked'),awaiting:!!rs.awaiting,
    currentNode:cur?cur.name:(rs.nodeStatus.includes('blocked')?'⛔ '+nodeState(rs).find(n=>n.status==='blocked').name:'—'),
    nodeElapsedMs:cur&&rs.nodeStartTs?Date.now()-rs.nodeStartTs:null,
    lastAction:rs.lastAction||null,nodes:rs.nodeStatus}}
function fullRun(rs){return {id:rs.id,idea:rs.idea,flow:rs.flow,stage:rs.stage,done:rs.done,dir:rs.dir,executing:!!rs.executing,awaiting:rs.awaiting||null,gate:!!rs.gate,
  nodeElapsedMs:rs.nodeStartTs?Date.now()-rs.nodeStartTs:null,lastAction:rs.lastAction||null,
  events:rs.events.slice(-300),artifacts:rs.artifacts,nodes:nodeState(rs)}}
function restoreRun(dir){ // 从磁盘恢复一个 run 为 paused 态（bootState 与 open 共用）
  try{
    const f=rf(dir,'nodes.json');if(!f)return null;
    const st=JSON.parse(f);
    const ns=(st.nodeStatus||[]).map(s=>s==='running'?'blocked':s); // 重启中断的 running → blocked（可重试续跑）
    if(ns.length&&ns[ns.length-1]==='done'&&!ns.includes('blocked'))return null; // 已完整交付，不占并发池
    let repo=null;try{repo=(JSON.parse(rf(dir,'manifest.json')||'{}').repo)||null}catch(e){}
    const rs={dir,id:path.basename(dir),idea:st.idea||'(未知)',flow:st.flow||'build',repo,parentProject:null,stage:null,
      nodeStatus:ns,acceptDetails:(st.acceptDetails||[]).map((a,i)=>ns[i]==='blocked'&&!a?'⛔ 服务重启中断，可重试续跑':a),
      gate:!!st.gate,awaiting:st.awaiting||null,
      events:[],artifacts:listArtifacts(dir),done:false,executing:false,nodeStartTs:0,lastAction:null,projectId:null,resumed:true};
    persist(rs);
    return rs;
  }catch(e){return null}
}
function cpDir(src,dst){fs.mkdirSync(dst,{recursive:true});for(const f of fs.readdirSync(src)){const s=path.join(src,f),t=path.join(dst,f);
  if(fs.statSync(s).isDirectory())cpDir(s,t);else fs.copyFileSync(s,t)}}
// ===== 目录规范机器巡检（只读，不自动删）—— 产物落位靠机器约束，不靠节点 prompt 自觉 =====
const TOP_ALLOWED=['.git','.gitignore','README.md','analyses','archive','logs','panels','projects.json','runs','samples','wiki','docs','.oss.env','.env','.claude','node_modules'];
const RUN_ALLOWED=['loop','llmwiki','runtime','skills','plugins','product','materials','.git','manifest.json','nodes.json','README.md'];
function checkWorkspace(){
  const issues=[];const root=path.dirname(RUNDIR);
  try{for(const e of fs.readdirSync(root)){if(!TOP_ALLOWED.includes(e))issues.push({where:path.basename(root)+'/'+e,what:'顶层散落（非白名单条目）'})}}catch(e){}
  try{
    for(const d of fs.readdirSync(RUNDIR)){
      const p=path.join(RUNDIR,d);
      if(!fs.statSync(p).isDirectory())continue;
      if(!/^(run|fix)-/.test(d))issues.push({where:'runs/'+d,what:'runs/ 下目录须以 run-/fix- 开头'});
      else{
        if(!rf(p,'manifest.json'))issues.push({where:'runs/'+d,what:'残缺：缺 manifest.json'});
        if(!rf(p,'nodes.json'))issues.push({where:'runs/'+d,what:'残缺：缺 nodes.json'});
        for(const e of fs.readdirSync(p)){if(!RUN_ALLOWED.includes(e))issues.push({where:'runs/'+d+'/'+e,what:'run 内一级散落（产物须落 llmwiki/runtime/product/materials 等）'})}
      }
    }
  }catch(e){}
  for(const pr of loadProjects())for(const rid of pr.runs||[])
    if(!fs.existsSync(path.join(RUNDIR,rid)))issues.push({where:'projects.json→'+pr.id,what:'悬空 runId: '+rid});
  const AN=path.join(root,'analyses');
  try{for(const d of fs.readdirSync(AN)){const p=path.join(AN,d);
    if(fs.statSync(p).isDirectory()&&!d.startsWith('an-'))issues.push({where:'analyses/'+d,what:'analyses/ 下目录须以 an- 开头'})}}catch(e){}
  return{ok:issues.length===0,issues};
}
function pushIfPossible(repoDir,remoteUrl){ // best-effort 推送：任何失败只记 note 不 throw；token 只走临时 URL，绝不进 config/磁盘
  try{
    if(!remoteUrl)return{pushed:false,note:'未绑定远程'};
    const tok=process.env.DSH_GIT_TOKEN;
    if(!tok)return{pushed:false,note:'未配置 DSH_GIT_TOKEN — 推送跳过'};
    let url=remoteUrl;
    if(url.startsWith('https://github.com/'))url='https://x-access-token:'+tok+'@github.com/'+url.slice(19);
    else url='https://x-access-token:'+tok+'@github.com/'+url.slice('git@github.com:'.length);
    try{execSync('git -C '+repoDir+' remote remove origin',{env:ENV,stdio:'pipe'})}catch(e){}
    execSync('git -C '+repoDir+' remote add origin '+remoteUrl,{env:ENV,stdio:'pipe'}); // config 存干净 URL
    execSync('git -C '+repoDir+' push -u '+url+' HEAD',{env:ENV,stdio:'pipe'}); // 推送用临时 token URL
    return{pushed:true,note:'已推送 '+remoteUrl};
  }catch(e){return{pushed:false,note:'推送失败: '+String(e.message||e).replace(process.env.DSH_GIT_TOKEN||'','***').slice(0,140)}}
}
function bootState(){ // 全量恢复所有未完 run 为 paused（不自动续跑，防重启风暴）
  try{
    let n=0;
    for(const d of fs.readdirSync(RUNDIR).sort()){
      if(!d.startsWith('run-')&&!d.startsWith('fix-'))continue;
      const p=path.join(RUNDIR,d);
      try{if(!fs.statSync(p).isDirectory())continue}catch(e){continue}
      const rs=restoreRun(p);
      if(rs){activeRuns.set(p,rs);n++}
    }
    if(n)console.log('bootState: 恢复',n,'个未完 run（paused）');
  }catch(e){}
}

function runFrom(rs,idx,res){
  // 从第 idx 个节点起执行（重试入口也走这里）；全程只引用参数 rs
  const emit=e=>{
    rs.events.push(e);if(rs.events.length>2000)rs.events.splice(0,rs.events.length-1500);
    if(e.type==='tool')rs.lastAction={ts:Date.now(),text:e.brief};
    else if(e.type==='text')rs.lastAction={ts:Date.now(),text:(e.text||'').slice(0,120)};
    logLoop(rs.dir,e);if(res)W(res,e);
  };
  rs.executing=true;
  const step=()=>{
    const ns=flowNodes(rs.flow);
    if(idx>=ns.length){rs.executing=false;rs.done=true;persist(rs);emit({type:'all_done',text:'🏁 全部节点验收通过 — 产物已就绪'});if(res)res.end();return}
    const n=ns[idx];
    rs.stage=n.id;rs.nodeStartTs=Date.now();rs.nodeStatus[idx]='running';persist(rs);
    emit({type:'node_start',node:n.id,name:n.name,owner:n.owner,entry:n.entry,deliverable:n.deliverable});
    if(!n.prompt){ // kickoff：无执行直接验收
      finishNode(n.accept(rs.dir,rs));return;
    }
    const cwd=(rs.flow==='fix'&&['fix','regression'].includes(n.id)&&rs.repo)?rs.repo
      :(rs.flow==='build'&&n.id==='coding')?path.join(rs.dir,'product'):rs.dir; // build 开发在独立产品仓根执行
    if(cwd!==rs.dir)try{fs.mkdirSync(cwd,{recursive:true})}catch(e){} // 历史 run 可能无 product/（Task 3 前布局）
    claudeStream(n.prompt(rs.idea,rs),cwd,ev=>emit(ev),summary=>{
      emit({type:'node_exec_done',node:n.id,text:(summary||'(无回执)').slice(0,500)});
      finishNode(n.accept(rs.dir,rs));
    });
    function finishNode(a){
      rs.acceptDetails[idx]=`${a.pass?'✅':'⛔'} ${a.detail}`;
      rs.nodeStatus[idx]=a.pass?'done':'blocked';
      rs.artifacts=listArtifacts(rs.dir);persist(rs);
      emit({type:'node_check',node:n.id,pass:a.pass,detail:a.detail,deliverable:n.deliverable});
      if(!a.pass){rs.executing=false;emit({type:'pipeline_blocked',node:n.id,text:`⛔ 节点「${n.name}」验收未过，流水线已停止 — 修正后可重试本节点`});if(res)res.end();return}
      if(a.pass&&!rs.projectId){ // 首个验收通过 → 登记项目索引（每 run 只登记一次）
        try{
          if(rs.flow==='build'){newProject(rs.idea.slice(0,24),rs.dir).then(pr=>{rs.projectId=pr.id;attachRun(pr.id,rs.id,rs.idea.slice(0,24),rs.dir)})}
          else if(rs.flow==='iterate'&&rs.parentProject){attachRun(rs.parentProject,rs.id);rs.projectId=rs.parentProject}
          else if(rs.flow==='fix'){newProject('fix:'+rs.idea.slice(0,16),rs.repo||rs.dir).then(pr=>{rs.projectId=pr.id;attachRun(pr.id,rs.id)})}
          emit({type:'project',text:'🗂 已登记项目索引'});
        }catch(e){}
      }
      if(a.pass&&n.id==='delivery'&&rs.flow!=='fix'){ // 交付通过 → best-effort 推 GitHub（失败不阻断交付）
        const repoDir=rs.flow==='build'?path.join(rs.dir,'product'):rs.repo;
        if(repoDir)projMutate(p=>{const pr=p.find(x=>x.id===rs.projectId);return pr?(pr.remote||null):null}).then(remote=>{
          const r=pushIfPossible(repoDir,remote);
          emit({type:'push',pushed:r.pushed,text:(r.pushed?'☁️ 已推送: ':'☁️ 推送跳过: ')+r.note});
          rs.acceptDetails[idx]+=' · 推送:'+r.note;persist(rs);
        });
      }
      if(a.pass&&n.id==='prototype'&&rs.gate){ // from-plan 流：原型确认闸（人看过原型才放行技术方案）
        rs.awaiting={gate:'prototype',nodeIdx:idx};rs.executing=false;persist(rs);
        emit({type:'pipeline_awaiting',node:n.id,text:'⏸ 原型已就绪 — 等待人工确认（确认通过 /api/approve go，打回重做 /api/approve redo）'});
        if(res)res.end();return;
      }
      idx++;setTimeout(step,600);
    }
  };
  step();
}

http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}
  const u=new URL(req.url,'http://x');
  if(req.method==='GET'&&u.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,'factory.html')))}
  if(req.method==='GET'&&u.pathname.startsWith('/preview/')){
    // 新寻址 /preview/<runId>/<rel>；旧式 /preview/<rel> 回退最近活动 run
    const rest=decodeURIComponent(u.pathname.slice(9))||'';
    const seg=rest.split('/').filter(Boolean);
    let rs=seg.length>1?findRun(seg[0]):null;
    const rel=rs?seg.slice(1).join('/'):rest;
    if(!rs)rs=latestRun();
    if(!rs)return res.writeHead(404).end();
    let file=path.join(rs.dir,rel);
    if(!rel||!fs.existsSync(file)||fs.statSync(file).isDirectory()){const idx=findIndexHtml(path.join(rs.dir,'runtime'))||findIndexHtml(rs.dir);if(!idx){res.writeHead(404);return res.end('404')}file=path.join(rs.dir,idx)}
    try{return res.end(fs.readFileSync(file))}catch(e){res.writeHead(404);return res.end('404')}
  }
  if(req.method==='GET'&&u.pathname==='/api/state'){
    const id=u.searchParams.get('id');
    if(id){const rs=findRun(id);if(!rs)return j(res,404,{error:'no run',runs:[...activeRuns.values()].map(summarize)});return j(res,200,{run:fullRun(rs)})}
    const l=latestRun();
    return j(res,200,{runs:[...activeRuns.values()].map(summarize),run:l?fullRun(l):null,
      concurrency:{executing:execCount(),max:MAX_CONCURRENT}});
  }
  if(req.method==='GET'&&u.pathname.startsWith('/api/file?')){
    const name=u.searchParams.get('name');
    const rs=findRun(u.searchParams.get('id'))||latestRun();
    if(!rs)return j(res,400,{});
    try{return j(res,200,{content:fs.readFileSync(path.join(rs.dir,name),'utf8').slice(0,8000)})}catch(e){return j(res,404,{})}
  }
  // ===== 项目树 =====
  if(req.method==='GET'&&u.pathname==='/api/workspace/check')return j(res,200,checkWorkspace());
  if(req.method==='GET'&&u.pathname==='/api/projects'){
    const projs=loadProjects();
    const out=projs.map(pr=>({...pr,
      runs:(pr.runs||[]).map(id=>{
        const p=path.join(RUNDIR,id);
        let meta={idea:'',flow:'build',nodeStatus:[]};
        try{meta=JSON.parse(rf(p,'nodes.json')||'{}')}catch(e){}
        const blocked=(meta.nodeStatus||[]).includes('blocked');
        const done=(meta.nodeStatus||[]).length&&meta.nodeStatus[meta.nodeStatus.length-1]==='done'&&!blocked;
        return{id,idea:meta.idea||'',flow:meta.flow||'build',status:blocked?'blocked':(done?'delivered':'paused'),exists:fs.existsSync(p)};
      })}));
    return j(res,200,{projects:out});
  }
  // ===== 项目 CRUD =====
  if(req.method==='GET'&&u.pathname==='/api/runs'){
    const list=[];
    try{
      for(const d of fs.readdirSync(RUNDIR).sort().reverse()){
        const p=path.join(RUNDIR,d);
        if(!fs.statSync(p).isDirectory()||!d.startsWith('run-')&&!d.startsWith('fix-'))continue;
        let meta={idea:'(未知)',flow:'build',nodeStatus:[]};
        try{meta=JSON.parse(rf(p,'nodes.json')||'{}')}catch(e){}
        const blocked=(meta.nodeStatus||[]).includes('blocked');
        const done=(meta.nodeStatus||[]).length&&meta.nodeStatus[meta.nodeStatus.length-1]==='done'&&!blocked;
        list.push({id:d,idea:meta.idea||'',flow:meta.flow||'build',ts:meta.ts||0,
          status:blocked?'blocked':(done?'delivered':((meta.nodeStatus||[]).includes('running')?'running':'paused')),
          nodes:meta.nodeStatus||[]});
      }
    }catch(e){}
    const act=[...activeRuns.values()].map(summarize);
    return j(res,200,{runs:list,active:act.length?act.map(r=>r.id):null});
  }
  if(req.method==='POST'&&u.pathname==='/api/runs/delete'){
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const id=(JSON.parse(b||'{}').id||'').replace(/[\/..]/g,'');
      const p=path.join(RUNDIR,id);
      if(!id||!fs.existsSync(p)||!p.startsWith(RUNDIR))return j(res,400,{error:'bad id'});
      const rs=activeRuns.get(p);
      if(rs&&rs.executing)return j(res,409,{error:'正在执行的任务不可删除'});
      fs.rmSync(p,{recursive:true});
      if(rs)activeRuns.delete(p);
      projMutate(prs=>{for(const pr of prs)if(pr.runs)pr.runs=pr.runs.filter(x=>x!==id)}); // 去悬空引用
      return j(res,200,{ok:true,clearedActive:!!rs});
    });
    return;
  }
  if(req.method==='POST'&&u.pathname==='/api/runs/rollback'){
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const id=(JSON.parse(b||'{}').id||'').replace(/[\/..]/g,'');
      const p=path.join(RUNDIR,id);
      if(!fs.existsSync(p))return j(res,404,{error:'no run'});
      try{
        const before=execSync('git -C '+p+' log --oneline',{encoding:'utf8',env:ENV}).trim().split('\n');
        execSync('git -C '+p+' revert --no-edit HEAD',{encoding:'utf8',env:ENV,stdio:'pipe'});
        const after=execSync('git -C '+p+' log --oneline',{encoding:'utf8',env:ENV}).trim().split('\n');
        return j(res,200,{ok:true,reverted:before[0],now:after[0],commits:after.length});
      }catch(e){return j(res,400,{error:'回滚失败: '+(e.message||'').slice(0,150)})}
    });
    return;
  }
  if(req.method==='POST'&&u.pathname==='/api/projects/delete'){
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const id=JSON.parse(b||'{}').id||'';
      const projs=loadProjects();const pr=projs.find(x=>x.id===id);
      if(!pr)return j(res,404,{error:'no project'});
      for(const rid of pr.runs||[]){
        const p=path.join(RUNDIR,rid);
        const rs=activeRuns.get(p);
        if(rs&&rs.executing)return j(res,409,{error:'项目含正在执行的任务'});
        if(p.startsWith(RUNDIR))fs.rmSync(p,{recursive:true,force:true});
        if(rs)activeRuns.delete(p);
      }
      if(pr.repo&&pr.repo.startsWith(RUNDIR))fs.rmSync(pr.repo,{recursive:true,force:true});
      saveProjects(projs.filter(x=>x.id!==id));
      return j(res,200,{ok:true,deletedRuns:(pr.runs||[]).length});
    });
    return;
  }
  if(req.method==='POST'&&u.pathname==='/api/runs/iterate'){
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const {id='',idea=''}=JSON.parse(b||'{}');
      const parent=path.join(RUNDIR,id.replace(/[\/..]/g,''));
      const repo=findIndexHtmlRoot(parent);
      if(!repo)return j(res,400,{error:'父项目无产品代码，不能迭代'});
      if(execCount()>=MAX_CONCURRENT)return j(res,409,{error:'并发已满'});
      if(!idea.trim())return j(res,400,{error:'empty idea'});
      const dir=newRunDir('run-');
      scaffold(dir,'iterate',idea,repo);
      let parentProject=null;
      try{const projs=loadProjects();parentProject=(projs.find(x=>x.runs&&x.runs.includes(id))||{}).id||null}catch(e){}
      const rs={dir,id:path.basename(dir),idea,flow:'iterate',repo,parentProject,stage:null,nodeStatus:ITERNODES.map(_=>'pending'),acceptDetails:[],events:[],artifacts:[],done:false,executing:false,nodeStartTs:0,lastAction:null,projectId:null};
      activeRuns.set(dir,rs);
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
      rs.events.push({type:'flow',flow:'iterate',text:'🔁 迭代开发流（基于 '+id+' 的产品，仓库: '+repo+'）'});
      W(res,rs.events[rs.events.length-1]);
      runFrom(rs,0,res);
    });
    return;
  }
  if(req.method==='POST'&&u.pathname==='/api/mission'){
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      if(execCount()>=MAX_CONCURRENT)return j(res,409,{error:'并发已满'});
      const idea=(JSON.parse(body||'{}').idea||'').trim();
      if(!idea)return j(res,400,{error:'empty idea'});
      const cls=classify(idea);
      if(cls.flow==='research')return j(res,422,{error:cls.reason});
      if(cls.flow==='build')return j(res,422,{error:'开发立项已收口到 Idea PLAN 分析台 —— 话题走完收敛并拍板 GO 后，在本面板「选话题立项」；此入口仅收运维修复工单（问题描述+目标仓库绝对路径）'});
      let dir=newRunDir(cls.flow==='fix'?'fix-':'run-');
      let repo=null;
      if(cls.flow==='fix'){repo=extractPath(idea);if(!repo)return j(res,422,{error:'修复流需要带目标仓库绝对路径（如 /root/xxx 的问题描述），未识别到有效目录'});}
      scaffold(dir,cls.flow,idea,repo);
      const rs={dir,id:path.basename(dir),idea,flow:cls.flow,repo,stage:null,nodeStatus:(cls.flow==='fix'?FIXNODES:NODES).map(_=>'pending'),acceptDetails:[],events:[],artifacts:[],done:false,executing:false,nodeStartTs:0,lastAction:null,projectId:null};
      activeRuns.set(dir,rs);
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
      rs.events.push({type:'flow',flow:cls.flow,text:cls.flow==='fix'?'🔧 运维修复流（工作区绑定: '+dir+'）':'🟢 立项开发流'});
      W(res,rs.events[rs.events.length-1]);
      runFrom(rs,0,res);
    });
    return;
  }
  if(req.method==='POST'&&u.pathname==='/api/projects/remote'){ // 项目绑 GitHub 远程（空=解绑）
    let b='';req.on('data',c=>b+=c);req.on('end',async()=>{
      const{id='',remote=''}=JSON.parse(b||'{}');
      if(remote&&!(remote.startsWith('https://github.com/')||remote.startsWith('git@github.com:')))
        return j(res,400,{error:'remote 仅支持 GitHub（https://github.com/… 或 git@github.com:…）'});
      let found=null;
      await projMutate(p=>{found=p.find(x=>x.id===id);if(found)found.remote=remote||null});
      if(!found)return j(res,404,{error:'no project'});
      return j(res,200,{ok:true,remote:remote||null});
    });
    return;
  }
  if(req.method==='GET'&&u.pathname==='/api/analyses'){ // 分析台话题列表（立项池数据源：state=go 且未 spawn 的可选）
    const list=[];
    try{for(const id of fs.readdirSync(ANALYSES).filter(d=>d.startsWith('an-')).sort().reverse()){
      const d=path.join(ANALYSES,id);const m=rf(d,'meta.json');if(!m)continue;
      try{const meta=JSON.parse(m);
        list.push({id,dir:d,idea:(meta.idea||'').slice(0,120),state:meta.state,round:meta.round,updated:meta.updated,spawnedRun:meta.spawnedRun||null})}
      catch(e){}
    }}catch(e){}
    return j(res,200,{analyses:list});
  }
  if(req.method==='POST'&&u.pathname==='/api/mission/from-plan'){ // 分析台话题立项三通：build(默认)/fix(带 repo)/iterate(带 projectId)；分析产物 = 工厂输入料（非工厂产物）
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const{analysisDir='',idea='',mode='build',repo='',projectId=''}=JSON.parse(b||'{}');
      const ad=path.resolve(analysisDir);
      if(!ad.startsWith(ANALYSES+path.sep)||!fs.existsSync(ad)||!fs.statSync(ad).isDirectory())
        return j(res,400,{error:'analysisDir 必须位于 '+ANALYSES+' 之下的会话目录'});
      const amRaw=rf(ad,'meta.json');
      if(!amRaw)return j(res,400,{error:'分析会话缺 meta.json，不是合法的分析台话题'});
      let am;try{am=JSON.parse(amRaw)}catch(e){return j(res,400,{error:'meta.json 不可解析'})}
      if(am.state!=='go')return j(res,400,{error:'话题未拍板 GO（当前状态 '+am.state+'）—— 先在 Idea PLAN 分析台拍板 GO 再立项'});
      if(am.spawnedRun)return j(res,409,{error:'该话题已立项过 run '+am.spawnedRun,runId:am.spawnedRun});
      if(!['build','fix','iterate'].includes(mode))return j(res,422,{error:'mode 须为 build|fix|iterate'});
      if(execCount()>=MAX_CONCURRENT)return j(res,409,{error:'并发已满'});
      const ideaText=((idea||'').trim())||String(am.idea||'').trim(); // idea 可省，回退 meta 真源
      if(!ideaText)return j(res,400,{error:'empty idea'});
      const copyAnalysis=dir=>{ // 分析产物随行（BRIEF 为首要输入料）
        const dst=path.join(dir,'materials','analysis');fs.mkdirSync(dst,{recursive:true});
        try{
          for(const f of ['IDEA.md','RESEARCH.md','BRIEF.md']){const s=path.join(ad,f);if(fs.existsSync(s))fs.copyFileSync(s,path.join(dst,f))}
          const msrc=path.join(ad,'materials');
          if(fs.existsSync(msrc))cpDir(msrc,path.join(dst,'materials'));
        }catch(e){}
      };
      let dir,rs,flowText;
      if(mode==='fix'){ // 转修复：话题结论落到既有仓（不建新产品仓）
        const rp=path.resolve(repo||'');
        if(!path.isAbsolute(repo||'')||!fs.existsSync(rp)||!fs.statSync(rp).isDirectory())
          return j(res,400,{error:'转修复需要有效目标仓库绝对路径 repo（现存目录）'});
        dir=newRunDir('fix-');scaffold(dir,'fix',ideaText,rp);copyAnalysis(dir);
        rs={dir,id:path.basename(dir),idea:ideaText,flow:'fix',repo:rp,parentProject:null,stage:null,
          nodeStatus:FIXNODES.map(_=>'pending'),acceptDetails:[],gate:false,awaiting:null,
          events:[],artifacts:[],done:false,executing:false,nodeStartTs:0,lastAction:null,projectId:null};
        flowText='🔧 运维修复流（来自 Idea PLAN 话题 '+path.basename(ad)+' · 目标仓: '+rp+'）';
      }else if(mode==='iterate'){ // 转升级：话题结论迭代到已交付项目
        const projs=loadProjects();const pr=projs.find(x=>x.id===projectId);
        if(!pr)return j(res,404,{error:'项目 '+projectId+' 不存在'});
        let parent=null,repoDir=null;
        for(const rid of [...(pr.runs||[])].reverse()){const p=path.join(RUNDIR,rid);const r=findIndexHtmlRoot(p);if(r){parent=rid;repoDir=r;break}}
        if(!parent)return j(res,400,{error:'项目 '+pr.id+' 无已交付产品代码，不能转升级'});
        dir=newRunDir('run-');scaffold(dir,'iterate',ideaText,repoDir);copyAnalysis(dir);
        rs={dir,id:path.basename(dir),idea:ideaText,flow:'iterate',repo:repoDir,parentProject:pr.id,stage:null,
          nodeStatus:ITERNODES.map(_=>'pending'),acceptDetails:[],gate:false,awaiting:null,
          events:[],artifacts:[],done:false,executing:false,nodeStartTs:0,lastAction:null,projectId:null};
        flowText='⬆️ 升级迭代流（来自 Idea PLAN 话题 '+path.basename(ad)+' · 项目 '+pr.id+' · 基于 '+parent+' 产品）';
      }else{ // build：既有「选话题立项」
        dir=newRunDir('run-');scaffold(dir,'build',ideaText,null);copyAnalysis(dir);
        rs={dir,id:path.basename(dir),idea:ideaText,flow:'build',repo:null,parentProject:null,stage:null,
          nodeStatus:NODES.map(_=>'pending'),acceptDetails:[],gate:true,awaiting:null,
          events:[],artifacts:[],done:false,executing:false,nodeStartTs:0,lastAction:null,projectId:null};
        flowText='🟢 立项开发流（来自 Idea PLAN 话题 '+path.basename(ad)+' · 原型后设确认闸）';
      }
      activeRuns.set(dir,rs);
      am.spawnedRun=rs.id;am.updated=new Date().toISOString(); // 回写分析台：防重复立项 + 状态可追溯
      try{fs.writeFileSync(path.join(ad,'meta.json'),JSON.stringify(am,null,1));
        fs.appendFileSync(path.join(ad,'events.jsonl'),JSON.stringify({ts:Date.now(),ev:'spawned',run:rs.id,mode})+'\n')}catch(e){}
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({id:rs.id,runId:rs.id,mode}));
      rs.events.push({type:'flow',flow:rs.flow,text:flowText});
      logLoop(dir,rs.events[rs.events.length-1]);
      runFrom(rs,0,null);
    });
    return;
  }
  if(req.method==='POST'&&u.pathname==='/api/approve'){ // 原型确认闸：go=放行下一节点 / redo=打回只重跑原型（feedback 入 prompt）
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const{id='',decision='',feedback=''}=JSON.parse(b||'{}');
      const rs=findRun(id);
      if(!rs)return j(res,400,{error:'no run'});
      if(!rs.awaiting)return j(res,400,{error:'该 run 不在确认闸（awaiting）状态'});
      if(!['go','redo'].includes(decision))return j(res,400,{error:'decision 须为 go|redo'});
      const idx=rs.awaiting.nodeIdx;rs.awaiting=null;persist(rs);
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
      if(decision==='redo'){
        rs.prototypeFeedback=feedback||'';rs.nodeStatus[idx]='pending';persist(rs);
        rs.events.push({type:'flow',text:'🔁 原型被打回重做'+(feedback?'（反馈: '+feedback.slice(0,80)+'）':'')});
        W(res,rs.events[rs.events.length-1]);
        runFrom(rs,idx,res);
      }else{
        rs.events.push({type:'flow',text:'✅ 原型确认通过 — 放行技术方案'});
        W(res,rs.events[rs.events.length-1]);
        runFrom(rs,idx+1,res);
      }
    });
    return;
  }
  if(req.method==='POST'&&u.pathname==='/api/runs/open'){ // 历史未完 run 重开（载入 activeRuns，paused 态）
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const id=(JSON.parse(b||'{}').id||'').replace(/[\/..]/g,'');
      const p=path.join(RUNDIR,id);
      if(!id)return j(res,400,{error:'bad id'});
      if(activeRuns.has(p))return j(res,200,{ok:true,id,already:true});
      if(!fs.existsSync(p)||!fs.statSync(p).isDirectory())return j(res,404,{error:'no run dir'});
      const rs=restoreRun(p);
      if(!rs)return j(res,400,{error:'run 已完整交付或 nodes.json 不可解析，无需重开'});
      activeRuns.set(p,rs);
      return j(res,200,{ok:true,id});
    });
    return;
  }
  if(req.method==='POST'&&u.pathname==='/api/retry'){ // 重试被阻断的节点（可带 {id} 缺省=最近活动 run；verifyOnly=仅重验判据）
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      let id=null,verifyOnly=false;try{const q=JSON.parse(b||'{}');id=q.id||null;verifyOnly=!!q.verifyOnly}catch(e){}
      let rs=id?findRun(id):latestRun();
      if(!rs&&id){ // 带 id 但未载入 → 自动 open 历史 run
        const p=path.join(RUNDIR,id.replace(/[\/..]/g,''));
        try{if(fs.statSync(p).isDirectory()){const r2=restoreRun(p);if(r2){activeRuns.set(p,r2);rs=r2}}}catch(e){}
      }
      if(!rs)return j(res,400,{error:'no run'});
      if(rs.awaiting)return j(res,400,{error:'原型确认闸等待人工拍板 — 请用 /api/approve {go|redo}'});
      if(rs.executing)return j(res,400,{error:'run 正在执行'});
      const idx=rs.nodeStatus.indexOf('blocked');
      if(idx<0)return j(res,400,{error:'no blocked node'});
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
      const n=flowNodes(rs.flow)[idx];
      if(verifyOnly){ // 人工外科修复产物后的轻通道：不跑 agent，仅重跑 accept 判据
        rs.events.push({type:'node_start',node:n.id,name:'仅重验(verify-only)',text:'🔎 人工触发：不跑 agent，仅重跑验收判据'});
        W(res,rs.events[rs.events.length-1]);
        rs.stage=n.id;rs.nodeStatus[idx]='running';persist(rs);
        const a=n.accept(rs.dir,rs);
        rs.acceptDetails[idx]=`${a.pass?'✅':'⛔'} ${a.detail}`;
        rs.nodeStatus[idx]=a.pass?'done':'blocked';rs.artifacts=listArtifacts(rs.dir);persist(rs);
        const ev={type:'node_check',node:n.id,pass:a.pass,detail:a.detail,deliverable:n.deliverable};
        rs.events.push(ev);W(res,ev);
        if(!a.pass){rs.executing=false;const ev2={type:'pipeline_blocked',node:n.id,text:'⛔ 判据仍未过 — 可继续人工修复后再 verify-only'};rs.events.push(ev2);W(res,ev2);return res.end()}
        return runFrom(rs,idx+1,res); // 判据过 → 从下一节点续跑
      }
      rs.events.push({type:'node_start',node:n.id,name:'人工重试',text:'👤 人工触发重试被阻断节点'});
      W(res,rs.events[rs.events.length-1]);
      runFrom(rs,idx,res);
    });
    return;
  }
  res.writeHead(404);res.end();
}).listen(PORT,'0.0.0.0',()=>{bootState();console.log('factory v2.1 (concurrent) on',PORT,'max',MAX_CONCURRENT)});
