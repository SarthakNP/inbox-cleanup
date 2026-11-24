import { OAuth2Client, type Credentials } from 'google-auth-library';
import { gmail } from 'googleapis/build/src/apis/gmail/index.js';
import { read, write } from './db';
import { encrypt, decrypt, key, origin } from './security';
import { AppError, isAuthError, requestWithBackoff, type Mailbox } from './engine';
import { parseMetadata } from './metadata';
import { gmailPacer } from './quota';
import { rateLimited,retryAfterMs } from './diagnostics';
export const scope = 'https://www.googleapis.com/auth/gmail.modify';
export type Account = { id: string; email: string; tokens: string; needsReconnect?: boolean };
export function oauth() {
  key();
  const id=process.env.GOOGLE_CLIENT_ID, secret=process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret || id.startsWith('your-') || secret.startsWith('your-')) throw new AppError('Gmail is not configured yet. Enter Google credentials in .env.local using the README, or try the labeled demo.',503);
  return new OAuth2Client(id,secret,`${origin()}/api/auth/google/callback`);
}
declare global { var inboxAuth: { id: string; client: OAuth2Client } | undefined; }
export function authorized(account: Account) {
  if (globalThis.inboxAuth?.id === account.id) return globalThis.inboxAuth.client;
  const client = oauth();
  client.setCredentials(decrypt<Credentials>(account.tokens));
  client.on('tokens',tokens => {
    const latest=read<Account>('account');
    if (latest?.id===account.id) {
      write('account',{...latest,tokens:encrypt({...decrypt<Credentials>(latest.tokens),...tokens}),needsReconnect:false});
    }
  });
  globalThis.inboxAuth={id:account.id,client};
  return client;
}
export function markAuthError(e: unknown, id: string) {
  const account=read<Account>('account');
  if (isAuthError(e) && account?.id===id) write('account',{...account,needsReconnect:true});
}
export async function revokeTokenSafely(client: OAuth2Client,token?:string|null) {
  if(!token)return;
  // The library's revokeToken helper places the token in a URL query string.
  // Use its official HTTP transport with Google's supported form-body endpoint instead.
  return requestWithBackoff(()=>client.transporter.request({
    url:'https://oauth2.googleapis.com/revoke',method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    data:new URLSearchParams({token}),retry:false,timeout:30_000
  }));
}
export async function revokeAccount(account: Account) {
  const credentials=decrypt<Credentials>(account.tokens);
  const token=credentials.refresh_token || credentials.access_token;
  if (!token) return;
  try { await revokeTokenSafely(authorized(account),token); }
  catch(e) {
    // Google reports invalid_token when access has already been revoked.
    if ((e as {response?:{data?:{error?:string}}}).response?.data?.error !== 'invalid_token') throw e;
  }
}
export function realMailbox(account: Account): Mailbox {
  const api=gmail({version:'v1',auth:authorized(account),retry:false,timeout:30_000});
  async function call<T>(cost:number,fn:()=>Promise<T>) {
    try { return await requestWithBackoff(async()=>{
      const pacer=gmailPacer();
      await pacer.wait(cost);
      try{return await fn();}
      catch(e){
        // Freeze all queued Gmail requests together; per-call retries alone can
        // continue flooding a minute-based quota. No emails are changed by a scan.
        if(rateLimited(e))pacer.pause(Math.max(60_000,retryAfterMs(e)));
        throw e;
      }
    }); }
    catch(e) { markAuthError(e,account.id); throw e; }
  }
  return {
    async list(pageToken) {
      const {data}=await call(5,()=>api.users.messages.list({userId:'me',labelIds:['INBOX','CATEGORY_PROMOTIONS'],q:'-is:starred',includeSpamTrash:false,maxResults:500,pageToken,fields:'messages/id,nextPageToken'}));
      return {ids:(data.messages??[]).flatMap(m=>m.id?[m.id]:[]),next:data.nextPageToken??undefined};
    },
    async get(id) {
      const {data}=await call(20,()=>api.users.messages.get({userId:'me',id,format:'metadata',metadataHeaders:['From','Subject'],fields:'id,internalDate,labelIds,payload/headers'}));
      return parseMetadata(data);
    },
    async trash(id) {
      await call(20,()=>api.users.messages.trash({userId:'me',id,fields:'id'}));
    },
    async checkedTrash(id,check){
      // Reserve both calls before reading metadata. Never let quota waiting or
      // retries separate the final eligibility check from the actual trash call.
      return call(40,async()=>{
        const {data}=await api.users.messages.get({userId:'me',id,format:'metadata',metadataHeaders:['From','Subject'],fields:'id,internalDate,labelIds,payload/headers'});
        if(!check(parseMetadata(data)))return false;
        await api.users.messages.trash({userId:'me',id,fields:'id'});return true;
      });
    }
  };
}
