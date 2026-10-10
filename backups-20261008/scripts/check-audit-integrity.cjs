'use strict';
// Integrity evidence only. Historical classifier labels never establish acceptance.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'docs/audit');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const hash=file=>{try{return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()}catch(error){if(error.code==='ENOENT')return null;throw error}};
const preflight=read(path.join(dir,'v2-preflight.json')),manifest=read(path.join(dir,'memepilot-inventory.json'));
const legacyChecks=manifest.entries.filter(e=>e.sha256).map(e=>{const actual=hash(path.join(manifest.root,e.file));return actual===null?{file:e.file,missing:true,unchanged:null,binding:'EXTERNAL_COPY_ABSENT'}:{file:e.file,missing:false,unchanged:actual===e.sha256.toUpperCase(),actual}});
const present=legacyChecks.filter(e=>!e.missing);
const uiChecks=preflight.uiBaseline.map(e=>{const actual=hash(path.join(root,e.file));return{file:e.file,expected:e.sha256,actual,unchanged:actual===e.sha256}});
const result={at:new Date().toISOString(),scope:'FILE_INTEGRITY_ONLY_NOT_ACCEPTANCE',uiChecks,legacyChecks,legacyRoot:manifest.root,classifierAuthority:'NONE; all TypeSafe receipts are auxiliary historical signals'};
fs.writeFileSync(path.join(dir,'audit-integrity.json'),JSON.stringify(result,null,2));
const summary={legacyFilesChecked:present.length,legacyFilesChanged:present.filter(x=>!x.unchanged),legacyFilesMissing:legacyChecks.filter(x=>x.missing).map(x=>x.file),uiUnchanged:uiChecks.every(x=>x.unchanged),scope:result.scope};
console.log(JSON.stringify(summary));
if(present.some(x=>!x.unchanged)||uiChecks.some(x=>!x.unchanged))process.exitCode=1;