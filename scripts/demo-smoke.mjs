// Runs the built application on loopback with an isolated temporary demo database.
// Google credentials are deliberately removed. No real Gmail calls are possible.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { groupSenders, defaults, toggleIds } from '../src/lib/domain.ts';
const require=createRequire(import.meta.url);
const directory=mkdtempSync(path.join(tmpdir(),'inbox-live-demo-'));
const port=3089,origin=`http://localhost:${port}`;
const child=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','--hostname','localhost','--port',String(port)],{
  cwd:process.cwd(),env:{...process.env,APP_ORIGIN:origin,DATA_DIR:directory,GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',TOKEN_ENCRYPTION_KEY:'',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']
});
let output='',cookie='',csrf='';
child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
const stopped=new Promise(resolve=>child.once('exit',resolve));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function call(action,body,expected=200){
  if(child.exitCode!==null)throw new Error('The isolated demo server stopped unexpectedly. Check that port 3089 is available.');
  const response=await fetch(`${origin}/api/${action}`,{method:body?'POST':'GET',headers:{cookie,...(body?{origin,'content-type':'application/json','x-csrf-token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
  for(const entry of response.headers.getSetCookie())if(entry.startsWith('inbox_session='))cookie=entry.split(';')[0];
  const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));if(data.csrf)csrf=data.csrf;return data;
}
async function waitUntil(check){for(let i=0;i<150;i++){const result=await check();if(result)return result;await pause(100);}throw new Error('Timed out waiting for background operation.');}
try{
  await waitUntil(async()=>{
    if(child.exitCode!==null)throw new Error('Could not start the isolated demo server. Check that port 3089 is available.');
    if(!output.includes('Ready in'))return false;
    try{return (await fetch(origin)).ok;}catch{return false;}
  });
  const home=await (await fetch(origin)).text();assert.ok(home.includes('Inbox Cleanup'));
  let state=await call('state');assert.equal(state.connected,false);
  await call('demo',{});state=await call('state');assert.equal(state.mode,'demo');assert.equal(state.connected,true);
  await call('scan',{});
  state=await waitUntil(async()=>{const s=await call('state');return s.scan.status==='complete'?s:false;});
  assert.ok(state.scan.messages.length>500);
  assert.ok(!state.scan.messages.some(m=>['demo-receipt','demo-starred','demo-archived'].includes(m.id)));
  const groups=groupSenders(state.scan.messages,defaults,new Set(state.protected));
  assert.equal(groups.length,10);assert.ok(groups.every(s=>s.email!=='hello@fieldnotes.example'));
  const store=groups.find(s=>s.email==='offers@nordandco.example');
  const selected=toggleIds(new Set(store.messages.map(m=>m.id)),[store.messages[0].id],false);
  const ids=[...selected];assert.equal(ids.length,285);
  await call('prepare',{ids:['demo-receipt'],filters:defaults},409);
  let batch=await call('prepare',{ids,filters:defaults});assert.equal(batch.total,285);assert.equal(batch.senders.length,1);
  await call('execute',{batchId:batch.id,confirm:false},400);
  await call('cancel',{batchId:batch.id});await call('execute',{batchId:batch.id,confirm:true},409);
  batch=await call('prepare',{ids,filters:defaults});await call('execute',{batchId:batch.id,confirm:true});
  await call('execute',{batchId:batch.id,confirm:true},409);
  state=await waitUntil(async()=>{const s=await call('state');return s.history.some(b=>b.id===batch.id&&b.status==='done')&&s.scan.status==='complete'?s:false;});
  const result=state.history.find(b=>b.id===batch.id);assert.deepEqual(result.counts,{success:285,skipped:0,failed:0,pending:0});
  const remaining=groupSenders(state.scan.messages,defaults,new Set(state.protected)).find(s=>s.email==='offers@nordandco.example');assert.equal(remaining.messages.length,1);assert.equal(remaining.messages[0].id,store.messages[0].id);
  await call('protect',{email:'news@everlane.example',protected:true});state=await call('state');assert.ok(state.protected.includes('news@everlane.example'));
  await call('prepare',{ids:['demo-1-0'],filters:defaults},409);
  await call('protect',{email:'news@everlane.example',protected:false});
  await call('disconnect',{});state=await call('state');assert.equal(state.connected,false);
  await call('demo',{});state=await call('state');assert.equal(state.history[0].counts.success,285);
  console.log('PASS: built localhost app → demo → complete multi-page scan → select sender → individual deselection → cancel → explicit confirmation → 285 sample messages moved → duplicate blocked → exact refreshed counts → protection → persisted history → exit demo.');
}catch(error){console.error(output);throw error;}
finally{child.kill('SIGTERM');await stopped;rmSync(directory,{recursive:true,force:true});}
