import { randomUUID } from 'node:crypto';
import { db, read, write, protection } from './db';
import { AppError, executeBatch, scanMailbox, type BatchItem, type ScanProgress } from './engine';
import { cutoffFor, defaults, groupSenders, selectedSummary, type Filters, type Mail } from './domain';
import { demoMailbox } from './demo';
import { realMailbox, type Account } from './gmail';
import { scanFailure } from './diagnostics';
import { gmailPacer } from './quota';
export type Scan = { id: string; status: 'idle'|'running'|'complete'|'incomplete'; progress: ScanProgress; messages: Mail[]; lastSuccess: number|null; error?: string; revision: string; retryAt?:number };
export type Batch = { id: string; scope: string; status: 'awaiting'|'running'|'done'|'cancelled'; createdAt: number; cutoff: number|null; scanId: string; items: BatchItem[]; retryOf?: string };
declare global { var inboxScans: Map<string,Scan> | undefined; var inboxBusy: Set<string> | undefined; }
const scans=()=>globalThis.inboxScans??(globalThis.inboxScans=new Map());
const busy=()=>globalThis.inboxBusy??(globalThis.inboxBusy=new Set());
export function ensureFree(scope:string) { if(busy().has(scope)) throw new AppError('Wait for the current scan or cleanup to finish.',409); }
export function getScan(scope:string): Scan {
  if(!scans().has(scope)) scans().set(scope,{id:randomUUID(),status:'idle',progress:{phase:'listing',pages:0,fetched:0,candidates:0},messages:[],lastSuccess:read<number>(`last-scan:${scope}`),revision:randomUUID()});
  const scan=scans().get(scope)!;
  scan.retryAt=scan.status==='running'&&scope.startsWith('real:')&&gmailPacer().retryAt>Date.now()?gmailPacer().retryAt:undefined;
  return scan;
}
export function mailbox(scope:string) {
  if(scope==='demo') return demoMailbox();
  const account=read<Account>('account');
  if(!account || scope!==`real:${account.id}`) throw new AppError('Connect Gmail to continue.',401);
  return realMailbox(account);
}
export function startScan(scope:string) {
  ensureFree(scope);
  const client=mailbox(scope), scan=getScan(scope);
  Object.assign(scan,{id:randomUUID(),status:'running',error:undefined,messages:[],revision:randomUUID(),progress:{phase:'listing',pages:0,fetched:0,candidates:0}});
  busy().add(scope);
  // Background work is process-local; run one Next.js process for this local app.
  void (async()=>{
    try {
      const messages=await scanMailbox(client,p=>{scan.progress=p;});
      scan.messages=messages; scan.status='complete'; scan.lastSuccess=Date.now();
      write(`last-scan:${scope}`,scan.lastSuccess);
    } catch(e) { scan.status='incomplete'; scan.messages=[]; scan.error=scanFailure(e,scan.progress.phase,scan.progress.fetched,scan.progress.candidates); }
    finally { scan.revision=randomUUID(); busy().delete(scope); }
  })();
  return scan;
}
export function parseFilters(value:unknown): Filters {
  const f=value as Filters;
  if(!f || typeof f.search!=='string' || f.search.length>200 || ![0,30,90,365].includes(f.age) || ![1,10,50,100].includes(f.minimum)) throw new AppError('Invalid filters.');
  return {search:f.search,age:f.age,minimum:f.minimum};
}
export function saveBatch(batch:Batch) {
  const {items,...metadata}=batch,d=db();
  d.exec('BEGIN');
  try {
    // UPSERT preserves child rows; REPLACE would cascade-delete them.
    d.prepare('INSERT INTO batches(id,scope,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
      .run(batch.id,batch.scope,JSON.stringify(metadata));
    const statement=d.prepare(`INSERT INTO batch_items(batch_id,id,email,name,status,reason) VALUES(?,?,?,?,?,?)
      ON CONFLICT(batch_id,id) DO UPDATE SET status=excluded.status,reason=excluded.reason
      WHERE batch_items.status!=excluded.status OR batch_items.reason IS NOT excluded.reason`);
    for(const item of items) statement.run(batch.id,item.id,item.email,item.name,item.status,item.reason??null);
    d.exec('COMMIT');
  } catch(e) { d.exec('ROLLBACK');throw e; }
}
export function getBatch(scope:string,id:string) {
  const row=db().prepare('SELECT payload FROM batches WHERE id=? AND scope=?').get(id,scope) as {payload:string}|undefined;
  if(!row) throw new AppError('Batch not found.',404);
  const metadata=JSON.parse(row.payload);
  const items=db().prepare('SELECT id,email,name,status,reason FROM batch_items WHERE batch_id=? ORDER BY rowid').all(id) as BatchItem[];
  return {...metadata,items} as Batch;
}
export function prepareBatch(scope:string,ids:unknown,filters:Filters,retryOf?:string) {
  ensureFree(scope);
  if(!Array.isArray(ids) || !ids.length || ids.some(x=>typeof x!=='string' || !x || x.length>200) || new Set(ids).size!==ids.length) throw new AppError('Select unique valid message IDs.');
  const scan=getScan(scope);
  if(scan.status!=='complete') throw new AppError('Complete a successful scan before preparing cleanup.',409);
  const cutoff=cutoffFor(filters.age);
  const protectedEmails=protection(scope);
  const allowed=new Map(groupSenders(scan.messages,filters,protectedEmails).flatMap(s=>s.messages.map(m=>[m.id,m] as const)));
  let retry:Batch|undefined;
  if(retryOf) {
    retry=getBatch(scope,retryOf);
    if(retry.status!=='done') throw new AppError('Only finished batches can be retried.',409);
    const failed=new Set(retry.items.filter(i=>i.status==='failed').map(i=>i.id));
    if(ids.some(id=>!failed.has(id))) throw new AppError('Retries can only include failed messages.');
  }
  const previousItems=new Map(retry?.items.map(i=>[i.id,i])??[]);
  const items:BatchItem[]=ids.map(id=>{
    // Failed originals may no longer appear in the current scan. Recheck them at execution.
    const prior=previousItems.get(id),previous=prior?.status==='failed'?prior:undefined;
    const m=allowed.get(id);
    if(protectedEmails.has((m??previous)?.email??'') || (!m&&!previous)) throw new AppError('Selection contains a protected sender or messages outside the eligible scan results. Refresh your selection.',409);
    return {id,email:(m??previous)!.email,name:(m??previous)!.name,status:'pending'};
  });
  const batch:Batch={id:randomUUID(),scope,status:'awaiting',createdAt:Date.now(),cutoff:retry?retry.cutoff:cutoff,scanId:scan.id,items,retryOf};
  // One outstanding confirmation; a stale dialog cannot later execute a different batch.
  const awaiting=db().prepare('SELECT id,payload FROM batches WHERE scope=?').all(scope) as {id:string;payload:string}[];
  for(const row of awaiting) { const old=JSON.parse(row.payload) as Batch; if(old.status==='awaiting'){old.status='cancelled';db().prepare('UPDATE batches SET payload=? WHERE id=?').run(JSON.stringify(old),row.id);} }
  saveBatch(batch); return batch;
}
export function startBatch(scope:string,id:string) {
  ensureFree(scope);
  const batch=getBatch(scope,id);
  if(batch.status!=='awaiting' || Date.now()-batch.createdAt>15*60_000) throw new AppError('This confirmation has expired or was already used. Review the selection again.',409);
  const scan=getScan(scope);
  if(scan.status!=='complete' || batch.scanId!==scan.id) throw new AppError('The scan changed. Review your selection again.',409);
  const client=mailbox(scope);
  batch.status='running'; saveBatch(batch); busy().add(scope);
  void (async()=>{
    try { await executeBatch(client,batch.items,batch.cutoff,()=>protection(scope),item=>{
      db().prepare('UPDATE batch_items SET status=?,reason=? WHERE batch_id=? AND id=?').run(item.status,item.reason??null,batch.id,item.id);
    }); }
    catch { for(const item of batch.items) if(item.status==='pending'){item.status='failed';item.reason='Processing interrupted. Please retry.';} }
    finally {
      batch.status='done';saveBatch(batch);
      // Keep failures visible; remove successful/skipped items and refresh explicitly as needed.
      const removed=new Set(batch.items.filter(i=>i.status==='success'||i.status==='skipped').map(i=>i.id));
      scan.messages=scan.messages.filter(m=>!removed.has(m.id));scan.revision=randomUUID();
      busy().delete(scope);
      // Rebuild exact current counts after every batch, including failures.
      startScan(scope);
    }
  })();
  return batch;
}
export function publicBatch(batch:Batch) {
  const counts={success:0,skipped:0,failed:0,pending:0};
  for(const item of batch.items) counts[item.status]++;
  return {id:batch.id,status:batch.status,createdAt:batch.createdAt,counts,total:batch.items.length,
    senders:selectedSummary(batch.items.map(i=>({...i,subject:'',receivedAt:0,labelIds:[]})),new Set(batch.items.map(i=>i.id))),
    failed:batch.items.filter(i=>i.status==='failed').map(i=>({id:i.id,reason:i.reason})),
    skipped:batch.items.filter(i=>i.status==='skipped').map(i=>({id:i.id,reason:i.reason})),retryOf:batch.retryOf};
}
export function history(scope:string) {
  return (db().prepare('SELECT id,payload FROM batches WHERE scope=? ORDER BY rowid DESC').all(scope) as {id:string;payload:string}[])
    .filter(r=>['running','done'].includes(JSON.parse(r.payload).status)).map(r=>publicBatch(getBatch(scope,r.id)));
}
export function clearScope(scope:string) {
  ensureFree(scope);
  db().prepare('DELETE FROM sessions WHERE scope=?').run(scope);
  db().prepare('DELETE FROM protected WHERE scope=?').run(scope);
  db().prepare('DELETE FROM batches WHERE scope=?').run(scope);
  db().prepare('DELETE FROM kv WHERE key IN (?,?)').run(`settings:${scope}`,`last-scan:${scope}`);
  scans().delete(scope);
}
export function settings(scope:string) { return read<Filters>(`settings:${scope}`)??defaults; }
