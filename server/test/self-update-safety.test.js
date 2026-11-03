import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const source=await fs.readFile(new URL('../src/docker.js',import.meta.url),'utf8');
async function execute(t,name){
 const script=source.match(new RegExp('const '+name+' = `([\\s\\S]*?)`;'))?.[1];assert.ok(script);
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kissd-self-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const log=path.join(dir,'calls');const marker=path.join(dir,'marker');await fs.writeFile(marker,'pending');
 await fs.writeFile(path.join(dir,'docker'),`#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a.includes('pull')&&!a.includes('--ignore-pull-failures'))process.exit(1);`,{mode:0o700});
 let code=0;try{await promisify(execFile)('sh',['-c',script,'sh',dir,dir,'',marker,'-p','fixture'],{env:{...process.env,PATH:dir+path.delimiter+process.env.PATH}});}catch(e){code=e.code;}
 return {code,markerExists:await fs.stat(marker).then(()=>true,()=>false),calls:(await fs.readFile(log,'utf8')).trim().split('\n').map(JSON.parse)};
}
test('a failed self-image pull never continues to compose up',async t=>{const r=await execute(t,'SELF_UPDATE_SH');assert.notEqual(r.code,0);assert.equal(r.calls.some(a=>a.includes('up')),false);});
for(const name of ['SELF_UPDATE_SH','SELF_RESTART_SH'])test(name+' clears its maintenance marker on exit',async t=>{const r=await execute(t,name);assert.equal(r.markerExists,false);});
