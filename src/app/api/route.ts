import { NextRequest, NextResponse } from 'next/server';
import { CodeChallengeMethod } from 'google-auth-library';
import { db, read, write, remove, protection } from '@/lib/db';
import { cookieName, session, setSession, mutation, validateHost, nonce } from '@/lib/security';
import { revokeAccount, oauth, scope as gmailScope, type Account } from '@/lib/gmail';
import { AppError, requestWithBackoff } from '@/lib/engine';
import { initDemo } from '@/lib/demo';
import { getScan, startScan, ensureFree, parseFilters, prepareBatch, getBatch, saveBatch, startBatch, publicBatch, history, clearScope, settings } from '@/lib/service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
function failure(e:unknown) {
  return NextResponse.json({error:e instanceof AppError?e.message:'The request could not be completed. Check your local configuration and try again.'},{status:e instanceof AppError?e.status:500});
}
export async function GET(req:NextRequest) {
  try {
    validateHost(req);
    if(req.nextUrl.pathname!=='/api/state') throw new AppError('Not found.',404);
    const cookieResponse=NextResponse.json({});
    const s=session(req)??setSession(cookieResponse);
    const account=read<Account>('account');
    const connected=s.scope==='demo'||(account && s.scope===`real:${account.id}`);
    const scan=connected?getScan(s.scope):null;
    const body={csrf:s.csrf,connected:!!connected,mode:s.scope==='demo'?'demo':'real',email:connected?(s.scope==='demo'?'you@demo.example':account?.email):null,
      needsReconnect:connected&&s.scope!=='demo'&&!!account?.needsReconnect,
      settings:connected?settings(s.scope):undefined,protected:connected?[...protection(s.scope)]:[],history:connected?history(s.scope):[],
      scan:scan?{...scan,messages:scan.status==='complete'&&req.nextUrl.searchParams.get('revision')!==scan.revision?scan.messages:undefined}:null};
    const res=NextResponse.json(body);
    for(const c of cookieResponse.cookies.getAll()) res.cookies.set(c);
    return res;
  } catch(e) { return failure(e); }
}
export async function POST(req:NextRequest) {
  try {
    const s=session(req); mutation(req,s);
    if(!s) throw new AppError('Reload the page.',401);
    if(Number(req.headers.get('content-length'))>20_000_000) throw new AppError('Request too large.',413);
    const body=await req.json();
    const action=req.nextUrl.pathname.slice('/api/'.length);
    if(action==='auth/google') {
      if(s.scope!=='visitor') ensureFree(s.scope);
      const client=oauth(); const state=nonce();
      const {codeVerifier,codeChallenge}=await client.generateCodeVerifierAsync();
      write(`oauth:${s.id}`,{state,codeVerifier,expires:Date.now()+10*60_000});
      const url=client.generateAuthUrl({access_type:'offline',scope:[gmailScope],prompt:'consent',state,code_challenge:codeChallenge,code_challenge_method:CodeChallengeMethod.S256,include_granted_scopes:false});
      return NextResponse.json({url});
    }
    if(action==='demo') {
      if(s.scope!=='visitor') throw new AppError('Disconnect the current account before entering demo mode.',409);
      initDemo(); const res=NextResponse.json({ok:true});
      db().prepare('DELETE FROM sessions WHERE id=?').run(s.id); setSession(res,'demo');
      return res;
    }
    const account=read<Account>('account');
    if(s.scope!=='demo'&&(!account||s.scope!==`real:${account.id}`)) throw new AppError('Connect Gmail or enter demo mode first.',401);
    switch(action) {
      case 'scan': startScan(s.scope); return NextResponse.json({ok:true});
      case 'settings': {
        const filters=parseFilters(body.filters); write(`settings:${s.scope}`,filters); return NextResponse.json({ok:true});
      }
      case 'protect': {
        if(typeof body.email!=='string'||body.email.length>320||!body.email.includes('@')||typeof body.protected!=='boolean') throw new AppError('Invalid sender.');
        const email=body.email.toLowerCase();
        if(body.protected) {
          if(!getScan(s.scope).messages.some(m=>m.email===email)) throw new AppError('Sender is outside this scan.',409);
          db().prepare('INSERT OR IGNORE INTO protected(scope,email) VALUES(?,?)').run(s.scope,email);
        } else db().prepare('DELETE FROM protected WHERE scope=? AND email=?').run(s.scope,email);
        return NextResponse.json({ok:true});
      }
      case 'prepare': {
        return NextResponse.json(publicBatch(prepareBatch(s.scope,body.ids,parseFilters(body.filters))));
      }
      case 'retry': {
        if(typeof body.batchId!=='string') throw new AppError('Invalid batch.');
        const previous=getBatch(s.scope,body.batchId);
        const ids=previous.items.filter(i=>i.status==='failed'&&!protection(s.scope).has(i.email)).map(i=>i.id);
        if(!ids.length) throw new AppError('No unprotected failed messages remain to retry.',409);
        return NextResponse.json(publicBatch(prepareBatch(s.scope,ids,settings(s.scope),previous.id)));
      }
      case 'execute': {
        if(typeof body.batchId!=='string'||body.confirm!==true) throw new AppError('Explicit confirmation is required.');
        return NextResponse.json(publicBatch(startBatch(s.scope,body.batchId)));
      }
      case 'cancel': {
        if(typeof body.batchId!=='string') throw new AppError('Invalid batch.');
        const batch=getBatch(s.scope,body.batchId);
        if(batch.status==='awaiting'){batch.status='cancelled';saveBatch(batch);} return NextResponse.json({ok:true});
      }
      case 'disconnect': {
        ensureFree(s.scope);
        if(s.scope!=='demo'&&account) {
          try { await revokeAccount(account); }
          catch { throw new AppError('Google could not confirm revocation. Check your connection and try Disconnect again. Your local connection has been retained so revocation can be retried.',502); }
          clearScope(s.scope);remove('account');globalThis.inboxAuth=undefined;
          db().prepare("DELETE FROM kv WHERE key LIKE 'oauth:%'").run();
          db().exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } else db().prepare('DELETE FROM sessions WHERE id=?').run(s.id);
        const res=NextResponse.json({ok:true});res.cookies.delete(cookieName);setSession(res);return res;
      }
      default: throw new AppError('Not found.',404);
    }
  } catch(e) { return failure(e); }
}
