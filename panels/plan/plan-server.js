// Idea Plan 分析台 v1.1 —— 会话/轮次协议（单一真源=磁盘，逐轮只增不改）
// 端口 8792 · 独立服务，零耦合工厂（GO 仅提交立项池，立项由工厂 from-plan 拉起并回写 spawnedRun）
// v1.1：话题目录归属（analyses/<topic>/an-*，杜绝无归属漂移会话）+ 历史话题续接（parent 注入父成果，不从零立项）
const http=require('http'),fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const PORT=process.env.PORT||8792;
const ADIR=process.env.ANALYSES||'/root/.dsh/ds-af/analyses';
const FACTORY=process.env.FACTORY_URL||'http://127.0.0.1:8794'; // 工厂地址（转修复/转升级服务端代呼，免 CORS）
const ENV={...process.env,PATH:'/home/administrator/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin'};
fs.mkdirSync(ADIR,{recursive:true});

/* ---------- 磁盘基元 ---------- */
const rf=(d,f)=>{try{return fs.readFileSync(path.join(d,f),'utf8')}catch(e){return null}};
const log=(d,ev)=>{try{fs.appendFileSync(path.join(d,'events.jsonl'),JSON.stringify({ts:Date.now(),...ev})+'\n')}catch(e){}};
/* ---------- 话题目录基元（v1.1：会话挂 analyses/<topic>/an-*；根级 an-* = 历史未分组） ---------- */
const NO_TOPIC='未分组';
function topicDirs(){try{return fs.readdirSync(ADIR,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith('an-')).map(e=>e.name)}catch(e){return[]}}
function readMeta(id){ // 先根级（历史未分组）后各话题目录逐层找
  if(!/^an-[\w-]+$/.test(id))return null;
  for(const base of [ADIR,...topicDirs().map(t=>path.join(ADIR,t))]){
    const d=path.join(base,id);const m=rf(d,'meta.json');if(m)return{dir:d,meta:JSON.parse(m)}}
  return null}
function writeMeta(d,meta){meta.updated=new Date().toISOString();fs.writeFileSync(path.join(d,'meta.json'),JSON.stringify(meta,null,1))}
function listAnalyses(){
  const out=[];
  const push=(id,dir,topic)=>{const m=rf(dir,'meta.json');if(!m)return;let j;try{j=JSON.parse(m)}catch(e){return}
    out.push({id,topic,idea:j.idea.slice(0,80),state:j.state,round:j.round,updated:j.updated,
      submitMode:j.submitMode||'build',spawnedRuns:Array.isArray(j.spawnedRuns)?j.spawnedRuns.length:0,parent:j.parent||null})};
  try{
    for(const id of fs.readdirSync(ADIR).filter(d=>d.startsWith('an-')))push(id,path.join(ADIR,id),NO_TOPIC);
    for(const t of topicDirs())for(const id of fs.readdirSync(path.join(ADIR,t)).filter(d=>d.startsWith('an-')))push(id,path.join(ADIR,t,id),t);
  }catch(e){}
  return out.sort((a,b)=>(b.updated||'').localeCompare(a.updated||''))}

/* ---------- 历史防重复立项（近 10 条注入 prompt） ---------- */
function historyBlock(curId){
  const h=listAnalyses().filter(a=>a.id!==curId).slice(0,10);
  if(!h.length)return '（无历史分析）';
  return h.map(a=>`- [${a.state}] ${a.idea}`).join('\n')+'\n若本轮想法与上述任何一条相似，必须在 out.md 中明确说明差异，否则不得通过。';
}

/* ---------- Agent 轮次执行 ---------- */
const running=new Set(); // 会话 id → 轮进行中（防重入）
function agentStream(prompt,cwd,onEvent,onDone){
  const p=spawn(process.env.PLAN_AGENT_CMD||'claude',['-p',prompt,'--output-format','stream-json','--verbose',
    '--permission-mode','acceptEdits',
    '--allowedTools','Read Write Edit Bash(ls *) Bash(cat *) Bash(mkdir *) WebSearch WebFetch',
    '--max-turns','40'],{cwd,env:ENV});
  let buf='',summary='';
  p.stdout.on('data',d=>{buf+=d;let i;
    while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
      if(!line||line.startsWith('['))continue;let e;try{e=JSON.parse(line)}catch{continue}
      if(e.type==='assistant')for(const c of e.message.content){
        if(c.type==='tool_use')onEvent({type:'tool',tool:c.name,brief:briefOf(c.name,c.input||{})});
        else if(c.type==='text'&&c.text.trim()){summary=c.text.slice(0,400);onEvent({type:'text',text:c.text.slice(0,600)})}}
      else if(e.type==='result')onEvent({type:'meta',status:e.subtype,turns:e.num_turns})}});
  p.on('error',e=>onDone('spawn失败:'+e.message));
  p.on('close',()=>onDone(summary));
}
const briefOf=(n,inp)=>n==='Bash'?'$ '+(inp.command||'').slice(0,80):n==='WebSearch'?'🔍 '+(inp.query||'').slice(0,60):n==='WebFetch'?'🌐 '+(inp.url||'').slice(0,60):n==='Read'?'读取 '+inp.file_path:n==='Write'?'写出 '+inp.file_path:n;

