import {test,after} from 'node:test';import assert from 'node:assert/strict';
import fs from 'fs';import path from 'path';
// v1.3 前端逻辑级回归（DIAGNOSIS R3 同款方法：逐字加载 plan.html 内联脚本 + 虚拟 fetch/DOM，非浏览器端到端）：
// 判据1 树任意深度可见可选（三四级）· 叶子无假 ▸ · 判据4 侧栏按磁盘桶聚合默认折叠展开记忆 · 判据9 同桶不分裂
const html=fs.readFileSync(path.resolve('plan.html'),'utf8');
const src=html.split('<script>')[1].split('</script>')[0];
const els={};
const el=id=>els[id]||(els[id]={innerHTML:'',textContent:'',value:'',style:{},title:'',
  classList:{add(){},remove(){},toggle(){}},onclick:null,querySelector:()=>null});
const store={};
let listCalls=[];
globalThis.window=globalThis;
globalThis.document={getElementById:el,querySelectorAll:()=>[],body:{classList:{add(){},remove(){},toggle(){}}},
  createElement:()=>({classList:{add(){},remove(){}},style:{},querySelector:()=>null})};
globalThis.localStorage={getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=String(v)}};
globalThis.matchMedia=()=>({matches:false});
globalThis.alert=()=>{};globalThis.confirm=()=>true;globalThis.prompt=()=>null;
const VT={ // 虚拟树：/ → r0 → a → b → c(叶)
  '/':[{name:'r0',hasChildren:true}],
  '/r0':[{name:'a',hasChildren:true}],
  '/r0/a':[{name:'b',hasChildren:true}],
  '/r0/a/b':[{name:'c',hasChildren:false}]};
const origFetch=globalThis.fetch;
let analyses=[];
globalThis.fetch=async url=>{
  if(url.startsWith('/api/dirs')){const b=new URL(url,'http://x').searchParams.get('base')||'/';
    return{json:async()=>({base:b,dirs:VT[b]||[]})}}
  if(url==='/api/analyses'){listCalls++;return{json:async()=>({analyses})}}
  return{json:async()=>({})}};
const origSetInterval=globalThis.setInterval;globalThis.setInterval=()=>0;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await eval(src); // 加载内联脚本（window.* 挂全局，renderTree 经 twDir/pickDir 驱动）

test('判据1：树真递归 —— 三、四级目录展开后可见可选，叶子无假 ▸（R3 修复）',async()=>{
  window.openModal('new');await sleep(50); // 树随弹层打开才渲染
  assert.ok(el('tree').innerHTML.includes('📁 r0'),'根层 r0 应渲染');
  assert.ok(el('tree').innerHTML.includes('▸'),'有子目录的节点应有展开钮');
  await window.twDir('/r0');await sleep(50);
  assert.ok(el('tree').innerHTML.includes('📁 a'),'二级 a 应可见');
  await window.twDir('/r0/a');await sleep(50);
  assert.ok(el('tree').innerHTML.includes('📁 b'),'三级 b 应可见（v1.2 缺陷：永不出现）');
  await window.twDir('/r0/a/b');await sleep(50);
  const h=el('tree').innerHTML;
  assert.ok(h.includes('📁 c'),'四级 c 应可见');
  assert.ok(h.includes(`<span class="tw"></span>📁 c`),'叶子 c 不应渲染 ▸（hasChildren=false）');
  window.pickDir('/r0/a/b/c');await sleep(50);
  assert.equal(el('selPath').textContent,'/r0/a/b/c','四级目录应可选为归属（全路径）');
  assert.ok(el('tree').innerHTML.includes("pickDir('/r0/a/b/c')"));
});

test('判据4+9：侧栏按磁盘桶聚合默认折叠（展开记忆）· 同桶不分裂、标签可区分',async()=>{
  analyses=[
    {id:'an-1',topic:'x/panel',bucket:'x_panel',idea:'斜杠标签',state:'open',round:1,updated:'2026-11-18T01:00:00Z',submitMode:'build',spawnedRuns:0,parent:null},
    {id:'an-2',topic:'x_panel',bucket:'x_panel',idea:'下划线标签',state:'open',round:1,updated:'2026-11-18T02:00:00Z',submitMode:'build',spawnedRuns:0,parent:null}];
  await window.setF('all');await sleep(50); // setF 触发 loadList（loadList 闭包在脚本作用域内，经 window 钩子驱动）
  await sleep(0);
  let h=el('list').innerHTML;
  const heads=(h.match(/tg-head/g)||[]).length;
  assert.equal(heads,1,'x/panel 与 x_panel 同磁盘桶 → 一个组头（不分裂）');
  assert.ok(h.includes('x_panel'),'组名歧义时显示磁盘桶名');
  assert.ok(h.includes('class="ses'),'v1.3.1 默认展开：组内条目直接渲染');
  await window.tgToggle('x_panel');await sleep(50); // 手动折叠 → 记忆
  h=el('list').innerHTML;
  assert.ok(!h.includes('class="ses'),'折叠后组内条目不渲染');
  assert.ok(JSON.parse(store['plan-tg-collapsed'])['x_panel']===true,'折叠记忆写入 plan-tg-collapsed');
  await window.setF('all');await sleep(50);
  assert.ok(!el('list').innerHTML.includes('class="ses'),'记忆折叠在下次 loadList 保持');
  await window.tgToggle('x_panel');await sleep(50); // 再展开恢复
});

after(()=>{globalThis.fetch=origFetch;globalThis.setInterval=origSetInterval}); // 测试全部跑完才恢复真实实现
