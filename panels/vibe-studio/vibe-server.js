// Vibe Coding Studio · 真引擎直播后端（claude CLI stream-json → NDJSON 流）
const http=require('http'),{spawn}=require('child_process'),fs=require('fs'),path=require('path');
const PORT=8793, LAB='/root/.dsh/DS-AF/samples/lab';
const ENV={...process.env,PATH:'/home/administrator/.hermes/node/bin:'+process.env.PATH};
const HIST=[]; // {ts,task,events[],result}
const j=(res,c,o)=>{res.writeHead(c,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(o))};

http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end()}
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,'studio.html')))}
  if(req.method==='GET'&&req.url==='/api/history')return j(res,200,{hist:HIST.slice(0,20)});
  if(req.method==='GET'&&req.url==='/api/files'){
    return j(res,200,{files:fs.readdirSync(LAB).filter(f=>f!=='.git'&&f!=='hello.js')});
  }
  if(req.method==='POST'&&req.url==='/api/task'){
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      let{message=''}=JSON.parse(body||'{}');
      if(!message.trim())return j(res,400,{error:'empty'});
      message=message.trim();
      const run={ts:new Date().toTimeString().slice(0,8),task:message,events:[],result:null};
      HIST.unshift(run);
      // NDJSON 流式响应
      res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-cache'});
      const send=o=>{run.events.push(o);res.write(JSON.stringify(o)+'\n')};
      send({type:'stage',stage:'start',text:'任务已接收，启动 Coding Agent…'});
      const p=spawn('claude',['-p',
        '你是 Coding Agent，工作目录=当前目录。完成任务并真实验证（能运行就运行）。完成后按 [STATUS]/[CHANGES]/[TESTS] 格式回执。任务：'+message,
        '--output-format','stream-json','--verbose','--permission-mode','acceptEdits',
        '--allowedTools','Read Write Edit Bash(node *) Bash(npm test *) Bash(ls *) Bash(cat *) Bash(mkdir *)',
        '--max-turns','24'],{cwd:LAB,env:ENV});
      let buf='';
      p.stdout.on('data',d=>{
        buf+=d;let i;
        while((i=buf.indexOf('\n'))>=0){
          const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
          if(!line||line.startsWith('['))continue;
          let e;try{e=JSON.parse(line)}catch{continue}
          if(e.type==='assistant'){
            for(const c of e.message.content){
              if(c.type==='text'&&c.text.trim())send({type:'text',text:c.text});
              else if(c.type==='tool_use'){
                const inp=c.input||{};
                send({type:'tool',tool:c.name,brief:briefTool(c.name,inp)});
              }
            }
          }else if(e.type==='result'){
            run.result={status:e.subtype,turns:e.num_turns};
            send({type:'stage',stage:'done',text:`执行结束：${e.subtype} · ${e.num_turns} turns`});
          }
        }
      });
      p.on('close',()=>{if(!run.result){run.result={status:'aborted'};send({type:'stage',stage:'done',text:'进程结束（无 result 事件）'})}res.end()});
      p.on('error',err=>send({type:'stage',stage:'error',text:'启动失败:'+err.message}));
    });
    return;
  }
  res.writeHead(404);res.end();
}).listen(PORT,'0.0.0.0',()=>console.log('studio on',PORT));

function briefTool(name,inp){
  if(name==='Read')return '读取 '+inp.file_path;
  if(name==='Write')return '创建 '+inp.file_path;
  if(name==='Edit')return '编辑 '+inp.file_path;
  if(name==='Bash')return '$ '+(inp.command||'').slice(0,80);
  return name+' '+JSON.stringify(inp).slice(0,60);
}