function roundPrompt(meta,round){
  const parentBlock=meta.parent?`

## 续接背景
本会话续接自父话题 ${meta.parent}（materials/parent-BRIEF.md 与 materials/parent-rounds.md 是其已交付成果）。
必须在父话题成果的基础上继续分析研究（如二次开发、升级方向），不得从零重复立项或重复父话题已完成的论证。`:'';
  return `你是 Idea Plan 分析 Agent，工作目录即本分析会话目录（磁盘是唯一真源，逐轮只增不改）。

## 任务（第 ${round} 轮）
读 meta.json、rounds/ 下全部历史轮次（r*-in.json 是人的拍板输入，r*-out.md 是往轮分析）、
活文档 IDEA.md / RESEARCH.md / BRIEF.md（不存在则本轮创建/更新）、materials/ 下人喂的料。
然后写出 rounds/r${String(round).padStart(3,'0')}-out.md，并同步更新活文档。
${parentBlock}

## 历史分析（近 10 条，防重复立项）
${historyBlock(meta.id)}

## 输出二态（必须居其一）
1. 仍有决策点 → out.md 含「## 决策点表」markdown 表（列：#/决策点/选项/推荐/依据），等下一轮人拍板；
2. 已收敛 → out.md 含单独一行「状态:收敛」+「## BRIEF 结论」，并定稿 BRIEF.md。
除 out.md 与三个活文档外不得写其他文件。`;
}

function runRound(id){
  const s=readMeta(id);if(!s)return;
  const{dir,meta}=s;const round=meta.round;
  running.add(id);log(dir,{ev:'round_start',round});
  writeMeta(dir,meta); // updated
  agentStream(roundPrompt(meta,round),dir,ev=>log(dir,{ev:'agent',round,...ev}),summary=>{
    running.delete(id);
    const out=rf(dir,path.join('rounds',`r${String(round).padStart(3,'0')}-out.md`));
    const converged=out&&/(^|\n)\s*状态[:：]\s*收敛/.test(out);
    meta.state=converged?'awaiting':'open';
    writeMeta(dir,meta);log(dir,{ev:'round_done',round,state:meta.state,summary:(summary||'').slice(0,200)});
  });
}

/* ---------- HTTP ---------- */
const json=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(obj))};
const body=req=>new Promise(r=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{try{r(JSON.parse(b||'{}'))}catch(e){r({})}})});

