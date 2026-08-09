// Self-check for the JSON store: node test/db.test.js
// Runs against a throwaway directory so it can never touch your real database.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bulbox-test-'));
process.env.INBOX_FORGE_DATA = dir;

// Imported dynamically: db.js resolves its data dir at import time.
const db = await import('../lib/db.js');

try {
  await db.ensure();
  assert.equal(db.dbPath(), path.join(dir, 'emails.json'));
  assert.deepEqual((await db.read()).identities, []);
  assert.equal((await db.getSettings()).provider, 'mail.tm');

  const id = db.newId();
  await db.addIdentity({ id, email: 'a@example.com' });
  assert.equal((await db.getIdentity(id)).email, 'a@example.com');
  assert.equal(await db.getIdentity('nope'), null);

  assert.equal((await db.updateSettings({ throttleMs: 900 })).throttleMs, 900);
  assert.equal((await db.getSettings()).provider, 'mail.tm', 'patch must not drop other keys');

  assert.equal(await db.removeIdentities([id, 'nope']), 1, 'counts only what it removed');
  assert.deepEqual((await db.read()).identities, []);

  await db.backup('pre-delete');
  const backups = await fs.readdir(path.join(dir, 'backups'));
  assert.equal(backups.length, 1, 'backup writes exactly one snapshot');

  // Writes are chained, so the last one wins instead of interleaving.
  const a = { settings: {}, identities: [{ id: 'a' }] };
  const b = { settings: {}, identities: [{ id: 'b' }] };
  await Promise.all([db.write(a), db.write(b)]);
  assert.deepEqual((await db.read()).identities, [{ id: 'b' }]);

  // A corrupt file must not throw — read() falls back to the defaults.
  await fs.writeFile(db.dbPath(), '{ not json', 'utf8');
  assert.deepEqual(await db.read(), { settings: { provider: 'mail.tm', throttleMs: 500, theme: 'system' }, identities: [] });

  console.log('ok');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
