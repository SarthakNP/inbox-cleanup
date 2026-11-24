import { describe,it,expect,beforeEach,afterAll,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { GET,POST } from '../src/app/api/[...action]/route';
import { GET as callback } from '../src/app/api/auth/google/callback/route';
import { db,read,write,protection } from '../src/lib/db';
import { encrypt,decrypt } from '../src/lib/security';
import { getScan,prepareBatch,startBatch,getBatch,publicBatch,parseFilters,saveBatch } from '../src/lib/service';
import { sampleMessages } from '../src/lib/demo';
import { defaults,type Mail } from '../src/lib/domain';
const directory=mkdtempSync(path.join(tmpdir(),'inbox-test-'));
process.env.DATA_DIR=directory;process.env.TOKEN_ENCRYPTION_KEY='ab'.repeat(32);process.env.APP_ORIGIN='http://localhost:3000';
const req=(url:string,method='GET',body?:unknown,cookie='',csrf='')=>new NextRequest(`http://localhost:3000/api/${url}`,{method,headers:{host:'localhost:3000',origin:'http://localhost:3000',cookie,'content-type':'application/json','x-csrf-token':csrf},...(body?{body:JSON.stringify(body)}:{})});
async function loginDemo(){
  const res=await GET(req('state'));const init=await res.json();const cookie=res.cookies.getAll().map(c=>`${c.name}=${c.value}`).join('; ');
  const demo=await POST(req('demo','POST',{},cookie,init.csrf));expect(demo.status).toBe(200);
  const nextCookie=demo.cookies.getAll().map(c=>`${c.name}=${c.value}`).join('; ');
  const state=await (await GET(req('state','GET',undefined,nextCookie))).json();
  return {cookie:nextCookie,csrf:state.csrf};
}
beforeEach(()=>{db().exec('DELETE FROM kv;DELETE FROM sessions;DELETE FROM protected;DELETE FROM batches;');globalThis.inboxScans=new Map();globalThis.inboxBusy=new Set();});
afterAll(()=>{globalThis.inboxDb?.close();globalThis.inboxDb=undefined;rmSync(directory,{recursive:true,force:true});});
describe('HTTP security and persisted local workflow',()=>{
  it('requires session, correct origin, and CSRF token for every mutation',async()=>{
    expect((await POST(req('demo','POST',{}))).status).toBe(403);
    const s=await loginDemo();expect((await POST(req('scan','POST',{},s.cookie,'wrong'))).status).toBe(403);
    const bad=req('scan','POST',{},s.cookie,s.csrf);bad.headers.set('origin','http://evil.example');expect((await POST(bad)).status).toBe(403);
    const host=req('state');host.headers.set('host','evil.example');expect((await GET(host)).status).toBe(403);
    const state=await GET(req('state','GET',undefined,s.cookie));expect(state.headers.get('set-cookie')).toBeNull();
  });
  it('encrypts tokens with authenticated encryption; wrong keys and tampering fail',()=>{
    const raw={refresh_token:'private-refresh',access_token:'private-access'};const encrypted=encrypt(raw);
    expect(encrypted).not.toContain('private');expect(decrypt(encrypted)).toEqual(raw);
    const tampered=Buffer.from(encrypted,'base64');tampered[30]^=1;expect(()=>decrypt(tampered.toString('base64'))).toThrow();
    const prior=process.env.TOKEN_ENCRYPTION_KEY;process.env.TOKEN_ENCRYPTION_KEY='cd'.repeat(32);expect(()=>decrypt(encrypted)).toThrow();process.env.TOKEN_ENCRYPTION_KEY=prior;
  });
  it('rejects OAuth callbacks with missing/mismatched state before making any Google calls',async()=>{
    const res=await GET(req('state'));const cookie=res.cookies.getAll().map(c=>`${c.name}=${c.value}`).join('; ');
    const out=await callback(req('auth/google/callback?code=fake&state=invalid','GET',undefined,cookie));
    expect(out.status).toBe(307);expect(out.headers.get('location')).toContain('could+not+be+verified');expect(read('account')).toBeNull();
  });
  it('demo mode stays separate from a saved Gmail account and persists protection/settings/history',async()=>{
    write('account',{id:'real',email:'real@example.com',tokens:encrypt({refresh_token:'test'})});
    const s=await loginDemo();const scan=getScan('demo');Object.assign(scan,{status:'complete',messages:sampleMessages(),revision:'loaded'});
    const id=scan.messages.find(m=>m.id==='demo-0-0')!.id;
    const saved=await POST(req('settings','POST',{filters:{search:'Nord',age:30,minimum:10}},s.cookie,s.csrf));expect(saved.status).toBe(200);
    const protectedResult=await POST(req('protect','POST',{email:'offers@nordandco.example',protected:true},s.cookie,s.csrf));expect(protectedResult.status).toBe(200);expect(protection('demo').has('offers@nordandco.example')).toBe(true);
    expect(()=>prepareBatch('demo',[id],defaults)).toThrow('protected');
    expect(read<{email:string}>('account')?.email).toBe('real@example.com');
    const out=await GET(req('state','GET',undefined,s.cookie));const state=await out.json();expect(state.mode).toBe('demo');expect(state.settings.age).toBe(30);expect(state.protected).toContain('hello@fieldnotes.example');
    await POST(req('disconnect','POST',{},s.cookie,s.csrf));expect(read('account')).not.toBeNull();
  });
  it('rejects IDs outside a completed scan, receipts, protected senders, and invalid filters',()=>{
    const scan=getScan('demo');scan.status='running';scan.messages=sampleMessages();
    expect(()=>prepareBatch('demo',['demo-0-0'],defaults)).toThrow('successful scan');scan.status='complete';
    expect(()=>prepareBatch('demo',['not-my-message'],defaults)).toThrow('outside');expect(()=>prepareBatch('demo',['demo-receipt'],defaults)).toThrow('outside');
    expect(()=>prepareBatch('demo',['demo-starred'],defaults)).toThrow('outside');expect(()=>prepareBatch('demo',['demo-archived'],defaults)).toThrow('outside');
    expect(()=>parseFilters({search:'',age:7,minimum:1})).toThrow('Invalid filters');
  });
  it('freezes message IDs at confirmation, enforces one execution, and rechecks newly protected senders',async()=>{
    write('demo-messages',sampleMessages());const scan=getScan('demo');scan.status='complete';scan.messages=sampleMessages();
    const selected=['demo-0-0','demo-1-0'];const batch=prepareBatch('demo',selected,defaults);
    const late={...scan.messages[0],id:'late-arrival'};scan.messages.push(late);write('demo-messages',[...(read<Mail[]>('demo-messages')!),late]);
    db().prepare('INSERT INTO protected(scope,email) VALUES(?,?)').run('demo','offers@nordandco.example');
    startBatch('demo',batch.id);expect(()=>startBatch('demo',batch.id)).toThrow();
    await vi.waitFor(()=>expect(getBatch('demo',batch.id).status).toBe('done'));
    const done=publicBatch(getBatch('demo',batch.id));expect(done.total).toBe(2);expect(done.counts).toEqual({success:1,skipped:1,failed:0,pending:0});
    expect(read<Mail[]>('demo-messages')!.find(m=>m.id==='late-arrival')!.labelIds).not.toContain('TRASH');
    await vi.waitFor(()=>expect(getScan('demo').status).toBe('complete'));
    expect(()=>startBatch('demo',batch.id)).toThrow('already used');
    const s=await loginDemo();const state=await (await GET(req('state','GET',undefined,s.cookie))).json();expect(state.history[0].counts.success).toBe(1);
  });
  it('retries only failed IDs and preserves the original age cutoff',()=>{
    const scan=getScan('demo');scan.status='complete';scan.messages=sampleMessages();
    const original=prepareBatch('demo',['demo-0-20','demo-1-20'],{...defaults,age:30});original.status='done';original.items[0].status='success';original.items[1].status='failed';
    // Persist simulated partial API outcome, then exercise real retry validation.
    saveBatch(original);
    expect(()=>prepareBatch('demo',['demo-0-20'],defaults,original.id)).toThrow('only include failed');
    const retry=prepareBatch('demo',['demo-1-20'],defaults,original.id);expect(retry.cutoff).toBe(original.cutoff);expect(retry.items.map(i=>i.id)).toEqual(['demo-1-20']);
  });
});
