'use strict';
const {spawn}=require('node:child_process'),path=require('node:path');const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(require('electron'),[path.join(__dirname,'copy-paper-ui.cjs')],{env,stdio:'inherit',windowsHide:true});child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',c=>process.exitCode=c??1);
