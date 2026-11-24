/**
 * New Google projects: 6,000 Gmail quota units/user/minute; metadata get and
 * trash each cost 20 units. Reserve 20% headroom and spread work smoothly.
 * Concurrency alone cannot enforce a quota measured over time.
 */
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export class QuotaPacer {
  private tail:Promise<void>=Promise.resolve();
  private nextStart=0;
  private blockedUntil=0;
  constructor(private unitsPerMinute=4800,private now=()=>Date.now(),private sleep=delay) {
    if(!Number.isFinite(unitsPerMinute)||unitsPerMinute<=0)throw new Error('Invalid quota budget.');
  }
  get retryAt(){return this.blockedUntil;}
  pause(ms:number){this.blockedUntil=Math.max(this.blockedUntil,this.now()+Math.max(0,ms));}
  wait(cost:number):Promise<void>{
    if(!Number.isFinite(cost)||cost<=0)return Promise.reject(new Error('Invalid quota cost.'));
    const turn=this.tail.then(async()=>{
      // Re-evaluate after sleeping: another in-flight request may have hit a limit.
      for(;;){
        const wait=Math.max(this.nextStart,this.blockedUntil)-this.now();
        if(wait<=0)break;
        await this.sleep(wait);
      }
      this.nextStart=this.now()+Math.ceil(cost*60_000/this.unitsPerMinute);
    });
    this.tail=turn.catch(()=>{});return turn;
  }
}
declare global { var inboxGmailPacer: QuotaPacer|undefined; }
export const gmailPacer=()=>globalThis.inboxGmailPacer??(globalThis.inboxGmailPacer=new QuotaPacer());
