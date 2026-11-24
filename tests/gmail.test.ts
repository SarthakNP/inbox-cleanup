import { describe,it,expect,vi,beforeEach,afterAll } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { NextRequest,NextResponse } from 'next/server';
const mocks=vi.hoisted(()=>({list:vi.fn(),get:vi.fn(),trash:vi.fn(),profile:vi.fn()}));
vi.mock('googleapis/build/src/apis/gmail/index.js',()=>({gmail:()=>({users:{messages:{list:mocks.list,get:mocks.get,trash:mocks.trash},getProfile:mocks.profile}})}));
import { realMailbox,authorized,scope,markAuthError,revokeAccount,type Account } from '../src/lib/gmail';
import { encrypt,decrypt,setSession } from '../src/lib/security';
import { read,write,db } from '../src/lib/db';
import { GET,POST } from '../src/app/api/[...action]/route';
import { GET as callback } from '../src/app/api/auth/google/callback/route';
import { scanMailbox,executeBatch,type BatchItem } from '../src/lib/engine';
import { QuotaPacer } from '../src/lib/quota';
import { startScan,getScan } from '../src/lib/service';
const dir=mkdtempSync(path.join(tmpdir(),'inbox-gmail-'));
process.env.DATA_DIR=dir;process.env.TOKEN_ENCRYPTION_KEY='ab'.repeat(32);process.env.APP_ORIGIN='http://localhost:3000';
process.env.GOOGLE_CLIENT_ID='mock-client-id';process.env.GOOGLE_CLIENT_SECRET='mock-client-secret';
const account=():Account=>({id:'test-account',email:'test@example.com',tokens:encrypt({access_token:'access',refresh_token:'refresh',expiry_date:Date.now()+3600000})});
const request=(url:string,options:NonNullable<ConstructorParameters<typeof NextRequest>[1]>={})=>new NextRequest(`http://localhost:3000/api/${url}`,{...options,headers:{host:'localhost:3000',...options.headers}});
beforeEach(()=>{vi.clearAllMocks();db().exec('DELETE FROM kv;DELETE FROM sessions;DELETE FROM protected;DELETE FROM batches;');globalThis.inboxAuth=undefined;globalThis.inboxScans=new Map();globalThis.inboxBusy=new Set();let clock=0;globalThis.inboxGmailPacer=new QuotaPacer(4800,()=>clock,async ms=>{clock+=ms;});});
afterAll(()=>{vi.restoreAllMocks();globalThis.inboxDb?.close();globalThis.inboxDb=undefined;rmSync(dir,{recursive:true,force:true});});
describe('Official Gmail adapter and OAuth',()=>{
  it('rechecks eligibility after a quota wait and again on a transient cleanup retry',async()=>{
    vi.useFakeTimers();
    try{
      const raw={id:'retailer-message',internalDate:'1700000000000',labelIds:['INBOX','CATEGORY_PROMOTIONS'],payload:{headers:[{name:'From',value:'Store <offers@store.example>'}]}};
      mocks.get.mockResolvedValueOnce({data:raw}).mockResolvedValue({data:{...raw,labelIds:['INBOX','CATEGORY_PROMOTIONS','STARRED']}});
      mocks.trash.mockRejectedValueOnce({response:{status:429}});
      const item:BatchItem={id:raw.id,email:'offers@store.example',name:'Store',status:'pending'};
      const task=executeBatch(realMailbox(account()),[item],null,()=>new Set(),()=>{});
      await vi.runAllTimersAsync();await task;
      expect(mocks.get).toHaveBeenCalledTimes(2);expect(mocks.trash).toHaveBeenCalledTimes(1);expect(item.status).toBe('skipped');
    }finally{vi.useRealTimers();}
  });
  it('pauses queued Gmail requests on a rate limit and retries after the shared cooldown',async()=>{
    vi.useFakeTimers();
    try{
      mocks.list.mockResolvedValue({data:{messages:[{id:'limited-message'}]}});
      mocks.get.mockRejectedValueOnce({response:{status:429,headers:new Headers({'Retry-After':'90'})}})
        .mockResolvedValue({data:{id:'limited-message',internalDate:'1700000000000',labelIds:['INBOX','CATEGORY_PROMOTIONS'],payload:{headers:[{name:'From',value:'Store <offers@store.example>'}]}}});
      const pause=vi.spyOn(globalThis.inboxGmailPacer!,'pause');
      const pending=scanMailbox(realMailbox(account()),()=>{});
      await vi.runAllTimersAsync();const found=await pending;
      expect(found).toHaveLength(1);expect(mocks.get).toHaveBeenCalledTimes(2);expect(pause).toHaveBeenCalledExactlyOnceWith(90_000);
    }finally{vi.useRealTimers();}
  });
  it('surfaces sanitized failure details and incomplete scan status through the real scan service',async()=>{
    const a=account();write('account',a);
    mocks.list.mockResolvedValue({data:{messages:[{id:'one'}]}});
    mocks.get.mockRejectedValue({message:'private-token private-subject',response:{status:403,data:{error:{errors:[{reason:'insufficientPermissions'}]}}}});
    startScan(`real:${a.id}`);
    await vi.waitFor(()=>expect(getScan(`real:${a.id}`).status).toBe('incomplete'));
    const scan=getScan(`real:${a.id}`);expect(scan.messages).toEqual([]);expect(scan.error).toContain('GMAIL_PERMISSION_DENIED; HTTP 403; insufficientPermissions');
    expect(scan.error).not.toContain('private-');expect(mocks.trash).not.toHaveBeenCalled();
  });
  it('uses INBOX + CATEGORY_PROMOTIONS minus starred, exact metadata fields, all pages, and message trash only',async()=>{
    mocks.list.mockImplementation(async args=>({data:{messages:Array.from({length:args.pageToken?1:500},(_,i)=>({id:String(args.pageToken?500:i)})),nextPageToken:args.pageToken?undefined:'second',resultSizeEstimate:99999}}));
    mocks.get.mockImplementation(async args=>({data:{id:args.id,internalDate:'1700000000000',labelIds:['INBOX','CATEGORY_PROMOTIONS','UNREAD'],payload:{headers:[{name:'From',value:'Store <offers@store.example>'},{name:'Subject',value:'Sale'}]}}}));
    mocks.trash.mockResolvedValue({data:{id:'0'}});
    const box=realMailbox(account());const found=await scanMailbox(box,()=>{});expect(found).toHaveLength(501);
    expect(mocks.list).toHaveBeenNthCalledWith(1,expect.objectContaining({labelIds:['INBOX','CATEGORY_PROMOTIONS'],q:'-is:starred',maxResults:500,includeSpamTrash:false}));
    expect(mocks.list).toHaveBeenNthCalledWith(2,expect.objectContaining({pageToken:'second'}));
    expect(mocks.get).toHaveBeenCalledWith(expect.objectContaining({format:'metadata',metadataHeaders:['From','Subject'],fields:'id,internalDate,labelIds,payload/headers'}));
    await box.trash('0');expect(mocks.trash).toHaveBeenCalledExactlyOnceWith({userId:'me',id:'0',fields:'id'});
  });
  it('persists refresh events as encrypted tokens and flags revoked authorization without demo fallback',async()=>{
    const a=account();write('account',a);const client=authorized(a);
    client.emit('tokens',{access_token:'rotated',expiry_date:123456});
    const stored=read<Account>('account')!;expect(stored.tokens).not.toContain('rotated');
    expect(decrypt(stored.tokens)).toMatchObject({access_token:'rotated',refresh_token:'refresh'});
    const revoked={response:{status:400,data:{error:'invalid_grant'}}};markAuthError(revoked,a.id);expect(read<Account>('account')?.needsReconnect).toBe(true);
    mocks.list.mockRejectedValue(revoked);await expect(realMailbox(a).list()).rejects.toEqual(revoked);expect(read('demo-messages')).toBeNull();
  });
  it('starts authorization code OAuth with only gmail.modify, offline access, state, and PKCE; callback rotates session',async()=>{
    const first=await GET(request('state'));const initial=await first.json();const cookie=first.cookies.getAll().map(c=>`${c.name}=${c.value}`).join('; ');
    expect(first.cookies.get('inbox_session')?.httpOnly).toBe(true);
    const result=await POST(request('auth/google',{method:'POST',headers:{cookie,origin:'http://localhost:3000','x-csrf-token':initial.csrf,'content-type':'application/json'},body:'{}'}));
    const url=new URL((await result.json()).url);expect(url.searchParams.get('scope')).toBe(scope);expect(url.searchParams.get('response_type')).toBe('code');expect(url.searchParams.get('access_type')).toBe('offline');expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/google/callback');
    const tokenSpy=vi.spyOn(OAuth2Client.prototype,'getToken').mockResolvedValue({tokens:{access_token:'test-access',refresh_token:'test-refresh',scope},res:null} as never);
    mocks.profile.mockResolvedValue({data:{emailAddress:'test@example.com'}});
    const out=await callback(request(`auth/google/callback?code=mock-code&state=${url.searchParams.get('state')}`,{headers:{cookie}}));
    expect(out.status).toBe(307);expect(out.headers.get('location')).toBe('http://localhost:3000/');
    expect(tokenSpy).toHaveBeenCalledWith(expect.objectContaining({code:'mock-code',codeVerifier:expect.any(String)}));
    expect(read<Account>('account')?.email).toBe('test@example.com');expect(read<Account>('account')?.tokens).not.toContain('test-refresh');
    expect(out.cookies.get('inbox_session')?.value).not.toBe(first.cookies.get('inbox_session')?.value);
    // OAuth state is single-use even if an authorization response is replayed.
    const replay=await callback(request(`auth/google/callback?code=mock-code&state=${url.searchParams.get('state')}`,{headers:{cookie}}));expect(replay.headers.get('location')).toContain('could+not+be+verified');tokenSpy.mockRestore();
  });
  it('disconnect revokes the refresh token, clears local account data, and handles already revoked grants',async()=>{
    const a=account();write('account',a);
    const revoke=vi.spyOn(authorized(a).transporter,'request').mockResolvedValue({data:{}} as never);
    await revokeAccount(a);expect(revoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url:'https://oauth2.googleapis.com/revoke',method:'POST',data:expect.any(URLSearchParams)}));
    const options=revoke.mock.calls[0][0]!;expect(options.url).not.toContain('refresh');expect((options.data as URLSearchParams).get('token')).toBe('refresh');
    revoke.mockRejectedValueOnce({response:{status:400,data:{error:'invalid_token'}}});await expect(revokeAccount(a)).resolves.toBeUndefined();
    revoke.mockResolvedValue({data:{}} as never);
    const cookieResponse=NextResponse.json({}),s=setSession(cookieResponse,`real:${a.id}`);
    const cookie=cookieResponse.cookies.getAll().map(c=>`${c.name}=${c.value}`).join('; ');
    db().prepare('INSERT INTO protected(scope,email) VALUES(?,?)').run(s.scope,'keep@example.com');
    write(`settings:${s.scope}`,{search:'saved'});write(`last-scan:${s.scope}`,Date.now());write('demo-messages',['isolated-demo']);
    const out=await POST(request('disconnect',{method:'POST',headers:{cookie,origin:'http://localhost:3000','x-csrf-token':s.csrf,'content-type':'application/json'},body:'{}'}));
    expect(out.status).toBe(200);expect(read('account')).toBeNull();expect(read(`settings:${s.scope}`)).toBeNull();expect(read(`last-scan:${s.scope}`)).toBeNull();
    expect(db().prepare('SELECT * FROM protected WHERE scope=?').all(s.scope)).toHaveLength(0);expect(db().prepare('SELECT * FROM sessions WHERE scope=?').all(s.scope)).toHaveLength(0);
    expect(read('demo-messages')).toEqual(['isolated-demo']);revoke.mockRestore();
  });
});
