import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kissd-compose-safety-'));
process.env.DATA_DIR = path.join(root, 'data');
const log = path.join(root, 'calls.jsonl');
await fs.mkdir(path.join(root, 'bin'));
await fs.writeFile(path.join(root, 'compose.yml'), 'services: {}\n');
await fs.writeFile(path.join(root, 'bin/docker'), `#!${process.execPath}\nimport fs from 'node:fs';\nconst a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a.includes('pull')&&!a.includes('--ignore-pull-failures'))process.exit(1);\n`, {mode:0o700});
process.env.PATH = path.join(root, 'bin') + path.delimiter + process.env.PATH;
const {docker} = await import('../src/docker.js');
const compose = await import('../src/compose.js');
docker.listContainers = async () => [{Names:['/fixture-api'],State:'running',Labels:{'com.docker.compose.project':'fixture','com.docker.compose.project.working_dir':root,'com.docker.compose.project.config_files':path.join(root,'compose.yml'),'com.docker.compose.service':'api'}}];
after(()=>fs.rm(root,{recursive:true,force:true}));
const calls = async () => (await fs.readFile(log,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(JSON.parse);
test('a failed project pull prevents every container recreation', async () => {
 const code=await compose.update('fixture',()=>{});
 assert.notEqual(code,0,'A failed image pull must fail the update');
 assert.equal((await calls()).some(x=>x.includes('up')),false,'Do not continue with a partially fetched release');
});
test('an invalid guarded policy fails closed instead of falling back to a bulk update', async () => {
 await fs.writeFile(path.join(root,'kissd-update.json'),'{invalid');
 const before=(await calls()).length;
 await assert.rejects(compose.update('fixture',()=>{}),/policy/i);
 assert.equal((await calls()).length,before);
});
test('guarded projects cannot bypass deployment checks through apply or restart', async () => {
 await fs.writeFile(path.join(root,'kissd-update.json'),JSON.stringify({version:1,services:['api']}),{mode:0o600});
 for(const action of ['apply','restart']) await assert.rejects(compose[action]('fixture',()=>{}),/guarded|policy/i);
});
