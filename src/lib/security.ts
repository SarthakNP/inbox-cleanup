import { randomBytes, createHash, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { db } from './db';
import { AppError } from './engine';
export const cookieName = 'inbox_session';
export const nonce = () => randomBytes(32).toString('hex');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function origin() {
  const value = process.env.APP_ORIGIN || 'http://localhost:3000';
  const u = new URL(value);
  if (u.protocol !== 'http:' || u.hostname !== 'localhost' || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new AppError('APP_ORIGIN must be http://localhost:3000 (or another localhost port).', 500);
  return u.origin;
}
export function validateHost(req: NextRequest) {
  if (req.headers.get('host') !== new URL(origin()).host) throw new AppError('This app only accepts requests on its configured localhost address.',403);
}
export type Session = { id: string; csrf: string; scope: string; expires: number };
export function session(req: NextRequest) {
  const raw = req.cookies.get(cookieName)?.value;
  if (!raw) return null;
  const s = db().prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(raw),Date.now()) as Session | undefined;
  return s ?? null;
}
export function setSession(res: NextResponse, scope = 'visitor') {
  const raw = nonce();
  const s = { id:hash(raw), csrf:nonce(), scope, expires:Date.now()+7*86_400_000 };
  db().prepare('INSERT INTO sessions(id,csrf,scope,expires) VALUES(?,?,?,?)').run(s.id,s.csrf,s.scope,s.expires);
  db().prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  res.cookies.set(cookieName,raw,{httpOnly:true,sameSite:'lax',path:'/',maxAge:7*86400,secure:false});
  return s;
}
export function safeEqual(a: string,b: string) {
  const x=Buffer.from(a), y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y);
}
export function mutation(req: NextRequest, s: Session | null) {
  validateHost(req);
  if (req.headers.get('origin') !== origin() || !s || !safeEqual(req.headers.get('x-csrf-token') || '',s.csrf)) throw new AppError('Request could not be verified. Reload the page and try again.',403);
  if (!req.headers.get('content-type')?.startsWith('application/json')) throw new AppError('Expected JSON.',415);
}
export function key() {
  const value=process.env.TOKEN_ENCRYPTION_KEY || '';
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new AppError('Configure TOKEN_ENCRYPTION_KEY in .env.local. See README.',503);
  return Buffer.from(value,'hex');
}
export function encrypt(value: unknown) {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key(),iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
export function decrypt<T>(value: string): T {
  const b=Buffer.from(value,'base64'), decipher=createDecipheriv('aes-256-gcm',key(),b.subarray(0,12));
  decipher.setAuthTag(b.subarray(12,28));
  return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString('utf8')) as T;
}
