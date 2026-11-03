import {test} from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
test('project update controls show guarded scope, block bypasses and retain ordinary project actions',async t=>{
 const vite=await createServer({server:{middlewareMode:true,hmr:false},appType:'custom'});t.after(()=>vite.close());
 const {default:Controls}=await vite.ssrLoadModule('/src/components/ProjectUpdateControls.jsx');
 const render=policy=>renderToStaticMarkup(React.createElement(Controls,{project:'loadout',policy,onUpdate:()=>{},onRestart:()=>{}}));
 const guarded=render({mode:'guarded'});assert.match(guarded,/Guarded update/);assert.match(guarded,/database|protected/i);assert.match(guarded,/<button[^>]*disabled[^>]*>Restart all<\/button>/);
 const blocked=render({mode:'blocked'});assert.equal((blocked.match(/disabled=""/g)||[]).length,2);assert.match(blocked,/policy/i);
 const normal=render(null);assert.match(normal,/Update all/);assert.doesNotMatch(normal,/disabled=""/);
});
