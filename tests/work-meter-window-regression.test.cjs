'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkMeter,WINDOW_MS}=require('../runtime/work-meter.cjs');
test('pruning keeps crossing intervals and completions exactly at window boundary; disk evidence unchanged',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'meter-window-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const filename=path.join(dir,'receipts.jsonl'),anchor=1000,boundary=anchor+WINDOW_MS;
 const rows=[{type:'anchor',at:anchor},...Array.from({length:10000},(_,i)=>({type:'work',agent:'jev',start:anchor+i,end:anchor+i+1,outcome:'completed'})),{type:'work',agent:'jev',start:boundary-100,end:boundary,outcome:'failed'},{type:'work',agent:'jev',start:boundary-50,end:boundary+50,outcome:'completed'}];
 const source=rows.map(x=>JSON.stringify(x)).join('\n')+'\n';fs.writeFileSync(filename,source);
 let clock=boundary+100;const meter=createWorkMeter({filename,clock:()=>clock});
 for(let i=0;i<3;i++){const value=meter.snapshot().jev;assert.equal(value.workMs,50);assert.equal(value.completed,2);assert.equal(value.failures,1);}
 clock+=WINDOW_MS;assert.equal(meter.snapshot().jev.completed,0);assert.equal(meter.snapshot().jev.workMs,0);assert.equal(fs.readFileSync(filename,'utf8'),source);
});
test('pending task crossing window stays measured then counts completion exactly once',()=>{
 let clock=1000,mono=0;const meter=createWorkMeter({clock:()=>clock,monotonic:()=>mono});const end=meter.begin('jev','cross');clock+=WINDOW_MS+25;mono+=WINDOW_MS+25;
 assert.equal(meter.snapshot().jev.workMs,25);assert.equal(meter.snapshot().jev.running,1);end('completed');assert.equal(meter.snapshot().jev.completed,1);assert.equal(meter.snapshot().jev.workMs,25);
});
