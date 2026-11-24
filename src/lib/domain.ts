export type Mail = {
  id: string; email: string; name: string; subject: string;
  receivedAt: number; labelIds: string[];
};
export type Age = 0 | 30 | 90 | 365;
export type Filters = { search: string; age: Age; minimum: number };
export type Sender = { email: string; name: string; messages: Mail[]; unread: number; latest: number };
export const defaults: Filters = { search: '', age: 0, minimum: 1 };
export const cutoffFor = (age: Age, now = Date.now()) => age ? now - age * 86_400_000 : null;
export function eligible(m: Mail, protectedEmails: ReadonlySet<string>, cutoff: number | null = null) {
  return !!m.email && Number.isFinite(m.receivedAt) && m.receivedAt > 0 &&
    m.labelIds.includes('INBOX') && m.labelIds.includes('CATEGORY_PROMOTIONS') &&
    !['STARRED', 'TRASH', 'SPAM'].some(l => m.labelIds.includes(l)) &&
    !protectedEmails.has(m.email.toLowerCase()) && (cutoff === null || m.receivedAt < cutoff);
}
export function groupSenders(messages: Mail[], filters: Filters, protectedEmails: ReadonlySet<string>, now = Date.now()): Sender[] {
  const groups = new Map<string, Mail[]>();
  const cutoff = cutoffFor(filters.age, now);
  for (const m of messages) {
    if (!eligible(m, protectedEmails, cutoff)) continue;
    const key = m.email.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  const search = filters.search.trim().toLowerCase();
  return [...groups.entries()].map(([email, rows]) => {
    const sorted = rows.sort((a, b) => b.receivedAt - a.receivedAt || a.id.localeCompare(b.id));
    return { email, name: sorted[0].name || email, messages: sorted,
      unread: sorted.filter(m => m.labelIds.includes('UNREAD')).length, latest: sorted[0].receivedAt };
  }).filter(s => s.messages.length >= filters.minimum && (!search || s.email.includes(search) || s.name.toLowerCase().includes(search)))
    .sort((a, b) => b.messages.length - a.messages.length || a.email.localeCompare(b.email));
}
export function toggleIds(current: ReadonlySet<string>, ids: string[], checked: boolean) {
  const next = new Set(current);
  for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
  return next;
}
export function selectedSummary(messages: Mail[], ids: ReadonlySet<string>) {
  const counts = new Map<string, { email: string; name: string; count: number }>();
  for (const m of messages) if (ids.has(m.id)) {
    const s = counts.get(m.email) ?? { email: m.email, name: m.name, count: 0 };
    s.count++; counts.set(m.email, s);
  }
  return [...counts.values()].sort((a,b) => b.count - a.count);
}
