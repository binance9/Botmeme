'use strict';
const fs=require('node:fs'),path=require('node:path'),{performance}=require('node:perf_hooks');
const WINDOW_MS=12*60*60*1000, AGENTS=['jev','codex-1','codex-2','codex-3'];
function createWorkMeter({filename,clock=Date.now,monotonic=()=>performance.now()}={}){
 let anchor=clock(),rows=[],fault=null;const pending=new Map();let serial=0;
 if(filename&&fs.existsSync(filename)){
  const text=fs.readFileSync(filename,'utf8');
  for(const line of text.split('\n').filter(Boolean))try{const r=JSON.parse(line);if(r.type==='anchor'&&Number.isFinite(r.at))anchor=r.at;else if(r.type==='work'&&AGENTS.includes(r.agent)&&Number.isFinite(r.start)&&Number.isFinite(r.end)&&r.end>=r.start)rows.push(r);}catch{fault='WORK_METER_RECEIPT_INVALID';}
 }
 function write(row){if(filename){fs.mkdirSync(path.dirname(filename),{recursive:true});fs.appendFileSync(filename,JSON.stringify(row)+'\n');}}
 if(filename&&!fs.existsSync(filename))write({type:'anchor',at:anchor,version:1});
 function begin(agent,task){
  if(!AGENTS.includes(agent))throw Error('UNKNOWN_WORK_AGENT');
  const id=++serial,start=clock(),mono=monotonic();pending.set(id,{agent,task,start,mono});let ended=false;
  return outcome=>{if(ended)return;ended=true;pending.delete(id);const durationMs=Math.max(0,monotonic()-mono),row={type:'work',agent,task,start,end:start+durationMs,durationMs,outcome};rows.push(row);try{write(row);}catch{fault='WORK_METER_PERSIST_FAILED';}};
 }
 function snapshot(){
  const at=clock(),windowStart=anchor+Math.max(0,Math.floor((at-anchor)/WINDOW_MS))*WINDOW_MS,windowEnd=windowStart+WINDOW_MS;
  const live=[...pending.values()].map(r=>({...r,end:r.start+Math.max(0,monotonic()-r.mono)}));
  return Object.fromEntries(AGENTS.map(agent=>{
   const all=rows.concat(live).filter(r=>r.agent===agent&&r.end>windowStart&&r.start<windowEnd);
   const spans=all.map(r=>[Math.max(windowStart,r.start),Math.min(windowEnd,at,r.end)]).filter(([s,e])=>e>=s).sort((a,b)=>a[0]-b[0]);
   let workMs=0,last=-Infinity;for(const [s,e] of spans){workMs+=Math.max(0,e-Math.max(s,last));last=Math.max(last,e);}
   const completed=rows.filter(r=>r.agent===agent&&r.end>=windowStart&&r.end<windowEnd);
   return [agent,{workMs,progress:Math.min(99.999,workMs/WINDOW_MS*100),windowStart,windowEnd,completed:completed.length,failures:completed.filter(r=>r.outcome!=='completed').length,running:live.filter(r=>r.agent===agent).length,measurement:'active-task-wall-time',error:fault}];
  }));
 }
 function wrapRuntime(runtime){return {...runtime,subscribeDurable(id,type,handler){
  const agent=id.startsWith('jev.')?'jev':id.startsWith('commander.')?'codex-1':id.startsWith('quant.')?'codex-2':id.startsWith('forensic.')?'codex-3':null;
  if(!agent)return runtime.subscribeDurable(id,type,handler);
  return runtime.subscribeDurable(id,type,async(e,ctx)=>{const finish=begin(agent,id+':'+e.id);const abort=()=>finish('aborted');ctx.signal.addEventListener('abort',abort,{once:true});try{const value=await handler(e,ctx);finish('completed');return value;}catch(error){finish('failed');throw error;}finally{ctx.signal.removeEventListener('abort',abort);}});
 }};}
 return {begin,snapshot,wrapRuntime};
}
module.exports={createWorkMeter,WINDOW_MS};
