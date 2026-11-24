import { randomUUID } from 'node:crypto';
import type { Credentials } from 'google-auth-library';
import { NextRequest, NextResponse } from 'next/server';
import { db, read, write, remove } from '@/lib/db';
import { oauth, scope, revokeTokenSafely, type Account } from '@/lib/gmail';
import { origin, session, validateHost, safeEqual, encrypt, decrypt, setSession } from '@/lib/security';
import { gmail } from 'googleapis/build/src/apis/gmail/index.js';
import { AppError, requestWithBackoff } from '@/lib/engine';
import { ensureFree } from '@/lib/service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(req:NextRequest) {
  try {
    validateHost(req);
    const s=session(req);
    const pending=s?read<{state:string;codeVerifier:string;expires:number}>(`oauth:${s.id}`):null;
    if(s) remove(`oauth:${s.id}`);
    if(!s||!pending||pending.expires<Date.now()||!safeEqual(pending.state,req.nextUrl.searchParams.get('state')??'')) throw new AppError('Google sign-in could not be verified. Please connect again.');
    if(req.nextUrl.searchParams.has('error')) throw new AppError('Google sign-in was cancelled or permission was not granted.');
    const code=req.nextUrl.searchParams.get('code');
    if(!code) throw new AppError('Google did not return an authorization code.');
    const previous=read<Account>('account');
    if(previous)ensureFree(`real:${previous.id}`);
    const client=oauth();
    const {tokens}=await client.getToken({code,codeVerifier:pending.codeVerifier});
    client.setCredentials(tokens);
    const granted=tokens.scope?.split(' ')??[];
    if(!granted.includes(scope)) { await revokeTokenSafely(client,tokens.refresh_token??tokens.access_token).catch(()=>{}); throw new AppError('Gmail modify permission is required. Reconnect and allow the requested Gmail permission.'); }
    const {data}=await requestWithBackoff(()=>gmail({version:'v1',auth:client,retry:false,timeout:30_000}).users.getProfile({userId:'me',fields:'emailAddress'}));
    if(!data.emailAddress) throw new AppError('Google did not return the Gmail address.');
    if(previous&&previous.email.toLowerCase()!==data.emailAddress.toLowerCase()) {
      await revokeTokenSafely(client,tokens.refresh_token??tokens.access_token).catch(()=>{});
      throw new AppError('Only one Gmail account is supported. Disconnect the existing account first.');
    }
    const merged={...(previous?decrypt<Credentials>(previous.tokens):{}),...tokens};
    if(!merged.refresh_token) throw new AppError('Google did not provide offline access. Remove Inbox Cleanup from your Google account connections, then connect again.');
    const account:Account={id:previous?.id??randomUUID(),email:data.emailAddress,tokens:encrypt(merged),needsReconnect:false};
    if(previous)ensureFree(`real:${previous.id}`);
    write('account',account);globalThis.inboxAuth=undefined;
    db().prepare('DELETE FROM sessions WHERE id=?').run(s.id);
    const res=NextResponse.redirect(`${origin()}/`); setSession(res,`real:${account.id}`);return res;
  } catch(e) {
    const url=new URL('/',origin());
    url.searchParams.set('error',e instanceof AppError?e.message:'Google authorization failed. Check credentials, callback URL, and consent permissions, then reconnect.');
    return NextResponse.redirect(url);
  }
}
