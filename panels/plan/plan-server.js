// Idea Plan 分析台 v1 —— 会话/轮次协议（单一真源=磁盘，逐轮只增不改）
// 端口 8792 · 独立服务，零耦合工厂（GO 仅提交立项池，立项由工厂 from-plan 拉起并回写 spawnedRun）
const http=require('http'),fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const PORT=process.env.PORT||8792;
const ADIR=process.env.ANALYSES||'/root/.dsh/DS-AF/analyses';
const FACTORY=process.env.FACTORY_URL||'http://127.0.0.1:8794'; // 工厂地址（转修复/转升级服务端代呼，免 CORS）
const ENV={...process.env,PATH:'/home/administrator/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin'};
fs.mkdirSync(ADIR,{recursive:true});

/* ---------- 磁盘基元 ---------- */
const rf=(d,f)=>{try{return fs.readFileSync(path.join(d,f),'utf8')}catch(e){return null}};
const log=(d,ev)=>{try{fs.appendFileSync(path.join(d,'events.jsonl'),JSON.stringify({ts:Date.now(),...ev})+'\n')}catch(e){}};
function readMeta(id){const d=path.join(ADIR,id);const m=rf(d,'meta.json');return m?{dir:d,meta:JSON.parse(m)}:null}
function writeMeta(d,meta){meta.updated=new Date().toISOString();fs.writeFileSync(path.join(d,'meta.json'),JSON.stringify(meta,null,1))}
function listAnalyses(){try{return fs.readdirSync(ADIR).filter(d=>d.startsWith('an-')).sort().reverse()
  .map(id=>{const m=rf(path.join(ADIR,id),'meta.json');if(!m)return null;const j=JSON.parse(m);
    return{id,idea:j.idea.slice(0,80),state:j.state,round:j.round,updated:j.updated}}).filter(Boolean)}catch(e){return[]}}

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
  return `你是 Idea Plan 分析 Agent，工作目录即本分析会话目录（磁盘是唯一真源，逐轮只增不改）。

## 任务（第 ${round} 轮）
读 meta.json、rounds/ 下全部历史轮次（r*-in.json 是人的拍板输入，r*-out.md 是往轮分析）、
活文档 IDEA.md / RESEARCH.md / BRIEF.md（不存在则本轮创建/更新）、materials/ 下人喂的料。
然后写出 rounds/r${String(round).padStart(3,'0')}-out.md，并同步更新活文档。

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
    const{idea}=await body(req);
    if(!idea||idea.trim().length<5)return json(res,422,{error:'想法太短（≥5 字）'});
    const id='an-'+Date.now();const d=path.join(ADIR,id);
    fs.mkdirSync(path.join(d,'rounds'),{recursive:true});fs.mkdirSync(path.join(d,'materials'));
    const meta={id,idea:idea.trim(),state:'open',round:1,created:new Date().toISOString(),updated:null,spawnedRun:null};
    writeMeta(d,meta);
    fs.writeFileSync(path.join(d,'rounds','r001-in.json'),JSON.stringify({type:'idea',text:idea.trim()},null,1));
    log(d,{ev:'created',idea:idea.trim().slice(0,80)});
    runRound(id);
    return json(res,200,{id});
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
    const{decision,note}=await body(req);const s=readMeta(m[1]);
    if(!s)return json(res,404,{error:'会话不存在'});
    if(!['go','no-go','park','withdraw'].includes(decision))return json(res,422,{error:'decision 须为 go|no-go|park|withdraw'});
    if(running.has(m[1]))return json(res,409,{error:'本轮分析进行中，请稍候'});
    if(decision==='go'){
      if(!['awaiting','open'].includes(s.meta.state))return json(res,400,{error:'当前状态 '+s.meta.state+' 不能拍板 GO（open/awaiting 均可：收敛后正常拍板，或分析中强制提交）'});
      s.meta.state='go';s.meta.spawnedRun=null; // GO=提交立项池；真正建 run 由工厂「选话题立项/转修复/转升级」触发并回写 spawnedRun
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
      return json(res,r.status,await r.json().catch(()=>({})));
    }catch(e){return json(res,502,{error:'工厂不可达: '+(e.message||'')})}
  }
  json(res,404,{error:'not found'});
});
srv.listen(PORT,()=>console.log('idea-plan on :'+PORT+' analyses='+ADIR));
