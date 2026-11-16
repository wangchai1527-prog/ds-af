// Engineering Factory v2 · 节点管理制 —— 每个节点有进入条件/负责人/交付物/验收判据
// 验收不过 → 节点 blocked → 流水线停止 → 人工重试，防偏移
const http=require('http'),{spawn,execSync}=require('child_process'),fs=require('fs'),path=require('path');
const PORT=8794, RUNDIR='/root/.dsh/DS-AF/runs';
const ENV={...process.env,PATH:'/home/administrator/.hermes/node/bin:'+process.env.PATH};
let run=null;

const j=(r,c,o)=>{r.writeHead(c,{'Content-Type':'application/json; charset=utf-8'});r.end(JSON.stringify(o))};
// Workspace Standard 1.0
function scaffold(dir,flow,idea,repo){
  for(const d of ['loop','llmwiki','runtime','skills','plugins'])fs.mkdirSync(path.join(dir,d),{recursive:true});
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({run_id:path.basename(dir),standard:'workspace-1.0',flow,idea,repo:repo||null,created:new Date().toISOString()},null,1));
  fs.writeFileSync(path.join(dir,'plugins','used.json'),'[]');
  fs.writeFileSync(path.join(dir,'skills','README.md'),'本次运行沉淀的技能候选\n');
}
function logLoop(dir,ev){try{fs.appendFileSync(path.join(dir,'loop','events.jsonl'),JSON.stringify({ts:new Date().toISOString(),...ev})+'\n')}catch(e){}}
const W=(r,s)=>r.write(JSON.stringify(s)+'\n');
const rf=(d,f)=>{try{return fs.readFileSync(path.join(d,f),'utf8')}catch(e){return null}};

// ===== 研发流程节点定义（可管理：进入条件→执行→验收判据→放行/阻断） =====
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
  accept:d=>({pass:true,detail:'fix 工单: '+run.idea.slice(0,50)})},
 {id:'survey',name:'现场勘察',owner:'Diagnosis Agent',entry:'工单立项',deliverable:'SURVEY.md',
  prompt:i=>`你是诊断 Agent（只读）。工作目录是一个现有项目（上级指示的问题：${i}）。勘察：目录结构、README、入口文件、git log 最近提交、运行方式。目标仓库：${run.repo}。写 llmwiki/SURVEY.md（中文：项目概况/技术栈/相关文件定位/复现方式；用 Read/Bash 只读勘察目标仓库）。禁止修改目标仓库任何文件。`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'SURVEY.md')||'';return{pass:c.length>200,detail:`${c.length}字勘察报告`}}},
 {id:'diagnosis',name:'根因定位',owner:'Diagnosis Agent',entry:'勘察完成',deliverable:'DIAGNOSIS.md',
  prompt:i=>`你是诊断 Agent。读 llmwiki/SURVEY.md，用只读方式查看目标仓库代码（${run.repo}),定位问题根因（问题：${i}）。能运行复现的就真实运行复现。写 llmwiki/DIAGNOSIS.md（中文：症状/复现步骤/根因/影响范围/修复方案建议/回归判据）。`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'DIAGNOSIS.md')||'';return{pass:c.length>200&&/根因/.test(c),detail:`${c.length}字 · 含根因分析`}}},
 {id:'fix',name:'修复实施',owner:'Coding Agent',entry:'根因已定位',deliverable:'代码修复 diff',
  prompt:i=>`你是 Coding Agent。读 llmwiki/DIAGNOSIS.md，到目标仓库 ${run.repo} 按其修复方案实施修复：外科式最小改动，只改根因涉及文件，禁止顺手重构/删死代码（只报告）。改完按 DIAGNOSIS 的回归判据真实运行验证。回执 [STATUS]/[CHANGES]/[TESTS]。`,
  accept:d=>{try{const out=require('child_process').execSync('git -C '+d+' status --short 2>/dev/null||echo NOGIT',{encoding:'utf8',env:ENV}).trim();return{pass:!!out&&out!=='NOGIT',detail:`工作区变更: ${out.split('\n').length} 个文件`}}catch(e){return{pass:false,detail:'无法检测变更'}}}},
 {id:'regression',name:'回归验证',owner:'QA Agent',entry:'修复已实施',deliverable:'QA-Report.md',
  prompt:i=>`你是 QA Agent（只读+可运行，禁改代码）。读 llmwiki/DIAGNOSIS.md 回归判据，到目标仓库 ${run.repo} 逐项验证修复效果，并检查无新破坏。写 llmwiki/QA-Report.md（逐项 通过/未通过+证据，结论含 PASS/PARTIAL/FAIL）。`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'QA-Report.md')||'';return{pass:c.length>150&&/PASS|PARTIAL|FAIL/.test(c),detail:`结论:${(c.match(/PASS|PARTIAL|FAIL/g)||[]).join(',')}`}}},
 {id:'delivery',name:'交付',owner:'DevOps Agent',entry:'回归 PASS/PARTIAL',deliverable:'DELIVERY.md + git 提交',
  prompt:i=>`你是 DevOps Agent。git add -A && git commit -m "fix: per DIAGNOSIS（无 .git 则 init+本地身份）"。写 DELIVERY.md（中文：修复摘要/根因/改动文件/回归结果/版本）。不改代码。`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'DELIVERY.md');let commits='';try{commits=execSync('git -C '+d+' log --oneline',{encoding:'utf8',env:ENV}).trim()}catch(e){}
    return{pass:!!c&&commits.includes('fix'),detail:`DELIVERY.md:${!!c} · fix提交:${commits.split('\n').length} 条`}}},
];

