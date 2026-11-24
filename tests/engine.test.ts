import { describe,it,expect,vi } from 'vitest';
import { eligible, groupSenders, toggleIds, defaults, cutoffFor, type Mail } from '../src/lib/domain';
import { parseMetadata } from '../src/lib/metadata';
import { executeBatch, scanMailbox, Limiter, requestWithBackoff, type Mailbox, type BatchItem } from '../src/lib/engine';
const now=Date.UTC(2026,10,22,12);
const message=(id:string,patch:Partial<Mail>={}):Mail=>({id,email:'offers@store.example',name:'Store',subject:'Promotion',receivedAt:now-50*86400000,labelIds:['INBOX','CATEGORY_PROMOTIONS'],...patch});
function mockMailbox(rows:Mail[]):Mailbox {
  const map=new Map(rows.map(m=>[m.id,structuredClone(m)]));
  return {list:vi.fn(async()=>({ids:[...map.keys()]})),get:vi.fn(async id=>{if(!map.has(id))throw Object.assign(new Error('gone'),{code:404});return structuredClone(map.get(id)!);}),trash:vi.fn(async id=>{const m=map.get(id)!;m.labelIds=['TRASH'];})};
}
describe('Eligibility and selection',()=>{
  it('1,2,3: excludes archived/starred/receipt but includes read and unread Promotions',async()=>{
    const rows=[message('read'),message('unread',{labelIds:['INBOX','CATEGORY_PROMOTIONS','UNREAD']}),message('starred',{labelIds:['INBOX','CATEGORY_PROMOTIONS','STARRED']}),message('archived',{labelIds:['CATEGORY_PROMOTIONS']}),message('receipt',{labelIds:['INBOX','CATEGORY_PERSONAL']})];
    const box=mockMailbox(rows),scan=await scanMailbox(box,()=>{});
    expect(scan.map(m=>m.id)).toEqual(['read','unread']);
    const items=scan.map(m=>({id:m.id,email:m.email,name:m.name,status:'pending' as const}));
    await executeBatch(box,items,null,()=>new Set(),()=>{});
    expect(vi.mocked(box.trash).mock.calls.map(([id])=>id).sort()).toEqual(['read','unread']);
    expect((await box.get('receipt')).labelIds).toContain('INBOX');
    expect((await box.get('starred')).labelIds).toContain('STARRED');
    expect((await box.get('archived')).labelIds).not.toContain('TRASH');
  });
  it('4: fetches every page, deduplicates and retrieves more than 500 metadata records',async()=>{
    const ids=Array.from({length:1203},(_,i)=>String(i));
    const box=mockMailbox(ids.map(id=>message(id)));
    box.list=vi.fn(async(token?:string)=>{const offset=Number(token??0);return{ids:[...ids.slice(offset,offset+500),...(offset?['0']:[])],next:offset+500<ids.length?String(offset+500):undefined};});
    const progress=vi.fn(),result=await scanMailbox(box,progress);
    expect(result).toHaveLength(1203);expect(new Set(result.map(m=>m.id)).size).toBe(1203);
    expect(box.list).toHaveBeenCalledTimes(3);expect(box.get).toHaveBeenCalledTimes(1203);
    expect(progress).toHaveBeenLastCalledWith({phase:'metadata',pages:3,fetched:1203,candidates:1203});
  });
  it('5: applies receipt-time age before counts; min/search filters and individual deselection return exact IDs',()=>{
    const rows=[message('old-1'),message('old-2'),message('recent',{receivedAt:now-2*86400000}),message('other',{email:'other@store.example',name:'Other'})];
    const groups=groupSenders(rows,{search:'OFFERS@',age:30,minimum:1},new Set(),now);
    expect(groups).toHaveLength(1);expect(groups[0].messages.map(m=>m.id)).toEqual(['old-1','old-2']);
    const selected=toggleIds(new Set(),groups[0].messages.map(m=>m.id),true);
    expect([...toggleIds(selected,['old-2'],false)]).toEqual(['old-1']);
    expect(groupSenders(rows,{search:'',age:30,minimum:3},new Set(),now)).toHaveLength(0);
    // Filter changes intentionally replace selection, rather than preserving hidden IDs.
    expect(toggleIds(selected,[...selected],false).size).toBe(0);
  });
  it('groups exact addresses with casing normalized and never merges a domain',()=>{
    const raw=(from:string,id:string)=>parseMetadata({id,internalDate:String(now-10),labelIds:['INBOX','CATEGORY_PROMOTIONS'],payload:{headers:[{name:'From',value:from},{name:'Subject',value:'=?UTF-8?B?SGVsbG8=?='}]}});
    const result=groupSenders([raw('"Store, Inc." <Offers@Store.Example>','1'),raw('Store <offers@store.example>','2'),raw('Store VIP <vip@store.example>','3')],defaults,new Set(),now);
    expect(result.map(s=>[s.email,s.messages.length])).toEqual([['offers@store.example',2],['vip@store.example',1]]);
    expect(result[0].messages[0].subject).toBe('Hello');
    expect(parseMetadata({id:'bad',payload:{headers:[{name:'from',value:'a@example.com, b@example.com'}]}}).email).toBe('');
  });
  it('6: protection excludes all messages for the exact address only',()=>{
    const rows=[message('1'),message('2',{email:'vip@store.example'})];
    expect(groupSenders(rows,defaults,new Set(['offers@store.example']),now).flatMap(s=>s.messages.map(m=>m.id))).toEqual(['2']);
  });
  it('7: rechecks all eligibility immediately before each individual trash call',async()=>{
    const original=Array.from({length:7},(_,i)=>message(String(i)));
    const changed=[message('0',{labelIds:['CATEGORY_PROMOTIONS']}),message('1',{labelIds:['INBOX']}),message('2',{labelIds:['INBOX','CATEGORY_PROMOTIONS','STARRED']}),message('3',{email:'protected@example.com'}),message('4',{receivedAt:now-2*86400000}),message('5'),message('6')];
    const box=mockMailbox(changed);
    const items:BatchItem[]=original.map(m=>({id:m.id,email:m.email,name:m.name,status:'pending'}));
    await executeBatch(box,items,cutoffFor(30,now),()=>new Set(['protected@example.com']),()=>{});
    expect(items.map(i=>i.status)).toEqual(['skipped','skipped','skipped','skipped','skipped','success','success']);
    expect(vi.mocked(box.trash).mock.calls.map(([id])=>id)).toEqual(['5','6']);
  });
  it('8: partial failures have accurate outcomes; retry processes failed IDs only',async()=>{
    const box=mockMailbox([message('good'),message('bad'),message('gone',{labelIds:['CATEGORY_PROMOTIONS']})]);
    const realTrash=box.trash;let shouldFail=true;
    box.trash=vi.fn(async id=>{if(id==='bad'&&shouldFail)throw Object.assign(new Error('temporary'),{code:503});await realTrash(id);});
    const items:BatchItem[]=['good','bad','gone'].map(id=>({id,email:'offers@store.example',name:'Store',status:'pending'}));
    await executeBatch(box,items,null,()=>new Set(),()=>{});
    expect(items.map(i=>i.status)).toEqual(['success','failed','skipped']);
    const retry=items.filter(i=>i.status==='failed').map(i=>({...i,status:'pending' as const}));shouldFail=false;vi.mocked(box.trash).mockClear();
    await executeBatch(box,retry,null,()=>new Set(),()=>{});
    expect(box.trash).toHaveBeenCalledExactlyOnceWith('bad');expect(retry[0].status).toBe('success');expect(items[1].status).toBe('failed');
  });
  it('does not return partial scan results when any metadata request fails',async()=>{
    const box=mockMailbox([message('1'),message('2')]);box.get=vi.fn(async id=>{if(id==='2')throw new Error('offline');return message(id);});
    await expect(scanMailbox(box,()=>{})).rejects.toThrow('offline');
  });
  it('bounds global request concurrency to five with retry backoff for transient limits',async()=>{
    const limiter=new Limiter(5);let active=0,max=0;
    await Promise.all(Array.from({length:31},()=>requestWithBackoff(async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;},async()=>{},limiter)));
    expect(max).toBe(5);
    let calls=0;const sleep=vi.fn(async()=>{});
    const value=await requestWithBackoff(async()=>{if(++calls<4)throw Object.assign(new Error('limit'),{code:429});return 'ok';},sleep);
    expect(value).toBe('ok');expect(sleep).toHaveBeenCalledTimes(3);
    const permanent=vi.fn(async()=>{throw Object.assign(new Error('denied'),{code:403});});
    await expect(requestWithBackoff(permanent,sleep)).rejects.toThrow('denied');expect(permanent).toHaveBeenCalledTimes(1);
  });
});
