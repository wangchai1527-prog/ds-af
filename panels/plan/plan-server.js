// Idea Plan 分析台 v1.1 —— 会话/轮次协议（单一真源=磁盘，逐轮只增不改）
// 端口 8792 · 独立服务，零耦合工厂（GO 仅提交立项池，立项由工厂 from-plan 拉起并回写 spawnedRun）
// v1.1：话题目录归属（analyses/<topic>/an-*，杜绝无归属漂移会话）+ 历史话题续接（parent 注入父成果，不从零立项）
// v1.3：目录树对齐 DSH 语义（全局根 '/' + 系统目录黑名单 + hasChildren 真探测 + 目录增删收紧 /root 子树），
//       归属桶标签升级全路径 + 列表带磁盘桶 bucket（防「同磁盘桶不同侧栏组」分裂）—— 依据 BRIEF v1.3 / DIAGNOSIS §5
const http=require('http'),fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const PORT=process.env.PORT||8792;
const ADIR=process.env.ANALYSES||'/root/.dsh/ds-af/analyses';
const FACTORY=process.env.FACTORY_URL||'http://127.0.0.1:8794'; // 工厂地址（转修复/转升级服务端代呼，免 CORS）
const ENV={...process.env,PATH:'/home/administrator/.hermes/node/bin:/usr/local/bin:/usr/bin:/bin'};
fs.mkdirSync(ADIR,{recursive:true});

/* ---------- v1.4 图片通路限额（单一真源，前端提示文案与此对齐）：单张 ≤5MB · 单次 ≤4 张 · 每会话 ≤40 张 ---------- */
const IMG_MAX_BYTES=5*1024*1024,IMG_MAX_PER_REQ=4,IMG_MAX_PER_SESSION=40;
const IMG_EXT={'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','gif':'image/gif','webp':'image/webp'}; // 扩展名/mime 白名单（md 供文本材料复用读取端点）
const IMG_MAGIC={png:Buffer.from([0x89,0x50,0x4e,0x47]),jpg:Buffer.from([0xff,0xd8,0xff]),jpeg:Buffer.from([0xff,0xd8,0xff]),gif:Buffer.from([0x47,0x49,0x46])}; // 魔数抽验（防改扩展名伪装；webp 走 RIFF+WEBP 双验）