const ITERNODES=[
 {id:'kickoff',name:'迭代立项',owner:'👤 人',entry:'增量需求已提交',prompt:null,deliverable:'run 元数据',
  accept:d=>({pass:true,detail:'iterate: '+run.idea.slice(0,50)})},
 {id:'product',name:'增量PRD',owner:'Product Agent',entry:'迭代立项',deliverable:'llmwiki/PRD.md',
  prompt:i=>`你是 Product Agent。这是对已有产品的迭代（仓库 ${run.repo}）。先 Read 仓库现有代码了解现状，再写 llmwiki/PRD.md（中文：迭代目标/新增或修改功能清单/验收标准/不改动范围——明确外科式边界）。增量需求：${i}`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'PRD.md')||'';return{pass:c.length>250&&/验收标准/.test(c),detail:c.length+'字 · 含验收标准:'+(/验收标准/.test(c))}}},
 {id:'manager',name:'任务拆解',owner:'Eng Manager',entry:'增量PRD通过',deliverable:'llmwiki/tasks.json',
  prompt:i=>`你是 Engineering Manager。读 llmwiki/PRD.md 和目标仓库 ${run.repo} 的现有代码结构，写 llmwiki/tasks.json：JSON数组(2-5个增量任务)，每项含 task_id,objective,owner_agent(coding|qa),acceptance_criteria,git_branch。改动必须最小化。`,
  accept:d=>{try{const t=JSON.parse(rf(path.join(d,'llmwiki'),'tasks.json'));return{pass:Array.isArray(t)&&t.length>=1&&t.every(x=>x.task_id&&x.objective&&x.acceptance_criteria),detail:t.length+' 份增量合同'}}catch(e){return{pass:false,detail:'解析失败'}}}},
 {id:'coding',name:'增量开发',owner:'Coding Agent',entry:'合同通过',deliverable:'父仓代码 diff',
  prompt:i=>`你是 Coding Agent。读 llmwiki/PRD.md 和 llmwiki/tasks.json，到目标仓库 ${run.repo} 实施增量改动：外科式最小修改，禁止重构无关代码，每完成一个任务在 llmwiki/tasks.json 标 status:done。改完运行可运行的验证。回执 [STATUS]/[CHANGES]/[TESTS]。`,
  accept:d=>{try{const out=execSync('git -C '+run.repo+' status --short 2>/dev/null||echo NO',{encoding:'utf8',env:ENV}).trim();let all=true;try{all=JSON.parse(rf(path.join(d,'llmwiki'),'tasks.json')).every(t=>t.status==='done')}catch(e){}return{pass:!!out&&out!=='NO'&&all,detail:'父仓变更 '+out.split('\n').length+' 文件 · 任务全done:'+all}}catch(e){return{pass:false,detail:'无法检测'}}}},
 {id:'qa',name:'回归验证',owner:'QA Agent',entry:'增量完成',deliverable:'llmwiki/QA-Report.md',
  prompt:i=>`你是 QA Agent（只读+可运行，禁改代码）。对照 llmwiki/PRD.md 验收标准，在仓库 ${run.repo} 逐项验证增量功能，并抽查原有功能无回归。写 llmwiki/QA-Report.md（结论含 PASS/PARTIAL/FAIL）。`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'QA-Report.md')||'';return{pass:c.length>150&&/PASS|PARTIAL|FAIL/.test(c),detail:'结论:'+(c.match(/PASS|PARTIAL|FAIL/g)||[]).join(',')}}},
 {id:'delivery',name:'交付',owner:'DevOps Agent',entry:'回归 PASS/PARTIAL',deliverable:'父仓版本提交',
  prompt:i=>`你是 DevOps Agent。在目标仓库 ${run.repo} 执行 git add -A && git commit -m "iterate: 增量交付 v+（保持外科式边界）"。写 llmwiki/DELIVERY.md（增量摘要/改动文件/回归结果）。不改代码。`,
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'DELIVERY.md');let ok=false;try{ok=execSync('git -C '+run.repo+' log --oneline -1',{encoding:'utf8',env:ENV}).includes('iterate')}catch(e){}
    return{pass:!!c&&ok,detail:'DELIVERY.md:'+!!c+' · iterate提交:'+ok}}},
];
function findIndexHtmlRoot(dir){ // 返回含 index.html 的最近目录（含 runtime/）
  if(!dir)return null;
  const cand=[path.join(dir,'runtime'),dir];
  for(const c of cand){if(rf(c,'index.html')||rf(c,'prototype.html'))return c}
  return null;
}

