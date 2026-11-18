// Engineering Factory v2.1 · 节点管理制 × 多 run 并发执行制
// 每个节点有进入条件/负责人/交付物/验收判据；验收不过 → 节点 blocked → 流水线停止
// 并发模型：activeRuns: Map<runDir, runState>，executing 态并发上限 MAX_CONCURRENT（默认 3）
const http=require('http'),{spawn,execSync}=require('child_process'),fs=require('fs'),path=require('path');
const PORT=process.env.PORT||8794, RUNDIR=process.env.RUNDIR||'/root/.dsh/ds-af/runs';
const ANALYSES=path.join(path.dirname(RUNDIR),'analyses'); // 分析台会话根（from-plan 校验边界，防路径注入）
const PROJFILE=process.env.PROJFILE||path.join(path.dirname(RUNDIR),'projects.json');
const MAX_CONCURRENT=Math.max(1,parseInt(process.env.MAX_CONCURRENT||'3',10)||3);
let _runSeq=0;const newRunDir=prefix=>path.join(RUNDIR,prefix+Date.now()+'-'+String(++_runSeq).padStart(2,'0')); // 序号防同毫秒碰撞

// rework-dedup（2026-11-17 人批）：idea 指纹跨话题查重——重做闭环的正确入口是
// run 卡上的 /api/approve redo（原地重跑原型），不是再立一条 run；同 idea 活动
// run 已存在 → 409 带既有 id 引导去打回，防双并发烧双份 token。
const ideaFingerprint=s=>String(s||'').replace(/\s+/g,'').slice(0,120);
const findActiveByIdea=idea=>{
  const fp=ideaFingerprint(idea);
  if(!fp)return null;
  for(const rs of activeRuns.values())
    if(!rs.done&&ideaFingerprint(rs.idea)===fp)return rs;
  return null;
};

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
function saveProjects(p){ // F11（T4/T6）：tmp+rename 原子写，断电/崩溃防护
  const tmp=PROJFILE+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(p,null,1));
  fs.renameSync(tmp,PROJFILE);
}
// v2.2.1：id 取现存最大号+1 单调递增（归并删除旧项后不复用已见编号，保唯一）
function newProject(name,repo){return projMutate(p=>{const n=p.reduce((m,x)=>Math.max(m,parseInt(String(x.id).slice(2))||0),0)+1;const proj={id:'P-'+String(n).padStart(3,'0'),name,repo,created:new Date().toISOString(),runs:[]};p.push(proj);return proj})}
function attachRun(projId,runId,name,repo){return projMutate(p=>{let pr=p.find(x=>x.id===projId);
  if(!pr){pr={id:projId,name:name||runId,repo:repo||null,created:new Date().toISOString(),runs:[]};p.push(pr)}
  if(!pr.runs.includes(runId))pr.runs.push(runId)})}
