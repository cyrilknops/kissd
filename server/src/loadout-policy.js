// Optional Loadout recipe. Approval stays an owner action; the dashboard never guesses a release.
import {configurationHash} from './guarded-updates.js';
export function buildLoadoutPolicy({prefix,origin,revision,config,ciRun}){
 if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(prefix)||!/^[a-f0-9]{40}$/.test(revision))throw Error('Invalid project or revision');
 const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('A public HTTPS origin without a path is required');
 const apis=[prefix+'-api',prefix+'-api-replica'];const web=prefix+'-web';const database=prefix+'-postgres';const services=[...apis,web];
 const read=`const names=${JSON.stringify(apis)};const rows=await Promise.all(names.map(async name=>{const r=await fetch('http://'+name+':3000/api/health',{signal:AbortSignal.timeout(2000)});if(!r.ok)throw Error('Not ready');const body=await r.json();if(body.status!=='ok'||body.service!=='loadout-api'||!body.cluster?.instanceId)throw Error('Not ready');return {name,...body.cluster}}));if(new Set(rows.map(x=>x.instanceId)).size!==2||rows.filter(x=>x.leader===true).length!==1)throw Error('Invalid quorum');`;
 return {version:1,backwardCompatible:true,approvedRevision:revision,ciRun:ciRun||null,services,database,configurationHash:configurationHash(config,services),
  preflight:[{name:'No running or paused games',argv:['docker','exec',database,'sh','-c',`exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM game WHERE status IN ('running','paused');"`],expect:'0'}],
  health:[{name:'Two ready APIs and one MQTT owner',argv:['docker','exec',web,'node','--input-type=module','-e',read+`console.log('ready')`],expect:'ready'},
   ...['/api/health','/venues'].map(route=>({name:'Public '+route,argv:['curl','--fail','--silent','--show-error','--max-time','5','--output','/dev/null','--write-out','%{http_code}',url.origin+route],expect:'200'}))],
  order:['docker','exec',web,'node','--input-type=module','-e',read+`console.log(JSON.stringify([...rows.filter(x=>!x.leader).map(x=>x.name),...rows.filter(x=>x.leader).map(x=>x.name),${JSON.stringify(web)}]))`]};
}