const NODES=[
 {id:'kickoff',name:'立项',owner:'👤 人',entry:'产品想法已提交',
  prompt:null,deliverable:'run 元数据',
  accept:d=>({pass:true,detail:'idea: '+run.idea.slice(0,50)})},
 {id:'product',name:'PRD',owner:'Product Agent',entry:'立项通过',
  prompt:i=>`你是 Product Agent。把下面的产品想法转成 PRD，写入 llmwiki/PRD.md（中文，必须包含章节：产品定位/目标用户/功能清单(标P0/P1)/验收标准/非目标）。只写这一个文件。产品想法：${i}`,
  deliverable:'PRD.md',
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'PRD.md')||'';return{pass:c.length>300&&/验收标准/.test(c)&&/功能清单|功能/.test(c),detail:`${c.length}字 · 含验收标准:${/验收标准/.test(c)} · 含功能清单:${/功能清单|功能/.test(c)}`}}},
 {id:'prototype',name:'原型 Demo',owner:'Prototype Agent',entry:'PRD 验收通过（先看原型再实施）',
  prompt:i=>`你是 Prototype Agent。读当前目录 PRD.md，产出 runtime/prototype.html：单文件可交互高保真原型（纯 HTML+CSS+JS 内联，浅色现代风格，实现 P0 功能的界面与交互骨架，数据可用内存 mock）。只写这一个文件，供人预览确认方向。`,
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
  prompt:i=>`你是 Coding Agent。读 llmwiki/PRD.md、llmwiki/TechSpec.md、llmwiki/tasks.json，逐个完成全部 coding 任务：在 runtime/ 目录下真实创建代码文件（runtime/index.html 必须存在）并用 node 运行能跑的验证。每完成一个任务，把 llmwiki/tasks.json 里该 task 加 "status":"done"。遵守 TechSpec 文件结构，零外部依赖，浅色现代风格。完成后回执 [STATUS]/[CHANGES]/[TESTS]。`,
  deliverable:'代码 + tasks.json(status=done)',
  accept:d=>{const idx=findIndexHtml(path.join(d,'runtime'));let all=true,n=0;try{const t=JSON.parse(rf(path.join(d,'llmwiki'),'tasks.json'));n=t.length;all=t.every(x=>x.status==='done')}catch(e){all=false}
    return{pass:!!idx&&all,detail:`入口页:${idx||'未找到'} · 任务done:${all?`全部${n}`:'否(未逐个标记)'}`}}},
 {id:'qa',name:'QA 验证',owner:'QA Agent',entry:'开发验收通过（全部任务 done）',
  prompt:i=>`你是 QA/Review Agent（只读代码，可用 node 运行验证，禁止修改代码文件）。对照 PRD.md 验收标准和 tasks.json 逐项检查，能运行的一律真实运行。写 llmwiki/QA-Report.md（中文：逐项 通过/未通过+证据，结论行必须含 PASS、PARTIAL 或 FAIL）。`,
  deliverable:'QA-Report.md',
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'QA-Report.md')||'';return{pass:c.length>200&&/PASS|PARTIAL|FAIL/.test(c),detail:`${c.length}字 · 结论:${(c.match(/PASS|PARTIAL|FAIL/g)||[]).join(',')}`}}},
 {id:'delivery',name:'交付',owner:'DevOps Agent',entry:'QA 结论为 PASS/PARTIAL',
  prompt:i=>`你是 DevOps Agent。git add -A && git commit -m "delivery v1.0.0"（无 .git 先 git init 并 config 本地身份）。写 llmwiki/DELIVERY.md（中文：交付清单/如何运行/已知限制/版本）。不改代码。`,
  deliverable:'DELIVERY.md + git 提交',
  accept:d=>{const c=rf(path.join(d,'llmwiki'),'DELIVERY.md');let commits='';try{commits=execSync('git -C '+d+' log --oneline',{encoding:'utf8',env:ENV}).trim()}catch(e){}
    return{pass:!!c&&commits.includes('delivery'),detail:`DELIVERY.md:${!!c} · git提交:${commits.split('\n').length} 条`}}},
];

