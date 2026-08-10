// Exercises the category functions against a throwaway database.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bulbox-cat-'));
process.env.BULBOX_DATA = dir;
const db = await import('../lib/db.js');

try {
  await db.ensure();
  assert.deepEqual((await db.read()).categories, [], 'starts empty');

  const a = await db.addIdentity({ id: db.newId(), email: 'a@x.com' });
  const b = await db.addIdentity({ id: db.newId(), email: 'b@x.com' });
  const c = await db.addIdentity({ id: db.newId(), email: 'c@x.com' });

  let cats = await db.upsertCategory({ name: '  Shopping  ', color: '#22a06b' });
  assert.equal(cats.length, 1);
  assert.equal(cats[0].name, 'Shopping', 'name is tidied');
  assert.equal(cats[0].color, '#22a06b');
  const shopping = cats[0].id;

  await assert.rejects(() => db.upsertCategory({ name: '   ' }), /needs a name/);

  cats = await db.upsertCategory({ id: shopping, name: 'Shops', color: '#e5484d' });
  assert.equal(cats.length, 1, 'editing does not create a second one');
  assert.equal(cats[0].name, 'Shops');
  assert.equal(cats[0].color, '#e5484d');

  assert.equal((await db.assignCategory([a.id, b.id], shopping)).changed, 2);
  assert.equal((await db.getIdentity(a.id)).category, shopping);
  assert.equal((await db.getIdentity(c.id)).category, undefined, 'others untouched');

  await assert.rejects(() => db.assignCategory([a.id], 'nope'), /No such category/);

  assert.equal((await db.assignCategory([a.id], null)).changed, 1, 'null clears it');
  assert.equal((await db.getIdentity(a.id)).category, undefined);

  const gone = await db.removeCategory(shopping);
  assert.equal(gone.removed, 1);
  assert.deepEqual(gone.categories, []);
  assert.equal((await db.getIdentity(b.id)).category, undefined, 'members are not orphaned');
  assert.equal((await db.read()).identities.length, 3, 'deleting a category keeps the inboxes');

  console.log('ok');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
