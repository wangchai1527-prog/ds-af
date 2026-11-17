import fs from 'fs';import path from 'path';
let _n=0;
// 造一个分析台话题目录（默认已拍板 GO、未 spawn）供工厂 from-plan 立项测试用
export function mkGoAnalysis(anRoot,idea,state='go'){
  const id='an-'+Date.now()+'-'+String(++_n);
  const d=path.join(anRoot,id);
  fs.mkdirSync(path.join(d,'materials'),{recursive:true});
  fs.writeFileSync(path.join(d,'meta.json'),JSON.stringify({id,idea,state,round:1,created:new Date().toISOString(),updated:null,spawnedRun:null},null,1));
  return d;
}
// from-plan run 设原型确认闸：放行所有 awaiting 的 run（模拟人点「原型确认 · 放行」）
export async function approveAllAwaiting(base){
  const s=await(await fetch(base+'/api/state')).json();
  for(const r of (s.runs||[]))if(r.awaiting)
    await fetch(base+'/api/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:r.id,decision:'go'})}).catch(()=>{});
}
