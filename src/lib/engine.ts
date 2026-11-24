import { eligible, type Mail } from './domain';
import { statusCode,rateLimited,retryAfterMs } from './diagnostics';
export interface Mailbox {
  list(pageToken?: string): Promise<{ ids: string[]; next?: string }>;
  get(id: string): Promise<Mail>;
  trash(id: string): Promise<void>;
  // A paced provider can reserve a recheck + trash together. The eligibility
  // check must happen after waiting, including after any rate-limit cooldown.
  checkedTrash?(id:string,check:(fresh:Mail)=>boolean):Promise<boolean>;
}
export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function errorStatus(error: unknown): number {
  return statusCode(error);
}
export function isAuthError(error: unknown) {
  const e = error as { response?: { data?: { error?: string } }; message?: string };
  return errorStatus(error) === 401 || e.response?.data?.error === 'invalid_grant' || e.message?.includes('invalid_grant');
}
export function transient(error: unknown) {
  const s = errorStatus(error);
  const e = error as { code?: string; response?: { data?: { error?: { errors?: { reason?: string }[] } } } };
  return rateLimited(error) || s >= 500 || ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(e.code ?? '') ||
    (s === 403 && !!e.response?.data?.error?.errors?.some(x => ['rateLimitExceeded', 'userRateLimitExceeded', 'backendError'].includes(x.reason ?? '')));
}
// Shared across scans, profile calls, rechecks, trash and token refreshes in this process.
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private limit = 5) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>(resolve => {
      const enter = () => { this.active++; resolve(); };
      if (this.active < this.limit) enter(); else this.queue.push(enter);
    });
    try { return await fn(); }
    finally { this.active--; this.queue.shift()?.(); }
  }
}
declare global { var inboxGmailLimiter: Limiter | undefined; }
export const gmailLimiter = globalThis.inboxGmailLimiter ?? (globalThis.inboxGmailLimiter = new Limiter(5));
export async function requestWithBackoff<T>(fn: () => Promise<T>, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms)), limiter = gmailLimiter): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await limiter.run(fn); }
    catch (e) {
      if (attempt >= 3 || !transient(e)) throw e;
      const retryAfter = retryAfterMs(e);
      await sleep(Math.min(30_000, Math.max(retryAfter || 0, 500 * 2 ** attempt + Math.random() * 200)));
    }
  }
}
export async function pool<T>(items: T[], fn: (item: T) => Promise<void>, count = 5) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  }));
}
export type ScanProgress = { phase: 'listing' | 'metadata'; pages: number; fetched: number; candidates: number };
export async function scanMailbox(mailbox: Mailbox, progress: (p: ScanProgress) => void): Promise<Mail[]> {
  const ids = new Set<string>();
  const seenTokens = new Set<string>();
  let next: string | undefined, pages = 0;
  do {
    const page = await mailbox.list(next); pages++;
    page.ids.forEach(id => ids.add(id));
    next = page.next;
    if (next && seenTokens.has(next)) throw new AppError('Gmail repeated a page token. Scan incomplete.', 502);
    if (next) seenTokens.add(next);
    progress({ phase: 'listing', pages, fetched: 0, candidates: ids.size });
  } while (next);
  const messages: Mail[] = [];
  let fetched = 0, failure: unknown;
  await pool([...ids], async id => {
    // Drain outstanding calls after failure; never publish partial results as complete.
    if (failure) return;
    try {
      const m = await mailbox.get(id);
      if (m.id !== id) throw new AppError('Unexpected Gmail message ID.', 502);
      if (eligible(m, new Set())) messages.push(m);
    } catch (e) { if (errorStatus(e) !== 404) failure = e; }
    fetched++;
    progress({ phase: 'metadata', pages, fetched, candidates: ids.size });
  });
  if (failure) throw failure;
  return messages;
}
export type BatchItem = { id: string; email: string; name: string; status: 'pending' | 'success' | 'skipped' | 'failed'; reason?: string };
export async function executeBatch(mailbox: Mailbox, items: BatchItem[], cutoff: number | null,
  protectedSenders: () => ReadonlySet<string>, onUpdate: (item: BatchItem) => void) {
  let authorizationFailed=false;
  await pool(items.filter(i => i.status === 'pending'), async item => {
    if (authorizationFailed) {
      item.status='failed';item.reason='Authorization expired. Reconnect Gmail.';onUpdate(item);return;
    }
    try {
      if(mailbox.checkedTrash){
        const moved=await mailbox.checkedTrash(item.id,fresh=>fresh.id===item.id&&fresh.email===item.email&&eligible(fresh,protectedSenders(),cutoff));
        item.status=moved?'success':'skipped';if(!moved)item.reason='No longer eligible';onUpdate(item);return;
      }
      const fresh = await mailbox.get(item.id);
      if (fresh.id !== item.id || fresh.email !== item.email || !eligible(fresh, protectedSenders(), cutoff)) {
        item.status = 'skipped'; item.reason = 'No longer eligible';
      } else {
        // No awaited work between checking current protection and the trash call.
        await mailbox.trash(item.id); item.status = 'success';
      }
    } catch (e) {
      if (errorStatus(e) === 404) { item.status = 'skipped'; item.reason = 'Message no longer available'; }
      else { item.status = 'failed'; if(isAuthError(e))authorizationFailed=true; item.reason = isAuthError(e) ? 'Authorization expired. Reconnect Gmail.' : 'Gmail request failed. Retry after checking your connection.'; }
    }
    onUpdate(item);
  });
}
