// DSH 工作台 1.0 · Cockpit 总控服务（端口 8790）
// 架构：统一驾驶舱 → 四工作入口(Engineering=Factory v2 实挂) → DSH-Harness 后台 → 能力生态
const http=require('http'),{execSync}=require('child_process'),fs=require('fs'),path=require('path');
const PORT=8790;
const FACTORY='http://127.0.0.1:8794';
const ENV={...process.env,PATH:'/home/administrator/.hermes/node/bin:'+process.env.PATH};

async function fetchJson(url,ms=2000){
  return new Promise(r=>{const t=setTimeout(()=>r(null),ms);
    http.get(url,res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{clearTimeout(t);try{r(JSON.parse(b))}catch(e){r(null)}})})
      .on('error',()=>{clearTimeout(t);r(null)});});
}
function portUp(port){return new Promise(r=>{const rq=http.get({host:'127.0.0.1',port,path:'/'},res=>{res.resume();r(true)});rq.on('error',()=>r(false));rq.setTimeout(1500,()=>{rq.destroy();r(false)})})}

http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='GET'&&(req.url==='/'||req.url==='/index.html')){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
    return res.end(fs.readFileSync(path.join(__dirname,'workbench.html')));
  }
  if(req.method==='GET'&&req.url==='/api/overview'){
    const [factory, servers] = await Promise.all([
      fetchJson(FACTORY+'/api/state'),
      Promise.all([8791,8792,8793,8794,8795].map(p=>portUp(p))),
    ]);
    let runs=[];
    try{runs=fs.readdirSync('/root/.dsh/ds-af/runs').filter(d=>d.startsWith('run-')).sort().reverse().slice(0,6)}catch(e){}
    let claudeVer='';try{claudeVer=execSync('claude --version',{encoding:'utf8',env:ENV}).trim().split('\n')[0]}catch(e){claudeVer='未检出'}
    let pw='';try{pw=execSync('/home/administrator/.hermes/node/bin/npx playwright --version',{encoding:'utf8',env:ENV}).trim()}catch(e){pw='未检出'}
    const r=factory&&factory.run;
    const anyExec=factory&&Array.isArray(factory.runs)&&factory.runs.some(x=>x.executing); // 并发制：任一 run 在跑即忙
    return res.end(JSON.stringify({
      cockpit:{version:'1.0',ts:new Date().toISOString()},
      engineering:{
        live:servers[2],
        busy:anyExec||(r&&!r.done),
        done:r&&r.done,
        idea:r?r.idea:null,
        nodes:r?r.nodes:null,
        link:'http://23.27.169.181:8794',
      },
      services:[
        {port:8791,name:'编排回放 demo',up:servers[0]},
        {port:8792,name:'Idea Plan 分析台',up:servers[1]},
        {port:8793,name:'Vibe Coding Studio',up:servers[2]},
        {port:8794,name:'Engineering Factory v2',up:servers[3]},
        {port:8795,name:'ENG-UI-001 登录页样例',up:servers[4]},
      ],
      runs,
      runtime:{claude:claudeVer,playwright:pw},
      capabilities:['Claude Code Runtime','Playwright 视觉验证','Git 证据链','Skills 库(/root/.dsh/skills)','MCP 生态','节点验收硬闸','Task Contract 合同制','nodes.json 进度持久化'],
    }));
  }
  res.writeHead(404);res.end();
}).listen(PORT,'0.0.0.0',()=>console.log('workbench on',PORT));
