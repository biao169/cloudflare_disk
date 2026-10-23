// Dependency-free syntax pass for all handwritten JavaScript; no build step.
import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const roots=['worker','public/js','tests','scripts'];
const files=[];
function walk(path){for(const e of readdirSync(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())walk(p);else if(e.isFile()&&/\.(m?js)$/.test(e.name)&&e.name!=='check-syntax.mjs')files.push(p);}}
for(const p of roots)walk(p);
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr||`Syntax failure: ${file}\n`);process.exitCode=1;}}
if(!process.exitCode)console.log(`Syntax OK: ${files.length} JavaScript files`);