function claudeStream(prompt,cwd,onEvent,onDone){
  const p=spawn('claude',['-p',prompt,'--output-format','stream-json','--verbose',
    '--permission-mode','acceptEdits',
    '--allowedTools','Read Write Edit Bash(node *) Bash(ls *) Bash(cat *) Bash(git *) Bash(mkdir *)',
    '--max-turns','30'],{cwd,env:ENV});
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
    if(st.isDirectory()&&['llmwiki','runtime','loop','skills','plugins'].includes(f)){
      out.push({name:f,size:'dir',type:'dir'});
      for(const g of fs.readdirSync(p)){if(g==='.git')continue;const q=path.join(p,g);const st2=fs.statSync(q);
        out.push({name:f+'/'+g,size:st2.isDirectory()?'dir':st2.size+'B',type:st2.isDirectory()?'dir':path.extname(g)})}
    }else out.push({name:f,size:st.isDirectory()?'dir':st.size+'B',type:st.isDirectory()?'dir':path.extname(f)});
  }
  return out;
}
function flowNodes(){return run&&run.flow==='fix'?FIXNODES:(run&&run.flow==='iterate'?ITERNODES:NODES)}
function nodeState(){return flowNodes().map((n,i)=>({id:n.id,name:n.name,owner:n.owner,entry:n.entry,deliverable:n.deliverable,status:run.nodeStatus[i],acceptDetail:run.acceptDetails[i]||null}))}
function persist(){if(run)fs.writeFileSync(path.join(run.dir,'nodes.json'),JSON.stringify({idea:run.idea,flow:run.flow,nodeStatus:run.nodeStatus,acceptDetails:run.acceptDetails,ts:Date.now()},null,1))}
function bootState(){ // 服务重启后从磁盘恢复节点状态（防刷新/重启丢进度）
  try{
    const runs=fs.readdirSync(RUNDIR).filter(d=>d.startsWith('run-')).sort();
    const last=runs[runs.length-1];if(!last)return;
    const f=rf(path.join(RUNDIR,last),'nodes.json');if(!f)return;
    const st=JSON.parse(f);
    run={dir:path.join(RUNDIR,last),idea:st.idea,flow:st.flow||'build',stage:null,nodeStatus:st.nodeStatus,acceptDetails:st.acceptDetails||[],events:[],artifacts:listArtifacts(path.join(RUNDIR,last)),done:!st.nodeStatus.includes('blocked')&&st.nodeStatus[st.nodeStatus.length-1]==='done',resumed:true};
  }catch(e){}
}