// S6（T3）deployed 记账：只写 projects.json 指针，不动 run 目录；走 projMutate 串行化；history 头插裁尾 20；外层保持裸数组
function recordDeploy(projId,runId,action){
  if(!projId)return Promise.resolve(null);
  return projMutate(p=>{const pr=p.find(x=>x.id===projId);if(!pr)return null;
    const ts=Date.now();
    const history=[{runId,ts,action:action||'deploy'},...((pr.deployed&&pr.deployed.history)||[])].slice(0,20);
    pr.deployed={runId,ts,history};
    return pr.deployed});
}
function findProjectByRun(runId){try{return((loadProjects().find(p=>(p.runs||[]).includes(runId))||{}).id)||null}catch(e){return null}}
// deployTo（部署到既有面板 · 2026-11-18 人批）：deploy 阶段除 /apps 指针记账外，可把产物同步进既有面板目录并执行其 deploy.sh（人点上线 = 服务重启授权）
function validDeployTo(t){ // 须为现存目录绝对路径；runs/ 区、仓库根、/、/root 禁入（防误爆）
  if(!path.isAbsolute(String(t||'')))return null;
  const p=path.resolve(String(t));
  if(p==='/'||p==='/root'||p===RUNDIR||p.startsWith(RUNDIR+path.sep)||p===path.dirname(RUNDIR))return null;
  try{if(!fs.statSync(p).isDirectory())return null}catch(e){return null}
  return p;
}
function syncDeployTo(root,deployTo){ // 产物 add/overwrite 同步进目标目录（不删目标既有文件；跳过 .git/deploy.sh）+ 执行目标 deploy.sh（服务重启）
  if(!root)throw new Error('run 无产物（未找到 index.html 根）');
  let n=0;
  const walk=(s,d)=>{for(const f of fs.readdirSync(s)){
    if(f==='.git'||f==='deploy.sh')continue; // 目标自己的部署脚本/版本库不覆盖
    const a=path.join(s,f),b=path.join(d,f);
    if(fs.statSync(a).isDirectory())walk(a,b);
    else{fs.mkdirSync(path.dirname(b),{recursive:true});fs.copyFileSync(a,b);n++}}};
  walk(root,deployTo);
  let sh='（无 deploy.sh — 仅同步文件，服务需人工重启）';
  const script=path.join(deployTo,'deploy.sh');
  if(fs.existsSync(script)){
    try{sh=('deploy.sh: '+(execSync('bash '+JSON.stringify(script),{encoding:'utf8',timeout:30000,env:ENV,cwd:deployTo})||'').trim()).slice(0,300)}
    catch(e){sh='⚠️ deploy.sh 执行失败: '+String(e.message).slice(0,200)}
  }
  return{files:n,script:sh};
}
function deployRootOf(runDir,manifest){ // 取 run 产物根：iterate 产物在父产品仓（manifest.repo），build 在 run 目录（findIndexHtmlRoot）
  try{const meta=manifest||JSON.parse(rf(runDir,'manifest.json')||'{}');
    if((meta.flow||'')==='iterate'&&meta.repo&&fs.existsSync(meta.repo))return meta.repo;
  }catch(e){}
  return findIndexHtmlRoot(runDir);
}
// v2.2.1 归类自愈（规范程序，非人工/AI 手工清洗）：同 name+repo 的项目自动归并 ——
// 保留最早项，created 取最早、runs 有序去重并、remote 取首个非空、deployed 取 ts 最新且 history 并集降序裁 20；
// 启动时自动触发（listen 回调），配合 restore/立项查重（防再犯）构成自动归类闭环。
function normalizeProjects(){return projMutate(p=>{
  const byKey=new Map(),merged=[];
  for(const pr of p){
    const keep=byKey.get(pr.name+'\u0000'+(pr.repo||''));
    if(!keep){byKey.set(pr.name+'\u0000'+(pr.repo||''),pr);merged.push(pr);continue}
    keep.created=[keep.created,pr.created].filter(Boolean).sort()[0]||keep.created;
    for(const r of(pr.runs||[]))if(!keep.runs.includes(r))keep.runs.push(r);
    if(!keep.remote&&pr.remote)keep.remote=pr.remote;
    if(pr.deployed){
      const hist=new Map();
      for(const h of[...((keep.deployed&&keep.deployed.history)||[]),...(pr.deployed.history||[])])hist.set(h.runId+'\u0000'+h.ts+'\u0000'+h.action,h);
      const newer=(!keep.deployed||pr.deployed.ts>=keep.deployed.ts)?pr.deployed:keep.deployed;
      newer.history=[...hist.values()].sort((a,b)=>b.ts-a.ts).slice(0,20);
      keep.deployed=newer;
    }
    console.log('[normalize] 归并',pr.id,'→',keep.id,'（'+String(keep.name).slice(0,24)+'）');
  }
  if(merged.length!==p.length){p.length=0;p.push(...merged)}
  return merged.length;
})}
const ENV={...process.env,PATH:'/home/administrator/.hermes/node/bin:'+process.env.PATH};
// ===== 并发池：run 全局单例已废除 =====
const activeRuns=new Map(); // runDir -> runState
const execCount=()=>[...activeRuns.values()].filter(r=>r.executing).length;
const latestRun=()=>{let l=null;for(const rs of activeRuns.values())l=rs;return l};
const findRun=id=>{if(!id)return null;
  for(const rs of activeRuns.values())if(path.basename(rs.dir)===id)return rs;
  // 磁盘兜底：已交付/历史 run 不在内存，从 runs/ 目录按 id 找（含节点状态恢复为只读快照）
  if(/^[\w.-]+$/.test(id)){const p=path.join(RUNDIR,id);
    if(fs.existsSync(p)&&fs.statSync(p).isDirectory()){
      let st={};try{st=JSON.parse(rf(p,'nodes.json')||'{}')}catch(e){}
      return{dir:p,idea:st.idea||id,flow:st.flow||'build',nodeStatus:st.nodeStatus||[],acceptDetails:st.acceptDetails||[],events:[],artifacts:listArtifacts(p),done:true,resumed:true,readOnly:true};
    }}
  return null};

