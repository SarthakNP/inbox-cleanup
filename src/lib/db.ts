import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
declare global { var inboxDb: DatabaseSync | undefined; }
export function db() {
  if (!globalThis.inboxDb) {
    const dir = process.env.DATA_DIR || path.join(process.cwd(), '.data');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'inbox-cleanup.sqlite');
    const d = new DatabaseSync(file);
    chmodSync(file, 0o600);
    d.exec(`PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, scope TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS protected (scope TEXT NOT NULL, email TEXT NOT NULL, PRIMARY KEY(scope,email));
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, scope TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batch_items (
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        id TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL,
        status TEXT NOT NULL, reason TEXT, PRIMARY KEY(batch_id,id)
      );
    `);
    // Interrupted requests are uncertain, never mislabeled successful or automatically replayed.
    const interrupted = d.prepare('SELECT id,payload FROM batches').all() as {id:string;payload:string}[];
    for (const row of interrupted) {
      const batch = JSON.parse(row.payload);
      if (batch.status === 'running') {
        batch.status = 'done';
        d.prepare("UPDATE batch_items SET status='failed',reason=? WHERE batch_id=? AND status='pending'")
          .run('App stopped before completion could be confirmed. Retry rechecks current eligibility.',row.id);
        d.prepare('UPDATE batches SET payload=? WHERE id=?').run(JSON.stringify(batch),row.id);
      }
    }
    globalThis.inboxDb = d;
  }
  return globalThis.inboxDb;
}
export function read<T>(key: string): T | null {
  const row = db().prepare('SELECT value FROM kv WHERE key=?').get(key) as {value:string} | undefined;
  return row ? JSON.parse(row.value) as T : null;
}
export function write(key: string, value: unknown) {
  db().prepare('INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)').run(key, JSON.stringify(value));
}
export function remove(key:string) { db().prepare('DELETE FROM kv WHERE key=?').run(key); }
export function protection(scope: string) {
  return new Set((db().prepare('SELECT email FROM protected WHERE scope=? ORDER BY email').all(scope) as {email:string}[]).map(x=>x.email));
}