function runFrom(idx,res){
  // 从第 idx 个节点起执行（重试入口也走这里）
  const emit=e=>{run.events.push(e);logLoop(run.dir,e);if(res)W(res,e)};
  run.executing=true;
  const step=()=>{
    if(idx>=flowNodes().length){run.executing=false;run.done=true;persist();emit({type:'all_done',text:'🏁 全部节点验收通过 — 产物已就绪'});if(res)res.end();return}
    const n=flowNodes()[idx];
    run.stage=n.id;run.nodeStatus[idx]='running';persist();
    emit({type:'node_start',node:n.id,name:n.name,owner:n.owner,entry:n.entry,deliverable:n.deliverable});
    if(!n.prompt){ // kickoff：无执行直接验收
      const a=n.accept(run.dir);finishNode(a);return;
    }
    const cwd=(run.flow==='fix'&&['fix','regression'].includes(n.id)&&run.repo)?run.repo:run.dir;
    claudeStream(n.prompt(run.idea),cwd,ev=>emit(ev),summary=>{
      emit({type:'node_exec_done',node:n.id,text:(summary||'(无回执)').slice(0,500)});
      const a=n.accept(run.dir);finishNode(a);
    });
    function finishNode(a){
      run.acceptDetails[idx]=`${a.pass?'✅':'⛔'} ${a.detail}`;
      run.nodeStatus[idx]=a.pass?'done':'blocked';
      run.artifacts=listArtifacts(run.dir);persist();
      emit({type:'node_check',node:n.id,pass:a.pass,detail:a.detail,deliverable:n.deliverable});
      if(!a.pass){run.executing=false;emit({type:'pipeline_blocked',node:n.id,text:`⛔ 节点「${n.name}」验收未过，流水线已停止 — 修正后可重试本节点`});if(res)res.end();return}
      idx++;setTimeout(step,600);
    }
  };
  step();
}

