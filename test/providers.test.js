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

console.log('ok');
