import { describe,it,expect } from 'vitest';
import { QuotaPacer } from '../src/lib/quota';
import { scanFailure,rateLimited,retryAfterMs,statusCode } from '../src/lib/diagnostics';
import { transient } from '../src/lib/engine';
describe('Large real inbox scan fixes',()=>{
  it('paces metadata and list calls by quota cost, including concurrent callers',async()=>{
    let clock=0;const starts:number[]=[],costs=[20,20,5,20];
    const pacer=new QuotaPacer(4800,()=>clock,async ms=>{clock+=ms;});
    await Promise.all(costs.map(cost=>pacer.wait(cost).then(()=>{starts.push(clock);})));
    expect(starts).toEqual([0,250,500,563]);
  });
  it('keeps a long scan within 4,800 metadata quota units per minute',async()=>{
    let clock=0;const starts:number[]=[];
    const pacer=new QuotaPacer(4800,()=>clock,async ms=>{clock+=ms;});
    await Promise.all(Array.from({length:501},()=>pacer.wait(20).then(()=>{starts.push(clock);})));
    expect(starts[240]).toBe(60_000);expect(starts[500]).toBe(125_000);
    for(const start of starts)expect(starts.filter(t=>t>=start&&t<start+60_000).length*20).toBeLessThanOrEqual(4800);
  });
  it('applies shared rate-limit cooldown and resumes paced requests without a burst',async()=>{
    let clock=0;const starts:number[]=[];
    const pacer=new QuotaPacer(4800,()=>clock,async ms=>{clock+=ms;});
    await pacer.wait(20);pacer.pause(60_000);
    await Promise.all([20,20,20].map(cost=>pacer.wait(cost).then(()=>{starts.push(clock);})));
    expect(starts).toEqual([60_000,60_250,60_500]);expect(pacer.retryAt).toBe(60_000);
  });
  it('recognizes Google quota reasons and respects integer/date Retry-After headers',()=>{
    const limited={response:{status:403,data:{error:{errors:[{reason:'userRateLimitExceeded'}]}}}};
    expect(rateLimited(limited)).toBe(true);expect(transient(limited)).toBe(true);
    expect(rateLimited({response:{status:403,data:{error:{errors:[{reason:'insufficientPermissions'}]}}}})).toBe(false);
    expect(retryAfterMs({response:{headers:new Headers({'Retry-After':'120'})}})).toBe(120_000);
    const at=Date.UTC(2026,10,22);expect(retryAfterMs({response:{headers:{'retry-after':new Date(at+90_000).toUTCString()}}},at)).toBe(90_000);
    expect(statusCode(new Error('offline'))).toBe(0);expect(statusCode(null)).toBe(0);
  });
  it('explains the failed scan phase and reason without leaking raw SDK or mailbox data',()=>{
    const error={message:'private-subject, private-address@example.com, private-token',config:{headers:{authorization:'Bearer private-token'}},response:{status:403,data:{error:{message:'private-token',errors:[{reason:'userRateLimitExceeded'}]}}}};
    const text=scanFailure(error,'metadata',297,4000);
    expect(text).toContain('297 of 4000');expect(text).toContain('GMAIL_RATE_LIMIT; HTTP 403; userRateLimitExceeded');expect(text).toContain('Cleanup is disabled');
    expect(text).not.toMatch(/private-|Bearer|authorization/);
    expect(scanFailure(new TypeError('sender private-token'),'metadata',4,10)).toContain('SCAN_TYPE_ERROR');
    expect(scanFailure(new TypeError('sender private-token'),'metadata',4,10)).not.toContain('private-token');
    expect(scanFailure({response:{status:401}},'listing',0,0)).toContain('GMAIL_AUTH_EXPIRED');
    expect(scanFailure({response:{status:403,data:{error:{errors:[{reason:'accessNotConfigured'}]}}}},'listing',0,0)).toContain('GMAIL_API_DISABLED');
  });
});
