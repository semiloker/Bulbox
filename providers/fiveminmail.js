// providers/fiveminmail.js
// 5minmail.com's own endpoints (POST /generate, GET /inbox/<address>).
//
// Three things make it unlike the other backends, and they are not bugs:
//   * the server picks the address — no handle styles, and every local part
//     carries their recognisable "u_" prefix;
//   * inboxes die after ~5 minutes;
//   * one domain for everybody, and /generate is rate limited to one call per
//     five seconds.
// Its appeal is only that the domain is young enough not to be blocklisted yet.

const BASE = 'https://5minmail.com';
const HEADERS = { Accept: 'application/json' };

// Their inbox items carry no id, so make a stable one out of the fields that do
// not change — index would shift under the message as new mail arrives.
function idFor(m) {
  const seed = `${m.received_at}|${m.sender}|${m.subject}`;
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

async function request(path, { method = 'GET' } = {}) {
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: HEADERS, cache: 'no-store' });
  } catch (err) {
    const e = new Error(`Network error contacting 5minmail: ${err.message}`);
    e.code = 'NETWORK';
    throw e;
  }

  if (res.status === 429) {
    const err = new Error('5minmail allows one new address every 5 seconds.');
    err.status = 429;
    throw err;
  }
  if (res.status === 404) {
    const err = new Error('This 5minmail inbox has expired (they last ~5 minutes).');
    err.status = 404;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`5minmail request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const map = (m) => ({
  id: idFor(m),
  from: { address: m.sender || '', name: '' },
  subject: m.subject || '(no subject)',
  intro: String(m.body || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180),
  seen: false,
  hasAttachments: false,
  createdAt: m.received_at,
});

// The address is assigned, so there is nothing to list up front.
export function getDomains() {
  return [];
}

export async function createAccount() {
  const d = await request('/generate', { method: 'POST' });
  return {
    email: String(d.email).toLowerCase(),
    accountId: d.session_id || null,
    expiresAt: d.expires_in_minutes
      ? new Date(Date.now() + d.expires_in_minutes * 60_000).toISOString()
      : null,
  };
}

export async function listMessages(address) {
  const data = await request(`/inbox/${address}`);
  return (Array.isArray(data) ? data : []).map(map);
}

export async function getMessage(address, id) {
  const data = await request(`/inbox/${address}`);
  const m = (Array.isArray(data) ? data : []).find((x) => idFor(x) === String(id));
  if (!m) {
    const err = new Error('Message not found (5minmail may have expired it).');
    err.status = 404;
    throw err;
  }
  const body = String(m.body || '');
  const looksHtml = /<(html|body|div|table|p|span)\b/i.test(body);
  return {
    id,
    from: { address: m.sender || '', name: '' },
    to: [{ address }],
    subject: m.subject || '(no subject)',
    text: looksHtml ? '' : body,
    html: looksHtml ? body : '',
    createdAt: m.received_at,
  };
}

// Nothing to delete server-side: the inbox expires on its own.
export function deleteAccount() {
  return null;
}