/* ---------- 磁盘基元 ---------- */
const rf=(d,f)=>{try{return fs.readFileSync(path.join(d,f),'utf8')}catch(e){return null}};
const log=(d,ev)=>{try{fs.appendFileSync(path.join(d,'events.jsonl'),JSON.stringify({ts:Date.now(),...ev})+'\n')}catch(e){}};
/* ---------- v1.4 图片接收：纯校验+解码（不落盘，可先于目录创建调用） ---------- */
function parseImages(images){
  if(images===undefined||images===null)return{imgs:[]};
  if(!Array.isArray(images))return{error:'images 须为数组'};
  if(!images.length)return{imgs:[]};
  if(images.length>IMG_MAX_PER_REQ)return{error:'单次最多提交 '+IMG_MAX_PER_REQ+' 张图片'};
  const imgs=[];
  for(const im of images){
    const orig=String((im&&im.filename)||'').slice(0,40); // 原文件名仅截 40 字符记日志备查（不信任、不落盘）
    const ext=String((im&&im.filename)||'').split('.').pop().toLowerCase();
    if(!IMG_EXT[ext])return{error:'图片仅支持 png/jpg/jpeg/gif/webp：'+(orig||'（未命名）')};
    let data=String((im&&im.data)||'').replace(/^data:image\/[\w.+-]+;base64,/,''); // dataURL 前缀允许携带，服务端剥
    let buf;try{buf=Buffer.from(data,'base64')}catch(e){return{error:'图片 base64 解码失败：'+orig}}
    if(!buf.length)return{error:'图片内容为空：'+orig};
    if(buf.length>IMG_MAX_BYTES)return{error:'单张图片不可超过 5MB：'+orig+'（'+(buf.length/1048576).toFixed(1)+'MB）'};
    const mag=IMG_MAGIC[ext];
    if(mag&&!buf.slice(0,mag.length).equals(mag))return{error:'图片内容与扩展名不符（魔数抽验失败）：'+orig};
    if(ext==='webp'&&(buf.slice(0,4).toString('latin1')!=='RIFF'||buf.slice(8,12).toString('latin1')!=='WEBP'))
      return{error:'图片内容与扩展名不符（魔数抽验失败）：'+orig};
    imgs.push({buf,ext,orig});
  }
  return{imgs};
}
/* ---------- v1.4 图片落盘：服务端统一改名 img-<YYYYMMDD-HHmmss>-<seq>.<ext>（不信任客户端原名） ---------- */
function storeImages(dir,imgs){
  if(!imgs.length)return{names:[]};
  const mdir=path.join(dir,'materials');
  try{fs.mkdirSync(mdir,{recursive:true})}catch(e){}
  let cnt=0;try{cnt=fs.readdirSync(mdir).filter(f=>f.startsWith('img-')).length}catch(e){}
  if(cnt+imgs.length>IMG_MAX_PER_SESSION)return{error:'每会话图片总数上限 '+IMG_MAX_PER_SESSION+' 张（已有 '+cnt+' 张），请清理 materials/ 后再贴'};
  const t=new Date(),p2=n=>String(n).padStart(2,'0');
  const stamp=''+t.getFullYear()+p2(t.getMonth()+1)+p2(t.getDate())+'-'+p2(t.getHours())+p2(t.getMinutes())+p2(t.getSeconds());
  const names=imgs.map((im,i)=>'img-'+stamp+'-'+p2(cnt+i+1)+'.'+im.ext); // 序号以现有 img- 数为基，同秒多请求不碰撞
  imgs.forEach((im,i)=>fs.writeFileSync(path.join(mdir,names[i]),im.buf));
  for(let i=0;i<imgs.length;i++)log(dir,{ev:'material',kind:'image',filename:names[i],bytes:imgs[i].buf.length,orig:imgs[i].orig});
  return{names};
}
/* ---------- 话题目录基元（v1.1：会话挂 analyses/<topic>/an-*；根级 an-* = 历史待整理） ---------- */
const NO_TOPIC='待整理'; // DSH 式：无归属存量统一进「待整理」桶，人工归位（PRD D4=C，不自动猜测）
// v1.3 目录树读写分层：读/选全局根放开（+系统目录黑名单）；增/删收紧 /root 子树 + 保护路径（BRIEF v1.3 D4-A）
const DIR_ROOT='/'; // 目录树选择器根（DSH「Select Workspace Directory」语义：全局根，非仅 Home）
const SYS_DIRS=new Set(['/proc','/sys','/dev','/run','/boot','/etc','/var','/usr','/lost+found']);
const WRITE_ROOT='/root'; // 目录增/删写域（读/选不受限）
const PROTECTED_SEGS=['.dsh','.claude','.git','.ssh','.config','.local']; // 保护路径段：任一段命中即拒增/删
const inBlack=p=>{for(const b of SYS_DIRS)if(p===b||p.startsWith(b+path.sep))return true;return false};
const dirLog=(op,p)=>{try{fs.appendFileSync(path.join(ADIR,'dir-ops.jsonl'),JSON.stringify({ts:new Date().toISOString(),op,path:p})+'\n')}catch(e){}};
const writeErr=p=>{ // 目录增/删安全校验（DIAGNOSIS §5.6：增/删收紧、保护路径、桶根与家目录本体不可动）
  if(p===WRITE_ROOT)return '不能对 '+WRITE_ROOT+' 本身做增/删';
  if(!p.startsWith(WRITE_ROOT+path.sep))return '目录增/删仅限 '+WRITE_ROOT+' 子树（浏览/选择全局放开）';
  if(p===ADIR||p.split(path.sep).some(s=>PROTECTED_SEGS.includes(s)))return '保护路径不可增/删：'+p;
  return null};
const kidDirs=p=>{try{return fs.readdirSync(p,{withFileTypes:true})
  .filter(e=>e.isDirectory()&&!['.git','.cache','.config','node_modules'].includes(e.name)&&!inBlack(path.join(p,e.name)))}catch(e){return[]}}; // v1.3.1：隐藏目录可见（/root/.dsh 等工作目录要能选），仅排除版本库/缓存类
