// Self-check for the provider layer: node test/providers.test.js
// Never touches the network — fetch is stubbed and every call is recorded.
import assert from 'node:assert/strict';
import * as domain from '../providers/domain.js';
import * as mail from '../providers/index.js';

const calls = [];
let reply = { status: 200, body: [] };
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization });
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    json: async () => reply.body,
    text: async () => JSON.stringify(reply.body),
  };
};

const settings = {
  provider: 'domain',
  domain: 'Example.COM',
  mailApi: 'https://mail.example.workers.dev/', // trailing slash on purpose
  mailToken: 's3cret',
};
const identity = { email: 'neon-raven7@example.com', provider: 'domain' };
const last = () => calls[calls.length - 1];

assert.deepEqual(domain.getDomains(settings), ['example.com'], 'domain is normalised');
assert.deepEqual(domain.getDomains({}), [], 'no domain configured yet');
assert.equal(domain.createIdentity(), null, 'catch-all creates nothing');

reply = { status: 200, body: [{ id: 'm1', subject: 'hi' }] };
assert.deepEqual(await mail.listMessages(settings, identity), reply.body);
assert.equal(
  last().url,
  'https://mail.example.workers.dev/messages?to=neon-raven7%40example.com',
  'trailing slash trimmed, address encoded'
);
assert.equal(last().auth, 'Bearer s3cret');
assert.equal(last().method, 'GET');

reply = { status: 200, body: { id: 'm/1', text: 'body' } };
await mail.getMessage(settings, identity, 'm/1');
assert.equal(last().url, 'https://mail.example.workers.dev/messages/m%2F1', 'ids are encoded');

reply = { status: 200, body: { deleted: 2 } };
await mail.deleteIdentity(settings, identity);
assert.equal(last().method, 'DELETE');

// The identity decides the backend, so old mail.tm rows survive a provider switch.
await mail.listMessages({ ...settings, provider: 'mail.tm' }, identity);
assert.match(last().url, /workers\.dev/, 'own-domain identity still reads from the worker');

reply = { status: 401, body: { error: 'unauthorized' } };
await assert.rejects(() => mail.listMessages(settings, identity), /rejected the API token/);

reply = { status: 500, body: { error: 'boom' } };
await assert.rejects(() => mail.listMessages(settings, identity), /boom/);

const before = calls.length;
await assert.rejects(
  () => mail.listMessages({ provider: 'domain', domain: 'example.com' }, identity),
  /worker URL and its API token/
);
assert.equal(calls.length, before, 'misconfigured provider must not hit the network');

reply = { status: 200, body: [] };
assert.match(
  await mail.checkConnection(settings),
  /example\.com/,
  'a good probe names the domain it will receive for'
);
assert.match(
  last().url,
  /\/messages\?to=__bulbox-probe%40example\.com$/,
  'probe cannot collide with real mail'
);

assert.equal(await mail.checkConnection({ provider: 'mail.tm' }), 'mail.tm needs no setup.');

reply = { status: 401, body: {} };
await assert.rejects(() => mail.checkConnection(settings), /rejected the API token/);

// --- temp-mail.io ------------------------------------------------------------
const tmio = { provider: 'temp-mail.io' };
const box = { email: 'neon-raven7@bltiwd.com', provider: 'temp-mail.io', accountId: 'tok123' };

reply = {
  status: 200,
  body: { domains: [{ name: 'bltiwd.com', type: 'public' }, { name: 'vip.com', type: 'private' }] },
};
assert.deepEqual(await mail.getDomains(tmio), ['bltiwd.com'], 'private domains are not offered');

reply = {
  status: 200,
  body: [
    {
      id: 42,
      from: 'noreply@site.com',
      subject: 'Confirm',
      body_text: '  your   code is 1234 ',
      body_html: '<b>1234</b>',
      created_at: '2026-08-09T10:00:00Z',
      attachments: [],
    },
  ],
};
const [msg] = await mail.listMessages(tmio, box);
assert.equal(msg.from.address, 'noreply@site.com', 'mapped into the mail.tm shape the UI expects');
assert.equal(msg.intro, 'your code is 1234', 'intro is collapsed whitespace');
assert.equal(msg.hasAttachments, false);
assert.ok(
  last().url.endsWith('/email/neon-raven7@bltiwd.com/messages'),
  `the @ must stay literal, got ${last().url}`
);

assert.equal((await mail.getMessage(tmio, box, 42)).html, '<b>1234</b>');
assert.equal((await mail.getMessage(tmio, box, '42')).text, '  your   code is 1234 ', 'ids compare loosely');
await assert.rejects(() => mail.getMessage(tmio, box, 999), /Message not found/);

reply = { status: 200, body: {} };
await mail.deleteIdentity(tmio, box);
assert.equal(last().method, 'DELETE');

// A taken local part must look like mail.tm's 422 so the retry loop reacts.
reply = { status: 400, body: { error: 'taken' } };
await assert.rejects(() => mail.createIdentity(tmio, 'x@bltiwd.com', 'pw'), (e) => e.status === 422);

console.log('ok');
