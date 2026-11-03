// Owner-managed, image-only deployment policies. No policy/command comes from HTTP input.
import fs from 'node:fs/promises';
import {createWriteStream,createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {parseDocument} from 'yaml';

const MAX=512*1024;
const active=new Map();
const pin=/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const sha=/^[a-f0-9]{40}$/;
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const hash=value=>createHash('sha256').update(value).digest('hex');
export function configurationHash(config,services) {
 const value=structuredClone(config);
 for(const service of services)if(value.services?.[service])delete value.services[service].image;
 return hash(JSON.stringify(canonical(value)));
}
function argv(value){return Array.isArray(value)&&value.length>0&&value.length<=64&&value.every(v=>typeof v==='string'&&v.length>0&&v.length<=16384&&!v.includes('\0'));}
function validCheck(c){return c&&typeof c.name==='string'&&c.name.length>0&&c.name.length<=100&&argv(c.argv)&&typeof c.expect==='string'&&c.expect.length<=1000;}
export async function readPolicy(project) {
 const file=path.join(project.workdir,'kissd-update.json');let stat;
 try{stat=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw Error('Cannot read update policy');}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||(stat.mode&0o022))throw Error('Update policy must be a private regular file');
 let p;try{p=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw Error('Invalid update policy JSON');}
 if(p.version!==1||!Array.isArray(p.services)||p.services.length<1||p.services.length>20||new Set(p.services).size!==p.services.length||p.services.some(s=>!project.services.includes(s))||!project.services.includes(p.database)||p.services.includes(p.database)||!sha.test(p.approvedRevision)||!/^[a-f0-9]{64}$/.test(p.configurationHash)||p.backwardCompatible!==true||!Array.isArray(p.preflight)||!p.preflight.length||!p.preflight.every(validCheck)||!Array.isArray(p.health)||!p.health.length||!p.health.every(validCheck)||(p.order!==undefined&&!argv(p.order)))throw Error('Invalid guarded update policy');
 return p;
}
export async function policySummary(project){try{const p=await readPolicy(project);return p?{mode:'guarded',services:p.services,approvedRevision:p.approvedRevision}:null;}catch{return {mode:'blocked',message:'Update policy needs attention'};}}
export async function assertIdle(project){
 if(active.has(project.workdir))throw Error('A guarded update is running for this project');
 try{await fs.lstat(path.join(project.workdir,'.kissd','update.lock'));}catch(e){if(e.code==='ENOENT')return;throw e;}
 throw Error('An interrupted guarded update needs recovery; inspect the .kissd update journal before continuing');
}
export async function assertPlainAction(project){await assertIdle(project);if(await readPolicy(project))throw Error('Use the guarded project update; bulk apply, restart and individual updates are disabled');}
export function hasActiveUpdates(){return active.size>0;}