http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,'factory.html')))}
  if(req.method==='GET'&&req.url.startsWith('/preview/')){
    if(!run)return res.writeHead(404).end();
    let rel=decodeURIComponent(req.url.slice(9))||'';
    let file=path.join(run.dir,rel);
    if(!rel||!fs.existsSync(file)||fs.statSync(file).isDirectory()){const idx=findIndexHtml(path.join(run.dir,'runtime'))||findIndexHtml(run.dir);if(!idx){res.writeHead(404);return res.end('404')}file=path.join(run.dir,idx)}
    try{return res.end(fs.readFileSync(file))}catch(e){res.writeHead(404);return res.end('404')}
  }
  if(req.method==='GET'&&req.url==='/api/state'){
    return j(res,200,{run:run?{idea:run.idea,flow:run.flow,stage:run.stage,done:run.done,dir:run.dir,events:run.events.slice(-300),artifacts:run.artifacts,nodes:nodeState()}:null});
  }
  if(req.method==='GET'&&req.url.startsWith('/api/file?')){
    const name=new URL(req.url,'http://x').searchParams.get('name');
    if(!run)return j(res,400,{});
    try{return j(res,200,{content:fs.readFileSync(path.join(run.dir,name),'utf8').slice(0,8000)})}catch(e){return j(res,404,{})}
  }
  // ===== 项目 CRUD =====
  if(req.method==='GET'&&req.url==='/api/runs'){
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
    return j(res,200,{runs:list,active:run&&!run.done?run.dir&&path.basename(run.dir):null});
  }
  if(req.method==='POST'&&req.url==='/api/runs/delete'){
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const id=(JSON.parse(b||'{}').id||'').replace(/[\/..]/g,'');
      const p=path.join(RUNDIR,id);
      if(!id||!fs.existsSync(p)||!p.startsWith(RUNDIR))return j(res,400,{error:'bad id'});
      if(run&&run.dir===p&&run.executing)return j(res,409,{error:'正在执行的任务不可删除'});
      fs.rmSync(p,{recursive:true});
      if(run&&run.dir===p){run=null; // 当前任务被删 → 开发任务清零
        try{fs.rmSync('/tmp/.factory-active',{force:true})}catch(e){}}
      return j(res,200,{ok:true,clearedActive:true});
    });
    return;
  }
  if(req.method==='POST'&&req.url==='/api/runs/rollback'){
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
  if(req.method==='POST'&&req.url==='/api/runs/iterate'){
    let b='';req.on('data',c=>b+=c);req.on('end',()=>{
      const {id='',idea=''}=JSON.parse(b||'{}');
      const parent=path.join(RUNDIR,id.replace(/[\/..]/g,''));
      const repo=findIndexHtmlRoot(parent);
      if(!repo)return j(res,400,{error:'父项目无产品代码，不能迭代'});
      if(run&&!run.done)return j(res,409,{error:'factory busy'});
      if(!idea.trim())return j(res,400,{error:'empty idea'});
      const dir=path.join(RUNDIR,'run-'+Date.now());
      scaffold(dir,'iterate',idea,repo);
      run={dir,idea,flow:'iterate',repo,stage:null,nodeStatus:ITERNODES.map(_=>'pending'),acceptDetails:[],events:[],artifacts:[],done:false};
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
      run.events.push({type:'flow',flow:'iterate',text:'🔁 迭代开发流（基于 '+id+' 的产品，仓库: '+repo+'）'});
      W(res,run.events[run.events.length-1]);
      runFrom(0,res);
    });
    return;
  }
  if(req.method==='POST'&&req.url==='/api/mission'){
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      if(run&&!run.done)return j(res,409,{error:'factory busy'});
      const idea=(JSON.parse(body||'{}').idea||'').trim();
      if(!idea)return j(res,400,{error:'empty idea'});
      const cls=classify(idea);
      if(cls.flow==='research')return j(res,422,{error:cls.reason});
      let dir=path.join(RUNDIR,(cls.flow==='fix'?'fix-':'run-')+Date.now());
      let repo=null;
      if(cls.flow==='fix'){repo=extractPath(idea);if(!repo)return j(res,422,{error:'修复流需要带目标仓库绝对路径（如 /root/xxx 的问题描述），未识别到有效目录'});}
      scaffold(dir,cls.flow,idea,repo);
      run={dir,idea,flow:cls.flow,repo,stage:null,nodeStatus:(cls.flow==='fix'?FIXNODES:NODES).map(_=>'pending'),acceptDetails:[],events:[],artifacts:[],done:false};
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
      run.events.push({type:'flow',flow:cls.flow,text:cls.flow==='fix'?'🔧 运维修复流（工作区绑定: '+dir+'）':'🟢 立项开发流'});
      W(res,run.events[run.events.length-1]);
      runFrom(0,res);
    });
    return;
  }
  if(req.method==='POST'&&req.url==='/api/retry'){ // 重试被阻断的节点
    if(!run)return j(res,400,{error:'no run'});
    const idx=run.nodeStatus.indexOf('blocked');
    if(idx<0)return j(res,400,{error:'no blocked node'});
    res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8'});
    run.events.push({type:'node_start',node:flowNodes()[idx].id,name:'人工重试',text:'👤 人工触发重试被阻断节点'});
    runFrom(idx,res);
    return;
  }
  res.writeHead(404);res.end();
}).listen(PORT,'0.0.0.0',()=>{bootState();console.log('factory v2 on',PORT)});
