import type { Mail } from './domain';
import type { Mailbox } from './engine';
import { read, write, db } from './db';
export function sampleMessages(now=Date.now()): Mail[] {
  const senders: [string,string,number,string[]][] = [
    ['Nord & Co.','offers@nordandco.example',286,['Your weekend edit is here','A little something, just for you','Last hours: the seasonal sale']],
    ['Everlane','news@everlane.example',214,['Good things, better prices','The pieces you’ll wear on repeat','Your next everyday essential']],
    ['Airbnb','inspiration@airbnb.example',162,['A change of scenery is calling','Your next weekend away','Places worth adding to your list']],
    ['adidas','offers@adidas.example',128,['Members get more','Your favorites. A fresh price.','Ready for your next move?']],
    ['The Daily Edit','hello@dailyedit.example',96,['The best of this week','Our editors’ latest finds','A few things we think you’ll love']],
    ['DoorDash','promotions@doordash.example',84,['Dinner plans, sorted','Something delicious is waiting','A treat for your next order']],
    ['West Elm','news@westelm.example',63,['Make a little room for something new','A fresh take on your space','Your weekend home refresh']],
    ['Spotify','updates@spotify.example',51,['Made for your next favorite moment','Your listening, reimagined','A little more music in your day']],
    ['Nord & Co.','vip@nordandco.example',31,['An invitation for our members','Early access starts today','Your member preview']],
    ['Allbirds','hello@allbirds.example',18,['A lighter step','Comfort for the everyday','Meet your new go-to pair']],
    ['Field Notes','hello@fieldnotes.example',12,['A new edition, a new story','Notes from the studio','Something worth keeping']]
  ];
  const result: Mail[]=[];
  senders.forEach(([name,email,count,subjects],s)=>{
    for(let i=0;i<count;i++) result.push({id:`demo-${s}-${i}`,email,name,subject:subjects[i%subjects.length],receivedAt:now-(i*3+s+1)*86400000,labelIds:['INBOX','CATEGORY_PROMOTIONS',...(i%3!==0?['UNREAD']:[])]});
  });
  result.push(
    {id:'demo-receipt',name:'Nord & Co.',email:'offers@nordandco.example',subject:'Your order receipt #10482',receivedAt:now-86400000,labelIds:['INBOX','CATEGORY_PERSONAL','UNREAD']},
    {id:'demo-starred',name:'Nord & Co.',email:'offers@nordandco.example',subject:'Your saved member invitation',receivedAt:now-2*86400000,labelIds:['INBOX','CATEGORY_PROMOTIONS','STARRED']},
    {id:'demo-archived',name:'Everlane',email:'news@everlane.example',subject:'An archived promotion',receivedAt:now-86400000,labelIds:['CATEGORY_PROMOTIONS']}
  );
  return result;
}
export function initDemo() {
  if (!read('demo-messages')) {
    write('demo-messages',sampleMessages());
    db().prepare('INSERT OR IGNORE INTO protected(scope,email) VALUES(?,?)').run('demo','hello@fieldnotes.example');
  }
}
export function demoMailbox(): Mailbox {
  const messages=()=>read<Mail[]>('demo-messages')??[];
  return {
    async list(token) {
      const ids=messages().filter(m=>m.labelIds.includes('INBOX')&&m.labelIds.includes('CATEGORY_PROMOTIONS')&&!m.labelIds.includes('STARRED')&&!m.labelIds.includes('TRASH')).map(m=>m.id);
      const offset=Number(token??0);
      return {ids:ids.slice(offset,offset+500),next:offset+500<ids.length?String(offset+500):undefined};
    },
    async get(id) {
      const m=messages().find(m=>m.id===id);
      if(!m) throw Object.assign(new Error('Missing message'),{code:404});
      return structuredClone(m);
    },
    async trash(id) {
      const all=messages(),m=all.find(m=>m.id===id);
      if(!m) throw Object.assign(new Error('Missing message'),{code:404});
      m.labelIds=m.labelIds.filter(l=>l!=='INBOX'); m.labelIds.push('TRASH'); write('demo-messages',all);
    }
  };
}