const slugTopic=t=>String(t).replace(/[\\/:*?"<>|]+/g,'_').replace(/\.\./g,'').trim().slice(0,60);
function topicDirs(){try{return fs.readdirSync(ADIR,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith('an-')).map(e=>e.name)}catch(e){return[]}}
function readMeta(id){ // 先根级（历史待整理）后各话题目录逐层找
  if(!/^an-[\w-]+$/.test(id))return null;
  for(const base of [ADIR,...topicDirs().map(t=>path.join(ADIR,t))]){
    const d=path.join(base,id);const m=rf(d,'meta.json');if(m)return{dir:d,meta:JSON.parse(m)}}
  return null}
function writeMeta(d,meta){meta.updated=new Date().toISOString();fs.writeFileSync(path.join(d,'meta.json'),JSON.stringify(meta,null,1))}
function listAnalyses(){
  const out=[];
  // v1.3：带 bucket（磁盘桶目录名）——侧边栏按磁盘桶聚合（单一真源），防「同磁盘桶不同侧栏组」分裂（DIAGNOSIS R4）
  const push=(id,dir,topic,bucket)=>{const m=rf(dir,'meta.json');if(!m)return;let j;try{j=JSON.parse(m)}catch(e){return}
    out.push({id,topic,bucket,idea:j.idea.slice(0,80),state:j.state,round:j.round,updated:j.updated,
      submitMode:j.submitMode||'build',spawnedRuns:Array.isArray(j.spawnedRuns)?j.spawnedRuns.length:0,parent:j.parent||null})};
  try{
    for(const id of fs.readdirSync(ADIR).filter(d=>d.startsWith('an-')))push(id,path.join(ADIR,id),NO_TOPIC,NO_TOPIC);
    for(const t of topicDirs())for(const id of fs.readdirSync(path.join(ADIR,t)).filter(d=>d.startsWith('an-'))){
      const d=path.join(ADIR,t,id);const m=rf(d,'meta.json');
      push(id,d,m?(JSON.parse(m).topic||t):t,t)}
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
materials/ 下 img-* 图片是人提供的截图/设计稿/照片，必须用 Read 工具逐张查看并把图中信息纳入分析（UI 意图、数据、报错现场等），在 out.md 中引用所参考的图片文件名。
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
  if(req.method==='GET'&&(u==='/'||u==='/plan.html')) // no-store：防浏览器缓存旧版页面（「怎么还是没更新」根因）
    return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'})
      ,res.end(fs.readFileSync(path.join(__dirname,'plan.html')));
  if(req.method==='GET'&&u==='/favicon.ico')return res.writeHead(204).end(); // 浏览器自动请求，免 404 噪声
  if(req.method==='GET'&&u==='/api/analyses')return json(res,200,{analyses:listAnalyses()});
  let m;
  if(req.method==='GET'&&(m=u.match(/^\/api\/analyses\/(an-[\w-]+)$/))){
    const s=readMeta(m[1]);if(!s)return json(res,404,{error:'会话不存在'});
    const rounds={};
    try{for(const f of fs.readdirSync(path.join(s.dir,'rounds')).sort())
      rounds[f]=rf(s.dir,path.join('rounds',f))||''}catch(e){}
    const docs={IDEA:rf(s.dir,'IDEA.md')||'',RESEARCH:rf(s.dir,'RESEARCH.md')||'',BRIEF:rf(s.dir,'BRIEF.md')||''};
    const mats=[];try{for(const f of fs.readdirSync(path.join(s.dir,'materials')))mats.push(f)}catch(e){}
    let evs=[];try{evs=rf(s.dir,'events.jsonl').split('\n').filter(Boolean).slice(-100)
      .map(l=>{try{return JSON.parse(l)}catch(e){return null}}).filter(Boolean)}catch(e){}
    return json(res,200,{meta:s.meta,rounds,docs,materials:mats,running:running.has(m[1]),events:evs});
  }
  if(req.method==='GET'&&(m=u.match(/^\/api\/analyses\/(an-[\w-]+)\/materials\/([^\/]+)$/))){ // v1.4：材料读取端点（图片回显 + 文本材料复用）
    const s=readMeta(m[1]);if(!s)return json(res,404,{error:'会话不存在'});
    let file;try{file=decodeURIComponent(m[2])}catch(e){return json(res,400,{error:'文件名编码非法'})}
    if(/[\/\\]|\.\./.test(file))return json(res,400,{error:'文件名非法（禁止路径分隔符/../）'}); // 防逃逸（与 materials 文本写入同源校验）
    const fp=path.join(s.dir,'materials',file);
    let st;try{st=fs.statSync(fp)}catch(e){return json(res,404,{error:'文件不存在：'+file})}
    if(!st.isFile())return json(res,404,{error:'不是文件：'+file});
    const ext=file.split('.').pop().toLowerCase();
    const ct=IMG_EXT[ext]||(ext==='md'?'text/markdown; charset=utf-8':'application/octet-stream');
    const hdr={'Content-Type':ct};
    if(IMG_EXT[ext])hdr['Cache-Control']='public, max-age=86400'; // img-命名含时间戳+序号不重写，缓存安全
    return res.writeHead(200,hdr),res.end(fs.readFileSync(fp));
  }
  if(req.method==='POST'&&u==='/api/new'){
    const{idea,topic,parent,images}=await body(req);
    if(!idea||idea.trim().length<5)return json(res,422,{error:'想法太短（≥5 字）'});
    const pi=parseImages(images);if(pi.error)return json(res,400,{error:pi.error}); // v1.4：图片纯校验前置（失败不留会话目录残留）
    // v1.1：归属必填 —— 须带 topic（选已有或新建话题目录），或带 parent 续接（继承父话题目录）
    let p=null;
    if(parent){p=readMeta(parent);if(!p)return json(res,422,{error:'父话题 '+parent+' 不存在，无法续接'})}
    let topicName,baseDir;
    if(p){topicName=p.meta.topic||NO_TOPIC;baseDir=path.dirname(p.dir)} // 续接：落父话题同目录
    else{
      const t=String(topic||'').trim();
      if(!t)return json(res,422,{error:'新建会话须先选归属目录（topic），不能无归属漂移'});
      if(t===NO_TOPIC)return json(res,422,{error:'「待整理」是无归属存量的保留桶，不可作为归属 — 请先选一个真实目录'});
      topicName=t.slice(0,60);
      baseDir=path.join(ADIR,slugTopic(t));fs.mkdirSync(baseDir,{recursive:true}); // 磁盘桶名=净化 slug（label 含 / 时落单层桶）
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
    const si=storeImages(d,pi.imgs);if(si.error)return json(res,400,{error:si.error}); // v1.4：落盘（新会话目录刚建，总量闸天然不过界）
    const r1in=p?{type:'continue',parent:p.meta.id,text:idea.trim()}:{type:'idea',text:idea.trim()};
    if(si.names.length)r1in.images=si.names; // 只加字段：无图保持原结构（旧客户端/旧轮次零影响）
    fs.writeFileSync(path.join(d,'rounds','r001-in.json'),JSON.stringify(r1in,null,1));
    log(d,{ev:'created',topic:topicName,parent:p?p.meta.id:null,idea:idea.trim().slice(0,80)});
    runRound(id);
    return json(res,200,{id,topic:topicName});
  }
  if(req.method==='POST'&&(m=u.match(/^\/api\/analyses\/(an-[\w-]+)\/reply$/))){
    const p=await body(req);const s=readMeta(m[1]);
    if(!s)return json(res,404,{error:'会话不存在'});
    if(running.has(m[1]))return json(res,409,{error:'本轮分析进行中，请稍候'});
    const{answers,message,materials}=p;
    const pi=parseImages(p.images);if(pi.error)return json(res,400,{error:pi.error}); // v1.4：图片校验（纯校验，失败不落任何文件）
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
    const si=storeImages(s.dir,pi.imgs);if(si.error)return json(res,400,{error:si.error}); // v1.4：落盘后才写轮次输入（拒绝路径无残留）
    const rin={type:revived?'revive':'reply',answers:answers||{},message:message||''};
    if(si.names.length)rin.images=si.names; // 只加字段：无图保持原结构
    fs.writeFileSync(path.join(s.dir,'rounds',`r${String(round).padStart(3,'0')}-in.json`),
      JSON.stringify(rin,null,1));
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
  if(req.method==='GET'&&u.startsWith('/api/dirs')){ // v1.3 DSH 式目录树数据源：全局根 '/' + 系统目录黑名单 + hasChildren 真探测；防逃逸保留
    const q=new URL(req.url,'http://x').searchParams.get('base')||'';
    const base=path.resolve(DIR_ROOT,q||'.');
    if(DIR_ROOT!=='/'&&base!==DIR_ROOT&&!base.startsWith(DIR_ROOT+path.sep))return json(res,400,{error:'base 须位于 '+DIR_ROOT+' 之内'});
    if(inBlack(base))return json(res,400,{error:'base 在系统目录黑名单内（'+[...SYS_DIRS].join(' ')+'）'});
    let st;try{st=fs.statSync(base)}catch(e){return json(res,404,{error:'目录不存在'})}
    if(!st.isDirectory())return json(res,400,{error:'base 不是目录'});
    const dirs=kidDirs(base).slice(0,200)
      .map(e=>({name:e.name,hasChildren:kidDirs(path.join(base,e.name)).length>0})); // 真探测：叶子目录不再有假 ▸
    return json(res,200,{base:q||'',dirs});
  }
  if(req.method==='POST'&&u==='/api/dirs/mkdir'){ // v1.3 目录管理：树内新建子目录（写域收紧 /root 子树；操作写日志）
    const{base,name}=await body(req);
    const abs=path.resolve(String(base||''));
    const nm=String(name||'').trim();
    if(!nm||/[\\/]|\.\./.test(nm)||nm.startsWith('.'))return json(res,422,{error:'目录名非法（禁路径分隔符/../隐藏名）'});
    if(nm.length>60)return json(res,422,{error:'目录名过长（≤60 字）'});
    const we=writeErr(abs);if(we)return json(res,403,{error:we});
    let st;try{st=fs.statSync(abs)}catch(e){return json(res,404,{error:'父目录不存在：'+abs})}
    if(!st.isDirectory())return json(res,400,{error:'base 不是目录'});
    try{fs.mkdirSync(path.join(abs,nm))}catch(e){return json(res,409,{error:'创建失败：'+(e.message||'')})}
    dirLog('mkdir',path.join(abs,nm));
    return json(res,200,{ok:true,path:path.join(abs,nm)});
  }
  if(req.method==='POST'&&u==='/api/dirs/rmdir'){ // v1.3 目录管理：仅空目录可删 + 写域/保护路径校验；不可逆操作写日志
    const p=await body(req);
    const abs=path.resolve(String(p.path||''));
    const we=writeErr(abs);if(we)return json(res,403,{error:we});
    let st;try{st=fs.statSync(abs)}catch(e){return json(res,404,{error:'目录不存在：'+abs})}
    if(!st.isDirectory())return json(res,400,{error:'不是目录'});
    let entries;try{entries=fs.readdirSync(abs)}catch(e){return json(res,409,{error:'读取失败：'+(e.message||'')})}
    if(entries.length)return json(res,409,{error:'目录非空（'+entries.length+' 项），仅可删除空目录'});
    try{fs.rmdirSync(abs)}catch(e){return json(res,409,{error:'删除失败：'+(e.message||'')})}
    dirLog('rmdir',abs);
    return json(res,200,{ok:true});
  }
  if(req.method==='POST'&&(m=u.match(/^\/api\/analyses\/(an-[\w-]+)\/assign$/))){ // 归位/移动桶：待整理→目标目录（PRD D4=C 人工归位；不做自动猜测）
    const{topic}=await body(req);const s=readMeta(m[1]);
    if(!s)return json(res,404,{error:'会话不存在'});
    if(running.has(m[1]))return json(res,409,{error:'本轮分析进行中，不能归位'});
    const t=String(topic||'').trim();
    if(!t||t===NO_TOPIC)return json(res,422,{error:'归位须指定目标目录（不能归回「待整理」）'});
    const label=t.slice(0,60);
    const dstBase=path.join(ADIR,slugTopic(t));
    const dst=path.join(dstBase,m[1]);
    if(s.dir!==dst){ // 同桶归位幂等
      if(fs.existsSync(dst))return json(res,409,{error:'目标已存在同名会话目录'});
      fs.mkdirSync(dstBase,{recursive:true});fs.renameSync(s.dir,dst);
    }
    s.meta.topic=label;writeMeta(dst,s.meta);
    log(dst,{ev:'assign',topic:label});
    return json(res,200,{ok:true,topic:label});
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
      if(r.ok&&j.runId){ // dispatch 建 run 成功（fix 或 iterate）：追加 spawnedRuns[] 历史（无则建；spawnedRun 首值保留不覆盖；build 模式仍由工厂回写，不改）
        const fresh=readMeta(p.id),mm=fresh?fresh.meta:s.meta; // 重读防竞态：工厂 from-plan 已回写 spawnedRun，用请求初读的陈旧 meta 覆盖会抹掉它（残留可再立 build run）
        if(!Array.isArray(mm.spawnedRuns))mm.spawnedRuns=[];
        if(!mm.spawnedRuns.includes(j.runId))mm.spawnedRuns.push(j.runId);
        writeMeta(s.dir,mm);log(s.dir,{ev:'dispatch',mode,runId:j.runId,repo:repo||'',projectId:projectId||''});
      }
      return json(res,r.status,j);
    }catch(e){return json(res,502,{error:'工厂不可达: '+(e.message||'')})}
  }
  json(res,404,{error:'not found'});
});
srv.listen(PORT,()=>console.log('idea-plan on :'+PORT+' analyses='+ADIR));
