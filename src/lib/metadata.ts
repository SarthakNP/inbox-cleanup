import addresses from 'email-addresses';
import libmime from 'libmime';
import type { Mail } from './domain';
export type Metadata = { id?: string | null; internalDate?: string | null; labelIds?: string[] | null; payload?: { headers?: { name?: string | null; value?: string | null }[] | null } | null };
function decode(value: string) { try { return libmime.decodeWords(value); } catch { return value; } }
export function parseMetadata(raw: Metadata): Mail {
  const header = (key: string) => raw.payload?.headers?.find(h => h.name?.toLowerCase() === key)?.value ?? '';
  // Reject ambiguous/multiple From addresses rather than guessing a protected sender.
  const from = addresses.parseAddressList(header('from'));
  const sender = from?.length === 1 && from[0].type === 'mailbox' ? from[0] : null;
  return { id: raw.id ?? '', email: sender?.address.toLowerCase() ?? '', name: decode(sender?.name ?? ''),
    subject: decode(header('subject')) || '(No subject)', receivedAt: Number(raw.internalDate), labelIds: raw.labelIds ?? [] };
}