const srv=http.createServer(async(req,res)=>{
  const u=req.url.split('?')[0];
  if(req.method==='GET'&&(u==='/'||u==='/plan.html'))
    return res.end(fs.readFileSync(path.join(__dirname,'plan.html')));
  if(req.method==='GET'&&u==='/api/analyses')return json(res,200,{analyses:listAnalyses()});
  let m;
  if(req.method==='GET'&&(m=u.match(/^\/api\/analyses\/(an-[\w-]+)$/))){
    const s=readMeta(m[1]);if(!s)return json(res,404,{error:'会话不存在'});
    const rounds={};
    try{for(const f of fs.readdirSync(path.join(s.dir,'rounds')).sort())
      rounds[f]=rf(s.dir,path.join('rounds',f))||''}catch(e){}
    const docs={IDEA:rf(s.dir,'IDEA.md')||'',RESEARCH:rf(s.dir,'RESEARCH.md')||'',BRIEF:rf(s.dir,'BRIEF.md')||''};
    const mats=[];try{for(const f of fs.readdirSync(path.join(s.dir,'materials')))mats.push(f)}catch(e){}
    return json(res,200,{meta:s.meta,rounds,docs,materials:mats,running:running.has(m[1])});
  }
  if(req.method==='POST'&&u==='/api/new'){
    const{idea,topic,parent}=await body(req);
    if(!idea||idea.trim().length<5)return json(res,422,{error:'想法太短（≥5 字）'});
    // v1.1：归属必填 —— 须带 topic（选已有或新建话题目录），或带 parent 续接（继承父话题目录）
    let p=null;
    if(parent){p=readMeta(parent);if(!p)return json(res,422,{error:'父话题 '+parent+' 不存在，无法续接'})}
    let topicName,baseDir;
    if(p){topicName=p.meta.topic||NO_TOPIC;baseDir=path.dirname(p.dir)} // 续接：落父话题同目录
    else{
      const t=String(topic||'').trim();
      if(!t)return json(res,422,{error:'新建会话须指定话题目录（topic：选已有或新建），不能无归属漂移'});
      if(t===NO_TOPIC)return json(res,422,{error:'「未分组」是历史老会话的保留桶，不可作为新话题目录 — 请为会话起一个真实话题名'});
      topicName=t.replace(/[\\/:*?"<>|]+/g,'-').replace(/\.\./g,'').trim().slice(0,40);
      if(!topicName)return json(res,422,{error:'话题目录名非法'});
      baseDir=path.join(ADIR,topicName);fs.mkdirSync(baseDir,{recursive:true});
    }
    const id='an-'+Date.now();const d=path.join(baseDir,id);
    fs.mkdirSync(path.join(d,'rounds'),{recursive:true});fs.mkdirSync(path.join(d,'materials'));
    if(p){ // 续接：父话题成果注入 materials/（BRIEF 定稿 + 全部轮次结论），分析从成果接着走
      const brief=rf(p.dir,'BRIEF.md');
      if(brief)fs.writeFileSync(path.join(d,'materials','parent-BRIEF.md'),brief);
      const outs=[];
      try{for(const f of fs.readdirSync(path.join(p.dir,'rounds')).sort())
        if(/r\d+-out\.md$/.test(f))outs.push('### '+f+'\n'+(rf(p.dir,path.join('rounds',f))||''))}catch(e){}
      if(outs.length)fs.writeFileSync(path.join(d,'materials','parent-rounds.md'),outs.join('\n\n'));
    }
    const meta={id,topic:topicName,idea:idea.trim(),state:'open',round:1,created:new Date().toISOString(),updated:null,
      spawnedRun:null,parent:p?p.meta.id:null};
    writeMeta(d,meta);
    fs.writeFileSync(path.join(d,'rounds','r001-in.json'),JSON.stringify(p?
      {type:'continue',parent:p.meta.id,text:idea.trim()}:{type:'idea',text:idea.trim()},null,1));
    log(d,{ev:'created',topic:topicName,parent:p?p.meta.id:null,idea:idea.trim().slice(0,80)});
    runRound(id);
    return json(res,200,{id,topic:topicName});
  }
  if(req.method==='POST'&&(m=u.match(/^\/api\/analyses\/(an-[\w-]+)\/reply$/))){
    const p=await body(req);const s=readMeta(m[1]);
    if(!s)return json(res,404,{error:'会话不存在'});
    if(running.has(m[1]))return json(res,409,{error:'本轮分析进行中，请稍候'});
    const{answers,message,materials}=p;
    if(Array.isArray(materials))for(const f of materials){
      if(!f.filename||/[\/\\]|\.\./.test(f.filename)||typeof f.content!=='string')
        return json(res,400,{error:'materials.filename 非法（禁止路径分隔符/../）或 content 缺失'});
      fs.mkdirSync(path.join(s.dir,'materials'),{recursive:true});
      fs.writeFileSync(path.join(s.dir,'materials',f.filename),f.content);
      log(s.dir,{ev:'material',filename:f.filename});
    }
    if(!message&&!answers||(answers&&typeof answers!=='object'))return json(res,422,{error:'reply 需 answers 或 message'});
    const revived=['no-go','park'].includes(s.meta.state);
    const round=s.meta.round+1;
    fs.writeFileSync(path.join(s.dir,'rounds',`r${String(round).padStart(3,'0')}-in.json`),
      JSON.stringify({type:revived?'revive':'reply',answers:answers||{},message:message||''},null,1));
    s.meta.round=round;s.meta.state='open';
    if(revived)log(s.dir,{ev:'revive',round});
    writeMeta(s.dir,s.meta);
    runRound(m[1]);
    return json(res,200,{ok:true,round,state:'open'});
  }
  if(req.method==='POST'&&(m=u.match(/^\/api\/analyses\/(an-[\w-]+)\/decide$/))){
    const{decision,note,submitMode}=await body(req);const s=readMeta(m[1]);
    if(!s)return json(res,404,{error:'会话不存在'});
    if(!['go','no-go','park','withdraw'].includes(decision))return json(res,422,{error:'decision 须为 go|no-go|park|withdraw'});
    if(running.has(m[1]))return json(res,409,{error:'本轮分析进行中，请稍候'});
    if(decision==='go'){ // 全态可 GO：open/awaiting 正常提交；no-go/park 复活提交（补 revive 日志，不续轮）；go/spawnedRun 再次提交（spawnedRun 保留不覆盖）
      if(['no-go','park'].includes(s.meta.state))log(s.dir,{ev:'revive',round:s.meta.round});
      s.meta.state='go';s.meta.submitMode=submitMode==='fix'?'fix':'build'; // 建 run 由工厂「选话题立项」或 dispatch(fix) 触发并回写 spawnedRun
      writeMeta(s.dir,s.meta);log(s.dir,{ev:'decide',decision,note:note||''});
      return json(res,200,{ok:true,state:'go'});
    }
    if(decision==='withdraw'){ // 撤回拍板：已提交但工厂尚未选走 → 回到待拍板
      if(s.meta.state!=='go')return json(res,400,{error:'仅「已提交」状态可撤回'});
      if(s.meta.spawnedRun)return json(res,409,{error:'工厂已立项 run '+s.meta.spawnedRun+'，不能撤回（先到工厂处理该 run）'});
      s.meta.state='awaiting';writeMeta(s.dir,s.meta);
      log(s.dir,{ev:'decide',decision,note:note||''});
      return json(res,200,{ok:true,state:'awaiting'});
    }
    // no-go / park：任意非在跑状态可用（不必等收敛；已被工厂选走的除外）
    if(s.meta.spawnedRun)return json(res,409,{error:'工厂已立项 run '+s.meta.spawnedRun+'，不能否决/搁置（先到工厂处理该 run）'});
    s.meta.state=decision;writeMeta(s.dir,s.meta);
    log(s.dir,{ev:'decide',decision,note:note||''});
    return json(res,200,{ok:true,state:decision});
  }
  if(req.method==='POST'&&(m=u.match(/^\/api\/analyses\/(an-[\w-]+)\/rename$/))){ // 话题改名：只动 meta.idea，轮次与其余 meta 字段不变
    const{title}=await body(req);const s=readMeta(m[1]);
    if(!s)return json(res,404,{error:'会话不存在'});
    const t=(title||'').trim();
    if(!t||t.length>80)return json(res,422,{error:'title 须为 1–80 字'});
    s.meta.idea=t;writeMeta(s.dir,s.meta); // writeMeta 照常刷新 updated
    log(s.dir,{ev:'rename',title:t});
    return json(res,200,{ok:true,idea:t});
  }
  if(req.method==='POST'&&(m=u.match(/^\/api\/analyses\/(an-[\w-]+)\/delete$/))){ // 硬删：磁盘唯一真源，删了即没
    const s=readMeta(m[1]);
    if(!s)return json(res,404,{error:'会话不存在'});
    if(running.has(m[1]))return json(res,409,{error:'本轮分析进行中，不能删除'});
    if(s.meta.spawnedRun)return json(res,409,{error:'工厂已立项 run '+s.meta.spawnedRun+'，不能删除（先到工厂删除该 run 或另择话题）'});
    fs.rmSync(s.dir,{recursive:true,force:true});
    return json(res,200,{ok:true,deleted:m[1]});
  }
  if(req.method==='GET'&&u==='/api/factory/projects'){ // 代理工厂项目列表（转升级选择器数据源）
    try{const r=await fetch(FACTORY+'/api/projects');return json(res,r.status,await r.json())}
    catch(e){return json(res,502,{error:'工厂不可达: '+(e.message||'')})}
  }
  if(req.method==='POST'&&u==='/api/dispatch'){ // 话题直通工厂：mode=fix(带目标仓)|iterate(带项目)
    const p=await body(req);const{mode='build',repo='',projectId=''}=p;
    if(!p.id||!/^an-[\w-]+$/.test(p.id))return json(res,422,{error:'id 非法'});
    const s=readMeta(p.id);if(!s)return json(res,404,{error:'会话不存在'});
    try{
      const r=await fetch(FACTORY+'/api/mission/from-plan',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({analysisDir:s.dir,mode,repo,projectId})});
      const j=await r.json().catch(()=>({}));
      if(mode==='fix'&&r.ok&&j.runId){ // fix 成功建 run：追加 spawnedRuns[] 历史（无则建；spawnedRun 首值保留不覆盖；build 模式仍由工厂回写，不改）
        if(!Array.isArray(s.meta.spawnedRuns))s.meta.spawnedRuns=[];
        s.meta.spawnedRuns.push(j.runId);
        writeMeta(s.dir,s.meta);log(s.dir,{ev:'dispatch',mode:'fix',runId:j.runId,repo:repo||''});
      }
      return json(res,r.status,j);
    }catch(e){return json(res,502,{error:'工厂不可达: '+(e.message||'')})}
  }
  json(res,404,{error:'not found'});
});
srv.listen(PORT,()=>console.log('idea-plan on :'+PORT+' analyses='+ADIR));