const j=(r,c,o)=>{r.writeHead(c,{'Content-Type':'application/json; charset=utf-8'});r.end(JSON.stringify(o))};
// F11（T4/T6）：服务端外插 HTML 一律转义（/apps 503 文案页等），修复参考实现已知 XSS 面
const escapeHtml=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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
 // S1（T2）iterate 链末同样追加 deploy 人工闸（fix 链不追加 —— D1 默认案：整改诉求由 build/iterate 覆盖，改动面最小）
 {id:'deploy',name:'部署上线',owner:'👤 人',entry:'交付完成 — 人工拍板（go=上线 /apps，skip=delivered 收尾）',
  prompt:null,deliverable:'deployed 记账 + /apps/<projectId>/ 稳定地址',
  accept:(d,rs)=>({pass:true,detail:'deploy 闸：人工拍板（/api/approve go|skip）'})},
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
  accept:d=>{const root=findIndexHtmlRoot(d);const idx=root?path.relative(d,root):null;let all=true,n=0,mc=0;try{const t=JSON.parse(rf(path.join(d,'llmwiki'),'tasks.json'));const mine=t.filter(x=>!x.owner_agent||x.owner_agent==='coding');n=t.length;mc=mine.length;all=mine.every(x=>x.status==='done')}catch(e){all=false}
    return{pass:!!idx&&all,detail:`入口页:${idx||'未找到'} · coding任务done:${all?mc+'/'+n:'否(未逐个标记)'}`}}},
 {id:'qa',name:'QA 验证',owner:'QA Agent',entry:'开发验收通过（全部任务 done）',
  prompt:i=>`你是 QA/Review Agent（只读代码，可用 node 运行验证，禁止修改代码文件）。对照 PRD.md 验收标准和 tasks.json 逐项检查，能运行的一律真实运行。写 llmwiki/QA-Report.md（中文：逐项 通过/未通过+证据，结论行必须含 PASS、PARTIAL 或 FAIL）。`,
  deliverable:'QA-Report.md',
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'QA-Report.md')||'';return{pass:c.length>200&&/PASS|PARTIAL|FAIL/.test(c),detail:`${c.length}字 · 结论:${(c.match(/PASS|PARTIAL|FAIL/g)||[]).join(',')}`}}},
 {id:'delivery',name:'交付',owner:'DevOps Agent',entry:'QA 结论为 PASS/PARTIAL',
  prompt:i=>`你是 DevOps Agent。在 product/ 目录内（它本身就是独立产品仓）：若无 .git 先 git init 并 config 本地身份，然后 git add -A && git commit -m "delivery v1.0.0"（不对 run 根 init）。写 llmwiki/DELIVERY.md（中文：交付清单/如何运行/已知限制/版本）。不改代码。`,
  deliverable:'DELIVERY.md + product/ 内 git 提交',
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'DELIVERY.md');let commits='';try{commits=execSync('git -C '+path.join(d,'product')+' log --oneline',{encoding:'utf8',env:ENV}).trim()}catch(e){}
    return{pass:!!c&&commits.includes('delivery'),detail:`DELIVERY.md:${!!c} · product/git提交:${commits.split('\n').length} 条`}}},
 // S1（T2）deploy 人工闸节点：👤 人拍板、无 executor（prompt:null 不派 agent）、decision 取 go|skip、无 redo；
 // 状态由 /api/approve 按 gate 分流写入（go=done / skip=skipped），不走 runFrom 常规验收。
 {id:'deploy',name:'部署上线',owner:'👤 人',entry:'交付完成 — 人工拍板（go=上线 /apps，skip=delivered 收尾）',
  prompt:null,deliverable:'deployed 记账 + /apps/<projectId>/ 稳定地址',
  accept:(d,rs)=>({pass:true,detail:'deploy 闸：人工拍板（/api/approve go|skip）'})},
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
function findIndexHtml(dir){ // 产品入口允许在任意子目录（index.html 优先，原型 prototype.html 兜底）
  if(rf(dir,'index.html'))return 'index.html';
  if(rf(dir,'prototype.html'))return 'prototype.html';
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
// S5（T1）终态两态判定：全节点 ∈ {done,skipped} 且无 blocked = 终态；末位 deploy=done → deployed，
// =skipped（或历史 run 无 deploy 节点）→ delivered。旧式「末位 done」判定在 deploy·skip 后会把
// run 误判 paused / 捞回并发池，故 4 个判定点（/api/projects、/api/runs、restoreRun、/api/projects/deploy
// 目标校验）统一走本函数，禁止再写末位判定。
function runStatusOf(nodeStatus,flow){
  const ns=nodeStatus||[];
  const blocked=ns.includes('blocked');
  const terminal=ns.length>0&&!blocked&&ns.every(s=>s==='done'||s==='skipped');
  let status='paused';
  if(blocked)status='blocked';
  else if(terminal){
    const chain=flowNodes(flow);
    const hasDeploy=chain.length>0&&chain[chain.length-1].id==='deploy'&&ns.length===chain.length;
    status=(hasDeploy&&ns[ns.length-1]==='done')?'deployed':'delivered';
  }else if(ns.includes('running'))status='running';
  return{blocked,terminal,status};
}
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
    if(runStatusOf(ns,st.flow).terminal)return null; // S5 判定点③：终态（含 deploy·skip 的 delivered 与 deployed）不捞回并发池
    // S2（T2）恢复 awaiting-deploy：闸持久化在 nodes.json，重启后照常恢复且 executing=false（不被捞回并发池）；
    // 极端态自愈——delivery 已 done 但 deploy 仍 pending 且无 awaiting 记录（如旧版中断）→ 补挂 deploy 闸防卡死。
    const chain=flowNodes(st.flow||'build');
    let awaiting=st.awaiting||null;
    if(!awaiting&&chain.length&&chain[chain.length-1].id==='deploy'&&ns.length===chain.length&&ns[ns.length-1]==='pending')
      awaiting={gate:'deploy',nodeIdx:ns.length-1};
    let repo=null;try{repo=(JSON.parse(rf(dir,'manifest.json')||'{}').repo)||null}catch(e){}
    const rs={dir,id:path.basename(dir),idea:st.idea||'(未知)',flow:st.flow||'build',repo,parentProject:null,stage:null,
      nodeStatus:ns,acceptDetails:(st.acceptDetails||[]).map((a,i)=>ns[i]==='blocked'&&!a?'⛔ 服务重启中断，可重试续跑':a),
      gate:!!st.gate,awaiting,
      events:[],artifacts:listArtifacts(dir),done:false,executing:false,nodeStartTs:0,lastAction:null,
      projectId:findProjectByRun(path.basename(dir)),resumed:true}; // v2.2.1：恢复时按 runId 反查挂回项目（旧版 null 导致重复立项）
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
        rs.projectId=findProjectByRun(rs.id); // v2.2.1 防重：run 已挂项目则复用，不再新建（P-005~P-010 重复根因）
        if(rs.projectId)emit({type:'project',text:'🗂 复用既有项目 '+rs.projectId});
        else try{
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
      if(a.pass&&n.id==='delivery'&&(rs.flow==='build'||rs.flow==='iterate')){ // S2（T2）：交付通过 → deploy 人工闸（👤 上线|跳过；闸期间 executing=false 不占并发池，与 prototype 闸同构；fix 链不设）
        const chain=flowNodes(rs.flow);
        if(chain[idx+1]&&chain[idx+1].id==='deploy'){
          rs.awaiting={gate:'deploy',nodeIdx:idx+1};rs.executing=false;persist(rs);
          emit({type:'pipeline_awaiting',node:'deploy',text:'🚀 交付已就绪 — 等待人工拍板上线（上线 /api/approve go，跳过 /api/approve skip；无打回重做）'});
          if(res)res.end();return;
        }
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
  if(req.method==='GET'&&u.pathname.startsWith('/apps/')){ // S4（T4）：稳定路由 /apps/<projectId>/ —— 懒校验，地址随版本演进不变；产物寻址复用 findIndexHtmlRoot 支持子目录资产（与 /preview 同构，D3）
    const seg=decodeURIComponent(u.pathname.slice(6)).split('/').filter(Boolean);
    const apps503=(title,detail)=>{res.writeHead(503,{'Content-Type':'text/html; charset=utf-8'});res.end( // 503 文案页：外插值全走 escapeHtml（F11）
      '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHtml(title)+'</title>'+
      '<style>body{font:14px/1.7 -apple-system,"Segoe UI","PingFang SC",sans-serif;background:#fafafa;color:#1a1a1a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}'+
      '.card{background:#fff;border:1px solid #e5e5e5;border-radius:14px;padding:32px 36px;max-width:540px;box-shadow:0 4px 18px rgba(0,0,0,.05)}h1{font-size:18px;margin:0 0 8px}p{color:#737373;margin:6px 0}code{background:#f5f5f5;border-radius:5px;padding:1px 6px;font-family:ui-monospace,monospace;font-size:12.5px}</style></head><body>'+
      '<div class="card"><h1>'+escapeHtml(title)+'</h1><p>'+escapeHtml(detail)+'</p></div></body></html>')};
    const pr=loadProjects().find(x=>x.id===seg[0]);
    if(!pr)return apps503('未上线','项目 '+(seg[0]||'')+' 不存在（或已删除）。');
    const dep=pr.deployed;
    if(!dep||!dep.runId||!/^[\w.-]+$/.test(dep.runId)) // 分支①：未上线
      return apps503('未上线','「'+pr.name+'」还没有已部署版本 —— 在工厂面板项目卡「上线 / 补办部署」后，本地址即可访问（地址随版本演进不变）。');
    const runDir=path.join(RUNDIR,dep.runId);
    const root=fs.existsSync(runDir)?findIndexHtmlRoot(runDir):null;
    if(!root) // 分支②：部署中 / 产物异常
      return apps503('部署中 / 产物异常','版本 '+dep.runId+' 的产物缺失 —— 请检查 run 目录或重新部署（/api/projects/deploy）。');
    // 分支③：指针有效（含回退到历史版本）→ 正常伺服该 run 产物；子目录资产挂同根
    const rel=seg.slice(1).join('/');
    let file=path.join(root,rel);
    if(!rel||!fs.existsSync(file)||fs.statSync(file).isDirectory()){
      const idx=rf(root,'index.html')?'index.html':(rf(root,'prototype.html')?'prototype.html':null);
      if(!idx)return apps503('部署中 / 产物异常','版本 '+dep.runId+' 缺少 index.html。');
      file=path.join(root,idx);
    }
    try{
      if(!rel)res.setHeader('Content-Type','text/html; charset=utf-8');
      return res.end(fs.readFileSync(file));
    }catch(e){return apps503('部署中 / 产物异常','版本 '+dep.runId+' 产物读取失败。')}
  }
  if(req.method==='GET'&&u.pathname.startsWith('/preview/')){
    // 新寻址 /preview/<runId>/<rel>；旧式 /preview/<rel> 回退最近活动 run
    const rest=decodeURIComponent(u.pathname.slice(9))||'';
    const seg=rest.split('/').filter(Boolean);
    let rs=seg.length>1?findRun(seg[0]):null;
    const rel=rs?seg.slice(1).join('/'):rest;
    if(!rs)rs=latestRun();
    if(!rs)return res.writeHead(404).end();
    // preview-asset-root-fix（2026-11-17）：产品在 product/ 子目录时，资产
    // 相对路径必须挂到同一根下——否则 css/js 全部回退成 index.html（症状：
    // 预览页裸 HTML 无样式无交互）。
    let file=path.join(rs.dir,rel);
    if(!fs.existsSync(file)||fs.statSync(file).isDirectory()){
      const root=findIndexHtmlRoot(rs.dir)||rs.dir;
      const rooted=path.join(root,rel);
      if(fs.existsSync(rooted)&&!fs.statSync(rooted).isDirectory()){file=rooted}
      else{
        const idx=findIndexHtml(root);
        if(!idx){res.writeHead(404);return res.end('404')}
        file=path.join(root,idx);
      }
    }
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
        return{id,idea:meta.idea||'',flow:meta.flow||'build',status:runStatusOf(meta.nodeStatus,meta.flow).status,exists:fs.existsSync(p)}; // S5 判定点①
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
        list.push({id:d,idea:meta.idea||'',flow:meta.flow||'build',ts:meta.ts||0,
          status:runStatusOf(meta.nodeStatus,meta.flow).status, // S5 判定点②
          nodes:meta.nodeStatus||[]});
      }
    }catch(e){}
    const act=[...activeRuns.values()].map(summarize);
    return j(res,200,{runs:list,active:act.length?act.map(r=>r.id):null});
  }
  if(req.method==='POST'&&u.pathname==='/api/projects/deploy'){ // S7（T4）：补办部署与版本回退合一 —— 缺省 runId=补办最新 delivered；显式历史 runId=切 deployed 指针（回退）。与 /api/runs/rollback（run 内 git revert）语义不同、并存（D2）
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      let q;try{q=JSON.parse(b||'{}')}catch(e){return j(res,400,{error:'bad json'})}
      projMutate(p=>{ // 只切 projects.json 指针，不动 run 目录（readOnly/纯磁盘 run 可操作）
        const pr=p.find(x=>x.id===(q.projectId||''));
        if(!pr)return{code:404,error:'no project'};
        if(q.deployTo!==undefined){ // deployTo（面板部署目标）：可设/可清（空串=清除）；设了之后每次上线/补办都会同步产物+跑 deploy.sh
          if(String(q.deployTo||'')!==''){const v=validDeployTo(q.deployTo);
            if(!v)return{code:400,error:'deployTo 无效 — 须为现存目录绝对路径，且不得位于 runs/ 或仓库根'}}
          pr.deployTo=String(q.deployTo||'').trim()||null;
        }
        let target=q.runId||'';
        if(!target){ // 补办：最新 delivered（终态、未上线收尾）run；fix 流不走 /apps
          for(const rid of [...(pr.runs||[])].reverse()){
            let meta={flow:'build',nodeStatus:[]};
            try{meta=JSON.parse(rf(path.join(RUNDIR,rid),'nodes.json')||'{}')}catch(e){}
            if((meta.flow||'build')==='fix')continue;
            if(runStatusOf(meta.nodeStatus,meta.flow).status==='delivered'){target=rid;break}
          }
          if(!target)return{code:400,error:'项目无可补办部署的 delivered run（需先有交付完成且跳过上线的 run）'};
        }else{
          if(!(pr.runs||[]).includes(target))return{code:404,error:'runId 不属于项目 '+pr.id};
          if(!fs.existsSync(path.join(RUNDIR,target)))return{code:404,error:'run 目录不存在'};
          let meta={flow:'build',nodeStatus:[]};
          try{meta=JSON.parse(rf(path.join(RUNDIR,target),'nodes.json')||'{}')}catch(e){}
          if((meta.flow||'build')==='fix')return{code:400,error:'fix 流产物走 run 目录交付，不走 /apps 部署'};
          const st=runStatusOf(meta.nodeStatus,meta.flow); // S5 判定点④：目标校验同用两态判定
          if(st.status!=='delivered'&&st.status!=='deployed')return{code:400,error:'目标 run 非终态（'+st.status+'）— 仅 delivered/deployed 的 run 可切换指针'};
        }
        const prev=pr.deployed&&pr.deployed.runId;
        const ts=Date.now();
        pr.deployed={runId:target,ts,history:[{runId:target,ts,action:(q.runId&&prev&&prev!==target)?'rollback':'deploy'},...((pr.deployed&&pr.deployed.history)||[])].slice(0,20)};
        let dep=null; // deployTo：同步产物进既有面板 + deploy.sh（失败不回滚指针，仅回报）
        if(pr.deployTo){try{const r=syncDeployTo(deployRootOf(path.join(RUNDIR,target),null),pr.deployTo);
          dep={deployTo:pr.deployTo,files:r.files,script:r.script}}
        catch(e){dep={deployTo:pr.deployTo,error:String(e.message).slice(0,150)}}}
        return{code:200,deployed:pr.deployed,url:'/apps/'+pr.id+'/',deploy:dep};
      }).then(r=>{if(!r)return j(res,500,{error:'internal'});
        if(r.code===200)return j(res,200,{ok:true,deployed:r.deployed,url:r.url,deploy:r.deploy||null});
        return j(res,r.code,{error:r.error})});
    });
    return;
  }
  if(req.method==='POST'&&u.pathname==='/api/runs/delete'){
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const id=(JSON.parse(b||'{}').id||'').replace(/[\/..]/g,'');
      const p=path.join(RUNDIR,id);
      if(!id||!fs.existsSync(p)||!p.startsWith(RUNDIR))return j(res,400,{error:'bad id'});
      const rs=activeRuns.get(p);
      if(rs&&rs.executing)return j(res,409,{error:'正在执行的任务不可删除'});
      const depRef=loadProjects().find(x=>x.deployed&&x.deployed.runId===id); // S8（T4）：被 deployed 指针引用的 run 拒删
      if(depRef)return j(res,409,{error:'该 run 正被项目 '+depRef.id+' 的 deployed 指针引用（/apps/'+depRef.id+'/ 在线）— 请先回退到其他版本（/api/projects/deploy）再删除',projectId:depRef.id});
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
      // S8（T4）：项目删除前置校验——本项目 run 若被「其他项目」deployed 指针引用则拒删（本项目自身指针随项目记录一并消失，无 /apps 悬挂）
      const foreign=projs.find(x=>x.id!==id&&x.deployed&&(pr.runs||[]).includes(x.deployed.runId));
      if(foreign)return j(res,409,{error:'项目 run 被项目 '+foreign.id+' 的 deployed 指针引用 — 请先回退对方指针（/api/projects/deploy）再删除'});
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
      const dup=findActiveByIdea(idea); // rework-dedup
      if(dup)return j(res,409,{error:'同一 idea 已有活动中的 run '+dup.id+'——重做请用该 run 的原型打回（redo）',runId:dup.id});
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
      const dup=findActiveByIdea(idea); // rework-dedup
      if(dup)return j(res,409,{error:'同一 idea 已有活动中的 run '+dup.id+'——重做请用该 run 的原型打回（redo）',runId:dup.id});
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
  if(req.method==='GET'&&u.pathname==='/api/analyses'){ // 分析台话题列表（立项池数据源：state=go 且未 spawn 的可选；v1.1 兼容话题目录 analyses/<topic>/an-*）
    const list=[];
    try{
      const seen=[];
      for(const e of fs.readdirSync(ANALYSES,{withFileTypes:true})){
        if(!e.isDirectory())continue;
        if(e.name.startsWith('an-'))seen.push([e.name,ANALYSES]);
        else for(const s of fs.readdirSync(path.join(ANALYSES,e.name)).filter(d=>d.startsWith('an-')))seen.push([s,path.join(ANALYSES,e.name)]);
      }
      for(const[id,base]of seen.sort((a,b)=>b[0].localeCompare(a[0]))){
        const d=path.join(base,id);const m=rf(d,'meta.json');if(!m)continue;
        try{const meta=JSON.parse(m);
          list.push({id,dir:d,idea:(meta.idea||'').slice(0,120),state:meta.state,round:meta.round,updated:meta.updated,spawnedRun:meta.spawnedRun||null,topic:meta.topic||null})}
        catch(e){}
      }
    }catch(e){}
    return j(res,200,{analyses:list});
  }
  if(req.method==='POST'&&u.pathname==='/api/mission/from-plan'){ // 分析台话题立项三通：build(默认)/fix(带 repo)/iterate(带 projectId)；分析产物 = 工厂输入料（非工厂产物）
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const{analysisDir='',idea='',mode='build',repo='',projectId='',deployTo=''}=JSON.parse(b||'{}');
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
      const dup=findActiveByIdea(ideaText); // rework-dedup：重做走 /api/approve redo，不并排立新
      if(dup)return j(res,409,{error:'同一 idea 已有活动中的 run '+dup.id+'（节点:'+(dup.stage||'进行中')+'）——重做请在该 run 的原型确认闸选 redo 并附整改意见，勿另立新 run',runId:dup.id});
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
        const dt=String(deployTo||'').trim(); // deployTo：升级交付后可直接部署到既有面板（多轮整改 → 直接启用闭环）
        if(dt){const v=validDeployTo(dt);
          if(!v)return j(res,400,{error:'deployTo 无效 — 须为现存目录绝对路径，且不得位于 runs/ 或仓库根'});
          projMutate(p=>{const x=p.find(y=>y.id===pr.id);if(x)x.deployTo=v});
        }
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
  if(req.method==='POST'&&u.pathname==='/api/approve'){ // 人工闸按 gate 分流（S3/T3）：prototype=go|redo（原有语义不动）；deploy=go|skip（无 redo）
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const{id='',decision='',feedback=''}=JSON.parse(b||'{}');
      const rs=findRun(id);
      if(!rs)return j(res,400,{error:'no run'});
      if(!rs.awaiting)return j(res,400,{error:'该 run 不在确认闸（awaiting）状态'});
      if(!['go','redo','skip'].includes(decision))return j(res,400,{error:'decision 须为 go|redo（prototype 闸）或 go|skip（deploy 闸）'});
      const gate=rs.awaiting.gate||'prototype';
      if(gate==='deploy'){
        if(!['go','skip'].includes(decision))return j(res,400,{error:'deploy 闸仅收 go（上线）|skip（跳过）— 不支持打回重做（redo）'});
        const idx=rs.awaiting.nodeIdx;rs.awaiting=null;persist(rs);
        res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
        if(decision==='skip'){
          rs.nodeStatus[idx]='skipped';rs.acceptDetails[idx]='⏭ 人工跳过上线 — delivered 收尾（未上线，后续可在项目卡补办部署）';persist(rs);
          rs.events.push({type:'deploy',text:'⏭ 已跳过上线 — run 以 delivered 终态收尾'});
          W(res,rs.events[rs.events.length-1]);
          runFrom(rs,idx+1,res); // 末位之后 → all_done
        }else{
          rs.nodeStatus[idx]='done';rs.acceptDetails[idx]='✅ 人工拍板上线 — deployed';persist(rs);
          const pid=rs.projectId||findProjectByRun(rs.id); // 恢复/只读路径下内存无 projectId → 按 runId 反查
          recordDeploy(pid,rs.id,'deploy');
          let dmsg=''; // deployTo：项目设了面板部署目标 → 产物同步 + deploy.sh 重启（人点上线 = 授权）
          try{const prj=pid?loadProjects().find(x=>x.id===pid):null;
            if(prj&&prj.deployTo){
              const r=syncDeployTo(deployRootOf(rs.dir,null),prj.deployTo);
              dmsg=' · 已同步部署到面板 '+prj.deployTo+'（'+r.files+' 文件）· '+r.script;
            }
          }catch(e){dmsg=' · ⚠️ deployTo 同步失败: '+String(e.message).slice(0,150)}
          rs.events.push({type:'deploy',text:'🚀 已上线 — 稳定地址 /apps/'+(pid||'?')+'/（版本可回退、地址不变）'+dmsg});
          W(res,rs.events[rs.events.length-1]);
          runFrom(rs,idx+1,res);
        }
        return;
      }
      if(!['go','redo'].includes(decision))return j(res,400,{error:'原型确认闸仅收 go（放行）|redo（打回重做）— skip 是 deploy 闸专用'});
      const idx=rs.awaiting.nodeIdx;rs.awaiting=null;persist(rs);
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
      if(decision==='redo'){
        rs.prototypeFeedback=feedback||'';rs.nodeStatus[idx]='pending';persist(rs);
        try{fs.mkdirSync(path.join(rs.dir,'llmwiki'),{recursive:true});
            fs.writeFileSync(path.join(rs.dir,'llmwiki','REDO-feedback.md'),'# 原型打回反馈（'+new Date().toISOString()+'）\n\n'+(feedback||'（无具体意见）')+'\n')}catch(e){}
        rs.events.push({type:'flow',text:'🔁 原型被打回重做'+(feedback?'（反馈: '+feedback.slice(0,200)+'）':'（⚠️ 无具体意见）')});
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
      if(rs.awaiting)return j(res,400,{error:rs.awaiting.gate==='deploy'?'部署闸等待人工拍板 — 请用 /api/approve {go|skip}（上线或跳过，无打回重做）':'原型确认闸等待人工拍板 — 请用 /api/approve {go|redo}'});
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
}).listen(PORT,'0.0.0.0',()=>{normalizeProjects().then(n=>console.log('[normalize] 归类自愈完成：',n,'个项目'));bootState();console.log('factory v2.2.1 (concurrent+deploy+normalize) on',PORT,'max',MAX_CONCURRENT)});