// Capture secrets internally, never stream a rendered compose file, inspect output or hook stderr.
export async function runCommand(command,{cwd,env,timeoutMs=30000,outputFile,inputFile}={}){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
 const child=spawn(command[0],command.slice(1),{cwd,env,signal:controller.signal,stdio:['pipe','pipe','pipe']});
 let stdout='';let bytes=0;child.stderr.resume();
 const transfers=[];
 if(outputFile)transfers.push(pipeline(child.stdout,createWriteStream(outputFile,{flags:'wx',mode:0o600})));
 else child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024)controller.abort();else stdout+=chunk;});
 if(inputFile)transfers.push(pipeline(createReadStream(inputFile),child.stdin));else child.stdin.end();
 child.stdin.on('error',()=>{});
 const exit=new Promise((resolve,reject)=>{child.once('error',()=>reject(Error('Command could not complete')));child.once('close',code=>code===0?resolve():reject(Error('Command failed')));});
 try{await Promise.all([exit,...transfers]);return {stdout};}finally{clearTimeout(timer);}
}
async function privateDir(dir){
 try{await fs.mkdir(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const s=await fs.lstat(dir);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077))throw Error('Update journal directory must be private');
}
async function atomic(file,content,mode=0o600){const temp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,content,{mode,flag:'wx'});try{await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}}
function compose(project,sub,extra=[]){return ['docker','compose','--project-directory',project.workdir,'-p',project.project,...project.files.flatMap(f=>['-f',f]),sub,...extra];}
function fingerprint(x){return {image:x.Image,started:x.State.StartedAt,restarts:x.RestartCount,mounts:x.Mounts};}
async function sourceState(project){
 const values={};for(const file of [...project.files,path.join(project.workdir,'.env'),path.join(project.workdir,'kissd-update.json')]){
  try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>MAX)throw Error('Invalid deployment source');values[file]=await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT'&&!project.files.includes(file))values[file]=null;else throw e;}
 }return values;
}
async function unchanged(project,state){if(JSON.stringify(await sourceState(project))!==JSON.stringify(state))throw Error('Deployment configuration changed externally; automatic rollback requires manual recovery');}
function oldCompose(source,old){
 if(source.trimStart().startsWith('{')){const c=JSON.parse(source);for(const [s,x]of Object.entries(old))c.services[s].image=x.Config.Image;return JSON.stringify(c,null,2)+'\n';}
 const doc=parseDocument(source);if(doc.errors.length)throw Error('Compose cannot be prepared for rollback');
 for(const [s,x]of Object.entries(old))doc.setIn(['services',s,'image'],x.Config.Image);
 return String(doc);
}
export function createGuardedUpdater({run=runCommand,inspect,sleep=delay}={}){
 async function check(checks,project){for(const c of checks){try{const r=await run(c.argv,{cwd:project.workdir,timeoutMs:10000});if(r.stdout.trim()!==c.expect)throw Error();}catch{throw Error('Deployment check failed: '+c.name);}}}
 async function healthy(project,policy,service){
  const deadline=Date.now()+180000;
  for(let i=0;i<(policy.attempts??90)&&Date.now()<deadline;i++){
   try{if(service){const x=await inspect(service,project);if(!x.State.Running||(x.State.Health&&x.State.Health.Status!=='healthy'))throw Error();}await check(policy.health,project);return;}catch{}
   await sleep(policy.intervalMs??1000);
  }throw Error('Health gate failed');
 }
 async function execute(project,policy,emit,job){
  if(project.hasSelf||project.files.length!==1)throw Error('Guarded updates require one compose file and cannot replace kissd itself');
  const state=await sourceState(project);const source=state[project.files[0]];const fileMode=(await fs.stat(project.files[0])).mode&0o777;
  const cfg=JSON.parse((await run(compose(project,'config',['--format','json']),{cwd:project.workdir})).stdout);
  if(configurationHash(cfg,policy.services)!==policy.configurationHash)throw Error('Deployment configuration differs from the approved policy');
  const old={};const desired={};const protectedBefore={};
  for(const s of policy.services){
   if(!pin.test(cfg.services?.[s]?.image))throw Error('Application images must be pinned by digest');
   old[s]=await inspect(s,project);if(!pin.test(old[s].Config.Image))throw Error('Running application images must be pinned by digest');
   if(!old[s].State.Running)throw Error('Current release is not running');
   let image;try{image=JSON.parse((await run(['docker','image','inspect',cfg.services[s].image])).stdout)[0];}catch{
    emit('Fetching pinned image for '+s+'…\n');try{await run(['docker','pull',cfg.services[s].image],{timeoutMs:300000});image=JSON.parse((await run(['docker','image','inspect',cfg.services[s].image])).stdout)[0];}catch{throw Error('Pinned image pull failed for '+s);}
   }
   if(image?.Config?.Labels?.['org.opencontainers.image.revision']!==policy.approvedRevision)throw Error('Image revision does not match the approved release');desired[s]=image;
  }
  for(const s of Object.keys(cfg.services).filter(s=>!policy.services.includes(s)))protectedBefore[s]=fingerprint(await inspect(s,project));
  const protectedCheck=async()=>{for(const [s,value]of Object.entries(protectedBefore))if(JSON.stringify(fingerprint(await inspect(s,project)))!==JSON.stringify(value))throw Error('Protected service changed: '+s);};
  await check(policy.preflight,project);await healthy(project,policy);
  const changed=policy.services.filter(s=>old[s].Image!==desired[s].Id);
  if(!changed.length){await unchanged(project,state);await protectedCheck();emit('Current pinned release is healthy. No services changed.\n');return;}
  let order=policy.services;
  if(policy.order){try{order=JSON.parse((await run(policy.order,{cwd:project.workdir,timeoutMs:10000})).stdout);}catch{throw Error('Deployment order check failed');}}
  if(!Array.isArray(order)||order.length!==policy.services.length||new Set(order).size!==order.length||order.some(s=>!policy.services.includes(s)))throw Error('Invalid deployment order');
  const dir=job.dir;
  const prior=oldCompose(source,old);await fs.writeFile(path.join(dir,'rollback-compose.yml'),prior,{mode:0o600});
  for(const [file,value]of Object.entries(state))if(value!==null)await fs.writeFile(path.join(dir,path.basename(file)+'.private'),value,{mode:0o600});
  const dump=path.join(dir,'database.dump');emit('Backing up PostgreSQL…\n');
  const database=(await inspect(policy.database,project)).Id;
  try{await run(['docker','exec',database,'sh','-c','exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'],{outputFile:dump,timeoutMs:120000});await fs.chmod(dump,0o600);if(!(await fs.stat(dump)).size)throw Error();await run(['docker','exec','-i',database,'pg_restore','--list'],{inputFile:dump,timeoutMs:30000});}catch{throw Error('Database backup verification failed; no services changed');}
  await job.record({status:'backup-verified',order,previousImages:Object.fromEntries(Object.entries(old).map(([s,x])=>[s,x.Config.Image]))});
  emit('Database archive verified. Starting sequential update.\n');
  await unchanged(project,state);await protectedCheck();await check(policy.preflight,project);
  const touched=[];
  try{
   for(const s of order.filter(s=>changed.includes(s))){
    await unchanged(project,state);touched.push(s);await job.record({status:'updating',service:s,touched:[...touched]});emit('Updating '+s+'…\n');await run(compose(project,'up',['-d','--no-deps','--pull','never',s]),{cwd:project.workdir,timeoutMs:180000});
    await healthy(project,policy,s);const x=await inspect(s,project);if(x.Image!==desired[s].Id||x.RestartCount!==0)throw Error('Image or restart verification failed');await protectedCheck();
   }
   await unchanged(project,state);await protectedCheck();emit('Guarded update passed all health checks.\n');
  }catch(error){
   if(!touched.length)throw error;
   await job.record({status:'rolling-back',touched:[...touched]});emit('Update failed. Rolling application images back…\n');
   try{
    await unchanged(project,state);await atomic(project.files[0],prior,fileMode);const rollbackState={...state,[project.files[0]]:prior};
    for(const s of [...touched].reverse()){
     await unchanged(project,rollbackState);await run(compose(project,'up',['-d','--no-deps','--pull','never',s]),{cwd:project.workdir,timeoutMs:180000});await healthy(project,policy,s);
     if((await inspect(s,project)).Image!==old[s].Image)throw Error('Rollback image verification failed');
    }
    await protectedCheck();emit('Previous application images restored. PostgreSQL data was not restored.\n');
   }catch{const e=Error('Automatic rollback could not complete. Manual recovery required; inspect '+dir);e.recoveryRequired=true;throw e;}
   const e=Error('Update failed and was rolled back');e.rolledBack=true;throw e;
  }
 }
 return {async update(project,policy,onData){
  const running=active.get(project.workdir);if(running){for(const line of running.lines)try{onData(line);}catch{}running.listeners.add(onData);try{return await running.promise;}finally{running.listeners.delete(onData);}}
  await assertIdle(project);const root=path.join(project.workdir,'.kissd');await privateDir(root);
  const lock=path.join(root,'update.lock');const id=randomUUID();let handle;
  try{handle=await fs.open(lock,'wx',0o600);await handle.writeFile(JSON.stringify({id,startedAt:new Date().toISOString()}));}catch(e){if(e.code==='EEXIST')throw Error('A guarded update already owns this project');throw e;}finally{await handle?.close();}
  const dir=path.join(root,id);await fs.mkdir(dir,{mode:0o700});
  const journal={id,project:project.project,revision:policy.approvedRevision,status:'preflight',startedAt:new Date().toISOString(),touched:[]};
  const job={dir,lines:[],listeners:new Set([onData]),record:async patch=>{Object.assign(journal,patch);await atomic(path.join(dir,'status.json'),JSON.stringify(journal,null,2));}};await job.record({});const emit=line=>{job.lines.push(line);for(const listener of job.listeners)try{listener(line);}catch{}};
  active.set(project.workdir,job);let keepLock=false;
  job.promise=(async()=>{try{await execute(project,policy,emit,job);await job.record({status:'succeeded',completedAt:new Date().toISOString()});return 0;}catch(e){keepLock=e.recoveryRequired===true;await job.record({status:keepLock?'recovery-required':e.rolledBack?'rolled-back':'failed',completedAt:new Date().toISOString()});throw e;}finally{active.delete(project.workdir);if(!keepLock){const own=JSON.parse(await fs.readFile(lock,'utf8'));if(own.id===id)await fs.rm(lock);}}})();
  return job.promise;
 }};
}
